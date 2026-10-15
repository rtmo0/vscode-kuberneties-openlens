/* Metric history from Prometheus, reached through the API server's service proxy. */
import type { ClusterSession, K8sObject } from './cluster';
import { getConfig } from './config';
import { errorMessage } from './kubeRest';
import { logger } from './logger';

export interface PrometheusEndpoint {
  namespace: string;
  service: string;
  port: string;
}

export interface RangePoint {
  t: number;
  v: number;
}

const DETECT_CACHE_MS = 10 * 60_000;
const detected = new WeakMap<ClusterSession, { at: number; endpoint: Promise<PrometheusEndpoint | undefined> }>();

/** Well-known Prometheus services (kube-prometheus-stack, prometheus-community, Lens metrics, OpenShift…). */
const WELL_KNOWN: Array<[string, string, string]> = [
  ['monitoring', 'prometheus-operated', '9090'],
  ['monitoring', 'kube-prometheus-stack-prometheus', '9090'],
  ['monitoring', 'prometheus-k8s', '9090'],
  ['monitoring', 'prometheus-server', '80'],
  ['prometheus', 'prometheus-server', '80'],
  ['prometheus', 'prometheus-operated', '9090'],
  ['lens-metrics', 'prometheus', '80'],
  ['openshift-monitoring', 'prometheus-k8s', '9091'],
  ['kube-system', 'prometheus', '9090'],
  ['default', 'prometheus', '9090']
];

/** Setting format: "namespace/service:port". */
export function parseEndpoint(value: string): PrometheusEndpoint | undefined {
  const match = /^([^/]+)\/([^:]+):(.+)$/.exec(value.trim());
  return match ? { namespace: match[1], service: match[2], port: match[3] } : undefined;
}

export function endpointLabel(endpoint: PrometheusEndpoint): string {
  return `${endpoint.namespace}/${endpoint.service}:${endpoint.port}`;
}

function proxyBase(endpoint: PrometheusEndpoint): string {
  return `/api/v1/namespaces/${encodeURIComponent(endpoint.namespace)}/services/${encodeURIComponent(`${endpoint.service}:${endpoint.port}`)}/proxy`;
}

async function responds(session: ClusterSession, endpoint: PrometheusEndpoint): Promise<boolean> {
  try {
    const result = await session.rest.get<{ status?: string }>(`${proxyBase(endpoint)}/api/v1/query`, { query: '1' }, { timeoutMs: 5000 });
    return result?.status === 'success';
  } catch {
    return false;
  }
}

/** The Prometheus to use for a context: the setting, else the first well-known or labelled service that answers. */
export function prometheusFor(session: ClusterSession): Promise<PrometheusEndpoint | undefined> {
  const configured = getConfig().prometheus[session.context];
  const cached = detected.get(session);
  if (cached && Date.now() - cached.at < DETECT_CACHE_MS) {
    return cached.endpoint;
  }
  const endpoint = (async (): Promise<PrometheusEndpoint | undefined> => {
    if (configured === 'off') {
      return undefined;
    }
    if (configured) {
      const parsed = parseEndpoint(configured);
      if (!parsed) {
        logger.warn(`openLens.prometheus["${session.context}"] must look like "namespace/service:port"`);
      }
      return parsed;
    }
    const candidates: PrometheusEndpoint[] = WELL_KNOWN.map(([namespace, service, port]) => ({ namespace, service, port }));
    try {
      const services = await session.rest.get<{ items: K8sObject[] }>('/api/v1/services', { labelSelector: 'app.kubernetes.io/name=prometheus' });
      for (const svc of services.items ?? []) {
        const port = (svc.spec?.ports ?? []).find((p: any) => p.port === 9090 || p.name === 'web' || p.name === 'http') ?? svc.spec?.ports?.[0];
        if (port) {
          candidates.unshift({ namespace: svc.metadata.namespace!, service: svc.metadata.name, port: String(port.port) });
        }
      }
    } catch {
      // no cluster-wide service list; fall back to the well-known names
    }
    for (const candidate of candidates) {
      if (await responds(session, candidate)) {
        logger.info(`Using Prometheus ${endpointLabel(candidate)} for ${session.context}`);
        return candidate;
      }
    }
    return undefined;
  })();
  detected.set(session, { at: Date.now(), endpoint });
  return endpoint;
}

export function forgetPrometheus(session: ClusterSession): void {
  detected.delete(session);
}

export async function queryRange(session: ClusterSession, endpoint: PrometheusEndpoint, query: string, rangeSeconds: number): Promise<RangePoint[]> {
  const end = Math.floor(Date.now() / 1000);
  const step = Math.max(15, Math.round(rangeSeconds / 240));
  const result = await session.rest.get<{ status: string; data?: { result?: Array<{ values: Array<[number, string]> }> }; error?: string }>(
    `${proxyBase(endpoint)}/api/v1/query_range`,
    { query, start: end - rangeSeconds, end, step },
    { timeoutMs: 15_000 }
  );
  if (result.status !== 'success') {
    throw new Error(result.error ?? 'Prometheus query failed');
  }
  const series = result.data?.result ?? [];
  if (!series.length) {
    return [];
  }
  // sum(...) queries return one series.
  return series[0].values.map(([t, v]) => ({ t: t * 1000, v: Number(v) })).filter((p) => Number.isFinite(p.v));
}

const esc = (value: string): string => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
const escRegex = (value: string): string => esc(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

export interface MetricQueries {
  cpu: string;
  memory: string;
  rx?: string;
  tx?: string;
}

export function podQueries(namespace: string, pods: string[]): MetricQueries {
  const podSel = pods.length === 1 ? `pod="${esc(pods[0])}"` : `pod=~"${pods.map(escRegex).join('|')}"`;
  const sel = `namespace="${esc(namespace)}",${podSel}`;
  return {
    cpu: `sum(rate(container_cpu_usage_seconds_total{${sel},container!="",container!="POD"}[2m]))`,
    memory: `sum(container_memory_working_set_bytes{${sel},container!="",container!="POD"})`,
    rx: `sum(rate(container_network_receive_bytes_total{${sel}}[2m]))`,
    tx: `sum(rate(container_network_transmit_bytes_total{${sel}}[2m]))`
  };
}

export function nodeQueries(node: string): MetricQueries {
  const sel = `id="/",node="${esc(node)}"`;
  return {
    cpu: `sum(rate(container_cpu_usage_seconds_total{${sel}}[2m]))`,
    memory: `sum(container_memory_working_set_bytes{${sel}})`,
    rx: `sum(rate(container_network_receive_bytes_total{${sel}}[2m]))`,
    tx: `sum(rate(container_network_transmit_bytes_total{${sel}}[2m]))`
  };
}

export function clusterQueries(namespace: string): MetricQueries {
  if (namespace) {
    const sel = `namespace="${esc(namespace)}",container!="",container!="POD"`;
    return { cpu: `sum(rate(container_cpu_usage_seconds_total{${sel}}[2m]))`, memory: `sum(container_memory_working_set_bytes{${sel}})` };
  }
  return { cpu: 'sum(rate(container_cpu_usage_seconds_total{id="/"}[2m]))', memory: 'sum(container_memory_working_set_bytes{id="/"})' };
}

export interface RangeSeries {
  points: Array<{ t: number; cpu: number; memory: number }>;
  network?: Array<{ t: number; rx: number; tx: number }>;
}

/** Run a query set and join the series by timestamp. */
export async function fetchSeries(session: ClusterSession, endpoint: PrometheusEndpoint, queries: MetricQueries, rangeSeconds: number): Promise<RangeSeries | undefined> {
  try {
    const [cpu, memory, rx, tx] = await Promise.all([
      queryRange(session, endpoint, queries.cpu, rangeSeconds),
      queryRange(session, endpoint, queries.memory, rangeSeconds),
      queries.rx ? queryRange(session, endpoint, queries.rx, rangeSeconds) : Promise.resolve([]),
      queries.tx ? queryRange(session, endpoint, queries.tx, rangeSeconds) : Promise.resolve([])
    ]);
    if (!cpu.length && !memory.length) {
      return undefined;
    }
    const memoryByT = new Map(memory.map((p) => [p.t, p.v]));
    const times = cpu.length ? cpu.map((p) => p.t) : memory.map((p) => p.t);
    const cpuByT = new Map(cpu.map((p) => [p.t, p.v]));
    const points = times.map((t) => ({ t, cpu: cpuByT.get(t) ?? 0, memory: memoryByT.get(t) ?? 0 }));
    let network: RangeSeries['network'];
    if (rx.length || tx.length) {
      const txByT = new Map(tx.map((p) => [p.t, p.v]));
      network = (rx.length ? rx : tx).map((p) => ({ t: p.t, rx: rx.length ? p.v : 0, tx: txByT.get(p.t) ?? 0 }));
    }
    return { points, network };
  } catch (err) {
    logger.warn(`Prometheus query failed for ${session.context}`, errorMessage(err));
    return undefined;
  }
}
