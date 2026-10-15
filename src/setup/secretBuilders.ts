/* Building Secrets and ConfigMaps from registry credentials, certificates, .env files and files. */
import { createPrivateKey, X509Certificate } from 'crypto';
import * as path from 'path';

import type { K8sObject } from '../core/cluster';

export const REGISTRIES: Array<{ label: string; server: string }> = [
  { label: 'Docker Hub', server: 'https://index.docker.io/v1/' },
  { label: 'GitHub Container Registry', server: 'ghcr.io' },
  { label: 'GitLab Container Registry', server: 'registry.gitlab.com' },
  { label: 'Yandex Container Registry', server: 'cr.yandex' },
  { label: 'Google Artifact Registry (europe)', server: 'europe-docker.pkg.dev' },
  { label: 'Quay.io', server: 'quay.io' }
];

export function dockerConfigJson(server: string, username: string, password: string, email?: string): string {
  const auth = Buffer.from(`${username}:${password}`).toString('base64');
  return JSON.stringify({ auths: { [server]: { username, password, ...(email ? { email } : {}), auth } } });
}

export function registrySecret(name: string, namespace: string, server: string, username: string, password: string, email?: string): K8sObject {
  return {
    apiVersion: 'v1',
    kind: 'Secret',
    type: 'kubernetes.io/dockerconfigjson',
    metadata: { name, namespace },
    data: { '.dockerconfigjson': Buffer.from(dockerConfigJson(server, username, password, email)).toString('base64') }
  };
}

export interface TlsCheck {
  ok: boolean;
  error?: string;
  subject?: string;
  dnsNames?: string;
  validTo?: string;
}

/** Check that the certificate parses, has not expired and matches the key. */
export function checkTlsPair(certPem: string, keyPem: string): TlsCheck {
  try {
    const firstCert = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/.exec(certPem)?.[0];
    if (!firstCert) {
      return { ok: false, error: 'The certificate file has no PEM certificate.' };
    }
    const cert = new X509Certificate(firstCert);
    const key = createPrivateKey(keyPem);
    if (!cert.checkPrivateKey(key)) {
      return { ok: false, error: 'The private key does not belong to the certificate.' };
    }
    const expired = Date.parse(cert.validTo) < Date.now();
    return {
      ok: !expired,
      error: expired ? `The certificate expired on ${cert.validTo}.` : undefined,
      subject: cert.subject.replace(/\n/g, ', '),
      dnsNames: cert.subjectAltName ?? undefined,
      validTo: new Date(cert.validTo).toISOString().slice(0, 10)
    };
  } catch (err) {
    return { ok: false, error: `Could not read the certificate or key: ${(err as Error).message}` };
  }
}

export function tlsSecret(name: string, namespace: string, certPem: string, keyPem: string): K8sObject {
  return {
    apiVersion: 'v1',
    kind: 'Secret',
    type: 'kubernetes.io/tls',
    metadata: { name, namespace },
    data: { 'tls.crt': Buffer.from(certPem).toString('base64'), 'tls.key': Buffer.from(keyPem).toString('base64') }
  };
}

/** Parse a .env file: KEY=value, `export`, quotes, escapes in double quotes, comments. */
export function parseDotEnv(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/.exec(line);
    if (!match) {
      continue;
    }
    const [, key, raw] = match;
    let value = raw;
    const quote = value[0];
    if (quote === '"' || quote === "'") {
      // A quoted value may span several lines.
      let body = value.slice(1);
      while (!new RegExp(`(^|[^\\\\])${quote}\\s*(#.*)?$`).test(body) && i + 1 < lines.length) {
        i += 1;
        body += `\n${lines[i]}`;
      }
      value = body.replace(new RegExp(`${quote}\\s*(#.*)?$`), '');
      if (quote === '"') {
        value = value.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
      }
    } else {
      value = value.replace(/\s+#.*$/, '').trim();
    }
    result[key] = value;
  }
  return result;
}

export function keyFromFileName(file: string): string {
  return path.basename(file).replace(/[^-._a-zA-Z0-9]/g, '_');
}

/** Secret or ConfigMap from string values; binary values go to data / binaryData. */
export function dataObject(kind: 'Secret' | 'ConfigMap', name: string, namespace: string, entries: Record<string, Buffer | string>): K8sObject {
  const obj: K8sObject = { apiVersion: 'v1', kind, metadata: { name, namespace } };
  const isText = (b: Buffer): boolean => !b.includes(0) && Buffer.from(b.toString('utf8'), 'utf8').equals(b);
  if (kind === 'Secret') {
    obj.type = 'Opaque';
    obj.data = Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, Buffer.from(v).toString('base64')]));
  } else {
    const data: Record<string, string> = {};
    const binaryData: Record<string, string> = {};
    for (const [k, v] of Object.entries(entries)) {
      const buffer = Buffer.from(v);
      if (isText(buffer)) {
        data[k] = buffer.toString('utf8');
      } else {
        binaryData[k] = buffer.toString('base64');
      }
    }
    obj.data = data;
    if (Object.keys(binaryData).length) {
      obj.binaryData = binaryData;
    }
  }
  return obj;
}
