import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';

import { readKubeconfigFile, writeKubeconfigFile } from '../src/core/kubeconfigFiles';
import {
  analyzeImport,
  applyImport,
  dumpKubeconfig,
  emptyKubeconfig,
  ensureContexts,
  mergeFiles,
  missingReferences,
  parseKubeconfig,
  RawKubeconfig,
  relativePathReferences,
  removeContext,
  renameContext,
  resolveRelativePaths
} from '../src/core/kubeconfigModel';

/** The shape kubeadm / k3s / most installers hand out. */
function adminConfig(server: string, cert = 'CERT', extra: Record<string, unknown> = {}): RawKubeconfig {
  return parseKubeconfig(
    dumpKubeconfig({
      apiVersion: 'v1',
      kind: 'Config',
      clusters: [{ name: 'kubernetes', cluster: { server, 'certificate-authority-data': 'CA' } }],
      users: [{ name: 'kubernetes-admin', user: { 'client-certificate-data': cert, 'client-key-data': 'KEY', ...extra } }],
      contexts: [{ name: 'kubernetes-admin@kubernetes', context: { cluster: 'kubernetes', user: 'kubernetes-admin' } }],
      'current-context': 'kubernetes-admin@kubernetes'
    })
  );
}

const empty = (): RawKubeconfig => emptyKubeconfig();

describe('parseKubeconfig', () => {
  it('parses YAML', () => {
    const config = adminConfig('https://10.0.0.1:6443');
    assert.equal(config.contexts.length, 1);
    assert.equal(config.clusters[0].cluster.server, 'https://10.0.0.1:6443');
  });

  it('parses JSON', () => {
    const json = JSON.stringify({ clusters: [{ name: 'c', cluster: { server: 'https://x' } }], users: [{ name: 'u', user: {} }], contexts: [{ name: 'ctx', context: { cluster: 'c', user: 'u' } }] });
    assert.equal(parseKubeconfig(json).contexts[0].name, 'ctx');
  });

  it('decodes a base64 kubeconfig, also with comment lines around it', () => {
    const encoded = Buffer.from(dumpKubeconfig(adminConfig('https://b64:6443'))).toString('base64');
    assert.equal(parseKubeconfig(encoded).clusters[0].cluster.server, 'https://b64:6443');
    const wrapped = `# paste below\n${encoded.replace(/(.{76})/g, '$1\n')}\n`;
    assert.equal(parseKubeconfig(wrapped).clusters[0].cluster.server, 'https://b64:6443');
  });

  it('rejects text that is not a kubeconfig', () => {
    assert.throws(() => parseKubeconfig('   \n'), /empty/);
    assert.throws(() => parseKubeconfig('just some words: [unclosed'), /Not valid YAML/);
    assert.throws(() => parseKubeconfig('- a\n- b'), /mapping/);
    assert.throws(() => parseKubeconfig('clusters: {}'), /must be a list/);
    assert.throws(() => parseKubeconfig('contexts:\n- name: x\n  context: {cluster: c}'), /reference a cluster and a user/);
  });

  it('keeps fields it does not know about', () => {
    const text = dumpKubeconfig({
      ...adminConfig('https://x'),
      preferences: { colors: true },
      extensions: [{ name: 'e', extension: { a: 1 } }]
    });
    const config = parseKubeconfig(text);
    assert.deepEqual(config.preferences, { colors: true });
    assert.deepEqual(config.extensions, [{ name: 'e', extension: { a: 1 } }]);
  });
});

describe('import', () => {
  it('imports into an empty kubeconfig and sets the current context', () => {
    const report = applyImport(empty(), adminConfig('https://a:6443'), [{ source: 'kubernetes-admin@kubernetes', target: 'prod' }]);
    assert.deepEqual(report.added, ['prod']);
    assert.equal(report.config['current-context'], 'prod');
    assert.equal(report.config.contexts[0].context.cluster, 'kubernetes');
    assert.equal(report.config.apiVersion, 'v1');
    assert.equal(report.config.kind, 'Config');
  });

  it('keeps the existing current context', () => {
    const target = applyImport(empty(), adminConfig('https://a:6443'), [{ source: 'kubernetes-admin@kubernetes', target: 'first' }]).config;
    const report = applyImport(target, adminConfig('https://b:6443', 'OTHER'), [{ source: 'kubernetes-admin@kubernetes', target: 'second' }]);
    assert.equal(report.config['current-context'], 'first');
  });

  it('does not overwrite clusters and users with the same generic names', () => {
    const target = applyImport(empty(), adminConfig('https://a:6443', 'CERT-A'), [{ source: 'kubernetes-admin@kubernetes', target: 'staging' }]).config;
    const report = applyImport(target, adminConfig('https://b:6443', 'CERT-B'), [{ source: 'kubernetes-admin@kubernetes', target: 'prod' }]);
    const config = report.config;

    assert.equal(config.clusters.length, 2);
    assert.equal(config.users.length, 2);
    assert.deepEqual(report.renamedClusters, [['kubernetes', 'kubernetes-prod']]);
    assert.deepEqual(report.renamedUsers, [['kubernetes-admin', 'kubernetes-admin-prod']]);

    const staging = config.contexts.find((c) => c.name === 'staging')!;
    const prod = config.contexts.find((c) => c.name === 'prod')!;
    assert.equal(staging.context.cluster, 'kubernetes');
    assert.equal(staging.context.user, 'kubernetes-admin');
    assert.equal(prod.context.cluster, 'kubernetes-prod');
    assert.equal(prod.context.user, 'kubernetes-admin-prod');

    // The original credentials are untouched.
    assert.equal(config.clusters.find((c) => c.name === 'kubernetes')!.cluster.server, 'https://a:6443');
    assert.equal(config.users.find((u) => u.name === 'kubernetes-admin')!.user['client-certificate-data'], 'CERT-A');
    assert.equal(config.users.find((u) => u.name === 'kubernetes-admin-prod')!.user['client-certificate-data'], 'CERT-B');
  });

  it('reports a context that is already imported as identical and leaves the file alone', () => {
    const source = adminConfig('https://a:6443');
    const target = applyImport(empty(), source, [{ source: 'kubernetes-admin@kubernetes', target: 'kubernetes-admin@kubernetes' }]).config;
    assert.equal(analyzeImport(target, source)[0].status, 'identical');
    const report = applyImport(target, source, [{ source: 'kubernetes-admin@kubernetes', target: 'kubernetes-admin@kubernetes' }]);
    assert.deepEqual(report.unchanged, ['kubernetes-admin@kubernetes']);
    assert.deepEqual(report.config, target);
  });

  it('detects a name conflict with a different cluster', () => {
    const target = applyImport(empty(), adminConfig('https://a:6443'), [{ source: 'kubernetes-admin@kubernetes', target: 'kubernetes-admin@kubernetes' }]).config;
    const [candidate] = analyzeImport(target, adminConfig('https://b:6443'));
    assert.equal(candidate.status, 'conflict');
    assert.equal(candidate.server, 'https://b:6443');
    assert.throws(() => applyImport(target, adminConfig('https://b:6443'), [{ source: 'kubernetes-admin@kubernetes', target: 'kubernetes-admin@kubernetes' }]), /already exists/);
  });

  it('replaces a context in place when asked, cleaning up what it no longer uses', () => {
    const target = applyImport(empty(), adminConfig('https://a:6443', 'OLD'), [{ source: 'kubernetes-admin@kubernetes', target: 'prod' }]).config;
    const report = applyImport(target, adminConfig('https://a:6443', 'NEW'), [{ source: 'kubernetes-admin@kubernetes', target: 'prod', overwrite: true }]);
    assert.deepEqual(report.replaced, ['prod']);
    assert.equal(report.config.contexts.length, 1);
    assert.equal(report.config.users.length, 1);
    assert.equal(report.config.users[0].name, 'kubernetes-admin');
    assert.equal(report.config.users[0].user['client-certificate-data'], 'NEW');
    assert.equal(report.config.clusters.length, 1);
  });

  it('does not replace a user that another context still uses', () => {
    let target = applyImport(empty(), adminConfig('https://a:6443', 'OLD'), [{ source: 'kubernetes-admin@kubernetes', target: 'prod' }]).config;
    target = { ...target, contexts: [...target.contexts, { name: 'prod-admin', context: { cluster: 'kubernetes', user: 'kubernetes-admin', namespace: 'kube-system' } }] };
    const report = applyImport(target, adminConfig('https://a:6443', 'NEW'), [{ source: 'kubernetes-admin@kubernetes', target: 'prod', overwrite: true }]);
    const prodAdmin = report.config.contexts.find((c) => c.name === 'prod-admin')!;
    assert.equal(report.config.users.find((u) => u.name === prodAdmin.context.user)!.user['client-certificate-data'], 'OLD');
    const prod = report.config.contexts.find((c) => c.name === 'prod')!;
    assert.equal(report.config.users.find((u) => u.name === prod.context.user)!.user['client-certificate-data'], 'NEW');
  });

  it('reuses an identical cluster stored under another name', () => {
    const target: RawKubeconfig = {
      ...empty(),
      clusters: [{ name: 'my-cluster', cluster: { server: 'https://a:6443', 'certificate-authority-data': 'CA' } }],
      users: [{ name: 'me', user: { token: 't' } }],
      contexts: [{ name: 'mine', context: { cluster: 'my-cluster', user: 'me' } }]
    };
    const report = applyImport(target, adminConfig('https://a:6443'), [{ source: 'kubernetes-admin@kubernetes', target: 'admin' }]);
    assert.equal(report.config.clusters.length, 1);
    assert.equal(report.config.contexts.find((c) => c.name === 'admin')!.context.cluster, 'my-cluster');
  });

  it('keeps exec plugins, namespaces and extra fields', () => {
    const source = adminConfig('https://eks:443');
    source.users[0].user = { exec: { apiVersion: 'client.authentication.k8s.io/v1beta1', command: 'aws', args: ['eks', 'get-token'] } };
    source.contexts[0].context.namespace = 'apps';
    source.clusters[0].cluster['proxy-url'] = 'socks5://localhost:1080';
    const report = applyImport(empty(), source, [{ source: 'kubernetes-admin@kubernetes', target: 'eks' }]);
    assert.deepEqual(report.config.users[0].user.exec, source.users[0].user.exec);
    assert.equal(report.config.contexts[0].context.namespace, 'apps');
    assert.equal(report.config.clusters[0].cluster['proxy-url'], 'socks5://localhost:1080');
  });

  it('creates contexts for configs that only have clusters and users', () => {
    const config = parseKubeconfig(dumpKubeconfig({ clusters: [{ name: 'k3s', cluster: { server: 'https://k3s' } }], users: [{ name: 'admin', user: { token: 'x' } }], contexts: [] }));
    const withContexts = ensureContexts(config);
    assert.deepEqual(withContexts.contexts, [{ name: 'k3s', context: { cluster: 'k3s', user: 'admin' } }]);
  });

  it('reports dangling references', () => {
    const config = adminConfig('https://a');
    config.users = [];
    assert.match(missingReferences(config)[0], /missing user "kubernetes-admin"/);
  });
});

describe('paths', () => {
  it('resolves relative certificate paths against the kubeconfig directory', () => {
    const config = parseKubeconfig(
      dumpKubeconfig({
        clusters: [{ name: 'c', cluster: { server: 'https://x', 'certificate-authority': 'ca.crt' } }],
        users: [{ name: 'u', user: { 'client-certificate': './certs/u.crt', 'client-key': '/abs/u.key', exec: { command: './bin/auth' } } }],
        contexts: [{ name: 'ctx', context: { cluster: 'c', user: 'u' } }]
      })
    );
    assert.deepEqual(relativePathReferences(config), ['cluster c: certificate-authority: ca.crt', 'user u: client-certificate: ./certs/u.crt']);
    const resolved = resolveRelativePaths(config, '/home/me/Downloads');
    assert.equal(resolved.clusters[0].cluster['certificate-authority'], '/home/me/Downloads/ca.crt');
    assert.equal(resolved.users[0].user['client-certificate'], '/home/me/Downloads/certs/u.crt');
    assert.equal(resolved.users[0].user['client-key'], '/abs/u.key');
    assert.equal((resolved.users[0].user.exec as { command: string }).command, '/home/me/Downloads/bin/auth');
  });
});

describe('editing', () => {
  it('removes a context with the cluster and user only it used', () => {
    let config = applyImport(empty(), adminConfig('https://a', 'A'), [{ source: 'kubernetes-admin@kubernetes', target: 'a' }]).config;
    config = applyImport(config, adminConfig('https://b', 'B'), [{ source: 'kubernetes-admin@kubernetes', target: 'b' }]).config;
    config.contexts.push({ name: 'a-system', context: { cluster: 'kubernetes', user: 'kubernetes-admin', namespace: 'kube-system' } });

    const removed = removeContext(config, 'b');
    assert.deepEqual(removed.contexts.map((c) => c.name), ['a', 'a-system']);
    assert.deepEqual(removed.clusters.map((c) => c.name), ['kubernetes']);
    assert.deepEqual(removed.users.map((u) => u.name), ['kubernetes-admin']);

    const shared = removeContext(removed, 'a');
    assert.deepEqual(shared.clusters.map((c) => c.name), ['kubernetes']);
    assert.equal(shared['current-context'], '');
  });

  it('renames a context and the current context', () => {
    const config = applyImport(empty(), adminConfig('https://a'), [{ source: 'kubernetes-admin@kubernetes', target: 'a' }]).config;
    const renamed = renameContext(config, 'a', 'production');
    assert.equal(renamed.contexts[0].name, 'production');
    assert.equal(renamed['current-context'], 'production');
    assert.throws(() => renameContext({ ...renamed, contexts: [...renamed.contexts, { name: 'x', context: { cluster: 'kubernetes', user: 'kubernetes-admin' } }] }, 'x', 'production'), /already exists/);
  });

  it('merges several files with the first one winning, like kubectl', () => {
    const a = applyImport(empty(), adminConfig('https://a'), [{ source: 'kubernetes-admin@kubernetes', target: 'shared' }]).config;
    const b = applyImport(empty(), adminConfig('https://b', 'B'), [{ source: 'kubernetes-admin@kubernetes', target: 'shared' }]).config;
    b.contexts.push({ name: 'only-b', context: { cluster: 'kubernetes', user: 'kubernetes-admin' } });
    const merged = mergeFiles([
      { path: '/a', config: a },
      { path: '/b', config: b }
    ]);
    assert.deepEqual(merged.config.contexts.map((c) => c.name), ['shared', 'only-b']);
    assert.equal(merged.config.clusters[0].cluster.server, 'https://a');
    assert.equal(merged.contextOrigin.get('shared'), '/a');
    assert.equal(merged.contextOrigin.get('only-b'), '/b');
  });
});

describe('kubeconfig files', () => {
  const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'openlens-test-'));

  it('writes atomically with 0600 and keeps backups', () => {
    const dir = tmp();
    const file = path.join(dir, 'config');
    const first = applyImport(empty(), adminConfig('https://a'), [{ source: 'kubernetes-admin@kubernetes', target: 'a' }]).config;
    assert.equal(writeKubeconfigFile(file, first), undefined);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);

    const second = applyImport(first, adminConfig('https://b', 'B'), [{ source: 'kubernetes-admin@kubernetes', target: 'b' }]).config;
    const backup = writeKubeconfigFile(file, second)!;
    assert.ok(fs.existsSync(backup));
    assert.equal(readKubeconfigFile(backup).contexts.length, 1);
    assert.equal(readKubeconfigFile(file).contexts.length, 2);
    assert.deepEqual(fs.readdirSync(dir).filter((f) => f.includes('.tmp-')), []);
  });

  it('keeps a symlinked kubeconfig a symlink', () => {
    const dir = tmp();
    const real = path.join(dir, 'real-config');
    const link = path.join(dir, 'config');
    writeKubeconfigFile(real, empty(), { backup: false });
    fs.symlinkSync(real, link);
    writeKubeconfigFile(link, applyImport(empty(), adminConfig('https://a'), [{ source: 'kubernetes-admin@kubernetes', target: 'a' }]).config, { backup: false });
    assert.ok(fs.lstatSync(link).isSymbolicLink());
    assert.equal(readKubeconfigFile(real).contexts[0].name, 'a');
  });

  it('refuses to write a kubeconfig the client cannot load', () => {
    const dir = tmp();
    const file = path.join(dir, 'config');
    const broken = { ...empty(), clusters: [{ name: 'c', cluster: {} }], contexts: [] } as RawKubeconfig;
    assert.throws(() => writeKubeconfigFile(file, broken));
    assert.equal(fs.existsSync(file), false);
  });

  it('reads a missing file as empty', () => {
    assert.deepEqual(readKubeconfigFile(path.join(tmp(), 'nope')).contexts, []);
  });
});
