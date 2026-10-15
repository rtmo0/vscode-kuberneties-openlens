/* Registry of the Kubernetes resource kinds shown in the explorer. */

export type Category = 'cluster' | 'workloads' | 'config' | 'network' | 'storage' | 'access' | 'custom' | 'helm';

export interface ResourceKind {
  id: string;
  kind: string;
  group: string;
  version: string;
  plural: string;
  namespaced: boolean;
  title: string;
  category: Category;
  icon: string;
  /** Custom resource: columns come from the server-side Table format. */
  custom?: boolean;
}

export const CATEGORIES: Array<{ id: Category; title: string; icon: string }> = [
  { id: 'cluster', title: 'Cluster', icon: 'server-environment' },
  { id: 'workloads', title: 'Workloads', icon: 'layers' },
  { id: 'config', title: 'Config', icon: 'settings' },
  { id: 'network', title: 'Network', icon: 'globe' },
  { id: 'storage', title: 'Storage', icon: 'database' },
  { id: 'access', title: 'Access Control', icon: 'shield' },
  { id: 'helm', title: 'Helm', icon: 'package' },
  { id: 'custom', title: 'Custom Resources', icon: 'extensions' }
];

const k = (
  id: string,
  kind: string,
  apiVersion: string,
  plural: string,
  namespaced: boolean,
  title: string,
  category: Category,
  icon: string
): ResourceKind => {
  const [group, version] = apiVersion.includes('/') ? apiVersion.split('/') : ['', apiVersion];
  return { id, kind, group, version, plural, namespaced, title, category, icon };
};

export const KINDS: ResourceKind[] = [
  k('nodes', 'Node', 'v1', 'nodes', false, 'Nodes', 'cluster', 'server'),
  k('namespaces', 'Namespace', 'v1', 'namespaces', false, 'Namespaces', 'cluster', 'symbol-namespace'),
  k('events', 'Event', 'v1', 'events', true, 'Events', 'cluster', 'bell'),

  k('pods', 'Pod', 'v1', 'pods', true, 'Pods', 'workloads', 'symbol-misc'),
  k('deployments', 'Deployment', 'apps/v1', 'deployments', true, 'Deployments', 'workloads', 'rocket'),
  k('daemonsets', 'DaemonSet', 'apps/v1', 'daemonsets', true, 'DaemonSets', 'workloads', 'server-process'),
  k('statefulsets', 'StatefulSet', 'apps/v1', 'statefulsets', true, 'StatefulSets', 'workloads', 'database'),
  k('replicasets', 'ReplicaSet', 'apps/v1', 'replicasets', true, 'ReplicaSets', 'workloads', 'copy'),
  k('jobs', 'Job', 'batch/v1', 'jobs', true, 'Jobs', 'workloads', 'run'),
  k('cronjobs', 'CronJob', 'batch/v1', 'cronjobs', true, 'CronJobs', 'workloads', 'watch'),

  k('configmaps', 'ConfigMap', 'v1', 'configmaps', true, 'ConfigMaps', 'config', 'file-code'),
  k('secrets', 'Secret', 'v1', 'secrets', true, 'Secrets', 'config', 'key'),
  k('resourcequotas', 'ResourceQuota', 'v1', 'resourcequotas', true, 'Resource Quotas', 'config', 'dashboard'),
  k('limitranges', 'LimitRange', 'v1', 'limitranges', true, 'Limit Ranges', 'config', 'arrow-both'),
  k('hpa', 'HorizontalPodAutoscaler', 'autoscaling/v2', 'horizontalpodautoscalers', true, 'HPA', 'config', 'arrow-swap'),
  k('pdb', 'PodDisruptionBudget', 'policy/v1', 'poddisruptionbudgets', true, 'Pod Disruption Budgets', 'config', 'debug-pause'),
  k('priorityclasses', 'PriorityClass', 'scheduling.k8s.io/v1', 'priorityclasses', false, 'Priority Classes', 'config', 'list-ordered'),

  k('services', 'Service', 'v1', 'services', true, 'Services', 'network', 'plug'),
  k('endpoints', 'Endpoints', 'v1', 'endpoints', true, 'Endpoints', 'network', 'debug-disconnect'),
  k('ingresses', 'Ingress', 'networking.k8s.io/v1', 'ingresses', true, 'Ingresses', 'network', 'globe'),
  k('ingressclasses', 'IngressClass', 'networking.k8s.io/v1', 'ingressclasses', false, 'Ingress Classes', 'network', 'symbol-class'),
  k('networkpolicies', 'NetworkPolicy', 'networking.k8s.io/v1', 'networkpolicies', true, 'Network Policies', 'network', 'lock'),

  k('pvc', 'PersistentVolumeClaim', 'v1', 'persistentvolumeclaims', true, 'Persistent Volume Claims', 'storage', 'save'),
  k('pv', 'PersistentVolume', 'v1', 'persistentvolumes', false, 'Persistent Volumes', 'storage', 'save-all'),
  k('storageclasses', 'StorageClass', 'storage.k8s.io/v1', 'storageclasses', false, 'Storage Classes', 'storage', 'archive'),

  k('serviceaccounts', 'ServiceAccount', 'v1', 'serviceaccounts', true, 'Service Accounts', 'access', 'account'),
  k('roles', 'Role', 'rbac.authorization.k8s.io/v1', 'roles', true, 'Roles', 'access', 'person'),
  k('clusterroles', 'ClusterRole', 'rbac.authorization.k8s.io/v1', 'clusterroles', false, 'Cluster Roles', 'access', 'organization'),
  k('rolebindings', 'RoleBinding', 'rbac.authorization.k8s.io/v1', 'rolebindings', true, 'Role Bindings', 'access', 'link'),
  k('clusterrolebindings', 'ClusterRoleBinding', 'rbac.authorization.k8s.io/v1', 'clusterrolebindings', false, 'Cluster Role Bindings', 'access', 'link'),

  k('crds', 'CustomResourceDefinition', 'apiextensions.k8s.io/v1', 'customresourcedefinitions', false, 'Definitions', 'custom', 'symbol-structure'),

  // Helm releases are read from the release Secrets Helm 3 stores.
  k('helmreleases', 'HelmRelease', 'v1', 'secrets', true, 'Releases', 'helm', 'package')
];

const BY_ID = new Map(KINDS.map((kind) => [kind.id, kind]));

/** Kinds registered at runtime from CustomResourceDefinitions, keyed by id. */
const customKinds = new Map<string, ResourceKind>();

export function getKind(id: string): ResourceKind | undefined {
  return BY_ID.get(id) ?? customKinds.get(id);
}

export function findKindByKind(apiVersion: string | undefined, kind: string | undefined): ResourceKind | undefined {
  if (!kind) {
    return undefined;
  }
  const all = [...KINDS, ...customKinds.values()].filter((k) => k.id !== 'helmreleases');
  return (
    all.find((k) => k.kind === kind && (!apiVersion || apiVersionOf(k) === apiVersion)) ?? all.find((k) => k.kind === kind)
  );
}

export function kindsInCategory(category: Category): ResourceKind[] {
  return KINDS.filter((kind) => kind.category === category && kind.id !== 'crds');
}

export function registerKind(kind: ResourceKind): void {
  if (!BY_ID.has(kind.id)) {
    customKinds.set(kind.id, kind);
  }
}

/** Register (or look up) the kind served by a CRD's storage version. */
export function registerCustomKind(crd: {
  spec: { group: string; names: { kind: string; plural: string }; scope: string; versions?: Array<{ name: string; served?: boolean; storage?: boolean }> };
}): ResourceKind | undefined {
  const versions = crd.spec.versions ?? [];
  const version = versions.find((v) => v.storage && v.served !== false) ?? versions.find((v) => v.served !== false);
  if (!version) {
    return undefined;
  }
  const id = `cr:${crd.spec.group}/${crd.spec.names.plural}`;
  const kind: ResourceKind = {
    id,
    kind: crd.spec.names.kind,
    group: crd.spec.group,
    version: version.name,
    plural: crd.spec.names.plural,
    namespaced: crd.spec.scope === 'Namespaced',
    title: crd.spec.names.kind,
    category: 'custom',
    icon: 'symbol-object',
    custom: true
  };
  customKinds.set(id, kind);
  return kind;
}

export function apiVersionOf(kind: ResourceKind): string {
  return kind.group ? `${kind.group}/${kind.version}` : kind.version;
}

export function apiBase(group: string, version: string): string {
  return group ? `/apis/${group}/${version}` : `/api/${version}`;
}

export function collectionPath(kind: ResourceKind, namespace?: string): string {
  const base = apiBase(kind.group, kind.version);
  return kind.namespaced && namespace
    ? `${base}/namespaces/${encodeURIComponent(namespace)}/${kind.plural}`
    : `${base}/${kind.plural}`;
}

export function objectPath(kind: ResourceKind, name: string, namespace?: string): string {
  return `${collectionPath(kind, kind.namespaced ? namespace : undefined)}/${encodeURIComponent(name)}`;
}
