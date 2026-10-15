/* Relations between the objects of a namespace, for the topology view. */
import type { ClusterSession, K8sObject } from './cluster';
import type { Tone } from './protocol';
import { getKind } from './resources';
import { podStatus, workloadHealth } from './status';

export interface TopologyNode {
  id: string;
  kindId: string;
  kind: string;
  name: string;
  column: number;
  tone: Tone;
  status: string;
}

export interface TopologyGraph {
  namespace: string;
  columns: string[];
  nodes: TopologyNode[];
  edges: Array<{ from: string; to: string }>;
  truncated?: string;
}

const COLUMNS = ['Ingresses', 'Services', 'Workloads', 'ReplicaSets / Jobs', 'Pods', 'Config & Storage'];
const MAX_PODS = 400;

const id = (kindId: string, name: string): string => `${kindId}/${name}`;

function matchesSelector(labels: Record<string, string> | undefined, selector: Record<string, string> | undefined): boolean {
  const entries = Object.entries(selector ?? {});
  return entries.length > 0 && entries.every(([k, v]) => labels?.[k] === v);
}

export async function buildTopology(session: ClusterSession, namespace: string): Promise<TopologyGraph> {
  const kinds = ['ingresses', 'services', 'deployments', 'statefulsets', 'daemonsets', 'cronjobs', 'replicasets', 'jobs', 'pods'] as const;
  const lists = await Promise.all(kinds.map((k) => session.list(getKind(k)!, namespace).then((r) => r.items).catch(() => [] as K8sObject[])));
  const byKind = Object.fromEntries(kinds.map((k, i) => [k, lists[i]])) as Record<(typeof kinds)[number], K8sObject[]>;

  const nodes = new Map<string, TopologyNode>();
  const edges = new Set<string>();
  const add = (kindId: string, obj: K8sObject | { metadata: { name: string } }, column: number, tone: Tone, status: string): string => {
    const key = id(kindId, obj.metadata.name);
    if (!nodes.has(key)) {
      nodes.set(key, { id: key, kindId, kind: getKind(kindId)?.kind ?? kindId, name: obj.metadata.name, column, tone, status });
    }
    return key;
  };
  const link = (from: string, to: string): void => {
    edges.add(`${from}\u0000${to}`);
  };

  let pods = byKind.pods;
  let truncated: string | undefined;
  if (pods.length > MAX_PODS) {
    truncated = `Showing ${MAX_PODS} of ${pods.length} pods.`;
    pods = pods.slice(0, MAX_PODS);
  }
  const podIds = new Map<string, string>();
  for (const pod of pods) {
    const s = podStatus(pod);
    podIds.set(pod.metadata.uid!, add('pods', pod, 4, s.tone, s.text));
  }

  // Controllers and their pods.
  const ownerOf = (obj: K8sObject): any => (obj.metadata.ownerReferences ?? []).find((r: any) => r.controller);
  const uidToId = new Map<string, string>();
  for (const kindId of ['deployments', 'statefulsets', 'daemonsets'] as const) {
    for (const obj of byKind[kindId]) {
      const h = workloadHealth(obj, kindId);
      uidToId.set(obj.metadata.uid!, add(kindId, obj, 2, h.tone, `${h.ready}/${h.desired}`));
    }
  }
  for (const cj of byKind.cronjobs) {
    uidToId.set(cj.metadata.uid!, add('cronjobs', cj, 2, cj.spec?.suspend ? 'warn' : 'ok', cj.spec?.schedule ?? ''));
  }
  for (const rs of byKind.replicasets) {
    // Old revisions scaled to zero are noise.
    if ((rs.spec?.replicas ?? 0) === 0 && (rs.status?.replicas ?? 0) === 0) {
      continue;
    }
    const h = workloadHealth(rs, 'replicasets');
    const rsId = add('replicasets', rs, 3, h.tone, `${h.ready}/${h.desired}`);
    uidToId.set(rs.metadata.uid!, rsId);
    const owner = ownerOf(rs);
    if (owner && uidToId.has(owner.uid)) {
      link(uidToId.get(owner.uid)!, rsId);
    }
  }
  for (const job of byKind.jobs) {
    const h = workloadHealth(job, 'jobs');
    const jobId = add('jobs', job, 3, h.tone, `${h.ready}/${h.desired}`);
    uidToId.set(job.metadata.uid!, jobId);
    const owner = ownerOf(job);
    if (owner && uidToId.has(owner.uid)) {
      link(uidToId.get(owner.uid)!, jobId);
    }
  }
  for (const pod of pods) {
    const owner = ownerOf(pod);
    if (owner && uidToId.has(owner.uid)) {
      link(uidToId.get(owner.uid)!, podIds.get(pod.metadata.uid!)!);
    }
  }

  // Services → pods, ingresses → services.
  const serviceIds = new Map<string, string>();
  for (const svc of byKind.services) {
    const svcId = add('services', svc, 1, 'info', svc.spec?.type ?? 'ClusterIP');
    serviceIds.set(svc.metadata.name, svcId);
    for (const pod of pods) {
      if (matchesSelector(pod.metadata.labels, svc.spec?.selector)) {
        link(svcId, podIds.get(pod.metadata.uid!)!);
      }
    }
  }
  for (const ing of byKind.ingresses) {
    const hosts = (ing.spec?.rules ?? []).map((r: any) => r.host).filter(Boolean);
    const ingId = add('ingresses', ing, 0, 'info', hosts.join(', ') || '*');
    const backends = new Set<string>();
    if (ing.spec?.defaultBackend?.service?.name) {
      backends.add(ing.spec.defaultBackend.service.name);
    }
    for (const rule of ing.spec?.rules ?? []) {
      for (const p of rule.http?.paths ?? []) {
        if (p.backend?.service?.name) {
          backends.add(p.backend.service.name);
        }
      }
    }
    for (const name of backends) {
      const svcId = serviceIds.get(name) ?? add('services', { metadata: { name } }, 1, 'error', 'missing');
      link(ingId, svcId);
    }
  }

  // Pods → config and storage.
  for (const pod of pods) {
    const podId = podIds.get(pod.metadata.uid!)!;
    const refs = new Set<string>();
    for (const v of pod.spec?.volumes ?? []) {
      if (v.configMap?.name) refs.add(id('configmaps', v.configMap.name));
      if (v.secret?.secretName) refs.add(id('secrets', v.secret.secretName));
      if (v.persistentVolumeClaim?.claimName) refs.add(id('pvc', v.persistentVolumeClaim.claimName));
      for (const source of v.projected?.sources ?? []) {
        if (source.configMap?.name) refs.add(id('configmaps', source.configMap.name));
        if (source.secret?.name) refs.add(id('secrets', source.secret.name));
      }
    }
    for (const c of [...(pod.spec?.containers ?? []), ...(pod.spec?.initContainers ?? [])]) {
      for (const from of c.envFrom ?? []) {
        if (from.configMapRef?.name) refs.add(id('configmaps', from.configMapRef.name));
        if (from.secretRef?.name) refs.add(id('secrets', from.secretRef.name));
      }
      for (const env of c.env ?? []) {
        if (env.valueFrom?.configMapKeyRef?.name) refs.add(id('configmaps', env.valueFrom.configMapKeyRef.name));
        if (env.valueFrom?.secretKeyRef?.name) refs.add(id('secrets', env.valueFrom.secretKeyRef.name));
      }
    }
    // Every pod mounts these CA bundles; they only add noise.
    refs.delete(id('configmaps', 'kube-root-ca.crt'));
    refs.delete(id('configmaps', 'openshift-service-ca.crt'));
    for (const ref of refs) {
      const [kindId, name] = [ref.slice(0, ref.indexOf('/')), ref.slice(ref.indexOf('/') + 1)];
      add(kindId, { metadata: { name } }, 5, 'muted', getKind(kindId)?.kind ?? kindId);
      link(podId, ref);
    }
  }

  return {
    namespace,
    columns: COLUMNS,
    nodes: [...nodes.values()],
    edges: [...edges].map((e) => {
      const [from, to] = e.split('\u0000');
      return { from, to };
    }),
    truncated
  };
}
