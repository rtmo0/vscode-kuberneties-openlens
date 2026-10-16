/* Data shapes exchanged between the extension host and the webviews. */

export interface WebviewMessage {
  type: string;
  requestId?: string;
  payload?: unknown;
  error?: { message: string; code?: number };
}

export type Tone = 'ok' | 'warn' | 'error' | 'info' | 'muted';

export type ActionId =
  | 'details'
  | 'yaml'
  | 'delete'
  | 'logs'
  | 'shell'
  | 'forward'
  | 'scale'
  | 'restart'
  | 'trigger'
  | 'suspend'
  | 'resume'
  | 'cordon'
  | 'uncordon'
  | 'drain'
  | 'nodeShell'
  | 'debug'
  | 'kubeconfig'
  | 'helmUninstall';

export interface ObjectRef {
  kindId: string;
  name: string;
  namespace?: string;
}

export interface Cell {
  text: string;
  sort?: string | number;
  tone?: Tone;
  /** Render as a coloured badge. */
  badge?: boolean;
  title?: string;
  /** Creation / event time; rendered as a live age. */
  time?: string;
  /** Container status dots. */
  dots?: Array<{ tone: Tone; title: string }>;
  /** Usage bar (0..1). */
  ratio?: number;
  link?: ObjectRef;
}

export interface Column {
  id: string;
  title: string;
  align?: 'left' | 'right';
  /** Column is hidden when the table shows one namespace. */
  namespaceColumn?: boolean;
}

export interface Row {
  key: string;
  name: string;
  namespace?: string;
  cells: Cell[];
  actions: ActionId[];
  /** Text matched by the search box in addition to the cells. */
  search?: string;
}

export interface TableData {
  columns: Column[];
  rows: Row[];
  notice?: string;
  /** Progress shown while additional rows or metadata are still loading. */
  loading?: string;
  metricsAvailable?: boolean;
}

export interface TableInit {
  context: string;
  kindId: string;
  title: string;
  namespaced: boolean;
  namespace: string;
  namespaces: string[];
  bulkActions: ActionId[];
}

/** A resource scope changes on namespace switches; late background results are ignored. */
export interface ResourceTableData extends TableData {
  namespace: string;
  scope: number;
}

/** Changes since the last `data`/`patch` of the same scope; rows not listed are unchanged. */
export interface TablePatch {
  scope: number;
  namespace: string;
  upsert: Row[];
  remove: string[];
  notice?: string;
  loading?: string;
  metricsAvailable?: boolean;
}

export interface TableRowUpdate {
  key: string;
  cells?: Record<string, Cell>;
  actions?: ActionId[];
}

export interface TableSupplement {
  scope: number;
  rows: TableRowUpdate[];
  /** An empty string clears the metrics notice. */
  metricsNotice?: string;
}

// ─────────────────────────── details ───────────────────────────

export interface KeyValue {
  key: string;
  value: string;
  tone?: Tone;
  link?: ObjectRef;
  /** Value is a timestamp, render age next to it. */
  time?: string;
}

export interface ContainerInfo {
  name: string;
  init?: boolean;
  image: string;
  state: string;
  tone: Tone;
  ready: boolean;
  restarts: number;
  ports: Array<{ name?: string; port: number; protocol: string }>;
  requests: string;
  limits: string;
  usage?: string;
  lastState?: string;
  command?: string;
  mounts: string[];
  env: Array<{ name: string; value: string }>;
}

export interface SecretEntry {
  key: string;
  value: string;
  binary: boolean;
  size: number;
}

export interface MetricPoint {
  t: number;
  cpu: number;
  memory: number;
}

export interface MetricSeries {
  title: string;
  points: MetricPoint[];
  /** Bytes per second, from Prometheus. */
  network?: Array<{ t: number; rx: number; tx: number }>;
  cpuRequest?: number;
  cpuLimit?: number;
  memoryRequest?: number;
  memoryLimit?: number;
}

export type Section =
  | { type: 'kv'; title: string; items: KeyValue[] }
  | { type: 'labels'; title: string; items: Array<{ key: string; value: string }> }
  | { type: 'conditions'; title: string; items: Array<{ type: string; status: string; reason?: string; message?: string; time?: string }> }
  | { type: 'containers'; title: string; items: ContainerInfo[]; podName: string; namespace: string }
  | { type: 'metrics'; title: string; series: MetricSeries[]; unavailable?: string; source?: 'prometheus' | 'metrics-server'; range?: number; endpoint?: string }
  | { type: 'usage'; title: string; items: Array<{ label: string; used: number; requested?: number; limit?: number; capacity: number; format: 'cpu' | 'memory' | 'count' }> }
  | { type: 'table'; title: string; data: TableData }
  | { type: 'secret'; title: string; items: SecretEntry[]; editable: boolean; encoded: boolean }
  | { type: 'ports'; title: string; items: Array<{ name?: string; port: number; targetPort: string; protocol: string; nodePort?: number }>; serviceName: string; namespace: string }
  | { type: 'code'; title: string; language: string; text: string }
  | { type: 'events'; title: string; items: Array<{ type: string; reason: string; message: string; count: number; time?: string; source: string }> }
  | {
      type: 'revisions';
      title: string;
      mode: 'rollout' | 'helm';
      items: Array<{ revision: number; current: boolean; time?: string; status?: string; description: string }>;
    };

export interface DetailsData {
  ref?: ObjectRef;
  pinned?: boolean;
  title: string;
  subtitle: string;
  status?: { text: string; tone: Tone };
  actions: ActionId[];
  sections: Section[];
}

// ─────────────────────────── dashboard ───────────────────────────

export interface DashboardData {
  context: string;
  server: string;
  version?: string;
  namespace: string;
  namespaces: string[];
  metricsAvailable: boolean;
  nodes: { total: number; ready: number };
  cpu: { usage: number; requests: number; limits: number; allocatable: number; capacity: number };
  memory: { usage: number; requests: number; limits: number; allocatable: number; capacity: number };
  pods: { usage: number; capacity: number };
  workloads: Array<{ kindId: string; title: string; total: number; ok: number; warn: number; error: number }>;
  podPhases: Array<{ label: string; count: number; tone: Tone }>;
  warnings: Array<{ reason: string; message: string; object: string; link?: ObjectRef; namespace?: string; count: number; time?: string }>;
  history: MetricPoint[];
  historySource: 'prometheus' | 'metrics-server';
  range: number;
  notices: string[];
}
