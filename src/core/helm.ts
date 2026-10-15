/* Helm 3 releases, read from the release Secrets Helm stores in the cluster. */
import * as zlib from 'zlib';

import type { K8sObject } from './cluster';

export interface HelmRelease {
  name: string;
  namespace: string;
  revision: number;
  status: string;
  chart: string;
  chartVersion: string;
  appVersion: string;
  updated?: string;
  description?: string;
  notes?: string;
  values: unknown;
  manifest: string;
  secretName: string;
}

/** Decode `secret.data.release`: base64(base64(gzip(json))). */
export function decodeRelease(secret: K8sObject): HelmRelease | undefined {
  const data = secret.data?.release;
  if (typeof data !== 'string') {
    return undefined;
  }
  try {
    let raw = Buffer.from(Buffer.from(data, 'base64').toString('utf8'), 'base64');
    if (raw[0] === 0x1f && raw[1] === 0x8b) {
      raw = zlib.gunzipSync(raw);
    }
    const release = JSON.parse(raw.toString('utf8'));
    const meta = release.chart?.metadata ?? {};
    return {
      name: release.name,
      namespace: release.namespace ?? secret.metadata.namespace,
      revision: release.version ?? 0,
      status: release.info?.status ?? secret.metadata.labels?.status ?? 'unknown',
      chart: meta.name ?? '',
      chartVersion: meta.version ?? '',
      appVersion: meta.appVersion ?? '',
      updated: release.info?.last_deployed,
      description: release.info?.description,
      notes: release.info?.notes,
      values: release.config ?? {},
      manifest: release.manifest ?? '',
      secretName: secret.metadata.name
    };
  } catch {
    return undefined;
  }
}

/** Keep the latest revision of every release. */
export function latestReleaseSecrets(secrets: K8sObject[]): K8sObject[] {
  const latest = new Map<string, K8sObject>();
  for (const secret of secrets) {
    const labels = secret.metadata.labels ?? {};
    if (labels.owner !== 'helm' || !labels.name) {
      continue;
    }
    const key = `${secret.metadata.namespace}/${labels.name}`;
    const current = latest.get(key);
    if (!current || Number(labels.version) > Number(current.metadata.labels?.version)) {
      latest.set(key, secret);
    }
  }
  return [...latest.values()];
}

export function releaseHistory(secrets: K8sObject[], name: string, namespace: string): Array<{ revision: number; status: string; updated?: string; chart: string; description?: string }> {
  return secrets
    .filter((s) => s.metadata.namespace === namespace && s.metadata.labels?.name === name)
    .map((s) => decodeRelease(s))
    .filter((r): r is HelmRelease => !!r)
    .sort((a, b) => b.revision - a.revision)
    .map((r) => ({ revision: r.revision, status: r.status, updated: r.updated, chart: `${r.chart}-${r.chartVersion}`, description: r.description }));
}
