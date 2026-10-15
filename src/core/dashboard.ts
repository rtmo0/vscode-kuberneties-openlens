/* Data for the cluster overview (Lens "Cluster" page). */
import type { ClusterSession, K8sObject } from './cluster';
import { eventTime } from './columns';
import { parseQuantity } from './format';
import { errorMessage, isForbidden } from './kubeRest';
import type { DashboardData, MetricPoint, Tone } from './protocol';
import { findKindByKind, getKind } from './resources';
import { nodeReady, podStatus, workloadHealth } from './status';
import { clusterQueries, fetchSeries, prometheusFor } from './prometheus';

const HISTORY_POINTS = 90;
const histories = new WeakMap<ClusterSession, Map<string, MetricPoint[]>>();

const WORKLOADS = ['deployments', 'statefulsets', 'daemonsets', 'jobs', 'cronjobs'];

export async function buildDashboard(session: ClusterSession, namespace: string, range = 3600): Promise<DashboardData> {
  const notices: string[] = [];
  const softList = async (kindId: string, ns: string): Promise<K8sObject[]> => {
    try {
      const result = await session.list(getKind(kindId)!, ns);
      if (result.notice) {
        notices.push(result.notice);
      }
      return result.items;
    } catch (err) {
      if (!isForbidden(err)) {
        notices.push(`${getKind(kindId)!.title}: ${errorMessage(err)}`);
      }
      return [];
    }
  };

  const [nodes, pods, nodeMetrics, podMetrics, events, namespaces, ...workloadLists] = await Promise.all([
    softList('nodes', ''),
    softList('pods', namespace),
    session.nodeMetrics(),
    namespace ? session.podMetrics(namespace) : Promise.resolve(undefined),
    session.events(namespace || undefined, 'type=Warning').catch(() => [] as K8sObject[]),
    session.namespaces().catch(() => [] as string[]),
    ...WORKLOADS.map((id) => softList(id, namespace))
  ]);

  const sum = (values: number[]): number => values.reduce((a, b) => a + b, 0);
  const activePods = pods.filter((p) => p.status?.phase !== 'Succeeded' && p.status?.phase !== 'Failed');
  const containerTotal = (resource: 'cpu' | 'memory', field: 'requests' | 'limits'): number =>
    sum(activePods.flatMap((p) => (p.spec?.containers ?? []).map((c: any) => parseQuantity(c.resources?.[field]?.[resource]))));

  const nodeTotal = (key: 'cpu' | 'memory' | 'pods', field: 'allocatable' | 'capacity'): number =>
    sum(nodes.map((n) => parseQuantity(n.status?.[field]?.[key])));

  // With a namespace filter, usage is the namespace's pods; otherwise the nodes'.
  const usage = namespace
    ? {
        cpu: sum([...(podMetrics?.values() ?? [])].map((u) => u.cpu)),
        memory: sum([...(podMetrics?.values() ?? [])].map((u) => u.memory))
      }
    : {
        cpu: sum([...(nodeMetrics?.values() ?? [])].map((u) => u.cpu)),
        memory: sum([...(nodeMetrics?.values() ?? [])].map((u) => u.memory))
      };
  const metricsAvailable = namespace ? !!podMetrics : !!nodeMetrics;

  if (metricsAvailable) {
    let byScope = histories.get(session);
    if (!byScope) {
      byScope = new Map();
      histories.set(session, byScope);
    }
    const history = byScope.get(namespace) ?? [];
    history.push({ t: Date.now(), cpu: usage.cpu, memory: usage.memory });
    if (history.length > HISTORY_POINTS) {
      history.splice(0, history.length - HISTORY_POINTS);
    }
    byScope.set(namespace, history);
  } else if (session.metricsStatus) {
    notices.push(session.metricsStatus);
  }

  const phases = new Map<string, { count: number; tone: Tone }>();
  for (const pod of pods) {
    const status = podStatus(pod);
    const label = status.tone === 'ok' ? 'Running' : status.tone === 'muted' ? (status.text === 'Terminating' ? 'Terminating' : 'Succeeded') : status.tone === 'error' ? 'Failed' : 'Pending';
    const entry = phases.get(label) ?? { count: 0, tone: status.tone };
    entry.count += 1;
    phases.set(label, entry);
  }

  const workloads = WORKLOADS.map((kindId, index) => {
    const items = workloadLists[index];
    let ok = 0;
    let warn = 0;
    let error = 0;
    for (const item of items) {
      if (kindId === 'cronjobs') {
        if (item.spec?.suspend) {
          warn += 1;
        } else {
          ok += 1;
        }
        continue;
      }
      const tone = workloadHealth(item, kindId).tone;
      if (tone === 'error') {
        error += 1;
      } else if (tone === 'warn') {
        warn += 1;
      } else {
        ok += 1;
      }
    }
    return { kindId, title: getKind(kindId)!.title, total: items.length, ok, warn, error };
  });
  workloads.unshift({
    kindId: 'pods',
    title: 'Pods',
    total: pods.length,
    ok: phases.get('Running')?.count ?? 0,
    warn: phases.get('Pending')?.count ?? 0,
    error: phases.get('Failed')?.count ?? 0
  });

  const warnings = events
    .sort((a, b) => (Date.parse(eventTime(b) ?? '') || 0) - (Date.parse(eventTime(a) ?? '') || 0))
    .slice(0, 50)
    .map((e) => {
      const ref = e.involvedObject ?? e.regarding ?? {};
      const kind = findKindByKind(ref.apiVersion, ref.kind);
      return {
        reason: e.reason ?? '',
        message: e.message ?? e.note ?? '',
        object: `${ref.kind ?? ''}/${ref.name ?? ''}`,
        namespace: ref.namespace,
        link: kind && ref.name ? { kindId: kind.id, name: ref.name, namespace: ref.namespace } : undefined,
        count: e.count ?? e.series?.count ?? 1,
        time: eventTime(e)
      };
    });

  const endpoint = await prometheusFor(session);
  const prom = endpoint ? await fetchSeries(session, endpoint, clusterQueries(namespace), range) : undefined;

  return {
    context: session.context,
    server: session.server,
    version: session.version,
    namespace,
    namespaces,
    metricsAvailable,
    nodes: { total: nodes.length, ready: nodes.filter(nodeReady).length },
    cpu: {
      usage: usage.cpu,
      requests: containerTotal('cpu', 'requests'),
      limits: containerTotal('cpu', 'limits'),
      allocatable: nodeTotal('cpu', 'allocatable'),
      capacity: nodeTotal('cpu', 'capacity')
    },
    memory: {
      usage: usage.memory,
      requests: containerTotal('memory', 'requests'),
      limits: containerTotal('memory', 'limits'),
      allocatable: nodeTotal('memory', 'allocatable'),
      capacity: nodeTotal('memory', 'capacity')
    },
    pods: { usage: activePods.length, capacity: nodeTotal('pods', 'allocatable') },
    workloads,
    podPhases: [...phases.entries()].map(([label, v]) => ({ label, count: v.count, tone: v.tone })),
    warnings,
    history: prom?.points ?? histories.get(session)?.get(namespace) ?? [],
    historySource: prom ? 'prometheus' : 'metrics-server',
    range,
    notices: [...new Set(notices)]
  };
}
