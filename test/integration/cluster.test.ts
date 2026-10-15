/*
 * Integration tests against a real cluster with test/integration/fixtures.yaml applied.
 *
 *   OPENLENS_TEST_CONTEXT=kind-kind npm run test:integration
 *
 * Optional: OPENLENS_TEST_DESTRUCTIVE=1 also drains (and uncordons) a worker node,
 * OPENLENS_TEST_PROMETHEUS=1 expects test/integration/prometheus.yaml to be applied.
 */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { after, before, describe, it } from 'node:test';
import { Attach, Exec } from '@kubernetes/client-node';

import { ClusterManager, ClusterSession, K8sObject } from '../../src/core/cluster';
import { buildServerTable, buildTable } from '../../src/core/columns';
import { buildDashboard } from '../../src/core/dashboard';
import { buildDetails, MetricsHistory } from '../../src/core/details';
import { decodeRelease } from '../../src/core/helm';
import { decodeReleaseRaw, runHelm, storedChartUsable, writeStoredChart } from '../../src/core/helmCli';
import { liveHealth } from '../../src/core/kubeconfigHealth';
import { dumpKubeconfig } from '../../src/core/kubeconfigModel';
import { KubeApiError } from '../../src/core/kubeRest';
import { allowedActions } from '../../src/core/permissions';
import { PortForwardManager } from '../../src/core/portForward';
import { fetchSeries, nodeQueries, podQueries, prometheusFor } from '../../src/core/prometheus';
import { getKind, KINDS } from '../../src/core/resources';
import { buildTopology } from '../../src/core/topology';
import {
  addDebugContainer,
  createNodeShellPod,
  downloadFromContainer,
  evictPods,
  planDrain,
  rollbackTo,
  rolloutHistory,
  uploadToContainer
} from '../../src/core/workloadOps';
import { cleanForEdit } from '../../src/fs/resourceFs';

const CONTEXT = process.env.OPENLENS_TEST_CONTEXT;
const NS = 'openlens-smoke';
const skip = !CONTEXT ? 'set OPENLENS_TEST_CONTEXT to run against a cluster' : false;

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const memento = (): any => {
  const map = new Map<string, unknown>();
  return { get: (k: string, d: unknown) => (map.has(k) ? map.get(k) : d), update: async (k: string, v: unknown) => void map.set(k, v), keys: () => [...map.keys()] };
};
const httpGet = (port: number): Promise<{ status: number; body: string }> =>
  new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: '/' }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      })
      .on('error', reject);
  });

async function until<T>(what: string, fn: () => Promise<T | undefined>, timeoutMs = 90_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn().catch(() => undefined);
    if (value) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${what}`);
    }
    await wait(1000);
  }
}

/** Run a command over exec (optionally with a TTY) and collect its output. */
function execCollect(session: ClusterSession, pod: string, container: string, command: string[], tty = false, input?: string, namespace = NS): Promise<{ out: string; status: string }> {
  const chunks: string[] = [];
  const stdout = Object.assign(new Writable({ write: (c, _e, cb) => (chunks.push(c.toString()), cb()) }), tty ? { columns: 120, rows: 30 } : {});
  const stdin = input !== undefined ? new PassThrough() : null;
  return new Promise((resolve, reject) => {
    new Exec(session.kc)
      .exec(namespace, pod, container, command, stdout as any, tty ? null : (stdout as any), stdin, tty, (s) => resolve({ out: chunks.join(''), status: s.status ?? '' }))
      .then(() => {
        if (stdin && input !== undefined) {
          setTimeout(() => stdin.write(input), 1000);
        }
      })
      .catch(reject);
  });
}

describe('cluster integration', { skip }, () => {
  let clusters: ClusterManager;
  let session: ClusterSession;
  let webPod: string;

  before(async () => {
    clusters = new ClusterManager(memento());
    session = clusters.session(CONTEXT!);
    await session.connect();
    webPod = await until('a ready web pod', async () => {
      const pods = await session.list(getKind('pods')!, NS, { labelSelector: 'app=web' });
      return pods.items.find((p) => (p.status?.conditions ?? []).some((c: any) => c.type === 'Ready' && c.status === 'True'))?.metadata.name;
    });
  });

  after(() => clusters?.dispose());

  it('connects and lists every built-in kind', async () => {
    assert.equal(session.status, 'connected');
    for (const kind of KINDS) {
      const result = await session.list(kind, '');
      buildTable(kind, result.items, {});
    }
  });

  it('reads pod and node metrics', async () => {
    const metrics = await until('pod metrics', async () => (await session.podMetrics(NS))?.get(`${NS}/${webPod}`));
    assert.ok(metrics.memory > 0);
    const table = buildTable(getKind('nodes')!, (await session.list(getKind('nodes')!, '')).items, { nodeMetrics: await session.nodeMetrics() });
    assert.ok(table.rows.every((r) => r.cells[1].text.endsWith('%')));
  });

  it('builds the dashboard, details and topology', async () => {
    const dash = await buildDashboard(session, NS);
    assert.equal(dash.workloads.find((w) => w.kindId === 'deployments')!.total, 1);
    const history = new MetricsHistory();
    const dep = await buildDetails(session, getKind('deployments')!, await session.get(getKind('deployments')!, 'web', NS), history);
    assert.ok(dep.sections.some((s) => s.type === 'revisions'));
    const topo = await buildTopology(session, NS);
    const edge = (from: string, to: string): boolean => topo.edges.some((e) => e.from === from && e.to.startsWith(to));
    assert.ok(edge('ingresses/web', 'services/web'));
    assert.ok(edge('services/web', 'pods/web-'));
    assert.ok(edge('deployments/web', 'replicasets/web-'));
    assert.ok(topo.edges.some((e) => e.from.startsWith('pods/web-') && e.to === 'configmaps/app-config'));
  });

  it('keeps a watch up to date', async () => {
    const { watcher, release } = session.watch(getKind('configmaps')!, NS);
    try {
      await watcher.whenReady();
      const name = `watch-${Date.now()}`;
      await session.create(getKind('configmaps')!, { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name, namespace: NS }, data: { a: '1' } });
      await until('ADDED event', async () => watcher.state.items.some((o) => o.metadata.name === name));
      await session.patch(getKind('configmaps')!, name, NS, { data: { a: '2' } });
      await until('MODIFIED event', async () => watcher.state.items.find((o) => o.metadata.name === name)?.data?.a === '2');
      await session.delete(getKind('configmaps')!, name, NS);
      await until('DELETED event', async () => !watcher.state.items.some((o) => o.metadata.name === name));
    } finally {
      release();
    }
  });

  it('streams logs', async () => {
    const chunks: string[] = [];
    const stream = await session.rest.stream(`/api/v1/namespaces/${NS}/pods/${webPod}/log`, { container: 'nginx', follow: true, tailLines: 5, timestamps: true }, (c) => chunks.push(c.toString()));
    await wait(1500);
    stream.abort();
    await stream.done;
    assert.match(chunks.join(''), /^\d{4}-\d\d-\d\dT/);
  });

  it('opens a shell with a TTY that follows the terminal size', async () => {
    const { out, status } = await execCollect(session, webPod, 'nginx', ['sh', '-c', 'clear; (bash || ash || sh)'], true, 'echo OPENLENS_$((40+2)); stty size; exit\r');
    assert.equal(status, 'Success');
    assert.match(out, /OPENLENS_42/);
    assert.match(out, /30 120/);
  });

  it('forwards ports to a pod and to a service', async () => {
    const forwards = new PortForwardManager(clusters);
    try {
      const pod = await forwards.start({ context: CONTEXT!, namespace: NS, target: 'pod', name: webPod, remotePort: 80, localPort: 0, address: '127.0.0.1' });
      assert.equal((await httpGet(pod.localPort)).status, 200);
      const svc = await forwards.start({ context: CONTEXT!, namespace: NS, target: 'service', name: 'web', remotePort: 8080, localPort: 0, address: '127.0.0.1' });
      const results = await Promise.all([1, 2, 3, 4, 5].map(() => httpGet(svc.localPort)));
      assert.ok(results.every((r) => r.status === 200 && r.body.includes('nginx')));
    } finally {
      forwards.stopAll();
    }
  });

  it('copies files into and out of a container', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openlens-cp-'));
    fs.mkdirSync(path.join(dir, 'up'));
    fs.writeFileSync(path.join(dir, 'up', 'hello.txt'), 'hello from the test\n');
    await uploadToContainer(session, NS, webPod, 'nginx', path.join(dir, 'up'), '/tmp');
    const { out } = await execCollect(session, webPod, 'nginx', ['cat', '/tmp/up/hello.txt']);
    assert.equal(out, 'hello from the test\n');
    const local = await downloadFromContainer(session, NS, webPod, 'nginx', '/tmp/up', path.join(dir, 'down'));
    assert.equal(fs.readFileSync(path.join(local, 'hello.txt'), 'utf8'), 'hello from the test\n');
    await assert.rejects(downloadFromContainer(session, NS, webPod, 'nginx', '/does/not/exist', path.join(dir, 'down2')), /No such file|not found|Cannot stat/i);
  });

  it('adds a debug container and attaches to it', async () => {
    const name = await addDebugContainer(session, NS, webPod, 'nginx', 'busybox:1.36');
    const chunks: string[] = [];
    const stdout = Object.assign(new Writable({ write: (c, _e, cb) => (chunks.push(c.toString()), cb()) }), { columns: 100, rows: 20 });
    const stdin = new PassThrough();
    const ws: any = await new Attach(session.kc).attach(NS, webPod, name, stdout, null, stdin, true);
    await wait(500);
    // The debug container shares the target's process namespace: nginx is visible.
    stdin.write('ps | grep -c "nginx: master"; exit\n');
    await until('debug container to exit', async () => {
      const pod = await session.get(getKind('pods')!, webPod, NS);
      return pod.status?.ephemeralContainerStatuses?.find((c: any) => c.name === name)?.state?.terminated;
    });
    ws.close();
    assert.match(chunks.join(''), /[12]\r?\n/);
  });

  it('opens a shell on a node', async () => {
    const node = (await session.list(getKind('nodes')!, '')).items[0].metadata.name;
    const pod = await createNodeShellPod(session, node, 'busybox:1.36', 'kube-system');
    try {
      const { out } = await execCollect(session, pod, 'shell', ['nsenter', '-t', '1', '-m', '-u', '-i', '-n', '-p', '--', 'hostname'], false, undefined, 'kube-system');
      assert.equal(out.trim(), node);
    } finally {
      await session.delete(getKind('pods')!, pod, 'kube-system');
    }
  });

  it('shows rollout history and rolls back', async () => {
    const kind = getKind('deployments')!;
    const image = (o: K8sObject): string => o.spec.template.spec.containers[0].image;
    await session.patch(kind, 'web', NS, { spec: { template: { spec: { containers: [{ name: 'nginx', image: 'nginx:1.27-alpine' }] } } } }, 'strategic');
    const history = await until('a new revision', async () => {
      const h = await rolloutHistory(session, 'deployments', await session.get(kind, 'web', NS));
      return h.length >= 2 && h.some((r) => r.current) ? h : undefined;
    });
    const previous = history.find((r) => !r.current)!;
    await rollbackTo(session, kind, await session.get(kind, 'web', NS), previous.revision);
    assert.equal(image(await session.get(kind, 'web', NS)), 'nginx:alpine');

    const sts = getKind('statefulsets')!;
    await session.patch(sts, 'store', NS, { spec: { template: { metadata: { annotations: { 'openlens/test': String(Date.now()) } } } } }, 'strategic');
    const stsHistory = await until('statefulset revisions', async () => {
      const h = await rolloutHistory(session, 'statefulsets', await session.get(sts, 'store', NS));
      return h.length >= 2 ? h : undefined;
    });
    await rollbackTo(session, sts, await session.get(sts, 'store', NS), stsHistory[stsHistory.length - 1].revision);
    webPod = await until('a ready web pod after the rollback', async () => {
      const pods = await session.list(getKind('pods')!, NS, { labelSelector: 'app=web' });
      const ready = pods.items.filter((p) => !p.metadata.deletionTimestamp && (p.status?.conditions ?? []).some((c: any) => c.type === 'Ready' && c.status === 'True'));
      return ready.length >= 2 ? ready[0].metadata.name : undefined;
    }, 180_000);
  });

  it('checks RBAC for a read-only identity', async () => {
    const token = await session.rest.json<{ status: { token: string } }>('POST', `/api/v1/namespaces/${NS}/serviceaccounts/viewer/token`, {
      body: { apiVersion: 'authentication.k8s.io/v1', kind: 'TokenRequest', spec: { expirationSeconds: 600 } }
    });
    const cluster = session.kc.getCurrentCluster()!;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openlens-rbac-'));
    const file = path.join(dir, 'config');
    fs.writeFileSync(
      file,
      dumpKubeconfig({
        apiVersion: 'v1',
        kind: 'Config',
        clusters: [{ name: 'c', cluster: { server: cluster.server, 'certificate-authority-data': cluster.caData, 'insecure-skip-tls-verify': cluster.skipTLSVerify || undefined } }],
        users: [{ name: 'viewer', user: { token: token.status.token } }],
        contexts: [{ name: 'viewer', context: { cluster: 'c', user: 'viewer', namespace: NS } }],
        'current-context': 'viewer'
      })
    );
    const previous = process.env.KUBECONFIG;
    process.env.KUBECONFIG = file;
    try {
      const viewerClusters = new ClusterManager(memento());
      const viewer = viewerClusters.session('viewer');
      const allowed = await allowedActions(viewer, getKind('pods')!, NS, ['logs', 'shell', 'delete', 'forward']);
      assert.deepEqual([...allowed], ['logs']);
      // No cluster-wide access: the list narrows to the context namespace.
      const pods = await viewer.list(getKind('pods')!, '');
      assert.match(pods.notice ?? '', /showing namespace "openlens-smoke"/);
      const health = await liveHealth(viewerClusters.kubeconfig, 'viewer');
      assert.equal(health.reachable, true);
      assert.equal(health.authMethod, 'token');
      assert.ok(health.tokenExpires);
      viewerClusters.dispose();
    } finally {
      if (previous === undefined) {
        delete process.env.KUBECONFIG;
      } else {
        process.env.KUBECONFIG = previous;
      }
    }
  });

  it('applies, dry-runs, rejects stale edits and deletes', async () => {
    const cm = getKind('configmaps')!;
    const dry = await session.apply({ apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'dry-only' }, data: { a: '1' } } as K8sObject, NS, true);
    assert.equal(dry.object.metadata.name, 'dry-only');
    await assert.rejects(session.get(cm, 'dry-only', NS), (e) => e instanceof KubeApiError && e.status === 404);

    const live = cleanForEdit(await session.get(cm, 'app-config', NS));
    await session.replace(cm, { ...live, data: { LOG_LEVEL: 'debug' } });
    await assert.rejects(session.replace(cm, { ...live, data: { LOG_LEVEL: 'stale' } }), (e) => e instanceof KubeApiError && e.status === 409);
    await session.patch(cm, 'app-config', NS, { data: { LOG_LEVEL: 'info' } });
  });

  it('decodes Helm releases and upgrades / rolls back with the CLI', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openlens-helm-'));
    try {
      await runHelm(CONTEXT!, ['create', path.join(dir, 'demo')]).catch(async () => {
        // `helm create` does not need a cluster; ignore the extra --kube-context flag errors on old versions.
      });
      if (!fs.existsSync(path.join(dir, 'demo'))) {
        return;
      }
      await runHelm(CONTEXT!, ['upgrade', '--install', 'demo', path.join(dir, 'demo'), '--namespace', NS, '--set', 'replicaCount=1', '--wait', '--timeout', '3m']);
      const secrets = () => session.list(getKind('secrets')!, NS, { labelSelector: 'owner=helm,name=demo' });
      const latest = (await secrets()).items.sort((a, b) => Number(b.metadata.labels?.version) - Number(a.metadata.labels?.version))[0];
      const release = decodeRelease(latest)!;
      assert.equal(release.chart, 'demo');
      const raw = decodeReleaseRaw(latest);
      assert.ok(storedChartUsable(raw));
      // Upgrade with the chart stored in the release and new values, then roll back.
      const chartDir = writeStoredChart(raw);
      const values = path.join(dir, 'values.yaml');
      fs.writeFileSync(values, 'replicaCount: 2\n');
      await runHelm(CONTEXT!, ['upgrade', 'demo', chartDir, '--namespace', NS, '--values', values, '--wait', '--timeout', '3m']);
      assert.equal((await session.get(getKind('deployments')!, 'demo', NS)).spec.replicas, 2);
      await runHelm(CONTEXT!, ['rollback', 'demo', '1', '--namespace', NS, '--wait', '--timeout', '3m']);
      assert.equal((await session.get(getKind('deployments')!, 'demo', NS)).spec.replicas, 1);
      assert.equal((await secrets()).items.length, 3);
    } finally {
      await runHelm(CONTEXT!, ['uninstall', 'demo', '--namespace', NS, '--wait']).catch(() => undefined);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads metric history from Prometheus', { skip: process.env.OPENLENS_TEST_PROMETHEUS ? false : 'set OPENLENS_TEST_PROMETHEUS=1' }, async () => {
    const endpoint = await until('Prometheus', async () => prometheusFor(session), 30_000);
    assert.equal(endpoint.service, 'prometheus-server');
    const series = await until('pod series', async () => fetchSeries(session, endpoint, podQueries(NS, [webPod]), 600), 180_000);
    assert.ok(series.points.some((p) => p.memory > 0), `pod series without memory: ${JSON.stringify(series.points.slice(-3))}`);
    const node = (await session.list(getKind('nodes')!, '')).items[0].metadata.name;
    const nodeSeries = await until('node series', async () => fetchSeries(session, endpoint, nodeQueries(node), 600), 120_000);
    assert.ok(nodeSeries.points.some((p) => p.cpu > 0), `node series without CPU: ${JSON.stringify(nodeSeries.points.slice(-3))}`);
  });

  it('drains and uncordons a node', { skip: process.env.OPENLENS_TEST_DESTRUCTIVE ? false : 'set OPENLENS_TEST_DESTRUCTIVE=1' }, async () => {
    const nodes = (await session.list(getKind('nodes')!, '')).items.filter((n) => !n.metadata.labels?.['node-role.kubernetes.io/control-plane']);
    const pods = await session.list(getKind('pods')!, NS, { labelSelector: 'app=web' });
    const node = nodes.find((n) => pods.items.some((p) => p.spec?.nodeName === n.metadata.name)) ?? nodes[0];
    if (!node) {
      return;
    }
    const plan = await planDrain(session, node.metadata.name);
    await session.patch(getKind('nodes')!, node.metadata.name, undefined, { spec: { unschedulable: true } });
    try {
      const result = await evictPods(session, plan.evict, { report: () => undefined, cancelled: () => false }, 180_000);
      assert.deepEqual(result.failed, []);
      const left = await planDrain(session, node.metadata.name);
      assert.equal(left.evict.filter((p) => p.metadata.namespace === NS).length, 0);
    } finally {
      await session.patch(getKind('nodes')!, node.metadata.name, undefined, { spec: { unschedulable: false } });
    }
  });

  it('builds a custom resource table from the server', async () => {
    const crds = await session.customResourceKinds();
    if (!crds.length) {
      return;
    }
    const table = buildServerTable(crds[0].id, crds[0].namespaced, await session.listTable(crds[0], ''));
    assert.equal(table.columns[0].title, 'Name');
  });
});
