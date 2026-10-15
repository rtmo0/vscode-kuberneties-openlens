/*
 * Integration tests of the setup features against a real cluster.
 *
 *   OPENLENS_TEST_CONTEXT=kind-kind npm run test:integration
 *
 * Optional: OPENLENS_TEST_ADDONS=1 installs and removes cert-manager and ingress-nginx,
 * OPENLENS_KIND_BIN=/path/to/kind creates and deletes a throwaway kind cluster.
 */
import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';
import Ajv from 'ajv';

import { ClusterManager, ClusterSession, K8sObject } from '../../src/core/cluster';
import { KubeApiError } from '../../src/core/kubeRest';
import { dumpKubeconfig, parseKubeconfig } from '../../src/core/kubeconfigModel';
import { getKind } from '../../src/core/resources';
import { detectEnv, getAddon, defaultOptions } from '../../src/setup/addons';
import { generateDeployment } from '../../src/setup/deployGen';
import { dnsTest, runDoctor } from '../../src/setup/doctor';
import { installAddon, uninstallAddon } from '../../src/setup/helmInstall';
import { kindConfig } from '../../src/setup/localClusters';
import { serviceAccountKubeconfig, teamManifests, tokenSecretName } from '../../src/setup/onboarding';
import { checkTlsPair, dataObject, parseDotEnv, registrySecret, tlsSecret } from '../../src/setup/secretBuilders';
import { runTool } from '../../src/setup/tools';
import { buildManifestSchema } from '../../src/yaml/schemas';

const CONTEXT = process.env.OPENLENS_TEST_CONTEXT;
const skip = !CONTEXT ? 'set OPENLENS_TEST_CONTEXT to run against a cluster' : false;
const NS = 'openlens-setup-test';

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const memento = (): any => {
  const map = new Map<string, unknown>();
  return { get: (k: string, d: unknown) => (map.has(k) ? map.get(k) : d), update: async (k: string, v: unknown) => void map.set(k, v), keys: () => [...map.keys()] };
};

async function until<T>(what: string, fn: () => Promise<T | undefined | false>, timeoutMs = 180_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn().catch(() => undefined);
    if (value) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${what}`);
    }
    await wait(1500);
  }
}

function withKubeconfig<T>(file: string, fn: () => Promise<T>): Promise<T> {
  const previous = process.env.KUBECONFIG;
  process.env.KUBECONFIG = file;
  return fn().finally(() => {
    if (previous === undefined) {
      delete process.env.KUBECONFIG;
    } else {
      process.env.KUBECONFIG = previous;
    }
  });
}

describe('setup features', { skip }, () => {
  let clusters: ClusterManager;
  let session: ClusterSession;

  before(async () => {
    clusters = new ClusterManager(memento());
    session = clusters.session(CONTEXT!);
    await session.connect();
    await session.apply({ apiVersion: 'v1', kind: 'Namespace', metadata: { name: NS } } as K8sObject);
  });

  after(async () => {
    await session.delete(getKind('namespaces')!, NS).catch(() => undefined);
    await session.delete(getKind('namespaces')!, 'openlens-team-test').catch(() => undefined);
    clusters?.dispose();
  });

  it('runs the cluster doctor', async () => {
    // Earlier tests (drain) may have just rescheduled metrics-server or CoreDNS.
    const checks = await until('a healthy doctor report', async () => {
      const result = await runDoctor(session);
      return result.filter((c) => ['nodes', 'metrics', 'dns'].includes(c.id)).every((c) => c.status === 'ok') ? result : undefined;
    });
    const byId = new Map(checks.map((c) => [c.id, c]));
    for (const id of ['api', 'nodes', 'metrics', 'dns', 'storage', 'ingress', 'pods', 'deprecated']) {
      assert.ok(byId.has(id), `missing check ${id}`);
    }
    assert.equal(byId.get('nodes')!.status, 'ok');
    assert.equal(byId.get('metrics')!.status, 'ok');
    assert.equal(byId.get('dns')!.status, 'ok');
  });

  it('resolves names from inside the cluster', async () => {
    const result = await dnsTest(session, NS);
    assert.equal(result.ok, true, result.output);
    assert.match(result.output, /kubernetes\.default\.svc\.cluster\.local/);
  });

  it('onboards a team with a working, limited kubeconfig', async () => {
    const ns = 'openlens-team-test';
    const objects = teamManifests({ namespace: ns, serviceAccount: 'deployer', role: 'edit', quota: { cpu: '2', memory: '4Gi', pods: 10 }, defaults: true, isolate: true, permanentToken: true });
    for (const obj of objects) {
      await session.apply(obj, obj.metadata.namespace);
    }
    const token = await until('the token secret', async () => {
      const secret = await session.get(getKind('secrets')!, tokenSecretName('deployer'), ns);
      return secret.data?.token ? Buffer.from(secret.data.token, 'base64').toString() : undefined;
    });
    const cluster = session.kc.getCurrentCluster()!;
    const config = serviceAccountKubeconfig({ contextName: 'team', server: cluster.server, caData: cluster.caData, insecure: cluster.skipTLSVerify, token, namespace: ns, serviceAccount: 'deployer' });
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'openlens-team-')), 'config');
    fs.writeFileSync(file, dumpKubeconfig(config));
    await withKubeconfig(file, async () => {
      const team = new ClusterManager(memento()).session('team');
      // edit in its namespace…
      await team.create(getKind('configmaps')!, { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'hello', namespace: ns }, data: { a: '1' } } as K8sObject);
      // …nothing elsewhere.
      await assert.rejects(team.rest.get('/api/v1/namespaces/kube-system/pods'), (e) => e instanceof KubeApiError && e.status === 403);
      // The LimitRange fills in requests, so the quota admits pods without them.
      await team.create(getKind('pods')!, { apiVersion: 'v1', kind: 'Pod', metadata: { name: 'p', namespace: ns }, spec: { containers: [{ name: 'c', image: 'busybox:1.36', command: ['sleep', '5'] }] } } as K8sObject);
      const pod = await team.get(getKind('pods')!, 'p', ns);
      assert.equal(pod.spec.containers[0].resources.requests.cpu, '100m');
    });
  });

  it('creates registry, TLS and .env secrets', async () => {
    await session.apply(registrySecret('regcred', NS, 'ghcr.io', 'me', 'token'), NS);
    const reg = await session.get(getKind('secrets')!, 'regcred', NS);
    assert.equal(reg.type, 'kubernetes.io/dockerconfigjson');

    const env = parseDotEnv('DB_HOST=db\nDB_PASSWORD="p@ss word"\n');
    await session.apply(dataObject('Secret', 'app-env', NS, env), NS);
    const secret = await session.get(getKind('secrets')!, 'app-env', NS);
    assert.equal(Buffer.from(secret.data.DB_PASSWORD, 'base64').toString(), 'p@ss word');

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openlens-tls-'));
    try {
      execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'k'), '-out', path.join(dir, 'c'), '-days', '10', '-subj', '/CN=t.example'], { stdio: 'ignore' });
    } catch {
      return;
    }
    const cert = fs.readFileSync(path.join(dir, 'c'), 'utf8');
    const key = fs.readFileSync(path.join(dir, 'k'), 'utf8');
    assert.equal(checkTlsPair(cert, key).ok, true);
    await session.apply(tlsSecret('t-tls', NS, cert, key), NS);
    assert.equal((await session.get(getKind('secrets')!, 't-tls', NS)).type, 'kubernetes.io/tls');
  });

  it('deploys an image from the form', async () => {
    const objects = generateDeployment({
      name: 'hello',
      namespace: NS,
      image: 'nginx:alpine',
      port: 80,
      replicas: 1,
      env: 'GREETING=hi',
      resources: 'small',
      healthPath: '/',
      expose: 'ClusterIP',
      host: 'hello.local',
      path: '/',
      hpa: true,
      hpaMin: 1,
      hpaMax: 3,
      hpaCpu: 80
    });
    for (const obj of objects) {
      await session.apply(obj, NS);
    }
    await until('the deployment to become available', async () => (await session.get(getKind('deployments')!, 'hello', NS)).status?.availableReplicas >= 1);
    assert.equal((await session.get(getKind('hpa')!, 'hello', NS)).spec.maxReplicas, 3);
    assert.equal((await session.get(getKind('ingresses')!, 'hello', NS)).spec.rules[0].host, 'hello.local');
  });

  it('validates manifests with the schema of the cluster', async () => {
    const openapi = await session.rest.get<any>('/openapi/v2', undefined, { timeoutMs: 60_000 });
    const schema = buildManifestSchema(openapi);
    const ajv = new Ajv({ strict: false, allErrors: false, validateFormats: false });
    const validate = ajv.compile(schema);
    const deployment = {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: 'x', labels: { a: 'b' } },
      spec: {
        replicas: 2,
        selector: { matchLabels: { a: 'b' } },
        template: {
          metadata: { labels: { a: 'b' } },
          spec: { containers: [{ name: 'c', image: 'nginx', ports: [{ containerPort: 80 }], resources: { requests: { cpu: 1, memory: '64Mi' } }, readinessProbe: { httpGet: { path: '/', port: 80 } } }] }
        }
      }
    };
    assert.equal(validate(deployment), true, JSON.stringify(validate.errors?.slice(0, 3)));
    const typo = JSON.parse(JSON.stringify(deployment));
    typo.spec.template.spec.containers[0].imagePullPolicyy = 'Always';
    assert.equal(validate(typo), false);
    const wrongKind = { ...deployment, apiVersion: 'apps/v1beta1' };
    assert.equal(validate(wrongKind), false);
    assert.ok(Object.keys(schema.definitions).length > 100);
  });

  it('installs and removes add-ons', { skip: process.env.OPENLENS_TEST_ADDONS ? false : 'set OPENLENS_TEST_ADDONS=1' }, async () => {
    const env = await detectEnv(session);
    const cm = getAddon('cert-manager')!;
    await installAddon(session, cm, { email: 'ops@example.com' }, env, () => undefined);
    assert.equal((await cm.detect(session)).installed, true);
    const issuers = await session.rest.get<{ items: K8sObject[] }>('/apis/cert-manager.io/v1/clusterissuers');
    assert.deepEqual(issuers.items.map((i) => i.metadata.name).sort(), ['letsencrypt-prod', 'letsencrypt-staging']);
    await uninstallAddon(session, cm, () => undefined);
    assert.equal((await cm.detect(session)).managed, false);

    const nginx = getAddon('ingress-nginx')!;
    await installAddon(session, nginx, defaultOptions(nginx, env), env, () => undefined);
    const status = await nginx.detect(session);
    assert.equal(status.installed && status.managed, true);
    await uninstallAddon(session, nginx, () => undefined);
    await session.delete(getKind('namespaces')!, 'ingress-nginx').catch(() => undefined);
    await session.delete(getKind('namespaces')!, 'cert-manager').catch(() => undefined);
    // Helm keeps CRDs on uninstall; remove the ones this test brought in.
    const crds = await session.list(getKind('crds')!, '');
    for (const crd of crds.items.filter((c) => c.spec?.group?.endsWith('cert-manager.io'))) {
      await session.delete(getKind('crds')!, crd.metadata.name).catch(() => undefined);
    }
  });

  it('creates and deletes a kind cluster', { skip: process.env.OPENLENS_KIND_BIN ? false : 'set OPENLENS_KIND_BIN to a kind binary' }, async () => {
    const kind = process.env.OPENLENS_KIND_BIN!;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openlens-kind-'));
    const name = `openlens-test-${Date.now().toString(36)}`;
    fs.writeFileSync(path.join(dir, 'kind.yaml'), kindConfig({ engine: 'kind', name, workers: 0, version: '', ingressPorts: false }));
    try {
      await runTool(kind, ['create', 'cluster', '--name', name, '--config', path.join(dir, 'kind.yaml'), '--kubeconfig', path.join(dir, 'config'), '--wait', '120s']);
      const config = parseKubeconfig(fs.readFileSync(path.join(dir, 'config'), 'utf8'));
      assert.equal(config.contexts[0].name, `kind-${name}`);
      await withKubeconfig(path.join(dir, 'config'), async () => {
        const fresh = new ClusterManager(memento()).session(`kind-${name}`);
        await fresh.connect();
        assert.equal(fresh.status, 'connected');
        assert.equal((await detectEnv(fresh)).local, 'kind');
      });
    } finally {
      await runTool(kind, ['delete', 'cluster', '--name', name, '--kubeconfig', path.join(dir, 'config')]).catch(() => undefined);
    }
  });
});
