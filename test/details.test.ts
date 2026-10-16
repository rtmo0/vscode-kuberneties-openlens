import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { DetailsPanel, PanelServices } from '../src/webviews/panels';
import { prometheusFor } from '../src/core/prometheus';
import type { ClusterSession } from '../src/core/cluster';
import type { DetailsData, WebviewMessage } from '../src/core/protocol';

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

test('pod details are shown from the object at once, without waiting for version, metrics, Prometheus or events', async () => {
  const messages: WebviewMessage[] = [];
  let receive!: (message: WebviewMessage) => void;
  let dispose!: () => void;
  Object.assign(vscode.Uri, { joinPath: (uri: vscode.Uri, ...parts: string[]) => vscode.Uri.file([uri.fsPath, ...parts].join('/')) });
  Object.assign(vscode.window, {
    createWebviewPanel: () => ({
      visible: true,
      webview: { html: '', postMessage: (message: WebviewMessage) => { messages.push(message); return Promise.resolve(true); }, onDidReceiveMessage: (fn: typeof receive) => { receive = fn; } },
      onDidDispose: (fn: () => void) => { dispose = fn; },
      onDidChangeViewState: () => undefined
    })
  });
  const never = <T>(): Promise<T> => new Promise(() => undefined);
  const pod = { metadata: { name: 'web', namespace: 'team', uid: 'u1' }, spec: { containers: [{ name: 'app', image: 'nginx' }] }, status: { phase: 'Running' } };
  const session = {
    context: 'test',
    connect: never,
    get: async () => pod,
    podMetrics: never,
    events: never,
    can: never,
    rest: { get: never }
  };
  const opened: string[] = [];
  const services = {
    extensionUri: vscode.Uri.file('/nonexistent-openlens-test'),
    clusters: { session: () => session },
    actions: { onOpened: (_context: string, ref: { name: string }) => opened.push(ref.name) },
    favorites: { isPinned: () => false }
  } as unknown as PanelServices;
  DetailsPanel.show(services, 'test', { kindId: 'pods', name: 'web', namespace: 'team' });
  receive({ type: 'ready', requestId: 'ready' });
  try {
    for (let i = 0; i < 5; i++) { await settle(); }
    const data = messages.find((message) => message.type === 'data');
    assert.ok(data, 'details must be posted while every optional request hangs');
    const details = (data.payload as { details: DetailsData }).details;
    assert.deepEqual(details.sections.map((section) => section.title).slice(0, 4), ['Overview', 'Pod', 'Metrics', 'Containers']);
    assert.ok(details.sections.some((section) => section.title === 'Events (loading…)'));
    assert.deepEqual(opened, ['web']);
  } finally {
    dispose();
  }
});

test('Prometheus candidates are probed together and the first one in priority order wins', async () => {
  let active = 0;
  let peak = 0;
  const session = {
    context: 'detect',
    rest: {
      get: async (path: string) => {
        if (path === '/api/v1/services') { return { items: [] }; }
        active++;
        peak = Math.max(peak, active);
        await settle();
        active--;
        // Two well-known services exist; the first listed must be chosen.
        if (path.includes('/monitoring/services/prometheus-k8s') || path.includes('/kube-system/services/prometheus')) {
          return { status: 'success' };
        }
        throw new Error('not found');
      }
    }
  } as unknown as ClusterSession;
  const endpoint = await prometheusFor(session);
  assert.deepEqual(endpoint, { namespace: 'monitoring', service: 'prometheus-k8s', port: '9090' });
  assert.ok(peak > 5, `probes must run concurrently (peak ${peak})`);
});
