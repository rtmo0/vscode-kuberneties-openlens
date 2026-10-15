/* Cluster Doctor: readiness checks with fixes. */
import * as https from 'https';
import * as tls from 'tls';

import type { ClusterSession, K8sObject } from '../core/cluster';
import { formatAge, parseQuantity } from '../core/format';
import { decodeRelease, latestReleaseSecrets } from '../core/helm';
import { errorMessage, isForbidden, isNotFound } from '../core/kubeRest';
import type { Tone } from '../core/protocol';
import { getKind } from '../core/resources';
import { nodeReady, podStatus } from '../core/status';
import { detectEnv } from './addons';

export type CheckStatus = 'ok' | 'warn' | 'error' | 'info';

export interface Fix {
  label: string;
  /** Host-side action id, see DoctorPanel. */
  action: 'installAddon' | 'makeDefaultStorageClass' | 'dnsTest' | 'openTable' | 'openDocs';
  arg?: string;
}

export interface Check {
  id: string;
  group: string;
  title: string;
  status: CheckStatus;
  detail: string;
  items?: string[];
  fixes?: Fix[];
}

export const STATUS_TONE: Record<CheckStatus, Tone> = { ok: 'ok', warn: 'warn', error: 'error', info: 'info' };

const minor = (version: string | undefined): number => Number(/v?\d+\.(\d+)/.exec(version ?? '')?.[1] ?? NaN);

/** API versions removed from Kubernetes, with the minor version that removed them. */
export const REMOVED_APIS: Array<{ apiVersion: string; kind: string; removedIn: number; replacement: string }> = [
  { apiVersion: 'extensions/v1beta1', kind: 'Ingress', removedIn: 22, replacement: 'networking.k8s.io/v1' },
  { apiVersion: 'networking.k8s.io/v1beta1', kind: 'Ingress', removedIn: 22, replacement: 'networking.k8s.io/v1' },
  { apiVersion: 'extensions/v1beta1', kind: 'Deployment', removedIn: 16, replacement: 'apps/v1' },
  { apiVersion: 'apps/v1beta2', kind: 'Deployment', removedIn: 16, replacement: 'apps/v1' },
  { apiVersion: 'extensions/v1beta1', kind: 'DaemonSet', removedIn: 16, replacement: 'apps/v1' },
  { apiVersion: 'apiextensions.k8s.io/v1beta1', kind: 'CustomResourceDefinition', removedIn: 22, replacement: 'apiextensions.k8s.io/v1' },
  { apiVersion: 'rbac.authorization.k8s.io/v1beta1', kind: 'ClusterRole', removedIn: 22, replacement: 'rbac.authorization.k8s.io/v1' },
  { apiVersion: 'rbac.authorization.k8s.io/v1beta1', kind: 'ClusterRoleBinding', removedIn: 22, replacement: 'rbac.authorization.k8s.io/v1' },
  { apiVersion: 'rbac.authorization.k8s.io/v1beta1', kind: 'Role', removedIn: 22, replacement: 'rbac.authorization.k8s.io/v1' },
  { apiVersion: 'rbac.authorization.k8s.io/v1beta1', kind: 'RoleBinding', removedIn: 22, replacement: 'rbac.authorization.k8s.io/v1' },
  { apiVersion: 'admissionregistration.k8s.io/v1beta1', kind: 'MutatingWebhookConfiguration', removedIn: 22, replacement: 'admissionregistration.k8s.io/v1' },
  { apiVersion: 'admissionregistration.k8s.io/v1beta1', kind: 'ValidatingWebhookConfiguration', removedIn: 22, replacement: 'admissionregistration.k8s.io/v1' },
  { apiVersion: 'batch/v1beta1', kind: 'CronJob', removedIn: 25, replacement: 'batch/v1' },
  { apiVersion: 'policy/v1beta1', kind: 'PodDisruptionBudget', removedIn: 25, replacement: 'policy/v1' },
  { apiVersion: 'policy/v1beta1', kind: 'PodSecurityPolicy', removedIn: 25, replacement: 'Pod Security Admission' },
  { apiVersion: 'autoscaling/v2beta1', kind: 'HorizontalPodAutoscaler', removedIn: 25, replacement: 'autoscaling/v2' },
  { apiVersion: 'autoscaling/v2beta2', kind: 'HorizontalPodAutoscaler', removedIn: 26, replacement: 'autoscaling/v2' },
  { apiVersion: 'discovery.k8s.io/v1beta1', kind: 'EndpointSlice', removedIn: 25, replacement: 'discovery.k8s.io/v1' },
  { apiVersion: 'storage.k8s.io/v1beta1', kind: 'CSIStorageCapacity', removedIn: 27, replacement: 'storage.k8s.io/v1' },
  { apiVersion: 'flowcontrol.apiserver.k8s.io/v1beta2', kind: 'FlowSchema', removedIn: 29, replacement: 'flowcontrol.apiserver.k8s.io/v1' },
  { apiVersion: 'flowcontrol.apiserver.k8s.io/v1beta3', kind: 'FlowSchema', removedIn: 32, replacement: 'flowcontrol.apiserver.k8s.io/v1' }
];

/** apiVersion/kind pairs that are removed in `clusterMinor` or within the next two minor versions. */
export function findDeprecated(objects: Array<{ apiVersion?: string; kind?: string; source: string }>, clusterMinor: number): Array<{ source: string; apiVersion: string; kind: string; removedIn: number; replacement: string }> {
  const found: Array<{ source: string; apiVersion: string; kind: string; removedIn: number; replacement: string }> = [];
  for (const obj of objects) {
    const match = REMOVED_APIS.find((r) => r.apiVersion === obj.apiVersion && r.kind === obj.kind);
    if (match && match.removedIn <= clusterMinor + 2) {
      found.push({ source: obj.source, apiVersion: match.apiVersion, kind: match.kind, removedIn: match.removedIn, replacement: match.replacement });
    }
  }
  return found;
}

/** Expiry of the certificate the API server presents. */
function apiServerCertificate(server: string): Promise<{ validTo: Date; subject?: string } | undefined> {
  return new Promise((resolve) => {
    let url: URL;
    try {
      url = new URL(server);
    } catch {
      resolve(undefined);
      return;
    }
    if (url.protocol !== 'https:') {
      resolve(undefined);
      return;
    }
    const socket = tls.connect({ host: url.hostname, port: Number(url.port || 443), servername: /^[\d.]+$/.test(url.hostname) ? undefined : url.hostname, rejectUnauthorized: false, timeout: 5000 }, () => {
      const cert = socket.getPeerCertificate();
      socket.end();
      resolve(cert?.valid_to ? { validTo: new Date(cert.valid_to), subject: String(cert.subject?.CN ?? "") } : undefined);
    });
    socket.on('error', () => resolve(undefined));
    socket.on('timeout', () => {
      socket.destroy();
      resolve(undefined);
    });
  });
}

function latestStableMinor(): Promise<number | undefined> {
  return new Promise((resolve) => {
    https
      .get('https://dl.k8s.io/release/stable.txt', { timeout: 5000 }, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.headers.location) {
          https.get(res.headers.location, { timeout: 5000 }, (r2) => {
            let body = '';
            r2.on('data', (c) => (body += c));
            r2.on('end', () => resolve(minor(body.trim()) || undefined));
          }).on('error', () => resolve(undefined));
          res.resume();
          return;
        }
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve(minor(body.trim()) || undefined));
      })
      .on('error', () => resolve(undefined))
      .on('timeout', function (this: any) {
        this.destroy();
        resolve(undefined);
      });
  });
}

export async function runDoctor(session: ClusterSession): Promise<Check[]> {
  const checks: Check[] = [];
  const add = (check: Check): void => {
    checks.push(check);
  };
  const soft = <T>(p: Promise<T>, fallback: T): Promise<T> => p.catch(() => fallback);

  await session.connect();
  const [nodes, pods, storageClasses, ingressClasses, deployments, events, secrets, pdbs, env, stable, cert] = await Promise.all([
    soft(session.list(getKind('nodes')!, '').then((r) => r.items), [] as K8sObject[]),
    soft(session.list(getKind('pods')!, '').then((r) => r.items), [] as K8sObject[]),
    soft(session.list(getKind('storageclasses')!, '').then((r) => r.items), [] as K8sObject[]),
    soft(session.list(getKind('ingressclasses')!, '').then((r) => r.items), [] as K8sObject[]),
    soft(session.list(getKind('deployments')!, 'kube-system').then((r) => r.items), [] as K8sObject[]),
    soft(session.events(undefined, 'type=Warning'), [] as K8sObject[]),
    soft(session.list(getKind('secrets')!, '', { labelSelector: 'owner=helm' }).then((r) => r.items), [] as K8sObject[]),
    soft(session.list(getKind('pdb')!, '').then((r) => r.items), [] as K8sObject[]),
    detectEnv(session),
    latestStableMinor(),
    apiServerCertificate(session.server)
  ]);
  const clusterMinor = minor(session.version);

  // ── Control plane ──
  add({
    id: 'api',
    group: 'Control plane',
    title: 'API server',
    status: 'ok',
    detail: `Reachable at ${session.server}, Kubernetes ${session.version ?? 'unknown'}${env.local ? ` (${env.local})` : ''}.`
  });
  if (cert) {
    const days = Math.floor((cert.validTo.getTime() - Date.now()) / 86_400_000);
    add({
      id: 'apiCert',
      group: 'Control plane',
      title: 'API server certificate',
      status: days < 0 ? 'error' : days < 30 ? 'warn' : 'ok',
      detail: days < 0 ? `Expired on ${cert.validTo.toISOString().slice(0, 10)}.` : `Valid until ${cert.validTo.toISOString().slice(0, 10)} (${days} days).${days < 30 ? ' Renew the control plane certificates (e.g. kubeadm certs renew all) before it expires.' : ''}`
    });
  }
  if (stable && clusterMinor) {
    const behind = stable - clusterMinor;
    add({
      id: 'version',
      group: 'Control plane',
      title: 'Kubernetes version support',
      status: behind >= 3 ? 'warn' : 'ok',
      detail:
        behind >= 3
          ? `1.${clusterMinor} is ${behind} minor versions behind the latest 1.${stable}; upstream supports the last three. Plan an upgrade.`
          : `1.${clusterMinor} is within the upstream support window (latest 1.${stable}).`,
      fixes: behind >= 3 ? [{ label: 'Version skew policy', action: 'openDocs', arg: 'https://kubernetes.io/releases/version-skew-policy/' }] : undefined
    });
  }

  // ── Nodes ──
  const notReady = nodes.filter((n) => !nodeReady(n));
  const pressure = nodes.flatMap((n) => (n.status?.conditions ?? []).filter((c: any) => c.type !== 'Ready' && c.status === 'True').map((c: any) => `${n.metadata.name}: ${c.type}`));
  const cordoned = nodes.filter((n) => n.spec?.unschedulable).map((n) => n.metadata.name);
  add({
    id: 'nodes',
    group: 'Nodes',
    title: 'Node health',
    status: notReady.length ? 'error' : pressure.length ? 'warn' : 'ok',
    detail: `${nodes.length - notReady.length}/${nodes.length} nodes ready${pressure.length ? `, ${pressure.length} under pressure` : ''}${cordoned.length ? `, ${cordoned.length} cordoned` : ''}.`,
    items: [...notReady.map((n) => `${n.metadata.name}: NotReady`), ...pressure, ...cordoned.map((n) => `${n}: SchedulingDisabled`)],
    fixes: notReady.length || pressure.length ? [{ label: 'Open Nodes', action: 'openTable', arg: 'nodes' }] : undefined
  });
  const skewed = nodes.filter((n) => {
    const kubelet = minor(n.status?.nodeInfo?.kubeletVersion);
    return clusterMinor && kubelet && (kubelet > clusterMinor || clusterMinor - kubelet > 3);
  });
  add({
    id: 'skew',
    group: 'Nodes',
    title: 'Kubelet version skew',
    status: skewed.length ? 'warn' : 'ok',
    detail: skewed.length ? 'Some kubelets are outside the supported skew (newer than the API server or more than three minors older).' : 'All kubelets are within the supported version skew.',
    items: skewed.map((n) => `${n.metadata.name}: ${n.status?.nodeInfo?.kubeletVersion}`)
  });
  const hot = nodes
    .map((n) => {
      const nodePods = pods.filter((p) => p.spec?.nodeName === n.metadata.name && p.status?.phase !== 'Succeeded' && p.status?.phase !== 'Failed');
      const requests = (resource: 'cpu' | 'memory'): number =>
        nodePods.reduce((sum, p) => sum + (p.spec?.containers ?? []).reduce((s: number, c: any) => s + parseQuantity(c.resources?.requests?.[resource]), 0), 0);
      const cpu = requests('cpu') / (parseQuantity(n.status?.allocatable?.cpu) || 1);
      const memory = requests('memory') / (parseQuantity(n.status?.allocatable?.memory) || 1);
      return { name: n.metadata.name, cpu, memory };
    })
    .filter((n) => n.cpu > 0.9 || n.memory > 0.9);
  add({
    id: 'capacity',
    group: 'Nodes',
    title: 'Schedulable capacity',
    status: hot.length ? 'warn' : 'ok',
    detail: hot.length ? 'Requests on some nodes are above 90% of allocatable; new pods may stay Pending.' : 'All nodes have room for new pods.',
    items: hot.map((n) => `${n.name}: CPU ${Math.round(n.cpu * 100)}%, memory ${Math.round(n.memory * 100)}% requested`)
  });

  // ── Core services ──
  let metricsOk = false;
  try {
    const svc = await session.rest.get<any>('/apis/apiregistration.k8s.io/v1/apiservices/v1beta1.metrics.k8s.io');
    metricsOk = (svc.status?.conditions ?? []).some((c: any) => c.type === 'Available' && c.status === 'True');
  } catch (err) {
    if (!isNotFound(err) && !isForbidden(err)) {
      throw err;
    }
  }
  add({
    id: 'metrics',
    group: 'Core services',
    title: 'Metrics API',
    status: metricsOk ? 'ok' : 'warn',
    detail: metricsOk ? 'metrics-server is available: kubectl top, HPAs and the metrics in this extension work.' : 'metrics-server is missing or not ready: no CPU / memory usage, HorizontalPodAutoscalers cannot scale.',
    fixes: metricsOk ? undefined : [{ label: 'Install metrics-server', action: 'installAddon', arg: 'metrics-server' }]
  });

  const coredns = deployments.find((d) => d.metadata.name === 'coredns' || d.metadata.labels?.['k8s-app'] === 'kube-dns');
  const dnsReady = coredns ? (coredns.status?.readyReplicas ?? 0) > 0 : false;
  add({
    id: 'dns',
    group: 'Core services',
    title: 'Cluster DNS',
    status: !coredns ? 'warn' : dnsReady ? 'ok' : 'error',
    detail: !coredns ? 'No CoreDNS / kube-dns deployment found in kube-system.' : dnsReady ? `${coredns.metadata.name}: ${coredns.status?.readyReplicas}/${coredns.spec?.replicas} ready.` : `${coredns.metadata.name} has no ready replicas: service names do not resolve.`,
    fixes: [{ label: 'Run a DNS lookup test', action: 'dnsTest' }]
  });

  const defaultClass = storageClasses.find((sc) => sc.metadata.annotations?.['storageclass.kubernetes.io/is-default-class'] === 'true' || sc.metadata.annotations?.['storageclass.beta.kubernetes.io/is-default-class'] === 'true');
  add({
    id: 'storage',
    group: 'Core services',
    title: 'Default StorageClass',
    status: defaultClass ? 'ok' : 'warn',
    detail: defaultClass
      ? `"${defaultClass.metadata.name}" (${defaultClass.provisioner}) is the default.`
      : storageClasses.length
        ? `There are StorageClasses (${storageClasses.map((s) => s.metadata.name).join(', ')}) but none is the default: PersistentVolumeClaims without storageClassName stay Pending.`
        : 'There is no StorageClass: PersistentVolumeClaims cannot be provisioned.',
    fixes: defaultClass
      ? undefined
      : storageClasses.length
        ? storageClasses.map((sc) => ({ label: `Make "${sc.metadata.name}" default`, action: 'makeDefaultStorageClass' as const, arg: sc.metadata.name }))
        : [{ label: 'Install Local Path Provisioner', action: 'installAddon', arg: 'local-path-provisioner' }]
  });

  add({
    id: 'ingress',
    group: 'Core services',
    title: 'Ingress controller',
    status: ingressClasses.length ? 'ok' : 'warn',
    detail: ingressClasses.length
      ? `IngressClasses: ${ingressClasses.map((c) => `${c.metadata.name} (${c.spec?.controller})${c.metadata.annotations?.['ingressclass.kubernetes.io/is-default-class'] === 'true' ? ' default' : ''}`).join(', ')}.`
      : 'No ingress controller: Ingress objects have no effect.',
    fixes: ingressClasses.length ? undefined : [{ label: 'Install ingress-nginx', action: 'installAddon', arg: 'ingress-nginx' }]
  });

  // ── Workloads ──
  const failing = pods.filter((p) => podStatus(p).tone === 'error');
  const pending = pods.filter((p) => p.status?.phase === 'Pending' && Date.now() - Date.parse(p.metadata.creationTimestamp ?? '') > 5 * 60_000);
  add({
    id: 'pods',
    group: 'Workloads',
    title: 'Failing pods',
    status: failing.length ? 'error' : pending.length ? 'warn' : 'ok',
    detail: failing.length || pending.length ? `${failing.length} failing, ${pending.length} pending for more than 5 minutes.` : 'No failing or stuck pods.',
    items: [
      ...failing.map((p) => `${p.metadata.namespace}/${p.metadata.name}: ${podStatus(p).text}`),
      ...pending.map((p) => `${p.metadata.namespace}/${p.metadata.name}: Pending for ${formatAge(p.metadata.creationTimestamp)}`)
    ].slice(0, 30),
    fixes: failing.length || pending.length ? [{ label: 'Open Pods', action: 'openTable', arg: 'pods' }] : undefined
  });

  const systemNs = new Set(['kube-system', 'kube-public', 'kube-node-lease', 'local-path-storage']);
  const unbounded = pods
    .filter((p) => !systemNs.has(p.metadata.namespace ?? '') && p.status?.phase === 'Running')
    .flatMap((p) => (p.spec?.containers ?? []).filter((c: any) => !c.resources?.requests?.cpu && !c.resources?.requests?.memory).map((c: any) => `${p.metadata.namespace}/${p.metadata.name}/${c.name}`));
  add({
    id: 'requests',
    group: 'Workloads',
    title: 'Resource requests',
    status: unbounded.length ? 'warn' : 'ok',
    detail: unbounded.length
      ? `${unbounded.length} container(s) outside kube-system have no CPU or memory requests: the scheduler cannot place them well and they are evicted first. A LimitRange can set defaults per namespace.`
      : 'Every container declares resource requests.',
    items: unbounded.slice(0, 30)
  });

  const blocking = pdbs.filter((p) => (p.status?.expectedPods ?? 0) > 0 && (p.status?.disruptionsAllowed ?? 0) === 0);
  add({
    id: 'pdb',
    group: 'Workloads',
    title: 'Disruption budgets',
    status: blocking.length ? 'warn' : 'ok',
    detail: blocking.length ? 'These PodDisruptionBudgets allow no disruption right now: node drains and upgrades will wait on them.' : 'No PodDisruptionBudget blocks drains.',
    items: blocking.map((p) => `${p.metadata.namespace}/${p.metadata.name}`)
  });

  // ── API usage ──
  const objects: Array<{ apiVersion?: string; kind?: string; source: string }> = [];
  for (const secret of latestReleaseSecrets(secrets)) {
    const release = decodeRelease(secret);
    if (!release) {
      continue;
    }
    for (const doc of release.manifest.split(/^---$/m)) {
      const apiVersion = /^apiVersion:\s*(\S+)/m.exec(doc)?.[1];
      const kind = /^kind:\s*(\S+)/m.exec(doc)?.[1];
      if (apiVersion && kind) {
        objects.push({ apiVersion, kind, source: `Helm release ${release.namespace}/${release.name}` });
      }
    }
  }
  const deprecated = clusterMinor ? findDeprecated(objects, clusterMinor) : [];
  add({
    id: 'deprecated',
    group: 'API usage',
    title: 'Removed and deprecated APIs',
    status: deprecated.some((d) => d.removedIn <= clusterMinor) ? 'error' : deprecated.length ? 'warn' : 'ok',
    detail: deprecated.length
      ? 'Helm releases use API versions that are removed in this or one of the next two Kubernetes versions; upgrades of those releases will fail.'
      : `No Helm release uses an API version removed up to 1.${clusterMinor + 2}.`,
    items: deprecated.map((d) => `${d.source}: ${d.kind} ${d.apiVersion} → ${d.replacement} (removed in 1.${d.removedIn})`)
  });

  const recent = events.filter((e) => Date.now() - Date.parse(e.lastTimestamp ?? e.eventTime ?? e.metadata.creationTimestamp ?? '') < 3600_000);
  const reasons = new Map<string, number>();
  for (const e of recent) {
    reasons.set(e.reason ?? '?', (reasons.get(e.reason ?? '?') ?? 0) + (e.count ?? 1));
  }
  add({
    id: 'events',
    group: 'Workloads',
    title: 'Warning events (last hour)',
    status: recent.length > 20 ? 'warn' : 'info',
    detail: recent.length ? `${recent.length} warning event(s) in the last hour.` : 'No warning events in the last hour.',
    items: [...reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([reason, count]) => `${reason}: ${count}`),
    fixes: recent.length ? [{ label: 'Open Events', action: 'openTable', arg: 'events' }] : undefined
  });

  return checks;
}

/** Resolve a service name from inside the cluster with a short-lived busybox pod. */
export async function dnsTest(session: ClusterSession, namespace = 'default'): Promise<{ ok: boolean; output: string }> {
  const name = `openlens-dns-test-${Math.random().toString(36).slice(2, 7)}`;
  const podKind = getKind('pods')!;
  await session.create(podKind, {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: { name, namespace, labels: { 'app.kubernetes.io/managed-by': 'openlens-vscode' } },
    spec: {
      restartPolicy: 'Never',
      terminationGracePeriodSeconds: 0,
      containers: [{ name: 'dns', image: 'busybox:1.36', command: ['sh', '-c', 'nslookup kubernetes.default.svc.cluster.local && nslookup example.com'] }]
    }
  } as K8sObject);
  try {
    const deadline = Date.now() + 90_000;
    let phase = '';
    while (Date.now() < deadline) {
      const pod = await session.get(podKind, name, namespace);
      phase = pod.status?.phase ?? '';
      if (phase === 'Succeeded' || phase === 'Failed') {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    const output = await session.rest.text('GET', `/api/v1/namespaces/${namespace}/pods/${name}/log`, { accept: '*/*' }).catch((err) => errorMessage(err));
    return { ok: phase === 'Succeeded', output: output || `Pod ended in phase ${phase || 'unknown'}` };
  } finally {
    await session.delete(podKind, name, namespace).catch(() => undefined);
  }
}
