import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';

import { exportContext, staticHealth } from '../src/core/kubeconfigHealth';
import { RawKubeconfig } from '../src/core/kubeconfigModel';

const jwt = (exp: number): string =>
  ['e30', Buffer.from(JSON.stringify({ exp })).toString('base64url'), 'sig'].join('.');

function config(user: Record<string, unknown>, cluster: Record<string, unknown> = { server: 'https://k8s:6443' }): RawKubeconfig {
  return {
    apiVersion: 'v1',
    kind: 'Config',
    clusters: [{ name: 'c', cluster }],
    users: [{ name: 'u', user }],
    contexts: [{ name: 'ctx', context: { cluster: 'c', user: 'u' } }],
    'current-context': 'ctx'
  };
}

function selfSignedCert(days: number): string | undefined {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openlens-cert-'));
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem'), '-days', String(days), '-subj', '/CN=test'], { stdio: 'ignore' });
    return fs.readFileSync(path.join(dir, 'c.pem'), 'utf8');
  } catch {
    return undefined;
  }
}

describe('kubeconfig health', () => {
  it('reports expired and expiring tokens', () => {
    const expired = staticHealth(config({ token: jwt(Math.floor(Date.now() / 1000) - 3600) }), 'ctx');
    assert.equal(expired.authMethod, 'token');
    assert.match(expired.problems[0], /Token expired/);
    const soon = staticHealth(config({ token: jwt(Math.floor(Date.now() / 1000) + 5 * 86400) }), 'ctx');
    assert.match(soon.warnings[0], /Token expires in [45] days/);
    assert.deepEqual(staticHealth(config({ token: 'opaque-token' }), 'ctx').problems, []);
  });

  it('reads client certificate expiry', { skip: selfSignedCert(1) ? false : 'openssl not available' }, () => {
    const pem = selfSignedCert(10)!;
    const health = staticHealth(config({ 'client-certificate-data': Buffer.from(pem).toString('base64'), 'client-key-data': 'x' }), 'ctx');
    assert.equal(health.authMethod, 'client certificate');
    assert.ok(health.certExpires);
    assert.match(health.warnings[0], /Client certificate expires in (9|10) days/);
  });

  it('finds missing files and auth plugins', () => {
    const health = staticHealth(
      config({ 'client-certificate': '/nope/cert.pem', exec: { command: 'definitely-not-installed-plugin', installHint: 'brew install it' } }, { server: 'https://k8s', 'certificate-authority': '/nope/ca.crt', 'insecure-skip-tls-verify': true }),
      'ctx'
    );
    assert.ok(health.problems.some((p) => p.includes('/nope/ca.crt')));
    assert.ok(health.problems.some((p) => p.includes('/nope/cert.pem')));
    assert.ok(health.problems.some((p) => p.includes('definitely-not-installed-plugin') && p.includes('brew install it')));
    assert.ok(health.warnings.some((w) => w.includes('insecure-skip-tls-verify')));
    assert.equal(health.authMethod, 'exec: definitely-not-installed-plugin');
  });

  it('reports dangling references', () => {
    const broken = config({ token: 't' });
    broken.users = [];
    assert.match(staticHealth(broken, 'ctx').problems.join(), /User "u" is missing/);
  });

  it('exports a context with files inlined', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openlens-export-'));
    fs.writeFileSync(path.join(dir, 'ca.crt'), 'CA-PEM');
    fs.writeFileSync(path.join(dir, 'token'), 'file-token\n');
    const source = config({ tokenFile: path.join(dir, 'token') }, { server: 'https://k8s', 'certificate-authority': path.join(dir, 'ca.crt') });
    source.contexts.push({ name: 'other', context: { cluster: 'c', user: 'u' } });
    const exported = exportContext(source, 'ctx');
    assert.equal(exported.contexts.length, 1);
    assert.equal(exported['current-context'], 'ctx');
    assert.equal(Buffer.from(exported.clusters[0].cluster['certificate-authority-data'] as string, 'base64').toString(), 'CA-PEM');
    assert.equal(exported.clusters[0].cluster['certificate-authority'], undefined);
    assert.equal(exported.users[0].user.token, 'file-token');
    assert.equal(exported.users[0].user.tokenFile, undefined);
  });
});
