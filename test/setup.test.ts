import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import * as yaml from 'js-yaml';

import { dumpKubeconfig, parseKubeconfig } from '../src/core/kubeconfigModel';
import { ADDONS, ClusterEnv, getAddon, valuesYaml } from '../src/setup/addons';
import { credentialArgs, parseClusters, suggestedContext } from '../src/setup/cloud';
import { composeToManifests, parsePorts } from '../src/setup/compose';
import { generateDeployment, parseEnvLines, validateDeployForm, DeployForm } from '../src/setup/deployGen';
import { findDeprecated } from '../src/setup/doctor';
import { agentScript, hostOf, interactiveRemote, rewriteK3sKubeconfig, serverScript } from '../src/setup/k3s';
import { contextFor, k3dCreateArgs, kindConfig, minikubeStartArgs, parseK3dClusters, parseKindClusters, parseMinikubeProfiles, validateClusterName } from '../src/setup/localClusters';
import { serviceAccountKubeconfig, teamManifests } from '../src/setup/onboarding';
import { checkTlsPair, dataObject, dockerConfigJson, parseDotEnv } from '../src/setup/secretBuilders';
import { buildManifestSchema, looksLikeManifest } from '../src/yaml/schemas';

describe('local clusters', () => {
  it('writes a kind config with workers, version and ingress ports', () => {
    const config = yaml.load(kindConfig({ engine: 'kind', name: 'dev', workers: 2, version: '1.31.0', ingressPorts: true })) as any;
    assert.equal(config.nodes.length, 3);
    assert.equal(config.nodes[0].role, 'control-plane');
    assert.equal(config.nodes[0].image, 'kindest/node:v1.31.0');
    assert.deepEqual(config.nodes[0].extraPortMappings.map((p: any) => p.hostPort), [80, 443]);
    assert.match(config.nodes[0].kubeadmConfigPatches[0], /ingress-ready=true/);
    assert.equal(config.nodes[2].role, 'worker');
    const plain = yaml.load(kindConfig({ engine: 'kind', name: 'x', workers: 0, version: '', ingressPorts: false })) as any;
    assert.deepEqual(plain.nodes, [{ role: 'control-plane' }]);
  });

  it('builds k3d and minikube arguments', () => {
    const k3d = k3dCreateArgs({ engine: 'k3d', name: 'dev', workers: 1, version: '1.30.2', ingressPorts: true });
    assert.deepEqual(k3d.slice(0, 5), ['cluster', 'create', 'dev', '--agents', '1']);
    assert.ok(k3d.includes('rancher/k3s:v1.30.2-k3s1'));
    assert.ok(k3d.includes('80:80@loadbalancer'));
    assert.ok(k3d.includes('--kubeconfig-update-default=false'));
    const mk = minikubeStartArgs({ engine: 'minikube', name: 'dev', workers: 2, version: 'v1.31.0', ingressPorts: false });
    assert.deepEqual(mk, ['start', '--profile', 'dev', '--nodes', '3', '--kubernetes-version', 'v1.31.0']);
  });

  it('parses cluster lists and names contexts', () => {
    assert.deepEqual(parseKindClusters('dev\nci\n').map((c) => c.context), ['kind-dev', 'kind-ci']);
    assert.deepEqual(parseKindClusters('No kind clusters found.\n'), []);
    assert.equal(parseK3dClusters('[{"name":"a","serversRunning":1}]')[0].status, 'running');
    assert.equal(parseMinikubeProfiles('{"invalid":[],"valid":[{"Name":"minikube","Status":"Running"}]}')[0].context, 'minikube');
    assert.equal(contextFor('k3d', 'x'), 'k3d-x');
    assert.ok(validateClusterName('Dev_1'));
    assert.equal(validateClusterName('dev-1'), undefined);
  });
});

describe('k3s over ssh', () => {
  const options = { target: 'ubuntu@203.0.113.10', address: '203.0.113.10', channel: 'stable', disableTraefik: true, clusterName: 'edge' };

  it('generates install scripts', () => {
    const script = serverScript(options);
    assert.match(script, /INSTALL_K3S_CHANNEL='stable'/);
    assert.match(script, /--tls-san '203\.0\.113\.10'/);
    assert.match(script, /--disable traefik/);
    assert.match(script, /--write-kubeconfig-mode 600/);
    assert.match(serverScript({ ...options, channel: 'v1.31.4+k3s1' }), /INSTALL_K3S_VERSION='v1\.31\.4\+k3s1'/);
    const agent = agentScript('https://203.0.113.10:6443', "tok'en", 'stable');
    assert.match(agent, /K3S_URL='https:\/\/203\.0\.113\.10:6443'/);
    assert.match(agent, /K3S_TOKEN='tok'\\''en'/);
    assert.equal(hostOf('root@host.example'), 'host.example');
  });

  it('runs scripts with single quotes through sh -c', () => {
    const remote = interactiveRemote("echo 'hi'");
    const out = execFileSync('/bin/sh', ['-c', remote.replace('read -r _;', '')]).toString();
    assert.match(out, /^hi\n/);
  });

  it('rewrites the k3s kubeconfig for remote use', () => {
    const k3s = dumpKubeconfig({
      apiVersion: 'v1',
      kind: 'Config',
      clusters: [{ name: 'default', cluster: { server: 'https://127.0.0.1:6443', 'certificate-authority-data': 'CA' } }],
      users: [{ name: 'default', user: { 'client-certificate-data': 'C', 'client-key-data': 'K' } }],
      contexts: [{ name: 'default', context: { cluster: 'default', user: 'default' } }],
      'current-context': 'default'
    });
    const result = parseKubeconfig(rewriteK3sKubeconfig(k3s, '203.0.113.10', 'edge'));
    assert.equal(result.clusters[0].cluster.server, 'https://203.0.113.10:6443');
    assert.equal(result.contexts[0].name, 'edge');
    assert.equal(result.contexts[0].context.user, 'edge-admin');
    assert.equal(result.users[0].name, 'edge-admin');
  });
});

describe('managed clusters', () => {
  it('parses provider listings', () => {
    const yc = parseClusters('yc', JSON.stringify([{ id: 'cat123', name: 'prod', status: 'RUNNING', master: { regional_master: { region_id: 'ru-central1' }, endpoints: { external_v4_endpoint: 'https://1.2.3.4' } } }]));
    assert.deepEqual(yc[0], { provider: 'yc', id: 'cat123', name: 'prod', status: 'RUNNING', location: 'ru-central1', scope: 'external' });
    assert.equal(parseClusters('aws', '{"clusters":["api","jobs"]}', 'eu-central-1')[1].scope, 'eu-central-1');
    assert.equal(parseClusters('gcloud', '[{"name":"g","location":"europe-west1","status":"RUNNING"}]')[0].scope, 'europe-west1');
    assert.equal(parseClusters('az', '[{"name":"a","resourceGroup":"rg","location":"westeurope","powerState":{"code":"Running"}}]')[0].scope, 'rg');
  });

  it('fetches credentials into a given file', () => {
    assert.deepEqual(credentialArgs({ provider: 'yc', id: 'cat123', name: 'prod' }, '/tmp/k', { internal: true }).args, [
      'managed-kubernetes', 'cluster', 'get-credentials', '--id', 'cat123', '--internal', '--kubeconfig', '/tmp/k', '--force'
    ]);
    assert.deepEqual(credentialArgs({ provider: 'gcloud', id: 'g', name: 'g', scope: 'europe-west1' }, '/tmp/k').env, { KUBECONFIG: '/tmp/k' });
    assert.ok(credentialArgs({ provider: 'az', id: 'x', name: 'a', scope: 'rg' }, '/tmp/k').args.includes('--file'));
    assert.equal(suggestedContext({ provider: 'aws', id: 'api', name: 'api' }), 'eks-api');
  });
});

describe('add-ons', () => {
  const kind: ClusterEnv = { local: 'kind', ingressReadyNode: true };
  const cloud: ClusterEnv = { local: undefined, ingressClass: 'nginx', ingressReadyNode: false };

  it('tunes values to the cluster', () => {
    const nginx = getAddon('ingress-nginx')!;
    const step = nginx.steps[0] as any;
    const onKind = yaml.load(valuesYaml(step, { defaultClass: true }, kind)) as any;
    assert.equal(onKind.controller.hostPort.enabled, true);
    assert.deepEqual(onKind.controller.nodeSelector, { 'ingress-ready': 'true' });
    const onCloud = yaml.load(valuesYaml(step, { defaultClass: false }, cloud)) as any;
    assert.equal(onCloud.controller.hostPort, undefined);
    const metrics = yaml.load(valuesYaml(getAddon('metrics-server')!.steps[0] as any, { insecureTls: true }, kind)) as any;
    assert.deepEqual(metrics.args, ['--kubelet-insecure-tls']);
    assert.equal(getAddon('metrics-server')!.options![0].default(kind), true);
    assert.equal(getAddon('metrics-server')!.options![0].default(cloud), false);
  });

  it('creates ClusterIssuers for cert-manager when an e-mail is given', () => {
    const cm = getAddon('cert-manager')!;
    assert.deepEqual(cm.extraObjects!({ email: '' }, cloud), []);
    const issuers = cm.extraObjects!({ email: 'ops@example.com' }, cloud);
    assert.deepEqual(issuers.map((i) => i.metadata.name), ['letsencrypt-staging', 'letsencrypt-prod']);
    assert.equal(issuers[1].spec.acme.solvers[0].http01.ingress.ingressClassName, 'nginx');
  });

  it('has unique ids and documentation', () => {
    assert.equal(new Set(ADDONS.map((a) => a.id)).size, ADDONS.length);
    assert.ok(ADDONS.every((a) => a.docs.startsWith('https://') && a.steps.length));
  });
});

describe('doctor', () => {
  it('finds removed API versions', () => {
    const found = findDeprecated(
      [
        { apiVersion: 'networking.k8s.io/v1beta1', kind: 'Ingress', source: 'a' },
        { apiVersion: 'networking.k8s.io/v1', kind: 'Ingress', source: 'b' },
        { apiVersion: 'flowcontrol.apiserver.k8s.io/v1beta3', kind: 'FlowSchema', source: 'c' }
      ],
      30
    );
    assert.deepEqual(found.map((f) => f.source), ['a', 'c']);
    assert.deepEqual(findDeprecated([{ apiVersion: 'flowcontrol.apiserver.k8s.io/v1beta3', kind: 'FlowSchema', source: 'c' }], 28), []);
  });
});

describe('onboarding', () => {
  it('builds a namespace with quota, defaults, isolation and a token secret', () => {
    const objects = teamManifests({ namespace: 'team-a', serviceAccount: 'deployer', role: 'edit', quota: { cpu: '2', memory: '4Gi', pods: 20 }, defaults: false, isolate: true, permanentToken: true });
    assert.deepEqual(objects.map((o) => o.kind), ['Namespace', 'ServiceAccount', 'RoleBinding', 'ResourceQuota', 'LimitRange', 'NetworkPolicy', 'Secret']);
    const quota = objects.find((o) => o.kind === 'ResourceQuota')!;
    assert.equal(quota.spec.hard['limits.memory'], '8Gi');
    assert.equal(objects.find((o) => o.kind === 'RoleBinding')!.roleRef.name, 'edit');
    const minimal = teamManifests({ namespace: 'b', serviceAccount: 's', role: 'view', defaults: false, isolate: false, permanentToken: false });
    assert.deepEqual(minimal.map((o) => o.kind), ['Namespace', 'ServiceAccount', 'RoleBinding']);
  });

  it('builds a token kubeconfig', () => {
    const config = serviceAccountKubeconfig({ contextName: 'prod-team-a', server: 'https://k8s', caData: 'CA', token: 'tok', namespace: 'team-a', serviceAccount: 'deployer' });
    assert.equal(config.users[0].user.token, 'tok');
    assert.equal(config.contexts[0].context.namespace, 'team-a');
    assert.equal(config.clusters[0].cluster['certificate-authority-data'], 'CA');
  });
});

describe('secrets', () => {
  it('parses .env files', () => {
    const env = parseDotEnv(['# comment', 'export A=1', 'B = two words # trailing', 'C="quoted \\"x\\"\\nline"', "D='single # not comment'", 'E="multi', 'line"', 'BAD LINE', 'F='].join('\n'));
    assert.deepEqual(env, { A: '1', B: 'two words', C: 'quoted "x"\nline', D: 'single # not comment', E: 'multi\nline', F: '' });
  });

  it('builds docker config json', () => {
    const json = JSON.parse(dockerConfigJson('ghcr.io', 'me', 'pat'));
    assert.equal(json.auths['ghcr.io'].auth, Buffer.from('me:pat').toString('base64'));
  });

  it('keeps binary files in binaryData of ConfigMaps', () => {
    const cm = dataObject('ConfigMap', 'c', 'ns', { 'a.txt': 'hello', 'b.bin': Buffer.from([0, 1, 2]) });
    assert.equal(cm.data['a.txt'], 'hello');
    assert.equal(cm.binaryData['b.bin'], 'AAEC');
    const secret = dataObject('Secret', 's', 'ns', { k: 'v' });
    assert.equal(secret.data.k, 'dg==');
  });

  it('checks TLS certificate and key pairs', { skip: (() => { try { execFileSync('openssl', ['version']); return false; } catch { return 'openssl not available'; } })() }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openlens-tls-'));
    const gen = (name: string): void => {
      execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, `${name}.key`), '-out', path.join(dir, `${name}.crt`), '-days', '30', '-subj', '/CN=app.example.com', '-addext', 'subjectAltName=DNS:app.example.com'], { stdio: 'ignore' });
    };
    gen('a');
    gen('b');
    const read = (f: string): string => fs.readFileSync(path.join(dir, f), 'utf8');
    const good = checkTlsPair(read('a.crt'), read('a.key'));
    assert.equal(good.ok, true);
    assert.match(good.dnsNames ?? '', /app\.example\.com/);
    const mismatch = checkTlsPair(read('a.crt'), read('b.key'));
    assert.equal(mismatch.ok, false);
    assert.match(mismatch.error ?? '', /does not belong/);
  });
});

describe('deploy form', () => {
  const form: DeployForm = {
    name: 'shop',
    namespace: 'web',
    image: 'ghcr.io/acme/shop:1.0',
    port: 8080,
    replicas: 2,
    env: 'A=1\n# c\nB=two=2\n',
    imagePullSecret: 'regcred',
    resources: 'small',
    healthPath: '/healthz',
    expose: 'ClusterIP',
    host: 'shop.example.com',
    path: '/',
    ingressClass: 'nginx',
    tlsIssuer: 'letsencrypt-prod',
    hpa: true,
    hpaMin: 2,
    hpaMax: 6,
    hpaCpu: 60
  };

  it('generates the objects', () => {
    const objects = generateDeployment(form);
    assert.deepEqual(objects.map((o) => o.kind), ['Deployment', 'Service', 'Ingress', 'HorizontalPodAutoscaler']);
    const dep = objects[0];
    assert.equal(dep.spec.replicas, undefined, 'the HPA owns the replica count');
    const container = dep.spec.template.spec.containers[0];
    assert.deepEqual(container.env, [{ name: 'A', value: '1' }, { name: 'B', value: 'two=2' }]);
    assert.equal(container.readinessProbe.httpGet.path, '/healthz');
    assert.deepEqual(dep.spec.template.spec.imagePullSecrets, [{ name: 'regcred' }]);
    const ingress = objects[2];
    assert.equal(ingress.metadata.annotations['cert-manager.io/cluster-issuer'], 'letsencrypt-prod');
    assert.deepEqual(ingress.spec.tls, [{ hosts: ['shop.example.com'], secretName: 'shop-tls' }]);
    assert.equal(objects[3].spec.metrics[0].resource.target.averageUtilization, 60);
    assert.deepEqual(parseEnvLines('X=1\n1BAD=2'), [{ name: 'X', value: '1' }]);
  });

  it('validates the form', () => {
    assert.deepEqual(validateDeployForm(form), []);
    assert.ok(validateDeployForm({ ...form, name: 'Bad Name' }).length);
    assert.ok(validateDeployForm({ ...form, resources: 'none' }).some((e) => e.includes('CPU requests')));
    assert.ok(validateDeployForm({ ...form, expose: 'none' }).some((e) => e.includes('ingress host')));
  });
});

describe('docker-compose', () => {
  it('converts services, ports, env, volumes and health checks', () => {
    const compose = `
services:
  web:
    image: nginx:1.27
    ports: ["8080:80", "443"]
    environment:
      MODE: prod
    depends_on: [db]
    deploy:
      replicas: 2
      resources:
        limits: { cpus: "0.5", memory: 256M }
  db:
    image: postgres:16
    environment: ["POSTGRES_PASSWORD=secret"]
    volumes: ["pgdata:/var/lib/postgresql/data", "./init.sql:/docker-entrypoint-initdb.d/init.sql"]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
  worker:
    build: .
    command: python worker.py
volumes:
  pgdata: {}
`;
    const { objects, warnings } = composeToManifests(compose, 'shop');
    const kinds = objects.map((o) => `${o.kind}/${o.metadata.name}`);
    assert.deepEqual(kinds, ['Deployment/web', 'Service/web', 'PersistentVolumeClaim/pgdata', 'Deployment/db', 'Deployment/worker']);
    const web = objects[0].spec.template.spec.containers[0];
    assert.deepEqual(web.ports.map((p: any) => p.containerPort), [80, 443]);
    assert.deepEqual(web.resources.limits, { cpu: '0.5', memory: '256Mi' });
    assert.equal(objects[0].spec.replicas, 2);
    assert.deepEqual(objects[1].spec.ports.map((p: any) => [p.port, p.targetPort]), [[8080, 80], [443, 443]]);
    const db = objects[3];
    assert.equal(db.spec.strategy.type, 'Recreate');
    assert.deepEqual(db.spec.template.spec.containers[0].livenessProbe.exec.command, ['sh', '-c', 'pg_isready -U postgres']);
    assert.equal(objects[4].spec.template.spec.containers[0].image, 'worker:latest');
    assert.deepEqual(objects[4].spec.template.spec.containers[0].command, ['sh', '-c', 'python worker.py']);
    assert.ok(warnings.some((w) => w.includes('bind mount')));
    assert.ok(warnings.some((w) => w.includes('depends_on')));
    assert.ok(warnings.some((w) => w.includes('no "image"')));
    assert.throws(() => composeToManifests('foo: 1', 'x'), /no "services"/);
    assert.deepEqual(parsePorts(['127.0.0.1:53:53/udp']), [{ target: 53, published: 53, protocol: 'UDP' }]);
  });
});

describe('manifest schemas', () => {
  const openapi = {
    definitions: {
      'io.k8s.api.apps.v1.Deployment': {
        type: 'object',
        'x-kubernetes-group-version-kind': [{ group: 'apps', version: 'v1', kind: 'Deployment' }],
        properties: { apiVersion: { type: 'string' }, kind: { type: 'string' }, metadata: { $ref: '#/definitions/meta' }, spec: { $ref: '#/definitions/spec' } }
      },
      'io.k8s.api.apps.v1.DeploymentList': {
        type: 'object',
        'x-kubernetes-group-version-kind': [{ group: 'apps', version: 'v1', kind: 'DeploymentList' }],
        properties: { metadata: { type: 'object' } }
      },
      meta: { type: 'object', properties: { name: { type: 'string' }, labels: { type: 'object', additionalProperties: { type: 'string' } } } },
      spec: { type: 'object', properties: { replicas: { type: 'integer' }, port: { $ref: '#/definitions/io.k8s.apimachinery.pkg.util.intstr.IntOrString' }, cpu: { $ref: '#/definitions/io.k8s.apimachinery.pkg.api.resource.Quantity' } } },
      'io.k8s.apimachinery.pkg.util.intstr.IntOrString': { type: 'string', format: 'int-or-string' },
      'io.k8s.apimachinery.pkg.api.resource.Quantity': { type: 'string' }
    }
  };

  it('builds one schema branch per kind', () => {
    const schema = buildManifestSchema(openapi);
    assert.deepEqual(schema.oneOf, [{ $ref: '#/definitions/io.k8s.api.apps.v1.Deployment' }]);
    const dep = schema.definitions['io.k8s.api.apps.v1.Deployment'];
    assert.deepEqual(dep.properties.apiVersion.enum, ['apps/v1']);
    assert.deepEqual(dep.properties.kind.enum, ['Deployment']);
    assert.equal(schema.definitions.spec.additionalProperties, false);
    assert.deepEqual(schema.definitions.meta.properties.labels.additionalProperties, { type: 'string' });
    assert.deepEqual(schema.definitions['io.k8s.apimachinery.pkg.util.intstr.IntOrString'].anyOf, [{ type: 'integer' }, { type: 'string' }]);
    assert.deepEqual(schema.definitions['io.k8s.apimachinery.pkg.api.resource.Quantity'].anyOf, [{ type: 'string' }, { type: 'number' }]);
  });

  it('recognises manifests', () => {
    assert.equal(looksLikeManifest('apiVersion: v1\nkind: Pod\nmetadata: {name: x}'), true);
    assert.equal(looksLikeManifest('apiVersion: v1\nkind: Config\nclusters: []'), false);
    assert.equal(looksLikeManifest('apiVersion: v1\nkind: Pod\nmetadata:\n  name: {{ .Release.Name }}'), false);
    assert.equal(looksLikeManifest('name: values'), false);
  });
});
