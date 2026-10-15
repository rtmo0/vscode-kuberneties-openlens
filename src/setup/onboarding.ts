/* Team namespaces with sane defaults, and kubeconfigs for service accounts. */
import type { K8sObject } from '../core/cluster';
import { RawKubeconfig } from '../core/kubeconfigModel';

export interface Quota {
  cpu: string;
  memory: string;
  pods: number;
}

export interface TeamOptions {
  namespace: string;
  serviceAccount: string;
  /** Built-in ClusterRole bound in the namespace. */
  role: 'view' | 'edit' | 'admin';
  quota?: Quota;
  /** Default container requests/limits via a LimitRange. */
  defaults: boolean;
  /** Allow traffic only from the same namespace (and the ingress controller). */
  isolate: boolean;
  /** Create a non-expiring token Secret instead of requesting a time-limited token. */
  permanentToken: boolean;
}

export const QUOTA_PRESETS: Array<{ label: string; quota?: Quota }> = [
  { label: 'No quota' },
  { label: 'Small: 2 CPU, 4 GiB, 20 pods', quota: { cpu: '2', memory: '4Gi', pods: 20 } },
  { label: 'Medium: 8 CPU, 16 GiB, 100 pods', quota: { cpu: '8', memory: '16Gi', pods: 100 } },
  { label: 'Large: 32 CPU, 64 GiB, 300 pods', quota: { cpu: '32', memory: '64Gi', pods: 300 } }
];

export function tokenSecretName(serviceAccount: string): string {
  return `${serviceAccount}-token`;
}

export function teamManifests(o: TeamOptions): K8sObject[] {
  const ns = o.namespace;
  const labels = { 'app.kubernetes.io/managed-by': 'openlens-vscode' };
  const objects: K8sObject[] = [
    { apiVersion: 'v1', kind: 'Namespace', metadata: { name: ns, labels: { ...labels, 'pod-security.kubernetes.io/warn': 'baseline' } } },
    { apiVersion: 'v1', kind: 'ServiceAccount', metadata: { name: o.serviceAccount, namespace: ns, labels } },
    {
      apiVersion: 'rbac.authorization.k8s.io/v1',
      kind: 'RoleBinding',
      metadata: { name: `${o.serviceAccount}-${o.role}`, namespace: ns, labels },
      subjects: [{ kind: 'ServiceAccount', name: o.serviceAccount, namespace: ns }],
      roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: o.role }
    }
  ];
  if (o.quota) {
    objects.push({
      apiVersion: 'v1',
      kind: 'ResourceQuota',
      metadata: { name: 'team-quota', namespace: ns, labels },
      spec: {
        hard: {
          'requests.cpu': o.quota.cpu,
          'requests.memory': o.quota.memory,
          'limits.cpu': String(Number(o.quota.cpu) * 2),
          'limits.memory': doubleQuantity(o.quota.memory),
          pods: String(o.quota.pods),
          'persistentvolumeclaims': String(Math.max(5, Math.round(o.quota.pods / 4)))
        }
      }
    });
  }
  if (o.defaults || o.quota) {
    // With a quota, every container must declare requests; defaults make that automatic.
    objects.push({
      apiVersion: 'v1',
      kind: 'LimitRange',
      metadata: { name: 'container-defaults', namespace: ns, labels },
      spec: {
        limits: [{ type: 'Container', defaultRequest: { cpu: '100m', memory: '128Mi' }, default: { cpu: '500m', memory: '512Mi' } }]
      }
    });
  }
  if (o.isolate) {
    objects.push({
      apiVersion: 'networking.k8s.io/v1',
      kind: 'NetworkPolicy',
      metadata: { name: 'same-namespace-only', namespace: ns, labels },
      spec: {
        podSelector: {},
        policyTypes: ['Ingress'],
        ingress: [
          { from: [{ podSelector: {} }] },
          // Keep ingress controllers and monitoring able to reach the pods.
          { from: [{ namespaceSelector: { matchExpressions: [{ key: 'kubernetes.io/metadata.name', operator: 'In', values: ['ingress-nginx', 'kube-system', 'monitoring'] }] } }] }
        ]
      }
    });
  }
  if (o.permanentToken) {
    objects.push({
      apiVersion: 'v1',
      kind: 'Secret',
      type: 'kubernetes.io/service-account-token',
      metadata: { name: tokenSecretName(o.serviceAccount), namespace: ns, labels, annotations: { 'kubernetes.io/service-account.name': o.serviceAccount } }
    });
  }
  return objects;
}

function doubleQuantity(q: string): string {
  const m = /^(\d+(?:\.\d+)?)(.*)$/.exec(q);
  return m ? `${Number(m[1]) * 2}${m[2]}` : q;
}

/** A kubeconfig that logs in as a service account with a token. */
export function serviceAccountKubeconfig(options: {
  contextName: string;
  server: string;
  caData?: string;
  insecure?: boolean;
  token: string;
  namespace: string;
  serviceAccount: string;
}): RawKubeconfig {
  const cluster: Record<string, unknown> = { server: options.server };
  if (options.caData) {
    cluster['certificate-authority-data'] = options.caData;
  }
  if (options.insecure) {
    cluster['insecure-skip-tls-verify'] = true;
  }
  const user = `${options.serviceAccount}@${options.namespace}`;
  return {
    apiVersion: 'v1',
    kind: 'Config',
    preferences: {},
    clusters: [{ name: options.contextName, cluster }],
    users: [{ name: user, user: { token: options.token } }],
    contexts: [{ name: options.contextName, context: { cluster: options.contextName, user, namespace: options.namespace } }],
    'current-context': options.contextName
  };
}

export function validateDnsLabel(value: string): string | undefined {
  return /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(value) && value.length <= 63 ? undefined : 'Lowercase letters, digits and "-", at most 63 characters';
}
