/* Table columns for every built-in kind (what `kubectl get -o wide` / Lens show). */
import type { K8sObject, PodUsage, Usage } from './cluster';
import { formatBytes, formatCpu, parseQuantity } from './format';
import { decodeRelease, latestReleaseSecrets } from './helm';
import type { ActionId, Cell, Column, Row, TableData, Tone } from './protocol';
import { findKindByKind, ResourceKind } from './resources';
import { containerDots, nodeRoles, nodeStatus, ownerOf, podRestarts, podStatus, selectorString, workloadHealth } from './status';

export interface TableContext {
  podMetrics?: Map<string, PodUsage>;
  nodeMetrics?: Map<string, Usage>;
  /** Pods per node, for the node table. */
  podsPerNode?: Map<string, number>;
}

type ColumnSpec = Column & { cell: (obj: K8sObject) => Cell };

const text = (value: unknown, tone?: Tone): Cell => ({ text: value === undefined || value === null || value === '' ? '—' : String(value), tone });
const badge = (value: string, tone: Tone): Cell => ({ text: value, tone, badge: true });
const num = (value: number, display?: string): Cell => ({ text: display ?? String(value), sort: value });

const NAME: ColumnSpec = { id: 'name', title: 'Name', cell: (o) => ({ text: o.metadata.name }) };
const NAMESPACE: ColumnSpec = {
  id: 'namespace',
  title: 'Namespace',
  namespaceColumn: true,
  cell: (o) => text(o.metadata.namespace)
};
const AGE: ColumnSpec = {
  id: 'age',
  title: 'Age',
  align: 'right',
  cell: (o) => ({ text: '', time: o.metadata.creationTimestamp, sort: -Date.parse(o.metadata.creationTimestamp ?? '') || 0 })
};

const keysCell = (data: Record<string, unknown> | undefined, binary?: Record<string, unknown>): Cell => {
  const keys = [...Object.keys(data ?? {}), ...Object.keys(binary ?? {})];
  return { text: keys.length ? keys.join(', ') : '—', sort: keys.length, title: keys.join('\n') };
};

function workloadPods(kindId: string): ColumnSpec {
  return {
    id: 'pods',
    title: 'Pods',
    cell: (o) => {
      const h = workloadHealth(o, kindId);
      return { text: `${h.ready}/${h.desired}`, tone: h.tone, sort: h.desired ? h.ready / h.desired : 1 };
    }
  };
}

function conditionsCell(o: K8sObject): Cell {
  const active = (o.status?.conditions ?? []).filter((c: any) => c.status === 'True').map((c: any) => c.type);
  const bad = (o.status?.conditions ?? []).some(
    (c: any) => (c.type === 'Available' && c.status !== 'True') || (c.type === 'ReplicaFailure' && c.status === 'True')
  );
  return { text: active.join(' ') || '—', tone: bad ? 'error' : active.length ? 'ok' : 'muted' };
}

function servicePorts(o: K8sObject): string {
  return (o.spec?.ports ?? [])
    .map((p: any) => `${p.port}${p.nodePort ? `:${p.nodePort}` : ''}/${p.protocol ?? 'TCP'}`)
    .join(', ');
}

function externalIps(o: K8sObject): string {
  const ingress = (o.status?.loadBalancer?.ingress ?? []).map((i: any) => i.ip || i.hostname);
  return [...ingress, ...(o.spec?.externalIPs ?? [])].join(', ') || (o.spec?.type === 'ExternalName' ? o.spec.externalName : '');
}

function linkToOwner(o: K8sObject): Cell {
  const owner = ownerOf(o);
  if (!owner) {
    return text('');
  }
  const kind = findKindByKind(undefined, owner.kind);
  return {
    text: `${owner.kind}/${owner.name}`,
    link: kind ? { kindId: kind.id, name: owner.name, namespace: o.metadata.namespace } : undefined
  };
}

function podColumns(ctx: TableContext): ColumnSpec[] {
  const usage = (o: K8sObject): PodUsage | undefined => ctx.podMetrics?.get(`${o.metadata.namespace}/${o.metadata.name}`);
  return [
    NAME,
    NAMESPACE,
    { id: 'containers', title: 'Containers', cell: (o) => ({ text: '', dots: containerDots(o), sort: (o.spec?.containers ?? []).length }) },
    {
      id: 'cpu',
      title: 'CPU',
      align: 'right',
      cell: (o) => {
        const u = usage(o);
        return u ? num(u.cpu, formatCpu(u.cpu)) : text('');
      }
    },
    {
      id: 'memory',
      title: 'Memory',
      align: 'right',
      cell: (o) => {
        const u = usage(o);
        return u ? num(u.memory, formatBytes(u.memory)) : text('');
      }
    },
    {
      id: 'restarts',
      title: 'Restarts',
      align: 'right',
      cell: (o) => {
        const r = podRestarts(o);
        return { text: String(r), sort: r, tone: r > 0 ? 'warn' : undefined };
      }
    },
    { id: 'owner', title: 'Controlled By', cell: linkToOwner },
    {
      id: 'node',
      title: 'Node',
      cell: (o) => (o.spec?.nodeName ? { text: o.spec.nodeName, link: { kindId: 'nodes', name: o.spec.nodeName } } : text(''))
    },
    { id: 'qos', title: 'QoS', cell: (o) => text(o.status?.qosClass) },
    AGE,
    {
      id: 'status',
      title: 'Status',
      cell: (o) => {
        const s = podStatus(o);
        return badge(s.text, s.tone);
      }
    }
  ];
}

function nodeColumns(ctx: TableContext): ColumnSpec[] {
  const usageCell = (o: K8sObject, key: 'cpu' | 'memory'): Cell => {
    const used = ctx.nodeMetrics?.get(o.metadata.name)?.[key];
    const allocatable = parseQuantity(o.status?.allocatable?.[key]);
    if (used === undefined || !allocatable) {
      return text('');
    }
    const ratio = used / allocatable;
    const fmt = key === 'cpu' ? formatCpu : formatBytes;
    return {
      text: `${Math.round(ratio * 100)}%`,
      sort: ratio,
      ratio,
      title: `${fmt(used)} of ${fmt(allocatable)} allocatable`,
      tone: ratio > 0.9 ? 'error' : ratio > 0.75 ? 'warn' : 'ok'
    };
  };
  return [
    NAME,
    { id: 'cpu', title: 'CPU', align: 'right', cell: (o) => usageCell(o, 'cpu') },
    { id: 'memory', title: 'Memory', align: 'right', cell: (o) => usageCell(o, 'memory') },
    {
      id: 'pods',
      title: 'Pods',
      align: 'right',
      cell: (o) => {
        const count = ctx.podsPerNode?.get(o.metadata.name);
        const capacity = parseQuantity(o.status?.allocatable?.pods);
        return count === undefined ? text(capacity || '') : num(count, `${count}/${capacity}`);
      }
    },
    { id: 'roles', title: 'Roles', cell: (o) => text(nodeRoles(o)) },
    { id: 'version', title: 'Version', cell: (o) => text(o.status?.nodeInfo?.kubeletVersion) },
    {
      id: 'ip',
      title: 'Internal IP',
      cell: (o) => text((o.status?.addresses ?? []).find((a: any) => a.type === 'InternalIP')?.address)
    },
    {
      id: 'taints',
      title: 'Taints',
      align: 'right',
      cell: (o) => {
        const taints = o.spec?.taints ?? [];
        return { text: String(taints.length), sort: taints.length, title: taints.map((t: any) => `${t.key}=${t.value ?? ''}:${t.effect}`).join('\n') };
      }
    },
    AGE,
    {
      id: 'status',
      title: 'Conditions',
      cell: (o) => {
        const s = nodeStatus(o);
        return badge(s.text, s.tone);
      }
    }
  ];
}

const COLUMNS: Record<string, (ctx: TableContext) => ColumnSpec[]> = {
  pods: podColumns,
  nodes: nodeColumns,
  namespaces: () => [
    NAME,
    {
      id: 'labels',
      title: 'Labels',
      cell: (o) => text(selectorString(o.metadata.labels))
    },
    AGE,
    { id: 'status', title: 'Status', cell: (o) => badge(o.status?.phase ?? 'Active', o.status?.phase === 'Terminating' ? 'warn' : 'ok') }
  ],
  events: () => [
    {
      id: 'type',
      title: 'Type',
      cell: (o) => badge(o.type ?? 'Normal', o.type === 'Warning' ? 'warn' : 'muted')
    },
    { id: 'reason', title: 'Reason', cell: (o) => text(o.reason) },
    { id: 'message', title: 'Message', cell: (o) => ({ text: o.message ?? '', title: o.message }) },
    NAMESPACE,
    {
      id: 'object',
      title: 'Involved Object',
      cell: (o) => {
        const ref = o.involvedObject ?? o.regarding ?? {};
        const kind = findKindByKind(ref.apiVersion, ref.kind);
        return {
          text: `${ref.kind ?? ''}/${ref.name ?? ''}`,
          link: kind && ref.name ? { kindId: kind.id, name: ref.name, namespace: ref.namespace } : undefined
        };
      }
    },
    { id: 'source', title: 'Source', cell: (o) => text(o.source?.component ?? o.reportingComponent) },
    { id: 'count', title: 'Count', align: 'right', cell: (o) => num(o.count ?? 1) },
    {
      id: 'lastSeen',
      title: 'Last Seen',
      align: 'right',
      cell: (o) => {
        const t = eventTime(o);
        return { text: '', time: t, sort: -Date.parse(t ?? '') || 0 };
      }
    }
  ],
  deployments: () => [
    NAME,
    NAMESPACE,
    workloadPods('deployments'),
    { id: 'replicas', title: 'Replicas', align: 'right', cell: (o) => num(o.spec?.replicas ?? 1) },
    { id: 'updated', title: 'Up-to-date', align: 'right', cell: (o) => num(o.status?.updatedReplicas ?? 0) },
    { id: 'available', title: 'Available', align: 'right', cell: (o) => num(o.status?.availableReplicas ?? 0) },
    AGE,
    { id: 'conditions', title: 'Conditions', cell: conditionsCell }
  ],
  daemonsets: () => [
    NAME,
    NAMESPACE,
    workloadPods('daemonsets'),
    { id: 'nodeSelector', title: 'Node Selector', cell: (o) => text(selectorString(o.spec?.template?.spec?.nodeSelector)) },
    AGE
  ],
  statefulsets: () => [
    NAME,
    NAMESPACE,
    workloadPods('statefulsets'),
    { id: 'replicas', title: 'Replicas', align: 'right', cell: (o) => num(o.spec?.replicas ?? 1) },
    { id: 'service', title: 'Service', cell: (o) => text(o.spec?.serviceName) },
    AGE
  ],
  replicasets: () => [
    NAME,
    NAMESPACE,
    { id: 'desired', title: 'Desired', align: 'right', cell: (o) => num(o.spec?.replicas ?? 1) },
    { id: 'current', title: 'Current', align: 'right', cell: (o) => num(o.status?.replicas ?? 0) },
    workloadPods('replicasets'),
    { id: 'owner', title: 'Controlled By', cell: linkToOwner },
    AGE
  ],
  jobs: () => [
    NAME,
    NAMESPACE,
    workloadPods('jobs'),
    {
      id: 'duration',
      title: 'Duration',
      align: 'right',
      cell: (o) => {
        const start = Date.parse(o.status?.startTime ?? '');
        if (!start) {
          return text('');
        }
        const end = Date.parse(o.status?.completionTime ?? '') || Date.now();
        const seconds = Math.round((end - start) / 1000);
        return num(seconds, seconds < 120 ? `${seconds}s` : `${Math.round(seconds / 60)}m`);
      }
    },
    { id: 'owner', title: 'Controlled By', cell: linkToOwner },
    AGE,
    {
      id: 'status',
      title: 'Status',
      cell: (o) => {
        const conditions: any[] = o.status?.conditions ?? [];
        if (conditions.some((c) => c.type === 'Failed' && c.status === 'True')) {
          return badge('Failed', 'error');
        }
        if (conditions.some((c) => c.type === 'Complete' && c.status === 'True')) {
          return badge('Complete', 'muted');
        }
        if (o.spec?.suspend) {
          return badge('Suspended', 'muted');
        }
        return badge('Running', 'ok');
      }
    }
  ],
  cronjobs: () => [
    NAME,
    NAMESPACE,
    { id: 'schedule', title: 'Schedule', cell: (o) => text(o.spec?.schedule) },
    {
      id: 'suspend',
      title: 'Suspend',
      cell: (o) => (o.spec?.suspend ? badge('Suspended', 'warn') : text('False', 'muted'))
    },
    { id: 'active', title: 'Active', align: 'right', cell: (o) => num((o.status?.active ?? []).length) },
    {
      id: 'lastSchedule',
      title: 'Last Schedule',
      align: 'right',
      cell: (o) => ({ text: o.status?.lastScheduleTime ? '' : '—', time: o.status?.lastScheduleTime, sort: -Date.parse(o.status?.lastScheduleTime ?? '') || 0 })
    },
    AGE
  ],
  configmaps: () => [NAME, NAMESPACE, { id: 'keys', title: 'Keys', cell: (o) => keysCell(o.data, o.binaryData) }, AGE],
  secrets: () => [
    NAME,
    NAMESPACE,
    { id: 'type', title: 'Type', cell: (o) => text(o.type) },
    { id: 'keys', title: 'Keys', cell: (o) => keysCell(o.data) },
    AGE
  ],
  resourcequotas: () => [
    NAME,
    NAMESPACE,
    {
      id: 'used',
      title: 'Used / Hard',
      cell: (o) =>
        text(
          Object.entries(o.status?.hard ?? o.spec?.hard ?? {})
            .map(([key, hard]) => `${key}: ${o.status?.used?.[key] ?? 0}/${hard}`)
            .join(', ')
        )
    },
    AGE
  ],
  limitranges: () => [NAME, NAMESPACE, AGE],
  hpa: () => [
    NAME,
    NAMESPACE,
    {
      id: 'reference',
      title: 'Reference',
      cell: (o) => {
        const ref = o.spec?.scaleTargetRef ?? {};
        const kind = findKindByKind(undefined, ref.kind);
        return { text: `${ref.kind}/${ref.name}`, link: kind ? { kindId: kind.id, name: ref.name, namespace: o.metadata.namespace } : undefined };
      }
    },
    { id: 'targets', title: 'Targets', cell: (o) => text(hpaTargets(o)) },
    { id: 'min', title: 'Min Pods', align: 'right', cell: (o) => num(o.spec?.minReplicas ?? 1) },
    { id: 'max', title: 'Max Pods', align: 'right', cell: (o) => num(o.spec?.maxReplicas ?? 0) },
    { id: 'replicas', title: 'Replicas', align: 'right', cell: (o) => num(o.status?.currentReplicas ?? 0) },
    AGE
  ],
  pdb: () => [
    NAME,
    NAMESPACE,
    { id: 'min', title: 'Min Available', cell: (o) => text(o.spec?.minAvailable) },
    { id: 'max', title: 'Max Unavailable', cell: (o) => text(o.spec?.maxUnavailable) },
    { id: 'allowed', title: 'Allowed Disruptions', align: 'right', cell: (o) => num(o.status?.disruptionsAllowed ?? 0) },
    AGE
  ],
  priorityclasses: () => [
    NAME,
    { id: 'value', title: 'Value', align: 'right', cell: (o) => num(o.value ?? 0) },
    { id: 'default', title: 'Global Default', cell: (o) => text(o.globalDefault ? 'True' : 'False') },
    AGE
  ],
  services: () => [
    NAME,
    NAMESPACE,
    { id: 'type', title: 'Type', cell: (o) => text(o.spec?.type) },
    { id: 'clusterIP', title: 'Cluster IP', cell: (o) => text(o.spec?.clusterIP) },
    { id: 'ports', title: 'Ports', cell: (o) => text(servicePorts(o)) },
    { id: 'external', title: 'External IP', cell: (o) => text(externalIps(o)) },
    { id: 'selector', title: 'Selector', cell: (o) => text(selectorString(o.spec?.selector)) },
    AGE
  ],
  endpoints: () => [
    NAME,
    NAMESPACE,
    {
      id: 'endpoints',
      title: 'Endpoints',
      cell: (o) => {
        const list: string[] = [];
        for (const subset of o.subsets ?? []) {
          for (const address of subset.addresses ?? []) {
            for (const port of subset.ports ?? [{ port: '' }]) {
              list.push(`${address.ip}${port.port ? `:${port.port}` : ''}`);
            }
          }
        }
        return { text: list.slice(0, 5).join(', ') + (list.length > 5 ? ` +${list.length - 5} more` : '') || '<none>', sort: list.length };
      }
    },
    AGE
  ],
  ingresses: () => [
    NAME,
    NAMESPACE,
    { id: 'class', title: 'Class', cell: (o) => text(o.spec?.ingressClassName ?? o.metadata.annotations?.['kubernetes.io/ingress.class']) },
    {
      id: 'hosts',
      title: 'Rules',
      cell: (o) =>
        text(
          (o.spec?.rules ?? [])
            .flatMap((r: any) =>
              (r.http?.paths ?? [{ path: '/' }]).map(
                (p: any) => `${r.host ?? '*'}${p.path ?? '/'} → ${p.backend?.service?.name ?? ''}${p.backend?.service?.port ? `:${p.backend.service.port.number ?? p.backend.service.port.name}` : ''}`
              )
            )
            .join(', ')
        )
    },
    { id: 'address', title: 'Load Balancer', cell: (o) => text(externalIps(o)) },
    AGE
  ],
  ingressclasses: () => [
    NAME,
    { id: 'controller', title: 'Controller', cell: (o) => text(o.spec?.controller) },
    {
      id: 'default',
      title: 'Default',
      cell: (o) => text(o.metadata.annotations?.['ingressclass.kubernetes.io/is-default-class'] === 'true' ? 'Yes' : 'No')
    },
    AGE
  ],
  networkpolicies: () => [
    NAME,
    NAMESPACE,
    { id: 'podSelector', title: 'Pod Selector', cell: (o) => text(selectorString(o.spec?.podSelector?.matchLabels) || '<all pods>') },
    { id: 'types', title: 'Policy Types', cell: (o) => text((o.spec?.policyTypes ?? []).join(', ')) },
    AGE
  ],
  pvc: () => [
    NAME,
    NAMESPACE,
    {
      id: 'status',
      title: 'Status',
      cell: (o) => badge(o.status?.phase ?? 'Unknown', o.status?.phase === 'Bound' ? 'ok' : o.status?.phase === 'Lost' ? 'error' : 'warn')
    },
    {
      id: 'volume',
      title: 'Volume',
      cell: (o) => (o.spec?.volumeName ? { text: o.spec.volumeName, link: { kindId: 'pv', name: o.spec.volumeName } } : text(''))
    },
    {
      id: 'capacity',
      title: 'Capacity',
      align: 'right',
      cell: (o) => {
        const q = o.status?.capacity?.storage ?? o.spec?.resources?.requests?.storage;
        return { text: q ?? '—', sort: parseQuantity(q) };
      }
    },
    { id: 'access', title: 'Access Modes', cell: (o) => text((o.spec?.accessModes ?? []).join(', ')) },
    {
      id: 'storageClass',
      title: 'Storage Class',
      cell: (o) => (o.spec?.storageClassName ? { text: o.spec.storageClassName, link: { kindId: 'storageclasses', name: o.spec.storageClassName } } : text(''))
    },
    AGE
  ],
  pv: () => [
    NAME,
    {
      id: 'capacity',
      title: 'Capacity',
      align: 'right',
      cell: (o) => ({ text: o.spec?.capacity?.storage ?? '—', sort: parseQuantity(o.spec?.capacity?.storage) })
    },
    { id: 'access', title: 'Access Modes', cell: (o) => text((o.spec?.accessModes ?? []).join(', ')) },
    { id: 'reclaim', title: 'Reclaim Policy', cell: (o) => text(o.spec?.persistentVolumeReclaimPolicy) },
    {
      id: 'status',
      title: 'Status',
      cell: (o) => badge(o.status?.phase ?? 'Unknown', o.status?.phase === 'Bound' ? 'ok' : o.status?.phase === 'Available' ? 'info' : o.status?.phase === 'Failed' ? 'error' : 'warn')
    },
    {
      id: 'claim',
      title: 'Claim',
      cell: (o) => {
        const ref = o.spec?.claimRef;
        return ref ? { text: `${ref.namespace}/${ref.name}`, link: { kindId: 'pvc', name: ref.name, namespace: ref.namespace } } : text('');
      }
    },
    { id: 'storageClass', title: 'Storage Class', cell: (o) => text(o.spec?.storageClassName) },
    AGE
  ],
  storageclasses: () => [
    NAME,
    { id: 'provisioner', title: 'Provisioner', cell: (o) => text(o.provisioner) },
    { id: 'reclaim', title: 'Reclaim Policy', cell: (o) => text(o.reclaimPolicy ?? 'Delete') },
    { id: 'binding', title: 'Binding Mode', cell: (o) => text(o.volumeBindingMode ?? 'Immediate') },
    {
      id: 'default',
      title: 'Default',
      cell: (o) => text(o.metadata.annotations?.['storageclass.kubernetes.io/is-default-class'] === 'true' ? 'Yes' : 'No')
    },
    AGE
  ],
  serviceaccounts: () => [NAME, NAMESPACE, AGE],
  roles: () => [NAME, NAMESPACE, { id: 'rules', title: 'Rules', align: 'right', cell: (o) => num((o.rules ?? []).length) }, AGE],
  clusterroles: () => [NAME, { id: 'rules', title: 'Rules', align: 'right', cell: (o) => num((o.rules ?? []).length) }, AGE],
  rolebindings: () => [NAME, NAMESPACE, roleRefColumn(), subjectsColumn(), AGE],
  clusterrolebindings: () => [NAME, roleRefColumn(), subjectsColumn(), AGE],
  crds: () => [
    { id: 'kind', title: 'Resource', cell: (o) => ({ text: o.spec?.names?.kind ?? o.metadata.name, link: { kindId: `cr:${o.spec?.group}/${o.spec?.names?.plural}`, name: '' } }) },
    { id: 'group', title: 'Group', cell: (o) => text(o.spec?.group) },
    {
      id: 'version',
      title: 'Version',
      cell: (o) => text((o.spec?.versions ?? []).filter((v: any) => v.served).map((v: any) => v.name).join(', '))
    },
    { id: 'scope', title: 'Scope', cell: (o) => text(o.spec?.scope) },
    NAME,
    AGE
  ]
};

function roleRefColumn(): ColumnSpec {
  return {
    id: 'role',
    title: 'Role',
    cell: (o) => {
      const ref = o.roleRef ?? {};
      const kindId = ref.kind === 'ClusterRole' ? 'clusterroles' : 'roles';
      return { text: `${ref.kind}/${ref.name}`, link: { kindId, name: ref.name, namespace: kindId === 'roles' ? o.metadata.namespace : undefined } };
    }
  };
}

function subjectsColumn(): ColumnSpec {
  return {
    id: 'subjects',
    title: 'Subjects',
    cell: (o) => text((o.subjects ?? []).map((s: any) => `${s.kind}:${s.namespace ? `${s.namespace}/` : ''}${s.name}`).join(', '))
  };
}

function hpaTargets(o: K8sObject): string {
  const current: any[] = o.status?.currentMetrics ?? [];
  return (o.spec?.metrics ?? [])
    .map((m: any, i: number) => {
      if (m.type === 'Resource') {
        const target = m.resource?.target ?? {};
        const cur = current[i]?.resource?.current ?? {};
        if (target.averageUtilization !== undefined) {
          return `${m.resource.name}: ${cur.averageUtilization ?? '?'}%/${target.averageUtilization}%`;
        }
        return `${m.resource.name}: ${cur.averageValue ?? '?'}/${target.averageValue ?? target.value}`;
      }
      return m.type;
    })
    .join(', ');
}

export function eventTime(o: K8sObject): string | undefined {
  return o.lastTimestamp ?? o.eventTime ?? o.series?.lastObservedTime ?? o.firstTimestamp ?? o.metadata.creationTimestamp;
}

/** Row actions available for a kind; some depend on the object state. */
export function rowActions(kindId: string, obj?: K8sObject): ActionId[] {
  const common: ActionId[] = ['yaml', 'delete'];
  switch (kindId) {
    case 'pods':
      return ['logs', 'shell', 'forward', 'debug', ...common];
    case 'deployments':
    case 'statefulsets':
      return ['scale', 'restart', 'logs', ...common];
    case 'daemonsets':
      return ['restart', 'logs', ...common];
    case 'replicasets':
      return ['scale', 'logs', ...common];
    case 'jobs':
      return ['logs', ...common];
    case 'cronjobs':
      return ['trigger', obj?.spec?.suspend ? 'resume' : 'suspend', ...common];
    case 'services':
      return ['forward', ...common];
    case 'nodes':
      return [obj?.spec?.unschedulable ? 'uncordon' : 'cordon', 'drain', 'nodeShell', 'yaml'];
    case 'events':
      return ['yaml'];
    case 'helmreleases':
      return ['helmUninstall'];
    default:
      return common;
  }
}

/** Build the table for a built-in kind. */
export function buildTable(kind: ResourceKind, items: K8sObject[], ctx: TableContext): TableData {
  if (kind.id === 'helmreleases') {
    return helmTable(items);
  }
  const specs = (COLUMNS[kind.id] ?? (() => (kind.namespaced ? [NAME, NAMESPACE, AGE] : [NAME, AGE])))(ctx);
  const rows: Row[] = items.map((obj) => ({
    key: obj.metadata.uid ?? `${obj.metadata.namespace}/${obj.metadata.name}`,
    name: obj.metadata.name,
    namespace: obj.metadata.namespace,
    cells: specs.map((spec) => spec.cell(obj)),
    actions: rowActions(kind.id, obj),
    search: selectorString(obj.metadata.labels)
  }));
  return {
    columns: specs.map(({ cell: _cell, ...column }) => column),
    rows,
    metricsAvailable: kind.id === 'pods' ? !!ctx.podMetrics : kind.id === 'nodes' ? !!ctx.nodeMetrics : undefined
  };
}

function helmTable(secrets: K8sObject[]): TableData {
  const columns: Column[] = [
    { id: 'name', title: 'Name' },
    { id: 'namespace', title: 'Namespace', namespaceColumn: true },
    { id: 'chart', title: 'Chart' },
    { id: 'revision', title: 'Revision', align: 'right' },
    { id: 'version', title: 'Version' },
    { id: 'appVersion', title: 'App Version' },
    { id: 'updated', title: 'Updated', align: 'right' },
    { id: 'status', title: 'Status' }
  ];
  const rows: Row[] = [];
  for (const secret of latestReleaseSecrets(secrets)) {
    const release = decodeRelease(secret);
    if (!release) {
      continue;
    }
    const tone: Tone = release.status === 'deployed' ? 'ok' : release.status === 'failed' ? 'error' : release.status === 'superseded' ? 'muted' : 'warn';
    rows.push({
      key: `${release.namespace}/${release.name}`,
      name: release.name,
      namespace: release.namespace,
      cells: [
        { text: release.name },
        { text: release.namespace },
        { text: release.chart },
        { text: String(release.revision), sort: release.revision },
        { text: release.chartVersion },
        { text: release.appVersion || '—' },
        { text: '', time: release.updated, sort: -Date.parse(release.updated ?? '') || 0 },
        { text: release.status, tone, badge: true }
      ],
      actions: ['helmUninstall']
    });
  }
  return { columns, rows };
}

/** Columns from the server-side Table format (custom resources). */
export function buildServerTable(kindId: string, namespaced: boolean, table: any): TableData {
  const definitions: any[] = (table?.columnDefinitions ?? []).filter((c: any) => !c.priority);
  const nameIndex = definitions.findIndex((c) => c.name === 'Name');
  const ageIndex = definitions.findIndex((c) => c.name === 'Age');
  const columns: Column[] = [{ id: 'name', title: 'Name' }];
  if (namespaced) {
    columns.push({ id: 'namespace', title: 'Namespace', namespaceColumn: true });
  }
  const extra = definitions.map((def, index) => ({ def, index })).filter(({ index }) => index !== nameIndex && index !== ageIndex);
  for (const { def } of extra) {
    columns.push({ id: `c:${def.name}`, title: def.name, align: def.type === 'integer' || def.type === 'number' ? 'right' : 'left' });
  }
  columns.push({ id: 'age', title: 'Age', align: 'right' });

  const rows: Row[] = (table?.rows ?? []).map((row: any) => {
    const meta = row.object?.metadata ?? {};
    const cells: Cell[] = [{ text: meta.name ?? String(row.cells?.[nameIndex] ?? '') }];
    if (namespaced) {
      cells.push(text(meta.namespace));
    }
    for (const { def, index } of extra) {
      const value = row.cells?.[index];
      if (def.type === 'date' || def.format === 'date-time') {
        cells.push({ text: value ? '' : '—', time: value, sort: -Date.parse(value ?? '') || 0 });
      } else {
        cells.push({ text: value === undefined || value === null || value === '' ? '—' : String(value), sort: typeof value === 'number' ? value : undefined });
      }
    }
    cells.push({ text: '', time: meta.creationTimestamp, sort: -Date.parse(meta.creationTimestamp ?? '') || 0 });
    return {
      key: meta.uid ?? `${meta.namespace}/${meta.name}`,
      name: meta.name ?? '',
      namespace: meta.namespace,
      cells,
      actions: rowActions(kindId)
    };
  });
  return { columns, rows };
}
