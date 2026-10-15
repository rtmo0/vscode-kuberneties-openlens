import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { K8sObject } from '../src/core/cluster';
import { formatAge, formatBytes, formatCpu, parseQuantity } from '../src/core/format';
import { decodeRelease } from '../src/core/helm';
import { labelSelectorString, podStatus } from '../src/core/status';
import * as zlib from 'node:zlib';

describe('quantities', () => {
  it('parses CPU and memory quantities', () => {
    assert.equal(parseQuantity('250m'), 0.25);
    assert.equal(parseQuantity('2'), 2);
    assert.equal(parseQuantity('1500000n'), 0.0015);
    assert.equal(parseQuantity('128Mi'), 128 * 2 ** 20);
    assert.equal(parseQuantity('1Gi'), 2 ** 30);
    assert.equal(parseQuantity('1G'), 1e9);
    assert.equal(parseQuantity('129e6'), 129e6);
    assert.equal(parseQuantity(undefined), 0);
  });

  it('formats like kubectl top', () => {
    assert.equal(formatCpu(0.25), '250m');
    assert.equal(formatCpu(1.5), '1.5');
    assert.equal(formatCpu(0.0004), '1m');
    assert.equal(formatBytes(128 * 2 ** 20), '128Mi');
    assert.equal(formatBytes(1536), '1.5Ki');
  });

  it('formats ages', () => {
    const now = Date.parse('2026-10-15T12:00:00Z');
    assert.equal(formatAge('2026-10-15T11:59:30Z', now), '30s');
    assert.equal(formatAge('2026-10-15T11:55:00Z', now), '5m');
    assert.equal(formatAge('2026-10-15T09:30:00Z', now), '2h30m');
    assert.equal(formatAge('2026-10-12T12:00:00Z', now), '3d');
  });
});

const pod = (status: Record<string, unknown>, extra: Partial<K8sObject> = {}): K8sObject => ({
  metadata: { name: 'p' },
  spec: { containers: [{ name: 'app' }] },
  status,
  ...extra
});

describe('podStatus', () => {
  it('reports Running when every container is ready', () => {
    assert.deepEqual(podStatus(pod({ phase: 'Running', containerStatuses: [{ name: 'app', ready: true, state: { running: {} } }] })), { text: 'Running', tone: 'ok' });
  });

  it('reports the waiting reason like kubectl', () => {
    const s = podStatus(pod({ phase: 'Running', containerStatuses: [{ name: 'app', ready: false, state: { waiting: { reason: 'CrashLoopBackOff' } } }] }));
    assert.deepEqual(s, { text: 'CrashLoopBackOff', tone: 'error' });
  });

  it('reports init container progress', () => {
    const s = podStatus(
      pod(
        { phase: 'Pending', initContainerStatuses: [{ name: 'init', state: { waiting: { reason: 'PodInitializing' } } }] },
        { spec: { initContainers: [{ name: 'init' }], containers: [{ name: 'app' }] } }
      )
    );
    assert.equal(s.text, 'Init:0/1');
  });

  it('reports Terminating for pods being deleted', () => {
    const s = podStatus({ ...pod({ phase: 'Running' }), metadata: { name: 'p', deletionTimestamp: '2026-01-01T00:00:00Z' } });
    assert.equal(s.text, 'Terminating');
  });

  it('reports Completed for finished jobs', () => {
    const s = podStatus(pod({ phase: 'Succeeded', containerStatuses: [{ name: 'app', state: { terminated: { reason: 'Completed', exitCode: 0 } } }] }));
    assert.deepEqual(s, { text: 'Completed', tone: 'muted' });
  });
});

describe('selectors', () => {
  it('turns label selectors into query syntax', () => {
    assert.equal(
      labelSelectorString({ matchLabels: { app: 'web' }, matchExpressions: [{ key: 'tier', operator: 'In', values: ['a', 'b'] }, { key: 'canary', operator: 'DoesNotExist' }] }),
      'app=web,tier in (a,b),!canary'
    );
  });
});

describe('helm', () => {
  it('decodes a Helm 3 release secret', () => {
    const release = { name: 'web', namespace: 'apps', version: 3, info: { status: 'deployed', last_deployed: '2026-10-01T00:00:00Z' }, chart: { metadata: { name: 'nginx', version: '1.2.3', appVersion: '1.25' } }, config: { replicas: 2 }, manifest: 'kind: Service' };
    const inner = zlib.gzipSync(Buffer.from(JSON.stringify(release))).toString('base64');
    const secret: K8sObject = { metadata: { name: 'sh.helm.release.v1.web.v3', namespace: 'apps', labels: { owner: 'helm', name: 'web', version: '3' } }, data: { release: Buffer.from(inner).toString('base64') } };
    const decoded = decodeRelease(secret)!;
    assert.equal(decoded.chart, 'nginx');
    assert.equal(decoded.chartVersion, '1.2.3');
    assert.equal(decoded.revision, 3);
    assert.equal(decoded.status, 'deployed');
    assert.deepEqual(decoded.values, { replicas: 2 });
  });
});
