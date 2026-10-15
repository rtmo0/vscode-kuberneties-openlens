/* docker-compose → Kubernetes manifests (a pragmatic subset, like kompose). */
import * as yaml from 'js-yaml';

import type { K8sObject } from '../core/cluster';

export interface ComposeResult {
  objects: K8sObject[];
  warnings: string[];
}

const dnsName = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63) || 'app';

interface PortMapping {
  target: number;
  published?: number;
  protocol: 'TCP' | 'UDP';
}

export function parsePorts(ports: unknown[]): PortMapping[] {
  const result: PortMapping[] = [];
  for (const p of ports) {
    if (typeof p === 'number') {
      result.push({ target: p, protocol: 'TCP' });
    } else if (typeof p === 'string') {
      const [spec, proto] = p.split('/');
      const parts = spec.split(':');
      const target = parts[parts.length - 1];
      const published = parts.length >= 2 ? parts[parts.length - 2] : undefined;
      // Ranges ("8000-8010:8000-8010") are expanded only for the first port.
      result.push({ target: Number(target.split('-')[0]), published: published ? Number(published.split('-')[0]) : undefined, protocol: proto?.toUpperCase() === 'UDP' ? 'UDP' : 'TCP' });
    } else if (p && typeof p === 'object') {
      const o = p as { target?: number; published?: number | string; protocol?: string };
      if (o.target) {
        result.push({ target: Number(o.target), published: o.published ? Number(o.published) : undefined, protocol: o.protocol?.toUpperCase() === 'UDP' ? 'UDP' : 'TCP' });
      }
    }
  }
  return result.filter((p) => Number.isFinite(p.target) && p.target > 0);
}

function envList(environment: unknown): Array<{ name: string; value: string }> {
  if (Array.isArray(environment)) {
    return environment
      .map(String)
      .filter((e) => e.includes('='))
      .map((e) => ({ name: e.slice(0, e.indexOf('=')), value: e.slice(e.indexOf('=') + 1) }));
  }
  if (environment && typeof environment === 'object') {
    return Object.entries(environment as Record<string, unknown>).map(([name, value]) => ({ name, value: value === null || value === undefined ? '' : String(value) }));
  }
  return [];
}

function commandList(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    return value.map(String);
  }
  if (typeof value === 'string' && value.trim()) {
    return ['sh', '-c', value];
  }
  return undefined;
}

function memory(value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') {
    return undefined;
  }
  const m = /^(\d+(?:\.\d+)?)\s*([kmgKMG])?[bB]?$/.exec(String(value).trim());
  if (!m) {
    return undefined;
  }
  const unit = m[2]?.toLowerCase();
  return unit ? `${m[1]}${{ k: 'Ki', m: 'Mi', g: 'Gi' }[unit]}` : m[1];
}

export function composeToManifests(text: string, namespace: string): ComposeResult {
  const doc = yaml.load(text) as { services?: Record<string, any>; volumes?: Record<string, unknown> } | undefined;
  if (!doc || typeof doc !== 'object' || !doc.services) {
    throw new Error('This is not a compose file: it has no "services".');
  }
  const objects: K8sObject[] = [];
  const warnings: string[] = [];
  const claims = new Set<string>();

  for (const [rawName, svc] of Object.entries(doc.services)) {
    const name = dnsName(rawName);
    const labels = { 'app.kubernetes.io/name': name };
    if (!svc.image) {
      warnings.push(`${rawName}: has "build" but no "image" — build and push it, then set the image (using "${name}:latest" for now).`);
    }
    const ports = parsePorts([...(svc.ports ?? []), ...(svc.expose ?? [])]);
    const container: Record<string, unknown> = { name, image: svc.image ?? `${name}:latest` };
    if (ports.length) {
      container.ports = ports.map((p, i) => ({ name: i === 0 ? 'http' : `port-${p.target}`, containerPort: p.target, protocol: p.protocol }));
    }
    const env = envList(svc.environment);
    if (env.length) {
      container.env = env;
    }
    if (svc.env_file) {
      warnings.push(`${rawName}: env_file is not converted — create a Secret or ConfigMap from it ("New Secret From .env File") and reference it with envFrom.`);
    }
    const entrypoint = commandList(svc.entrypoint);
    const command = commandList(svc.command);
    if (entrypoint) {
      container.command = entrypoint;
    }
    if (command) {
      container[entrypoint ? 'args' : typeof svc.command === 'string' ? 'command' : 'args'] = command;
    }
    if (svc.working_dir) {
      container.workingDir = svc.working_dir;
    }
    const limits = svc.deploy?.resources?.limits;
    if (limits) {
      container.resources = { limits: { ...(limits.cpus ? { cpu: String(limits.cpus) } : {}), ...(memory(limits.memory) ? { memory: memory(limits.memory) } : {}) } };
    } else if (svc.mem_limit) {
      container.resources = { limits: { memory: memory(svc.mem_limit) } };
    }
    const test = svc.healthcheck?.test;
    if (test && !svc.healthcheck?.disable) {
      const exec = Array.isArray(test) ? (test[0] === 'CMD-SHELL' ? ['sh', '-c', test.slice(1).join(' ')] : test[0] === 'CMD' ? test.slice(1) : undefined) : ['sh', '-c', String(test)];
      if (exec) {
        container.livenessProbe = { exec: { command: exec.map(String) }, periodSeconds: 30, initialDelaySeconds: 10 };
      }
    }

    const mounts: Array<Record<string, unknown>> = [];
    const volumes: Array<Record<string, unknown>> = [];
    for (const v of svc.volumes ?? []) {
      const spec = typeof v === 'string' ? v : `${v.source ?? ''}:${v.target ?? ''}${v.read_only ? ':ro' : ''}`;
      const [source, target, mode] = spec.split(':');
      if (!target) {
        // Anonymous volume.
        volumes.push({ name: `tmp-${volumes.length}`, emptyDir: {} });
        mounts.push({ name: `tmp-${volumes.length - 1}`, mountPath: source });
        continue;
      }
      if (/^[./~]/.test(source)) {
        warnings.push(`${rawName}: bind mount "${source}" → "${target}" is not converted — use a ConfigMap for config files or a PersistentVolumeClaim for data.`);
        continue;
      }
      const claim = dnsName(source);
      volumes.push({ name: claim, persistentVolumeClaim: { claimName: claim } });
      mounts.push({ name: claim, mountPath: target, ...(mode === 'ro' ? { readOnly: true } : {}) });
      if (!claims.has(claim)) {
        claims.add(claim);
        objects.push({
          apiVersion: 'v1',
          kind: 'PersistentVolumeClaim',
          metadata: { name: claim, namespace, labels: { 'app.kubernetes.io/part-of': 'compose' } },
          spec: { accessModes: ['ReadWriteOnce'], resources: { requests: { storage: '1Gi' } } }
        });
      }
    }
    if (mounts.length) {
      container.volumeMounts = mounts;
    }
    if (svc.depends_on) {
      warnings.push(`${rawName}: depends_on has no equivalent — pods start in any order; use readiness probes and retries.`);
    }
    if (svc.privileged) {
      container.securityContext = { privileged: true };
      warnings.push(`${rawName}: runs privileged.`);
    }

    const replicas = Number(svc.deploy?.replicas ?? 1);
    objects.push({
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name, namespace, labels: { ...labels, ...(typeof svc.labels === 'object' && !Array.isArray(svc.labels) ? svc.labels : {}) } },
      spec: {
        replicas,
        ...(claims.size && mounts.some((m) => volumes.find((v) => v.name === m.name)?.persistentVolumeClaim) ? { strategy: { type: 'Recreate' } } : {}),
        selector: { matchLabels: labels },
        template: { metadata: { labels }, spec: { containers: [container], ...(volumes.length ? { volumes } : {}), ...(svc.hostname ? { hostname: svc.hostname } : {}) } }
      }
    });
    if (ports.length) {
      const published = ports.some((p) => p.published);
      objects.push({
        apiVersion: 'v1',
        kind: 'Service',
        metadata: { name, namespace, labels },
        spec: {
          type: 'ClusterIP',
          selector: labels,
          ports: ports.map((p, i) => ({ name: i === 0 ? 'http' : `port-${p.target}`, port: p.published ?? p.target, targetPort: p.target, protocol: p.protocol }))
        }
      });
      if (published) {
        warnings.push(`${rawName}: published ports become a ClusterIP service; use port forwarding, an Ingress or type LoadBalancer to reach it from outside.`);
      }
    }
  }
  return { objects, warnings };
}
