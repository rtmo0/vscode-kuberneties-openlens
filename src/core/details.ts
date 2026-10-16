/* Content of the details panel (Lens drawer) for every kind. */
import type { ClusterSession, K8sObject, PodUsage } from './cluster';
import { buildTable, eventTime, rowActions } from './columns';
import { formatBytes, formatCpu, parseQuantity } from './format';
import { decodeRelease, releaseHistory } from './helm';
import { errorMessage } from './kubeRest';
import type { ContainerInfo, DetailsData, KeyValue, MetricPoint, MetricSeries, SecretEntry, Section, Tone } from './protocol';
import { apiVersionOf, findKindByKind, getKind, ResourceKind } from './resources';
import { toYaml } from '../fs/resourceFs';
import { ROLLOUT_KINDS, rolloutHistory } from './workloadOps';
import { endpointLabel, fetchSeries, knownPrometheus, MetricQueries, nodeQueries, podQueries, prometheusFor } from './prometheus';
import {
  containerState,
  nodeRoles,
  nodeStatus,
  ownerOf,
  podSelectorOf,
  podStatus,
  selectorString,
  workloadHealth
} from './status';

const HISTORY_POINTS = 60;

/** Metric history per object, kept by the details panel between refreshes. */
export class MetricsHistory {
  private readonly series = new Map<string, MetricPoint[]>();

  record(key: string, cpu: number, memory: number): MetricPoint[] {
    const points = this.series.get(key) ?? [];
    points.push({ t: Date.now(), cpu, memory });
    if (points.length > HISTORY_POINTS) {
      points.splice(0, points.length - HISTORY_POINTS);
    }
    this.series.set(key, points);
    return points;
  }

  get(key: string): MetricPoint[] {
    return this.series.get(key) ?? [];
  }
}

export interface DetailsOptions {
  /** Metrics range in seconds, when Prometheus is available. */
  range: number;
  /**
   * Only what the object itself contains, with no further API calls: shown at once
   * while metrics, events and related objects load.
   */
  quick?: boolean;
}

const LOADING = 'Loading…';

export async function buildDetails(session: ClusterSession, kind: ResourceKind, obj: K8sObject, history: MetricsHistory, options: DetailsOptions = { range: 3600 }): Promise<DetailsData> {
  const sections: Section[] = [];
  let status: DetailsData['status'];
  const ns = obj.metadata.namespace;

  if (kind.id === 'helmreleases') {
    return helmDetails(session, obj);
  }
  const quick = !!options.quick;
  // Independent requests start together instead of one after another.
  const events = kind.id === 'events' || quick ? undefined : eventsSection(session, kind, obj);
  if (!quick && ['pods', 'deployments', 'statefulsets', 'daemonsets', 'replicasets', 'jobs', 'nodes'].includes(kind.id)) {
    void prometheusFor(session).catch(() => undefined);
  }

  sections.push({ type: 'kv', title: 'Overview', items: overview(kind, obj) });

  switch (kind.id) {
    case 'pods': {
      status = podStatus(obj);
      const metrics = quick ? undefined : await session.podMetrics(ns);
      const usage = metrics?.get(`${ns}/${obj.metadata.name}`);
      sections.push({ type: 'kv', title: 'Pod', items: podInfo(obj) });
      sections.push(quick
        ? { type: 'metrics', title: 'Metrics', series: [], unavailable: LOADING }
        : await metricsSection(session, `pod:${obj.metadata.uid}`, history, usage, [obj], podQueries(ns ?? '', [obj.metadata.name]), options.range));
      sections.push({ type: 'containers', title: 'Containers', items: containers(obj, usage), podName: obj.metadata.name, namespace: ns ?? '' });
      sections.push(conditions(obj));
      sections.push({ type: 'kv', title: 'Volumes', items: volumes(obj) });
      break;
    }
    case 'deployments':
    case 'statefulsets':
    case 'daemonsets':
    case 'replicasets':
    case 'jobs': {
      const health = workloadHealth(obj, kind.id);
      status = { text: `${health.ready}/${health.desired} ready`, tone: health.tone };
      sections.push({ type: 'kv', title: 'Spec', items: workloadInfo(kind.id, obj) });
      const revisions = ROLLOUT_KINDS.has(kind.id) && !quick ? revisionsSection(session, kind.id, obj) : undefined;
      if (!quick) {
        sections.push(...(await podsSections(session, obj, kind.id, history, options.range)));
      }
      if (revisions) {
        sections.push(await revisions);
      }
      sections.push(conditions(obj));
      break;
    }
    case 'cronjobs': {
      status = obj.spec?.suspend ? { text: 'Suspended', tone: 'warn' } : { text: 'Active', tone: 'ok' };
      sections.push({
        type: 'kv',
        title: 'Schedule',
        items: [
          { key: 'Schedule', value: obj.spec?.schedule ?? '' },
          { key: 'Time Zone', value: obj.spec?.timeZone ?? 'controller default' },
          { key: 'Concurrency Policy', value: obj.spec?.concurrencyPolicy ?? 'Allow' },
          { key: 'Last Schedule', value: obj.status?.lastScheduleTime ?? 'never', time: obj.status?.lastScheduleTime },
          { key: 'Last Success', value: obj.status?.lastSuccessfulTime ?? 'never', time: obj.status?.lastSuccessfulTime },
          { key: 'Images', value: images(obj.spec?.jobTemplate?.spec?.template) }
        ]
      });
      if (!quick) {
        const jobs = await session.list(getKind('jobs')!, ns ?? '');
        const owned = jobs.items.filter((j) => (j.metadata.ownerReferences ?? []).some((o: any) => o.uid === obj.metadata.uid));
        sections.push({ type: 'table', title: 'Jobs', data: buildTable(getKind('jobs')!, owned, {}) });
      }
      break;
    }
    case 'services': {
      sections.push({
        type: 'kv',
        title: 'Connection',
        items: [
          { key: 'Type', value: obj.spec?.type ?? 'ClusterIP' },
          { key: 'Cluster IP', value: (obj.spec?.clusterIPs ?? [obj.spec?.clusterIP]).filter(Boolean).join(', ') },
          { key: 'External', value: [...(obj.status?.loadBalancer?.ingress ?? []).map((i: any) => i.ip || i.hostname), ...(obj.spec?.externalIPs ?? []), obj.spec?.externalName].filter(Boolean).join(', ') || '—' },
          { key: 'Selector', value: selectorString(obj.spec?.selector) || '—' },
          { key: 'Session Affinity', value: obj.spec?.sessionAffinity ?? 'None' },
          { key: 'DNS', value: `${obj.metadata.name}.${ns}.svc` }
        ]
      });
      sections.push({
        type: 'ports',
        title: 'Ports',
        serviceName: obj.metadata.name,
        namespace: ns ?? '',
        items: (obj.spec?.ports ?? []).map((p: any) => ({
          name: p.name,
          port: p.port,
          targetPort: String(p.targetPort ?? p.port),
          protocol: p.protocol ?? 'TCP',
          nodePort: p.nodePort
        }))
      });
      if (!quick) {
        sections.push(...(await podsSections(session, obj, kind.id, history, options.range)));
      }
      break;
    }
    case 'ingresses':
      sections.push({ type: 'kv', title: 'Rules', items: ingressRules(obj) });
      break;
    case 'nodes': {
      status = nodeStatus(obj);
      if (!quick) {
        sections.push(...(await nodeSections(session, obj, history, options.range)));
      }
      break;
    }
    case 'secrets':
      sections.push({ type: 'secret', title: 'Data', items: secretEntries(obj.data ?? {}, true), editable: true, encoded: true });
      break;
    case 'configmaps':
      sections.push({
        type: 'secret',
        title: 'Data',
        items: [
          ...Object.entries(obj.data ?? {}).map(([key, value]) => ({ key, value: String(value), binary: false, size: Buffer.byteLength(String(value)) })),
          ...secretEntries(obj.binaryData ?? {}, false)
        ],
        editable: true,
        encoded: false
      });
      break;
    case 'pvc':
      status = { text: obj.status?.phase ?? 'Unknown', tone: obj.status?.phase === 'Bound' ? 'ok' : 'warn' };
      break;
    case 'namespaces':
      status = { text: obj.status?.phase ?? 'Active', tone: obj.status?.phase === 'Terminating' ? 'warn' : 'ok' };
      break;
    case 'events':
      sections.push({
        type: 'kv',
        title: 'Event',
        items: [
          { key: 'Type', value: obj.type ?? '', tone: obj.type === 'Warning' ? 'warn' : undefined },
          { key: 'Reason', value: obj.reason ?? '' },
          { key: 'Message', value: obj.message ?? '' },
          { key: 'Source', value: obj.source?.component ?? obj.reportingComponent ?? '' },
          { key: 'Count', value: String(obj.count ?? 1) },
          { key: 'Last Seen', value: eventTime(obj) ?? '', time: eventTime(obj) }
        ]
      });
      break;
  }

  if (!['pods', 'nodes', 'secrets', 'configmaps', 'events', 'services'].includes(kind.id)) {
    const body = specOf(obj);
    if (body) {
      sections.push({ type: 'code', title: kind.id === 'roles' || kind.id === 'clusterroles' ? 'Rules' : 'Spec', language: 'yaml', text: toYaml(body) });
    }
  }

  sections.push({ type: 'labels', title: 'Labels', items: Object.entries(obj.metadata.labels ?? {}).map(([key, value]) => ({ key, value: String(value) })) });
  const annotations = Object.entries(obj.metadata.annotations ?? {}).filter(([key]) => key !== 'kubectl.kubernetes.io/last-applied-configuration');
  sections.push({ type: 'labels', title: 'Annotations', items: annotations.map(([key, value]) => ({ key, value: String(value) })) });

  if (events) {
    sections.push(await events);
  } else if (kind.id !== 'events') {
    sections.push({ type: 'events', title: `Events (${LOADING.toLowerCase()})`, items: [] });
  }

  return {
    title: obj.metadata.name,
    subtitle: `${kind.kind}${ns ? ` · ${ns}` : ''} · ${session.context}`,
    status,
    actions: rowActions(kind.id, obj),
    sections: sections.filter((s) => !(s.type === 'kv' && s.items.length === 0))
  };
}

function overview(kind: ResourceKind, obj: K8sObject): KeyValue[] {
  const items: KeyValue[] = [
    { key: 'Kind', value: `${kind.kind} (${obj.apiVersion ?? apiVersionOf(kind)})` },
    { key: 'Name', value: obj.metadata.name }
  ];
  if (obj.metadata.namespace) {
    items.push({ key: 'Namespace', value: obj.metadata.namespace, link: { kindId: 'namespaces', name: obj.metadata.namespace } });
  }
  items.push({ key: 'Created', value: obj.metadata.creationTimestamp ?? '', time: obj.metadata.creationTimestamp });
  const owner = ownerOf(obj);
  if (owner) {
    const ownerKind = findKindByKind(undefined, owner.kind);
    items.push({
      key: 'Controlled By',
      value: `${owner.kind}/${owner.name}`,
      link: ownerKind ? { kindId: ownerKind.id, name: owner.name, namespace: obj.metadata.namespace } : undefined
    });
  }
  if (obj.metadata.deletionTimestamp) {
    items.push({ key: 'Deleting Since', value: obj.metadata.deletionTimestamp, time: obj.metadata.deletionTimestamp, tone: 'warn' });
  }
  if (obj.metadata.finalizers?.length) {
    items.push({ key: 'Finalizers', value: obj.metadata.finalizers.join(', ') });
  }
  items.push({ key: 'UID', value: obj.metadata.uid ?? '' });
  return items;
}

function podInfo(pod: K8sObject): KeyValue[] {
  const s = pod.status ?? {};
  const items: KeyValue[] = [
    { key: 'Status', value: podStatus(pod).text, tone: podStatus(pod).tone },
    { key: 'Node', value: pod.spec?.nodeName ?? '—', link: pod.spec?.nodeName ? { kindId: 'nodes', name: pod.spec.nodeName } : undefined },
    { key: 'Pod IP', value: (s.podIPs ?? [{ ip: s.podIP }]).map((p: any) => p.ip).filter(Boolean).join(', ') || '—' },
    { key: 'Host IP', value: s.hostIP ?? '—' },
    { key: 'QoS Class', value: s.qosClass ?? '—' },
    {
      key: 'Service Account',
      value: pod.spec?.serviceAccountName ?? 'default',
      link: { kindId: 'serviceaccounts', name: pod.spec?.serviceAccountName ?? 'default', namespace: pod.metadata.namespace }
    },
    { key: 'Restart Policy', value: pod.spec?.restartPolicy ?? 'Always' }
  ];
  if (pod.spec?.priorityClassName) {
    items.push({ key: 'Priority Class', value: pod.spec.priorityClassName, link: { kindId: 'priorityclasses', name: pod.spec.priorityClassName } });
  }
  if (s.startTime) {
    items.push({ key: 'Started', value: s.startTime, time: s.startTime });
  }
  if (s.message) {
    items.push({ key: 'Message', value: s.message, tone: 'warn' });
  }
  if (pod.spec?.nodeSelector) {
    items.push({ key: 'Node Selector', value: selectorString(pod.spec.nodeSelector) });
  }
  if (pod.spec?.tolerations?.length) {
    items.push({ key: 'Tolerations', value: String(pod.spec.tolerations.length) });
  }
  return items;
}

function resourcesOf(container: any, field: 'requests' | 'limits'): string {
  const r = container.resources?.[field] ?? {};
  const parts: string[] = [];
  if (r.cpu) {
    parts.push(`CPU ${r.cpu}`);
  }
  if (r.memory) {
    parts.push(`Memory ${r.memory}`);
  }
  return parts.join(', ') || '—';
}

function containers(pod: K8sObject, usage: PodUsage | undefined): ContainerInfo[] {
  const statuses = new Map<string, any>();
  for (const c of [...(pod.status?.initContainerStatuses ?? []), ...(pod.status?.containerStatuses ?? [])]) {
    statuses.set(c.name, c);
  }
  const describe = (c: any, init: boolean): ContainerInfo => {
    const st = statuses.get(c.name);
    const state = containerState(st);
    const last = st?.lastState?.terminated;
    const u = usage?.containers.get(c.name);
    return {
      name: c.name,
      init,
      image: c.image,
      state: state.text,
      tone: state.tone,
      ready: !!st?.ready,
      restarts: st?.restartCount ?? 0,
      ports: (c.ports ?? []).map((p: any) => ({ name: p.name, port: p.containerPort, protocol: p.protocol ?? 'TCP' })),
      requests: resourcesOf(c, 'requests'),
      limits: resourcesOf(c, 'limits'),
      usage: u ? `CPU ${formatCpu(u.cpu)}, Memory ${formatBytes(u.memory)}` : undefined,
      lastState: last ? `${last.reason ?? 'Terminated'} (exit ${last.exitCode}) ${last.finishedAt ?? ''}`.trim() : undefined,
      command: [...(c.command ?? []), ...(c.args ?? [])].join(' ') || undefined,
      mounts: (c.volumeMounts ?? []).map((m: any) => `${m.mountPath} ← ${m.name}${m.subPath ? `/${m.subPath}` : ''}${m.readOnly ? ' (ro)' : ''}`),
      env: (c.env ?? []).map((e: any) => ({
        name: e.name,
        value:
          e.value ??
          (e.valueFrom?.secretKeyRef
            ? `secret ${e.valueFrom.secretKeyRef.name}:${e.valueFrom.secretKeyRef.key}`
            : e.valueFrom?.configMapKeyRef
              ? `configmap ${e.valueFrom.configMapKeyRef.name}:${e.valueFrom.configMapKeyRef.key}`
              : e.valueFrom?.fieldRef
                ? `field ${e.valueFrom.fieldRef.fieldPath}`
                : e.valueFrom?.resourceFieldRef
                  ? `resource ${e.valueFrom.resourceFieldRef.resource}`
                  : '')
      }))
    };
  };
  return [...(pod.spec?.initContainers ?? []).map((c: any) => describe(c, true)), ...(pod.spec?.containers ?? []).map((c: any) => describe(c, false))];
}

function volumes(pod: K8sObject): KeyValue[] {
  return (pod.spec?.volumes ?? []).map((v: any): KeyValue => {
    const ns = pod.metadata.namespace;
    if (v.secret) {
      return { key: v.name, value: `Secret ${v.secret.secretName}`, link: { kindId: 'secrets', name: v.secret.secretName, namespace: ns } };
    }
    if (v.configMap) {
      return { key: v.name, value: `ConfigMap ${v.configMap.name}`, link: { kindId: 'configmaps', name: v.configMap.name, namespace: ns } };
    }
    if (v.persistentVolumeClaim) {
      return { key: v.name, value: `PVC ${v.persistentVolumeClaim.claimName}`, link: { kindId: 'pvc', name: v.persistentVolumeClaim.claimName, namespace: ns } };
    }
    const type = Object.keys(v).find((key) => key !== 'name') ?? 'unknown';
    return { key: v.name, value: type };
  });
}

function images(template: any): string {
  return (template?.spec?.containers ?? []).map((c: any) => c.image).join(', ');
}

function workloadInfo(kindId: string, obj: K8sObject): KeyValue[] {
  const s = obj.status ?? {};
  const items: KeyValue[] = [{ key: 'Images', value: images(obj.spec?.template) }];
  items.push({ key: 'Selector', value: selectorString(obj.spec?.selector?.matchLabels) || '—' });
  if (kindId === 'deployments') {
    items.push(
      { key: 'Replicas', value: `${obj.spec?.replicas ?? 1} desired, ${s.updatedReplicas ?? 0} updated, ${s.readyReplicas ?? 0} ready, ${s.availableReplicas ?? 0} available, ${s.unavailableReplicas ?? 0} unavailable` },
      { key: 'Strategy', value: obj.spec?.strategy?.type ?? 'RollingUpdate' }
    );
  } else if (kindId === 'statefulsets') {
    items.push(
      { key: 'Replicas', value: `${obj.spec?.replicas ?? 1} desired, ${s.readyReplicas ?? 0} ready, ${s.currentReplicas ?? 0} current` },
      { key: 'Service', value: obj.spec?.serviceName ?? '—' },
      { key: 'Update Strategy', value: obj.spec?.updateStrategy?.type ?? 'RollingUpdate' }
    );
  } else if (kindId === 'daemonsets') {
    items.push(
      { key: 'Nodes', value: `${s.desiredNumberScheduled ?? 0} desired, ${s.currentNumberScheduled ?? 0} scheduled, ${s.numberReady ?? 0} ready, ${s.numberMisscheduled ?? 0} misscheduled` },
      { key: 'Update Strategy', value: obj.spec?.updateStrategy?.type ?? 'RollingUpdate' }
    );
  } else if (kindId === 'replicasets') {
    items.push({ key: 'Replicas', value: `${obj.spec?.replicas ?? 1} desired, ${s.replicas ?? 0} current, ${s.readyReplicas ?? 0} ready` });
  } else if (kindId === 'jobs') {
    items.push(
      { key: 'Completions', value: `${s.succeeded ?? 0}/${obj.spec?.completions ?? 1} succeeded, ${s.failed ?? 0} failed, ${s.active ?? 0} active` },
      { key: 'Parallelism', value: String(obj.spec?.parallelism ?? 1) },
      { key: 'Backoff Limit', value: String(obj.spec?.backoffLimit ?? 6) }
    );
    if (s.startTime) {
      items.push({ key: 'Started', value: s.startTime, time: s.startTime });
    }
    if (s.completionTime) {
      items.push({ key: 'Completed', value: s.completionTime, time: s.completionTime });
    }
  }
  return items;
}

async function podsSections(session: ClusterSession, obj: K8sObject, kindId: string, history: MetricsHistory, range: number): Promise<Section[]> {
  const selector = podSelectorOf(obj, kindId);
  if (!selector) {
    return [];
  }
  const ns = obj.metadata.namespace ?? '';
  const [pods, metrics] = await Promise.all([session.list(getKind('pods')!, ns, { labelSelector: selector }), session.podMetrics(ns)]);
  let items = pods.items;
  if (kindId !== 'services') {
    // A selector can match pods of other controllers; keep only ours where ownership is known.
    const owned = items.filter((p) => isOwnedBy(p, obj, kindId));
    if (owned.length || kindId === 'replicasets' || kindId === 'jobs') {
      items = owned.length ? owned : items;
    }
  }
  let cpu = 0;
  let memory = 0;
  for (const pod of items) {
    const u = metrics?.get(`${ns}/${pod.metadata.name}`);
    cpu += u?.cpu ?? 0;
    memory += u?.memory ?? 0;
  }
  const sections: Section[] = [];
  if (kindId !== 'services') {
    const names = items.map((p) => p.metadata.name);
    sections.push(await metricsSection(session, `workload:${obj.metadata.uid}`, history, metrics ? { cpu, memory } : undefined, items, names.length && names.length <= 200 ? podQueries(ns, names) : undefined, range));
  }
  sections.push({ type: 'table', title: `Pods (${items.length})`, data: buildTable(getKind('pods')!, items, { podMetrics: metrics }) });
  return sections;
}

/** Deployment → ReplicaSet → Pod ownership is two levels deep, so match by pod-template-hash too. */
function isOwnedBy(pod: K8sObject, owner: K8sObject, kindId: string): boolean {
  const refs: any[] = pod.metadata.ownerReferences ?? [];
  if (refs.some((r) => r.uid === owner.metadata.uid)) {
    return true;
  }
  if (kindId === 'deployments') {
    return refs.some((r) => r.kind === 'ReplicaSet' && typeof r.name === 'string' && r.name.startsWith(`${owner.metadata.name}-`));
  }
  return false;
}

async function metricsSection(
  session: ClusterSession,
  key: string,
  history: MetricsHistory,
  usage: { cpu: number; memory: number } | undefined,
  pods: K8sObject[],
  queries: MetricQueries | undefined,
  range: number
): Promise<Section> {
  const endpoint = queries ? await knownPrometheus(session) : undefined;
  const prom = endpoint && queries ? await fetchSeries(session, endpoint, queries, range) : undefined;
  if (!usage && !prom) {
    return { type: 'metrics', title: 'Metrics', series: [], unavailable: session.metricsStatus ?? 'Metrics are not available.' };
  }
  const points = prom ? prom.points : history.record(key, usage!.cpu, usage!.memory);
  const total = (resource: 'cpu' | 'memory', field: 'requests' | 'limits'): number | undefined => {
    let sum = 0;
    for (const pod of pods) {
      for (const c of pod.spec?.containers ?? []) {
        sum += parseQuantity(c.resources?.[field]?.[resource]);
      }
    }
    return sum > 0 ? sum : undefined;
  };
  const series: MetricSeries = {
    title: pods.length === 1 ? 'Pod' : `${pods.length} pods`,
    points,
    cpuRequest: total('cpu', 'requests'),
    cpuLimit: total('cpu', 'limits'),
    memoryRequest: total('memory', 'requests'),
    memoryLimit: total('memory', 'limits'),
    network: prom?.network
  };
  return {
    type: 'metrics',
    title: 'Metrics',
    series: [series],
    source: prom ? 'prometheus' : 'metrics-server',
    range,
    endpoint: endpoint ? endpointLabel(endpoint) : undefined
  };
}

async function nodeSections(session: ClusterSession, node: K8sObject, history: MetricsHistory, range: number): Promise<Section[]> {
  const info = node.status?.nodeInfo ?? {};
  const sections: Section[] = [
    {
      type: 'kv',
      title: 'Node',
      items: [
        { key: 'Roles', value: nodeRoles(node) },
        { key: 'Addresses', value: (node.status?.addresses ?? []).map((a: any) => `${a.type}: ${a.address}`).join(', ') },
        { key: 'OS', value: `${info.osImage ?? ''} (${info.operatingSystem ?? ''}/${info.architecture ?? ''})` },
        { key: 'Kernel', value: info.kernelVersion ?? '' },
        { key: 'Container Runtime', value: info.containerRuntimeVersion ?? '' },
        { key: 'Kubelet', value: info.kubeletVersion ?? '' },
        { key: 'Pod CIDR', value: (node.spec?.podCIDRs ?? [node.spec?.podCIDR]).filter(Boolean).join(', ') || '—' },
        { key: 'Schedulable', value: node.spec?.unschedulable ? 'No (cordoned)' : 'Yes', tone: node.spec?.unschedulable ? 'warn' : undefined },
        {
          key: 'Taints',
          value: (node.spec?.taints ?? []).map((t: any) => `${t.key}${t.value ? `=${t.value}` : ''}:${t.effect}`).join(', ') || '—'
        }
      ]
    }
  ];

  const [podsResult, nodeMetrics, podMetrics] = await Promise.all([
    session.list(getKind('pods')!, '', { fieldSelector: `spec.nodeName=${node.metadata.name}` }).catch(() => ({ items: [] as K8sObject[] })),
    session.nodeMetrics(),
    session.podMetrics()
  ]);
  const pods = podsResult.items.filter((p) => p.status?.phase !== 'Succeeded' && p.status?.phase !== 'Failed');
  const usage = nodeMetrics?.get(node.metadata.name);
  const sum = (resource: 'cpu' | 'memory', field: 'requests' | 'limits'): number =>
    pods.reduce((total, p) => total + (p.spec?.containers ?? []).reduce((s: number, c: any) => s + parseQuantity(c.resources?.[field]?.[resource]), 0), 0);
  sections.push({
    type: 'usage',
    title: 'Resources',
    items: [
      {
        label: 'CPU',
        used: usage?.cpu ?? 0,
        requested: sum('cpu', 'requests'),
        limit: sum('cpu', 'limits'),
        capacity: parseQuantity(node.status?.allocatable?.cpu),
        format: 'cpu'
      },
      {
        label: 'Memory',
        used: usage?.memory ?? 0,
        requested: sum('memory', 'requests'),
        limit: sum('memory', 'limits'),
        capacity: parseQuantity(node.status?.allocatable?.memory),
        format: 'memory'
      },
      { label: 'Pods', used: pods.length, capacity: parseQuantity(node.status?.allocatable?.pods), format: 'count' }
    ]
  });
  const endpoint = await knownPrometheus(session);
  const prom = endpoint ? await fetchSeries(session, endpoint, nodeQueries(node.metadata.name), range) : undefined;
  if (usage || prom) {
    sections.push({
      type: 'metrics',
      title: 'Metrics',
      source: prom ? 'prometheus' : 'metrics-server',
      range,
      endpoint: endpoint ? endpointLabel(endpoint) : undefined,
      series: [
        {
          title: 'Node',
          points: prom ? prom.points : history.record(`node:${node.metadata.name}`, usage!.cpu, usage!.memory),
          network: prom?.network,
          cpuLimit: parseQuantity(node.status?.allocatable?.cpu),
          memoryLimit: parseQuantity(node.status?.allocatable?.memory)
        }
      ]
    });
  } else {
    sections.push({ type: 'metrics', title: 'Metrics', series: [], unavailable: session.metricsStatus ?? 'Metrics are not available.' });
  }
  sections.push(conditions(node));
  sections.push({ type: 'table', title: `Pods (${podsResult.items.length})`, data: buildTable(getKind('pods')!, podsResult.items, { podMetrics }) });
  return sections;
}

async function revisionsSection(session: ClusterSession, kindId: string, obj: K8sObject): Promise<Section> {
  try {
    const revisions = await rolloutHistory(session, kindId, obj);
    return {
      type: 'revisions',
      title: 'Rollout History',
      mode: 'rollout',
      items: revisions.map((r) => ({
        revision: r.revision,
        current: r.current,
        time: r.created,
        description: [r.images, r.changeCause].filter(Boolean).join(' · ')
      }))
    };
  } catch (err) {
    return { type: 'revisions', title: `Rollout History (${errorMessage(err)})`, mode: 'rollout', items: [] };
  }
}

function ingressRules(obj: K8sObject): KeyValue[] {
  const ns = obj.metadata.namespace;
  const items: KeyValue[] = [];
  for (const rule of obj.spec?.rules ?? []) {
    for (const p of rule.http?.paths ?? []) {
      const svc = p.backend?.service;
      items.push({
        key: `${rule.host ?? '*'}${p.path ?? '/'}`,
        value: svc ? `${svc.name}:${svc.port?.number ?? svc.port?.name}` : (p.backend?.resource?.name ?? ''),
        link: svc ? { kindId: 'services', name: svc.name, namespace: ns } : undefined
      });
    }
  }
  for (const tls of obj.spec?.tls ?? []) {
    items.push({
      key: `TLS ${(tls.hosts ?? []).join(', ')}`,
      value: tls.secretName ?? '',
      link: tls.secretName ? { kindId: 'secrets', name: tls.secretName, namespace: ns } : undefined
    });
  }
  return items;
}

function conditions(obj: K8sObject): Section {
  return {
    type: 'conditions',
    title: 'Conditions',
    items: (obj.status?.conditions ?? []).map((c: any) => ({
      type: c.type,
      status: c.status,
      reason: c.reason,
      message: c.message,
      time: c.lastTransitionTime ?? c.lastHeartbeatTime
    }))
  };
}

export function secretEntries(data: Record<string, string>, decode: boolean): SecretEntry[] {
  return Object.entries(data).map(([key, encoded]) => {
    const bytes = Buffer.from(String(encoded), 'base64');
    const text = bytes.toString('utf8');
    const binary = text.includes('�') || /[\x00-\x08\x0E-\x1F]/.test(text);
    return { key, value: binary || !decode ? String(encoded) : text, binary: binary || !decode, size: bytes.length };
  });
}

function specOf(obj: K8sObject): unknown {
  const { apiVersion: _a, kind: _k, metadata: _m, status: _s, ...rest } = obj;
  if (rest.spec !== undefined && Object.keys(rest).length === 1) {
    return rest.spec;
  }
  return Object.keys(rest).length ? rest : undefined;
}

async function eventsSection(session: ClusterSession, kind: ResourceKind, obj: K8sObject): Promise<Section> {
  let items: K8sObject[] = [];
  try {
    items = await session.events(
      kind.namespaced ? obj.metadata.namespace : undefined,
      `involvedObject.name=${obj.metadata.name},involvedObject.kind=${kind.kind}`
    );
  } catch (err) {
    return { type: 'events', title: `Events (${errorMessage(err)})`, items: [] };
  }
  items.sort((a, b) => (Date.parse(eventTime(b) ?? '') || 0) - (Date.parse(eventTime(a) ?? '') || 0));
  return {
    type: 'events',
    title: 'Events',
    items: items.slice(0, 50).map((e) => ({
      type: e.type ?? 'Normal',
      reason: e.reason ?? '',
      message: e.message ?? '',
      count: e.count ?? 1,
      time: eventTime(e),
      source: e.source?.component ?? e.reportingComponent ?? ''
    }))
  };
}

async function helmDetails(session: ClusterSession, secret: K8sObject): Promise<DetailsData> {
  const release = decodeRelease(secret);
  if (!release) {
    return { title: secret.metadata.name, subtitle: 'Helm release', actions: [], sections: [{ type: 'kv', title: 'Error', items: [{ key: 'Release', value: 'Could not decode the release data.', tone: 'error' }] }] };
  }
  const all = await session.list(getKind('secrets')!, release.namespace, { labelSelector: `owner=helm,name=${release.name}` });
  const tone: Tone = release.status === 'deployed' ? 'ok' : release.status === 'failed' ? 'error' : 'warn';
  const sections: Section[] = [
    {
      type: 'kv',
      title: 'Release',
      items: [
        { key: 'Chart', value: `${release.chart}-${release.chartVersion}` },
        { key: 'App Version', value: release.appVersion || '—' },
        { key: 'Revision', value: String(release.revision) },
        { key: 'Namespace', value: release.namespace, link: { kindId: 'namespaces', name: release.namespace } },
        { key: 'Updated', value: release.updated ?? '', time: release.updated },
        { key: 'Description', value: release.description ?? '' }
      ]
    },
    { type: 'code', title: 'Values', language: 'yaml', text: release.values && Object.keys(release.values as object).length ? toYaml(release.values) : '# default values' },
    {
      type: 'revisions',
      title: 'History',
      mode: 'helm',
      items: releaseHistory(all.items, release.name, release.namespace).map((h) => ({
        revision: h.revision,
        current: h.revision === release.revision,
        time: h.updated,
        status: h.status,
        description: `${h.chart}${h.description ? ` · ${h.description}` : ''}`
      }))
    }
  ];
  if (release.notes) {
    sections.push({ type: 'code', title: 'Notes', language: 'text', text: release.notes });
  }
  sections.push({ type: 'code', title: 'Manifest', language: 'yaml', text: release.manifest });
  return {
    title: release.name,
    subtitle: `Helm release · ${release.namespace} · ${session.context}`,
    status: { text: release.status, tone },
    actions: ['helmUninstall'],
    sections
  };
}

