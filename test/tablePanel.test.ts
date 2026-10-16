import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { ResourceTablePanel, PanelServices } from '../src/webviews/panels';
import { getKind } from '../src/core/resources';
import type { ResourceTableData, TablePatch, TableSupplement, WebviewMessage } from '../src/core/protocol';
import type { PodUsage, Usage } from '../src/core/cluster';
import type { WatchState } from '../src/core/watch';

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

class Collection {
  listeners = new Set<() => void>();
  releases = 0;
  state: WatchState = { items: [], namespace: '', ready: true };
  onChange(fn: () => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  update(): void { this.listeners.forEach((fn) => fn()); }
}

function setup() {
  const messages: WebviewMessage[] = [];
  let receive!: (message: WebviewMessage) => void;
  let dispose!: () => void;
  let namespace = '';
  const collections = new Map<string, Collection>();
  const calls: string[] = [];
  Object.assign(vscode.Uri, { joinPath: (uri: vscode.Uri, ...parts: string[]) => vscode.Uri.file([uri.fsPath, ...parts].join('/')) });
  Object.assign(vscode.window, {
    createWebviewPanel: () => ({
      visible: true,
      webview: {
        html: '',
        postMessage: (message: WebviewMessage) => { messages.push(message); return Promise.resolve(true); },
        onDidReceiveMessage: (fn: typeof receive) => { receive = fn; }
      },
      onDidDispose: (fn: () => void) => { dispose = fn; },
      onDidChangeViewState: () => undefined
    })
  });
  const collection = (key: string): Collection => {
    if (!collections.has(key)) { collections.set(key, new Collection()); }
    return collections.get(key)!;
  };
  const session = {
    connect: async () => undefined,
    namespaces: async () => ['default'],
    kind: async (id: string) => getKind(id)!,
    can: async () => true,
    nodeMetrics: async (): Promise<Map<string, Usage> | undefined> => undefined,
    podMetrics: async (_namespace?: string): Promise<Map<string, PodUsage> | undefined> => undefined,
    watch: (kind: { id: string }, ns: string) => {
      const key = `${kind.id}|${ns}`;
      calls.push(key);
      const watcher = collection(key);
      return { watcher, release: () => { watcher.releases++; } };
    },
    list: () => { throw new Error('Tables must use the shared watcher'); }
  };
  const services = {
    extensionUri: vscode.Uri.file('/nonexistent-openlens-test'),
    clusters: {
      session: () => session,
      namespaceFilter: () => namespace,
      setNamespaceFilter: async (_context: string, value: string) => { namespace = value; }
    }
  } as unknown as PanelServices;
  const latest = (): ResourceTableData => {
    let data!: ResourceTableData;
    for (const message of messages) {
      if (message.type === 'data') { data = structuredClone(message.payload) as ResourceTableData; }
      if (message.type === 'patch' && data) {
        const patch = structuredClone(message.payload) as TablePatch;
        if (patch.scope !== data.scope) { continue; }
        const rows = new Map(data.rows.map((row) => [row.key, row]));
        patch.remove.forEach((key) => rows.delete(key));
        patch.upsert.forEach((row) => rows.set(row.key, row));
        data = { ...data, rows: [...rows.values()], loading: patch.loading, notice: patch.notice };
      }
      if (message.type === 'supplement' && data) {
        const supplement = message.payload as TableSupplement;
        if (supplement.scope !== data.scope) { continue; }
        for (const update of supplement.rows) {
          const row = data.rows.find((row) => row.key === update.key);
          if (!row) { continue; }
          if (update.actions) { row.actions = update.actions; }
          for (const [column, cell] of Object.entries(update.cells ?? {})) {
            row.cells[data.columns.findIndex((entry) => entry.id === column)] = cell;
          }
        }
      }
    }
    return data;
  };
  return {
    session, collection, calls, messages,
    open: (kind: string) => {
      ResourceTablePanel.show(services, 'test', kind);
      receive({ type: 'ready', requestId: 'ready' });
    },
    receive: (message: WebviewMessage) => receive(message),
    dispose: () => dispose(),
    latest,
    paint: () => receive({ type: 'painted', payload: { scope: latest().scope }, requestId: 'painted' })
  };
}

test('node counts update through one shared pod watch, independent of metrics and polling', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const host = setup();
  const nodes = host.collection('nodes|');
  nodes.state.items = [{ metadata: { name: 'node-1' }, status: { allocatable: { pods: '110' } } }];
  const pods = host.collection('pods|');
  pods.state.items = [
    { metadata: { name: 'running' }, spec: { nodeName: 'node-1' }, status: { phase: 'Running' } },
    { metadata: { name: 'finished' }, spec: { nodeName: 'node-1' }, status: { phase: 'Succeeded' } }
  ];
  // An unavailable metrics server must not stop either table or pod counts.
  host.session.nodeMetrics = () => new Promise(() => undefined);
  host.open('nodes');
  const render = async (): Promise<void> => { await settle(); t.mock.timers.tick(100); await settle(); };
  const count = (): string => {
    const table = host.latest();
    return table.rows[0].cells[table.columns.findIndex((column) => column.id === 'pods')].text;
  };
  try {
    await render();
    assert.deepEqual(host.calls, ['nodes|'], 'pod counts must not compete with the initial node list');
    host.paint();
    await settle();
    assert.equal(count(), '1/110');
    pods.state.items = [];
    pods.update();
    await render();
    assert.equal(count(), '0/110');
    host.receive({ type: 'refresh', requestId: 'refresh' });
    await render();
    assert.deepEqual(host.calls, ['nodes|', 'pods|']);
  } finally {
    host.dispose();
  }
  assert.equal(nodes.releases, 1);
  assert.equal(pods.releases, 1);
});

test('namespace switching is not queued behind a slow metrics request', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const host = setup();
  host.session.podMetrics = () => new Promise(() => undefined);
  host.collection('pods|next').state.items = [{ metadata: { name: 'new-pod', namespace: 'next' } }];
  host.open('pods');
  try {
    await settle();
    host.paint();
    host.receive({ type: 'setNamespace', requestId: 'namespace', payload: { namespace: 'next' } });
    await settle();
    t.mock.timers.tick(100);
    await settle();
    assert.deepEqual(host.calls, ['pods|', 'pods|next']);
    assert.equal(host.collection('pods|').releases, 1);
    assert.equal(host.latest().rows[0].name, 'new-pod');
  } finally {
    host.dispose();
  }
});

test('first rows and subsequent pages do not wait for version, namespaces, metrics or permissions', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const host = setup();
  const optional: string[] = [];
  host.session.connect = () => { optional.push('version'); return new Promise(() => undefined); };
  host.session.namespaces = () => { optional.push('namespaces'); return new Promise(() => undefined); };
  let finishMetrics!: (value: Map<string, PodUsage>) => void;
  host.session.podMetrics = () => {
    optional.push('metrics');
    return new Promise((resolve) => { finishMetrics = resolve; });
  };
  host.session.can = () => { optional.push('permission'); return new Promise(() => undefined); };
  const pods = host.collection('pods|');
  pods.state = { ready: false, namespace: '', items: [{ metadata: { name: 'first', namespace: 'default' } }] };
  host.open('pods');
  try {
    await settle();
    assert.equal(host.latest().rows[0].name, 'first');
    assert.equal(optional.length, 0);
    host.paint();
    assert.ok(optional.includes('metrics'));
    assert.ok(optional.includes('permission'));
    pods.state.ready = true;
    pods.state.items.push({ metadata: { name: 'second', namespace: 'next' } });
    pods.update();
    t.mock.timers.tick(100);
    await settle();
    assert.equal(host.latest().rows.length, 2, 'final rows must arrive even with all optional APIs hung');
    assert.equal(host.latest().loading, undefined);
    const snapshots = host.messages.filter((message) => message.type === 'data').length;
    finishMetrics(new Map([['default/first', { cpu: 0.1, memory: 1024, containers: new Map() }]]));
    await settle();
    const table = host.latest();
    assert.equal(table.rows[0].cells[table.columns.findIndex((column) => column.id === 'cpu')].text, '100m');
    assert.equal(host.messages.filter((message) => message.type === 'data').length, snapshots, 'metrics send cell patches, not another list');
    assert.ok(optional.filter((entry) => entry === 'permission').length < 10, 'permission checks are bounded to one namespace');
  } finally { host.dispose(); }
});

test('late metrics from the previous scope cannot update the current namespace', async () => {
  const host = setup();
  let finish!: (value: Map<string, PodUsage>) => void;
  host.session.podMetrics = () => new Promise((resolve) => { finish = resolve; });
  host.open('pods');
  try {
    await settle();
    host.paint();
    host.receive({ type: 'setNamespace', requestId: 'switch', payload: { namespace: 'new' } });
    await settle();
    const before = host.messages.length;
    finish(new Map());
    await settle();
    assert.ok(!host.messages.slice(before).some((message) => message.type === 'supplement'));
  } finally { host.dispose(); }
});

test('after the first snapshot only changed, added and removed rows are sent', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const host = setup();
  const pods = host.collection('pods|');
  const pod = (name: string, phase = 'Running') => ({ metadata: { name, namespace: 'default', uid: name }, status: { phase } });
  pods.state.items = [pod('a'), pod('b'), pod('c')];
  host.open('pods');
  try {
    await settle();
    assert.equal(host.messages.filter((message) => message.type === 'data').length, 1);
    pods.state.items = [pods.state.items[0], pod('b', 'Pending'), pod('d')];
    pods.update();
    t.mock.timers.tick(100);
    await settle();
    const patches = host.messages.filter((message) => message.type === 'patch');
    assert.equal(patches.length, 1);
    const patch = patches[0].payload as TablePatch;
    assert.deepEqual(patch.upsert.map((row) => row.key).sort(), ['b', 'd']);
    assert.deepEqual(patch.remove, ['c']);
    assert.deepEqual(host.latest().rows.map((row) => row.key).sort(), ['a', 'b', 'd']);
    assert.equal(host.messages.filter((message) => message.type === 'data').length, 1, 'no full snapshot for a small change');

    // A rebuilt but identical row is not re-sent.
    pods.state.items = [pod('a'), ...pods.state.items.slice(1)];
    pods.update();
    t.mock.timers.tick(100);
    await settle();
    assert.deepEqual((host.messages.at(-1)!.payload as TablePatch).upsert, []);
  } finally { host.dispose(); }
});

test('metrics patches are kept in cached rows for later snapshots', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const host = setup();
  host.session.podMetrics = async () => new Map([['default/a', { cpu: 0.25, memory: 1024, containers: new Map() }]]);
  const pods = host.collection('pods|');
  pods.state.items = [{ metadata: { name: 'a', namespace: 'default', uid: 'a' } }, { metadata: { name: 'b', namespace: 'default', uid: 'b' } }];
  host.open('pods');
  const cpu = (): string => {
    const table = host.latest();
    return table.rows.find((row) => row.key === 'a')!.cells[table.columns.findIndex((column) => column.id === 'cpu')].text;
  };
  try {
    await settle();
    host.paint();
    await settle();
    assert.equal(cpu(), '250m');
    // The watch replaced "a" with an equal object: its rebuilt row matches what the webview shows.
    pods.state.items = [{ ...pods.state.items[0] }, { metadata: { name: 'b', namespace: 'default', uid: 'b', labels: { x: 'y' } } }];
    pods.update();
    t.mock.timers.tick(100);
    await settle();
    assert.deepEqual((host.messages.at(-1)!.payload as TablePatch).upsert.map((row) => row.key), ['b']);
    assert.equal(cpu(), '250m');
  } finally { host.dispose(); }
});
