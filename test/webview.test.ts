import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { BaseWebviewPanel } from '../src/webviews/baseWebview';
import type { WebviewMessage } from '../src/core/protocol';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

class TestPanel extends BaseWebviewPanel {
  protected get panelKey(): string { return 'test'; }
  protected get title(): string { return 'Test'; }
  protected get webviewName(): string { return 'test'; }

  constructor(tick?: () => Promise<void>) {
    super(vscode.Uri.file('/nonexistent-openlens-test'));
    this.initializePanel(1);
    if (tick) {
      this.startPolling(tick, () => 3600);
    }
  }

  refresh(): Promise<void> { return this.pollNow(); }
  send(type: string, payload: unknown): void { this.post(type, payload); }
}

function setup(): { messages: WebviewMessage[]; receive: (message: WebviewMessage) => void } {
  const messages: WebviewMessage[] = [];
  let receive!: (message: WebviewMessage) => void;
  Object.assign(vscode.Uri, { joinPath: (uri: vscode.Uri, ...parts: string[]) => vscode.Uri.file([uri.fsPath, ...parts].join('/')) });
  Object.assign(vscode.window, {
    createWebviewPanel: () => ({
      visible: true,
      webview: {
        postMessage: (message: WebviewMessage) => { messages.push(message); return Promise.resolve(true); },
        onDidReceiveMessage: (handler: typeof receive) => { receive = handler; },
        html: ''
      },
      onDidDispose: () => undefined,
      onDidChangeViewState: () => undefined,
      dispose: () => undefined
    })
  });
  return { messages, receive: (message) => receive(message) };
}

test('buffers initial responses until listeners are ready, preserving message order', () => {
  const host = setup();
  const panel = new TestPanel();
  try {
    panel.send('loading', {});
    panel.send('lines', ['first']);
    panel.send('lines', ['second']);
    panel.send('data', { rows: [] });
    assert.equal(host.messages.length, 0);
    host.receive({ type: 'ready', requestId: 'ready-1' });
    assert.deepEqual(host.messages.map((message) => message.type), ['loading', 'lines', 'lines', 'data', 'response']);
    panel.send('data', { rows: ['new'] });
    assert.deepEqual(host.messages.at(-1)?.payload, { rows: ['new'] });
    host.receive({ type: 'ready', requestId: 'ready-2' });
    assert.equal(host.messages.length, 7);
  } finally {
    panel.dispose();
  }
});

test('coalesces refreshes during an active load and runs again without waiting for the polling interval', async () => {
  setup();
  const first = deferred();
  let calls = 0;
  const panel = new TestPanel(async () => {
    calls++;
    if (calls === 1) { await first.promise; }
  });
  try {
    assert.equal(calls, 1);
    await panel.refresh();
    await panel.refresh();
    assert.equal(calls, 1);
    first.resolve();
    await settle();
    assert.equal(calls, 2);
  } finally {
    panel.dispose();
  }
});

test('does not run a queued refresh after disposal', async () => {
  setup();
  const first = deferred();
  let calls = 0;
  const panel = new TestPanel(async () => { calls++; await first.promise; });
  await panel.refresh();
  panel.dispose();
  first.resolve();
  await settle();
  assert.equal(calls, 1);
});
