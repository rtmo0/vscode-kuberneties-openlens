import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import type { ClusterSession, K8sObject } from '../src/core/cluster';
import { getKind } from '../src/core/resources';
import { ResourceWatcher } from '../src/core/watch';

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function objects(start: number, count: number): K8sObject[] {
  return Array.from({ length: count }, (_, index) => ({
    apiVersion: 'v1',
    kind: 'Node',
    metadata: { name: `node-${start + index}`, uid: `uid-${start + index}` }
  }));
}

test('loads the initial resource list in pages and exposes each page immediately', async () => {
  const queries: Array<Record<string, unknown>> = [];
  let finishStream!: () => void;
  const streamDone = new Promise<void>((resolve) => { finishStream = resolve; });
  const rest = {
    get: async (_path: string, query: Record<string, unknown>) => {
      queries.push(query);
      if (!query.continue) {
        return { items: objects(0, 100), metadata: { resourceVersion: '42', continue: 'next-page' } };
      }
      return { items: objects(100, 250), metadata: { resourceVersion: '42' } };
    },
    stream: async () => ({ abort: finishStream, done: streamDone })
  };
  const session = { context: 'test', rest } as unknown as ClusterSession;
  const watcher = new ResourceWatcher(session, getKind('nodes')!, '');
  const states: Array<{ count: number; ready: boolean }> = [];
  const unsubscribe = watcher.onChange(() => {
    const state = watcher.state;
    states.push({ count: state.items.length, ready: state.ready });
  });

  try {
    await watcher.whenReady();
    assert.deepEqual(queries, [
      { limit: 100, continue: undefined },
      { limit: 500, continue: 'next-page' }
    ]);
    assert.deepEqual(states, [
      { count: 100, ready: false },
      { count: 350, ready: true }
    ]);
    assert.equal(watcher.state.items.length, 350);
  } finally {
    unsubscribe();
    watcher.stop();
    finishStream();
    await settle();
  }
});

test('continuous watch events publish updates without waiting for a quiet period', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let send!: (chunk: Buffer) => void;
  let finish!: () => void;
  const done = new Promise<void>((resolve) => { finish = resolve; });
  const session = {
    context: 'test',
    rest: {
      get: async () => ({ items: objects(0, 1), metadata: { resourceVersion: '1' } }),
      stream: async (_path: string, _query: unknown, onData: typeof send) => {
        send = onData;
        return { abort: finish, done };
      }
    }
  } as unknown as ClusterSession;
  const watcher = new ResourceWatcher(session, getKind('nodes')!, '');
  try {
    await watcher.whenReady();
    await settle();
    let updates = 0;
    watcher.onChange(() => updates++);
    for (let i = 0; i < 10; i++) {
      send(Buffer.from(JSON.stringify({ type: 'MODIFIED', object: objects(i, 1)[0] }) + '\n'));
      t.mock.timers.tick(50);
    }
    assert.equal(updates, 3);
    watcher.stop();
    t.mock.timers.tick(150);
    assert.equal(updates, 3);
  } finally {
    watcher.stop();
    await settle();
  }
});

test('stopping during the first page resolves waiters and never opens a watch', async () => {
  let resolvePage!: (page: unknown) => void;
  let streams = 0;
  const session = {
    context: 'test',
    rest: {
      get: () => new Promise((resolve) => { resolvePage = resolve; }),
      stream: () => { streams++; throw new Error('must not open'); }
    }
  } as unknown as ClusterSession;
  const watcher = new ResourceWatcher(session, getKind('nodes')!, '');
  const ready = watcher.whenReady();
  watcher.stop();
  await ready;
  resolvePage({ items: objects(0, 1), metadata: { resourceVersion: '1' } });
  await settle();
  assert.equal(streams, 0);
  assert.equal(watcher.state.items.length, 0);
});

test('a re-list after 410 Gone keeps the last complete list until the new one is complete', async () => {
  let lists = 0;
  let streams = 0;
  let finishSecond!: () => void;
  const secondDone = new Promise<void>((resolve) => { finishSecond = resolve; });
  const rest = {
    get: async (_path: string, query: Record<string, unknown>) => {
      if (!query.continue) {
        lists++;
        return { items: objects(0, 100), metadata: { resourceVersion: String(lists), continue: 'next-page' } };
      }
      // The re-list finds one object fewer.
      return { items: objects(100, lists === 1 ? 250 : 249), metadata: { resourceVersion: String(lists) } };
    },
    stream: async (_path: string, _query: unknown, onData: (chunk: Buffer) => void) => {
      streams++;
      if (streams === 1) {
        onData(Buffer.from(JSON.stringify({ type: 'ERROR', object: { code: 410, message: 'too old resource version' } }) + '\n'));
        return { abort: () => undefined, done: Promise.resolve() };
      }
      return { abort: finishSecond, done: secondDone };
    }
  };
  const watcher = new ResourceWatcher({ context: 'test', rest } as unknown as ClusterSession, getKind('nodes')!, '');
  const states: Array<{ count: number; ready: boolean }> = [];
  watcher.onChange(() => states.push({ count: watcher.state.items.length, ready: watcher.state.ready }));
  try {
    while (streams < 2) { await settle(); }
    assert.equal(lists, 2);
    assert.deepEqual(states, [
      { count: 100, ready: false },
      { count: 350, ready: true },
      { count: 349, ready: true }
    ]);
  } finally {
    watcher.stop();
    finishSecond();
    await settle();
  }
});
