import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { buildTable } from '../src/core/columns';
import { getKind } from '../src/core/resources';
import type { K8sObject } from '../src/core/cluster';
import type { Cell, TableData } from '../src/core/protocol';

const cell = (table: TableData, row: number, column: string): Cell => table.rows[row].cells[table.columns.findIndex((c) => c.id === column)];

test('pod CPU and memory use the node format: used amount and share of limit, then request, with the total in the tooltip', () => {
  const pod = (name: string, resources: unknown): K8sObject => ({
    metadata: { name, namespace: 'default' },
    spec: { containers: [{ name: 'app', resources }] }
  });
  const usage = { cpu: 0.4, memory: 256 * 1024 ** 2, containers: new Map() };
  const table = buildTable(getKind('pods')!, [
    pod('limited', { requests: { cpu: '100m' }, limits: { cpu: '500m', memory: '1Gi' } }),
    pod('requested', { requests: { cpu: '1', memory: '512Mi' } }),
    pod('unbounded', {})
  ], { podMetrics: new Map(['limited', 'requested', 'unbounded'].map((name) => [`default/${name}`, usage])) });

  assert.deepEqual(
    { text: cell(table, 0, 'cpu').text, ratio: cell(table, 0, 'cpu').ratio, tone: cell(table, 0, 'cpu').tone, title: cell(table, 0, 'cpu').title },
    { text: '400m (80%)', ratio: 0.8, tone: 'warn', title: '400m of 500m limit' }
  );
  assert.equal(cell(table, 0, 'memory').text, '256Mi (25%)');
  assert.equal(cell(table, 1, 'cpu').text, '400m (40%)');
  assert.match(cell(table, 1, 'cpu').title ?? '', /of 1 requested/);
  assert.equal(cell(table, 1, 'memory').text, '256Mi (50%)');
  assert.equal(cell(table, 2, 'cpu').ratio, undefined);
  assert.equal(cell(table, 2, 'cpu').text, '400m');
  // Pods sort by actual usage, whatever their limits are.
  assert.equal(cell(table, 0, 'cpu').sort, 0.4);

  const node = buildTable(getKind('nodes')!, [{ metadata: { name: 'n' }, status: { allocatable: { cpu: '4', memory: '1Gi' } } }],
    { nodeMetrics: new Map([['n', { cpu: 1, memory: 256 * 1024 ** 2 }]]) });
  assert.equal(cell(node, 0, 'cpu').text, '1 (25%)');
  assert.equal(cell(node, 0, 'cpu').ratio, 0.25);
  assert.match(cell(node, 0, 'cpu').title ?? '', /of 4 allocatable/);
});

test('a row cache rebuilds only replaced objects', () => {
  const cache = new WeakMap();
  const a = { metadata: { name: 'a', namespace: 'default' } };
  const b = { metadata: { name: 'b', namespace: 'default' } };
  const first = buildTable(getKind('pods')!, [a, b], {}, cache);
  const second = buildTable(getKind('pods')!, [a, { ...b }], {}, cache);
  assert.equal(second.rows[0], first.rows[0]);
  assert.notEqual(second.rows[1], first.rows[1]);
});

test('job duration ticks while running and is fixed once complete', () => {
  const table = buildTable(getKind('jobs')!, [
    { metadata: { name: 'running', namespace: 'default' }, status: { startTime: '2026-10-16T10:00:00Z' } },
    { metadata: { name: 'done', namespace: 'default' }, status: { startTime: '2026-10-16T10:00:00Z', completionTime: '2026-10-16T13:12:30Z' } }
  ], {});
  assert.equal(cell(table, 0, 'duration').time, '2026-10-16T10:00:00Z');
  assert.equal(cell(table, 0, 'duration').text, '');
  assert.equal(cell(table, 1, 'duration').text, '3h12m');
  assert.equal(cell(table, 1, 'duration').sort, 3 * 3600 + 12 * 60 + 30);
});
