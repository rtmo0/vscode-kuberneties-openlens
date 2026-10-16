import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import type { ResourceTableData, Row, TablePatch, TableSupplement, WebviewMessage } from '../src/core/protocol';

/** Small DOM harness for running the actual bundled table client without a browser dependency. */
class Element {
  children: Element[] = [];
  textContent = '';
  className = '';
  value = '';
  type = '';
  checked = false;
  disabled = false;
  style: Record<string, string> = {};
  width = 100;
  dataset = {};
  listeners = new Map<string, (event: unknown) => void>();
  classList = { add: () => undefined, toggle: () => undefined, remove: () => undefined };
  constructor(readonly tag: string) {}
  get firstChild(): Element | undefined { return this.children[0]; }
  append(...children: Array<Element | string>): void {
    this.children.push(...children.map((child) => {
      if (typeof child !== 'string') { return child; }
      const text = new Element('#text');
      text.textContent = child;
      return text;
    }));
  }
  prepend(child: Element): void { this.children.unshift(child); }
  removeChild(child: Element): void { this.children.splice(this.children.indexOf(child), 1); }
  setAttribute(): void {}
  addEventListener(type: string, fn: (event: unknown) => void): void { this.listeners.set(type, fn); }
  removeEventListener(type: string): void { this.listeners.delete(type); }
  getBoundingClientRect(): { width: number } { return { width: this.width }; }
  setPointerCapture(): void {}
  fire(type: string, extra: Record<string, unknown> = {}): void {
    this.listeners.get(type)?.({ target: this, currentTarget: this, preventDefault() {}, stopPropagation() {}, ...extra });
  }
  find(predicate: (element: Element) => boolean): Element[] {
    return [...(predicate(this) ? [this] : []), ...this.children.flatMap((child) => child.find(predicate))];
  }
}

async function setup() {
  const app = new Element('main');
  const body = new Element('body');
  body.append(app);
  const requests: WebviewMessage[] = [];
  const states: unknown[] = [];
  let receive!: (event: { data: WebviewMessage }) => void;
  let frames: Array<() => void> = [];
  let timers: Array<() => void> = [];
  const send = (type: string, payload: unknown): void => receive({ data: { type, payload } });
  runInNewContext(readFileSync(join(__dirname, 'table-client.js'), 'utf8'), {
    acquireVsCodeApi: () => ({
      getState: () => ({}), setState: (state: unknown) => states.push(state),
      postMessage: (message: WebviewMessage) => {
        requests.push(message);
        const payload = message.type === 'init'
          ? { context: 'test', kindId: 'pods', title: 'Pods', namespaced: true, namespace: '', namespaces: [], bulkActions: ['delete'] }
          : message.type === 'meta' ? { protected: false } : true;
        queueMicrotask(() => receive({ data: { type: 'response', requestId: message.requestId, payload } }));
      }
    }),
    window: { addEventListener: (type: string, fn: typeof receive) => { if (type === 'message') { receive = fn; } }, scrollY: 0, scrollTo() {} },
    document: {
      body, getElementById: () => app, querySelector: () => undefined,
      createElement: (tag: string) => new Element(tag), createElementNS: (_ns: string, tag: string) => new Element(tag),
      addEventListener() {}
    },
    queueMicrotask, requestAnimationFrame: (fn: () => void) => frames.push(fn),
    setTimeout: (fn: () => void) => timers.push(fn), clearTimeout() {}, setInterval() {}
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const flush = (): void => { const pending = frames; frames = []; pending.forEach((fn) => fn()); };
  const rows = (count: number): Row[] => Array.from({ length: count }, (_, i) => ({
    key: `pod-${i}`, name: `pod-${i}`, namespace: 'default', cells: [{ text: `pod-${i}` }], actions: ['delete']
  }));
  return {
    app, rows, requests, flush, send, states,
    data: (items: Row[], extra: Partial<ResourceTableData> = {}) => send('data', { columns: [{ id: 'name', title: 'Name' }], rows: items, namespace: '', scope: 1, ...extra }),
    supplement: (payload: TableSupplement) => send('supplement', payload),
    table: () => app.find((el) => el.tag === 'table')[0],
    rowCount: () => app.find((el) => el.tag === 'tbody')[0]?.children.length,
    button: (label: string) => app.find((el) => el.tag === 'button' && el.textContent === label)[0],
    timers: () => { const pending = timers; timers = []; pending.forEach((fn) => fn()); }
  };
}

test('keeps the DOM bounded to 100 rows, reuses unchanged pages and searches all resources', async () => {
  const host = await setup();
  const rows = host.rows(250);
  host.data(rows);
  host.flush();
  assert.equal(host.rowCount(), 100);
  const first = host.table();
  rows[249] = { ...rows[249], search: 'changed off-page' };
  host.data(rows);
  host.flush();
  assert.equal(host.table(), first);
  host.button('Next').fire('click');
  assert.equal(host.rowCount(), 100);
  host.button('Next').fire('click');
  assert.equal(host.rowCount(), 50);
  assert.equal(host.button('Next').disabled, true);

  const search = host.app.find((el) => el.type === 'search')[0];
  search.value = 'pod-249';
  search.fire('input');
  host.timers();
  assert.equal(host.rowCount(), 1);
  assert.ok(host.table().find((el) => el.textContent === 'pod-249').length);
});

test('acknowledges actual row paint before enrichment and patches metrics without replacing rows', async () => {
  const host = await setup();
  const rows = host.rows(1);
  rows[0].cells.push({ text: '—' });
  rows[0].actions = [];
  const columns = [{ id: 'name', title: 'Name' }, { id: 'cpu', title: 'CPU' }];
  host.data(rows, { columns });
  assert.equal(host.requests.some((message) => message.type === 'painted'), false);
  host.flush();
  assert.equal(host.rowCount(), 1);
  assert.equal(host.requests.some((message) => message.type === 'painted'), false);
  host.flush();
  host.timers();
  assert.equal(host.requests.filter((message) => message.type === 'painted').length, 1);

  const table = host.table();
  const row = table.find((element) => element.tag === 'tbody')[0].children[0];
  const name = row.find((element) => element.className === ' col-name')[0];
  host.supplement({ scope: 1, rows: [{ key: 'pod-0', cells: { cpu: { text: '200m', sort: 0.2 } }, actions: ['delete'] }] });
  assert.equal(host.table(), table);
  assert.equal(table.find((element) => element.tag === 'tbody')[0].children[0], row);
  assert.equal(row.find((element) => element.className === ' col-name')[0], name);
  assert.ok(row.find((element) => element.textContent === '200m').length);
  const action = row.find((element) => element.tag === 'button')[0];
  action.fire('click');
  assert.equal(host.requests.at(-1)?.type, 'action');
  host.supplement({ scope: 0, rows: [{ key: 'pod-0', cells: { cpu: { text: 'stale' } } }] });
  assert.equal(row.find((element) => element.textContent === 'stale').length, 0);
});

test('a metric patch cannot hide a queued resource snapshot', async () => {
  const host = await setup();
  const columns = [{ id: 'name', title: 'Name' }, { id: 'cpu', title: 'CPU' }];
  const rows = host.rows(1);
  rows[0].cells.push({ text: '—' });
  host.data(rows, { columns });
  host.flush();
  const changed = { ...rows[0], name: 'renamed', cells: [{ text: 'renamed' }, { text: '—' }] };
  host.data([changed], { columns });
  host.supplement({ scope: 1, rows: [{ key: rows[0].key, cells: { cpu: { text: '300m' } } }] });
  host.flush();
  assert.ok(host.table().find((element) => element.textContent === 'renamed').length);
  assert.ok(host.table().find((element) => element.textContent === '300m').length);
});

test('coalesces snapshots and selects current off-page rows after reusing the DOM', async () => {
  const host = await setup();
  const rows = host.rows(250);
  host.data(rows.slice(0, 100));
  host.data(rows);
  host.flush();
  const table = host.table();
  rows[249] = { ...rows[249], key: 'replacement', name: 'pod-999', cells: [{ text: 'pod-999' }] };
  host.data(rows);
  host.flush();
  assert.equal(host.table(), table);
  const selectAll = table.find((el) => el.type === 'checkbox')[0];
  selectAll.checked = true;
  selectAll.fire('change');
  host.button('Next').fire('click');
  host.button('Next').fire('click');
  assert.ok(host.table().find((el) => el.type === 'checkbox').every((box) => box.checked));

  host.data(rows.slice(0, 20));
  host.flush();
  assert.equal(host.rowCount(), 20);
  assert.equal(host.button('Next'), undefined);
});

test('patches replace only changed rows and keep the DOM of unchanged ones', async () => {
  const host = await setup();
  const rows = host.rows(3);
  host.data(rows);
  host.flush();
  const body = (): Element => host.table().find((el) => el.tag === 'tbody')[0];
  const [first, second] = body().children;
  receivePatch(host, { upsert: [{ ...rows[1], cells: [{ text: 'pod-1 changed' }] }], remove: ['pod-2'] });
  host.flush();
  assert.equal(host.rowCount(), 2);
  assert.equal(body().children[0], first, 'unchanged row is reused');
  assert.notEqual(body().children[1], second);
  assert.ok(body().children[1].find((el) => el.textContent === 'pod-1 changed').length);

  receivePatch(host, { upsert: [], remove: [], scope: 0 });
  receivePatch(host, { upsert: [host.rows(4)[3]], remove: [] });
  host.flush();
  assert.equal(host.rowCount(), 3);
});

function receivePatch(host: Awaited<ReturnType<typeof setup>>, patch: Partial<TablePatch>): void {
  host.send('patch', { scope: 1, namespace: '', upsert: [], remove: [], ...patch });
}

test('columns can be resized by dragging the header edge, without sorting, and keep their width', async () => {
  const host = await setup();
  const columns = [{ id: 'name', title: 'Name' }, { id: 'owner', title: 'Controlled By' }];
  const rows = host.rows(2).map((row) => ({ ...row, cells: [row.cells[0], { text: 'ReplicaSet/a-very-long-owner-name' }] }));
  host.data(rows, { columns });
  host.flush();
  const th = host.table().find((el) => el.tag === 'th' && el.className.includes('col-owner'))[0];
  const handle = th.find((el) => el.className === 'col-resizer')[0];
  th.width = 200;
  handle.fire('pointerdown', { clientX: 500, pointerId: 1 });
  handle.fire('pointermove', { clientX: 620 });
  handle.fire('pointerup');
  handle.fire('click');
  const cells = host.table().find((el) => el.tag === 'td' && el.className.includes('col-owner'));
  assert.equal(th.style.width, '320px');
  assert.deepEqual([...cells.map((td) => td.style.maxWidth)], ['320px', '320px']);
  assert.deepEqual(JSON.parse(JSON.stringify((host.states.at(-1) as { widths: unknown }).widths)), { pods: { owner: 320 } });
  assert.equal((host.states.at(-1) as { sort?: unknown }).sort, undefined, 'resizing must not sort');

  // A new snapshot keeps the width.
  host.data(rows.map((row) => ({ ...row })), { columns, scope: 2 });
  host.flush();
  const td = host.table().find((el) => el.tag === 'td' && el.className.includes('col-owner'))[0];
  assert.equal(td.style.width, '320px');
});
