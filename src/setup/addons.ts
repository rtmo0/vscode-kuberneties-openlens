/* A catalog of the add-ons most clusters need, installed with Helm (or a manifest). */
import * as https from 'https';
import * as yaml from 'js-yaml';

import type { ClusterSession, K8sObject } from '../core/cluster';
import { isNotFound } from '../core/kubeRest';
import { getKind } from '../core/resources';

export type LocalFlavour = 'kind' | 'k3s' | 'minikube' | undefined;

export interface ClusterEnv {
  local: LocalFlavour;
  /** Default IngressClass name, if any. */
  ingressClass?: string;
  /** A node labelled ingress-ready=true (kind clusters created with port mappings). */
  ingressReadyNode: boolean;
}

export interface AddonOption {
  id: string;
  label: string;
  type: 'boolean' | 'string';
  default: (env: ClusterEnv) => boolean | string;
  description?: string;
}

export interface HelmStep {
  type: 'helm';
  repo: string;
  chart: string;
  release: string;
  namespace: string;
  values: (options: Record<string, unknown>, env: ClusterEnv) => Record<string, unknown>;
}

export interface ManifestStep {
  type: 'manifest';
  url: string;
}

export interface AddonStatus {
  installed: boolean;
  /** Installed by this catalog / Helm (so it can be uninstalled here). */
  managed: boolean;
  version?: string;
  detail?: string;
}

export interface Addon {
  id: string;
  title: string;
  category: 'Essentials' | 'Networking' | 'Observability' | 'Security' | 'Delivery' | 'Storage';
  description: string;
  docs: string;
  steps: Array<HelmStep | ManifestStep>;
  options?: AddonOption[];
  detect: (session: ClusterSession) => Promise<AddonStatus>;
  /** Objects to apply after the install (e.g. ClusterIssuers). */
  extraObjects?: (options: Record<string, unknown>, env: ClusterEnv) => K8sObject[];
  /** Hints shown after a successful install. */
  notes?: (session: ClusterSession, options: Record<string, unknown>) => Promise<string[]>;
}

// ─────────────────────────── detection helpers ───────────────────────────

async function crdExists(session: ClusterSession, name: string): Promise<boolean> {
  try {
    await session.rest.get(`/apis/apiextensions.k8s.io/v1/customresourcedefinitions/${name}`);
    return true;
  } catch (err) {
    if (isNotFound(err)) {
      return false;
    }
    throw err;
  }
}

async function helmRelease(session: ClusterSession, namespace: string, name: string): Promise<{ version?: string; status?: string } | undefined> {
  try {
    const list = await session.list(getKind('secrets')!, namespace, { labelSelector: `owner=helm,name=${name}` });
    const latest = list.items.sort((a, b) => Number(b.metadata.labels?.version) - Number(a.metadata.labels?.version))[0];
    return latest ? { status: latest.metadata.labels?.status, version: latest.metadata.labels?.version } : undefined;
  } catch {
    return undefined;
  }
}

async function deploymentImageTag(session: ClusterSession, namespace: string, labelSelector: string): Promise<string | undefined> {
  try {
    const list = await session.list(getKind('deployments')!, namespace, { labelSelector });
    const image: string | undefined = list.items[0]?.spec?.template?.spec?.containers?.[0]?.image;
    return image?.split('@')[0].split(':').pop();
  } catch {
    return undefined;
  }
}

function statusFrom(installed: boolean, release: { status?: string } | undefined, version?: string, detail?: string): AddonStatus {
  return { installed, managed: !!release, version, detail: detail ?? (release && release.status !== 'deployed' ? `Helm release ${release.status}` : undefined) };
}

export async function detectEnv(session: ClusterSession): Promise<ClusterEnv> {
  const nodes = (await session.list(getKind('nodes')!, '').catch(() => ({ items: [] as K8sObject[] }))).items;
  let local: LocalFlavour;
  if (nodes.some((n) => String(n.spec?.providerID ?? '').startsWith('kind://'))) {
    local = 'kind';
  } else if (nodes.some((n) => String(n.spec?.providerID ?? '').startsWith('k3s://') || n.metadata.labels?.['node.kubernetes.io/instance-type'] === 'k3s')) {
    local = 'k3s';
  } else if (nodes.some((n) => n.metadata.labels?.['minikube.k8s.io/name'])) {
    local = 'minikube';
  }
  const classes = (await session.list(getKind('ingressclasses')!, '').catch(() => ({ items: [] as K8sObject[] }))).items;
  const ingressClass = (classes.find((c) => c.metadata.annotations?.['ingressclass.kubernetes.io/is-default-class'] === 'true') ?? classes[0])?.metadata.name;
  return { local, ingressClass, ingressReadyNode: nodes.some((n) => n.metadata.labels?.['ingress-ready'] === 'true') };
}

// ─────────────────────────── catalog ───────────────────────────

export const ADDONS: Addon[] = [
  {
    id: 'metrics-server',
    title: 'metrics-server',
    category: 'Essentials',
    description: 'CPU and memory usage of pods and nodes (kubectl top, HPA, the metrics in this extension).',
    docs: 'https://github.com/kubernetes-sigs/metrics-server',
    steps: [
      {
        type: 'helm',
        repo: 'https://kubernetes-sigs.github.io/metrics-server/',
        chart: 'metrics-server',
        release: 'metrics-server',
        namespace: 'kube-system',
        values: (o) => (o.insecureTls ? { args: ['--kubelet-insecure-tls'] } : {})
      }
    ],
    options: [{ id: 'insecureTls', label: 'Skip kubelet certificate verification', type: 'boolean', default: (env) => !!env.local, description: 'Needed on kind, k3d and minikube, whose kubelet certificates are self-signed' }],
    detect: async (session) => {
      const release = await helmRelease(session, 'kube-system', 'metrics-server');
      try {
        const svc = await session.rest.get<any>('/apis/apiregistration.k8s.io/v1/apiservices/v1beta1.metrics.k8s.io');
        const available = (svc.status?.conditions ?? []).some((c: any) => c.type === 'Available' && c.status === 'True');
        const version = await deploymentImageTag(session, 'kube-system', 'k8s-app=metrics-server').then((v) => v ?? deploymentImageTag(session, 'kube-system', 'app.kubernetes.io/name=metrics-server'));
        return statusFrom(true, release, version, available ? undefined : 'Registered but not available');
      } catch (err) {
        if (isNotFound(err)) {
          return statusFrom(false, release);
        }
        throw err;
      }
    }
  },
  {
    id: 'ingress-nginx',
    title: 'ingress-nginx',
    category: 'Networking',
    description: 'Ingress controller: routes HTTP(S) traffic from outside to your services by host and path.',
    docs: 'https://kubernetes.github.io/ingress-nginx/',
    steps: [
      {
        type: 'helm',
        repo: 'https://kubernetes.github.io/ingress-nginx',
        chart: 'ingress-nginx',
        release: 'ingress-nginx',
        namespace: 'ingress-nginx',
        values: (o, env) => {
          const controller: Record<string, unknown> = { ingressClassResource: { default: !!o.defaultClass }, watchIngressWithoutClass: !!o.defaultClass };
          if (env.local === 'kind') {
            // kind publishes ports 80/443 of the node labelled ingress-ready.
            Object.assign(controller, {
              hostPort: { enabled: true },
              service: { type: 'NodePort' },
              ...(env.ingressReadyNode ? { nodeSelector: { 'ingress-ready': 'true' } } : {}),
              tolerations: [{ key: 'node-role.kubernetes.io/control-plane', operator: 'Exists', effect: 'NoSchedule' }],
              publishService: { enabled: false },
              extraArgs: { 'publish-status-address': 'localhost' }
            });
          }
          return { controller };
        }
      }
    ],
    options: [{ id: 'defaultClass', label: 'Make "nginx" the default IngressClass', type: 'boolean', default: (env) => !env.ingressClass }],
    detect: async (session) => {
      const release = await helmRelease(session, 'ingress-nginx', 'ingress-nginx');
      const classes = (await session.list(getKind('ingressclasses')!, '').catch(() => ({ items: [] as K8sObject[] }))).items;
      const nginx = classes.find((c) => c.spec?.controller === 'k8s.io/ingress-nginx');
      const version = nginx ? await deploymentImageTag(session, '', 'app.kubernetes.io/name=ingress-nginx') : undefined;
      const others = classes.filter((c) => c !== nginx).map((c) => `${c.metadata.name} (${c.spec?.controller})`);
      return statusFrom(!!nginx, release, version, !nginx && others.length ? `Other ingress controllers: ${others.join(', ')}` : undefined);
    }
  },
  {
    id: 'cert-manager',
    title: 'cert-manager',
    category: 'Security',
    description: "Issues and renews TLS certificates (Let's Encrypt and others) for your ingresses automatically.",
    docs: 'https://cert-manager.io/docs/',
    steps: [{ type: 'helm', repo: 'https://charts.jetstack.io', chart: 'cert-manager', release: 'cert-manager', namespace: 'cert-manager', values: () => ({ crds: { enabled: true } }) }],
    options: [{ id: 'email', label: "E-mail for Let's Encrypt ClusterIssuers (optional)", type: 'string', default: () => '', description: 'Creates letsencrypt-staging and letsencrypt-prod issuers using HTTP-01 through your ingress controller' }],
    extraObjects: (o, env) => {
      const email = String(o.email ?? '').trim();
      if (!email) {
        return [];
      }
      const issuer = (name: string, server: string): K8sObject => ({
        apiVersion: 'cert-manager.io/v1',
        kind: 'ClusterIssuer',
        metadata: { name },
        spec: {
          acme: {
            email,
            server,
            privateKeySecretRef: { name: `${name}-account-key` },
            solvers: [{ http01: { ingress: { ingressClassName: env.ingressClass ?? 'nginx' } } }]
          }
        }
      });
      return [issuer('letsencrypt-staging', 'https://acme-staging-v02.api.letsencrypt.org/directory'), issuer('letsencrypt-prod', 'https://acme-v02.api.letsencrypt.org/directory')];
    },
    detect: async (session) => {
      const release = await helmRelease(session, 'cert-manager', 'cert-manager');
      // Helm keeps CRDs on uninstall, so look for the controller itself.
      const version = (await crdExists(session, 'certificates.cert-manager.io')) ? await deploymentImageTag(session, '', 'app.kubernetes.io/name=cert-manager') : undefined;
      return statusFrom(!!version, release, version);
    },
    notes: async (_s, o) => (o.email ? ['Add `cert-manager.io/cluster-issuer: letsencrypt-prod` to an Ingress annotation and a `tls:` section to get a certificate.'] : [])
  },
  {
    id: 'kube-prometheus-stack',
    title: 'Prometheus + Grafana',
    category: 'Observability',
    description: 'kube-prometheus-stack: Prometheus, Alertmanager, Grafana dashboards and node metrics. This extension picks it up for metric history automatically.',
    docs: 'https://github.com/prometheus-community/helm-charts/tree/main/charts/kube-prometheus-stack',
    steps: [
      {
        type: 'helm',
        repo: 'https://prometheus-community.github.io/helm-charts',
        chart: 'kube-prometheus-stack',
        release: 'kube-prometheus-stack',
        namespace: 'monitoring',
        values: (o, env) => ({
          alertmanager: { enabled: !!o.alertmanager },
          prometheus: { prometheusSpec: { retention: String(o.retention || '7d'), resources: { requests: { cpu: '200m', memory: '512Mi' } } } },
          grafana: { adminPassword: String(o.grafanaPassword || randomPassword()) },
          // Control plane components are not reachable on local clusters.
          ...(env.local ? { kubeEtcd: { enabled: false }, kubeScheduler: { enabled: false }, kubeControllerManager: { enabled: false }, kubeProxy: { enabled: env.local !== 'k3s' } } : {})
        })
      }
    ],
    options: [
      { id: 'retention', label: 'Metric retention', type: 'string', default: () => '7d' },
      { id: 'alertmanager', label: 'Install Alertmanager', type: 'boolean', default: (env) => !env.local },
      { id: 'grafanaPassword', label: 'Grafana admin password (empty generates one)', type: 'string', default: () => '' }
    ],
    detect: async (session) => {
      const release = await helmRelease(session, 'monitoring', 'kube-prometheus-stack');
      const installed = (await crdExists(session, 'prometheuses.monitoring.coreos.com')) && !!(await deploymentImageTag(session, '', 'app.kubernetes.io/name=kube-prometheus-stack-prometheus-operator').then((v) => v ?? deploymentImageTag(session, '', 'app=kube-prometheus-stack-operator')));
      return statusFrom(installed, release, undefined, installed && !release ? 'Prometheus Operator is installed by something else' : undefined);
    },
    notes: async (session) => {
      const secret = await session.get(getKind('secrets')!, 'kube-prometheus-stack-grafana', 'monitoring').catch(() => undefined);
      const password = secret?.data?.['admin-password'] ? Buffer.from(secret.data['admin-password'], 'base64').toString() : undefined;
      return [`Grafana: forward the service kube-prometheus-stack-grafana (port 80) in "monitoring"; user admin${password ? `, password ${password}` : ''}.`];
    }
  },
  {
    id: 'loki',
    title: 'Loki + Promtail',
    category: 'Observability',
    description: 'Log aggregation: Promtail ships the logs of every pod to a single-binary Loki; query them in Grafana.',
    docs: 'https://grafana.com/docs/loki/latest/',
    steps: [
      {
        type: 'helm',
        repo: 'https://grafana.github.io/helm-charts',
        chart: 'loki',
        release: 'loki',
        namespace: 'monitoring',
        values: (o) => ({
          deploymentMode: 'SingleBinary',
          loki: {
            auth_enabled: false,
            commonConfig: { replication_factor: 1 },
            storage: { type: 'filesystem' },
            schemaConfig: { configs: [{ from: '2024-04-01', store: 'tsdb', object_store: 'filesystem', schema: 'v13', index: { prefix: 'loki_index_', period: '24h' } }] },
            limits_config: { retention_period: String(o.retention || '168h') }
          },
          singleBinary: { replicas: 1 },
          read: { replicas: 0 },
          write: { replicas: 0 },
          backend: { replicas: 0 },
          chunksCache: { enabled: false },
          resultsCache: { enabled: false },
          lokiCanary: { enabled: false },
          test: { enabled: false },
          gateway: { enabled: false }
        })
      },
      {
        type: 'helm',
        repo: 'https://grafana.github.io/helm-charts',
        chart: 'promtail',
        release: 'promtail',
        namespace: 'monitoring',
        values: () => ({ config: { clients: [{ url: 'http://loki.monitoring.svc:3100/loki/api/v1/push' }] } })
      }
    ],
    options: [{ id: 'retention', label: 'Log retention', type: 'string', default: () => '168h' }],
    detect: async (session) => {
      const release = await helmRelease(session, 'monitoring', 'loki');
      return statusFrom(!!release, release);
    },
    notes: async () => ['Add a Loki data source in Grafana with the URL http://loki.monitoring.svc:3100.']
  },
  {
    id: 'sealed-secrets',
    title: 'Sealed Secrets',
    category: 'Security',
    description: 'Encrypt secrets so they can be stored in Git; only the controller in the cluster can decrypt them (kubeseal).',
    docs: 'https://github.com/bitnami-labs/sealed-secrets',
    steps: [{ type: 'helm', repo: 'https://bitnami-labs.github.io/sealed-secrets', chart: 'sealed-secrets', release: 'sealed-secrets-controller', namespace: 'kube-system', values: () => ({ fullnameOverride: 'sealed-secrets-controller' }) }],
    detect: async (session) => {
      const release = await helmRelease(session, 'kube-system', 'sealed-secrets-controller');
      return statusFrom((await crdExists(session, 'sealedsecrets.bitnami.com')) && !!(await deploymentImageTag(session, '', 'app.kubernetes.io/name=sealed-secrets')), release);
    }
  },
  {
    id: 'argo-cd',
    title: 'Argo CD',
    category: 'Delivery',
    description: 'GitOps continuous delivery: keeps the cluster in sync with manifests and Helm charts in Git.',
    docs: 'https://argo-cd.readthedocs.io/',
    steps: [{ type: 'helm', repo: 'https://argoproj.github.io/argo-helm', chart: 'argo-cd', release: 'argocd', namespace: 'argocd', values: () => ({ configs: { params: { 'server.insecure': true } } }) }],
    detect: async (session) => {
      const release = await helmRelease(session, 'argocd', 'argocd');
      return statusFrom((await crdExists(session, 'applications.argoproj.io')) && !!(await deploymentImageTag(session, '', 'app.kubernetes.io/name=argocd-server')), release);
    },
    notes: async (session) => {
      const secret = await session.get(getKind('secrets')!, 'argocd-initial-admin-secret', 'argocd').catch(() => undefined);
      const password = secret?.data?.password ? Buffer.from(secret.data.password, 'base64').toString() : undefined;
      return [`Argo CD UI: forward the service argocd-server (port 80) in "argocd"; user admin${password ? `, password ${password}` : ''}.`];
    }
  },
  {
    id: 'external-dns',
    title: 'ExternalDNS',
    category: 'Networking',
    description: 'Creates DNS records for your ingresses and LoadBalancer services in Cloudflare, Route 53, Cloud DNS, Azure DNS and more. Use "Edit Values" for providers other than Cloudflare.',
    docs: 'https://kubernetes-sigs.github.io/external-dns/',
    steps: [
      {
        type: 'helm',
        repo: 'https://kubernetes-sigs.github.io/external-dns/',
        chart: 'external-dns',
        release: 'external-dns',
        namespace: 'external-dns',
        values: (o) => ({
          provider: { name: String(o.provider || 'cloudflare') },
          domainFilters: String(o.domain || '')
            .split(/[\s,]+/)
            .filter(Boolean),
          policy: 'upsert-only',
          ...(o.provider === 'cloudflare' || !o.provider ? { env: [{ name: 'CF_API_TOKEN', valueFrom: { secretKeyRef: { name: 'cloudflare-api-token', key: 'api-token' } } }] } : {})
        })
      }
    ],
    options: [
      { id: 'provider', label: 'DNS provider', type: 'string', default: () => 'cloudflare', description: 'cloudflare, aws, google, azure, digitalocean, …' },
      { id: 'domain', label: 'Domains to manage', type: 'string', default: () => '', description: 'e.g. example.com' },
      { id: 'cloudflareToken', label: 'Cloudflare API token (stored in the secret cloudflare-api-token)', type: 'string', default: () => '' }
    ],
    extraObjects: (o) =>
      o.cloudflareToken
        ? [{ apiVersion: 'v1', kind: 'Secret', metadata: { name: 'cloudflare-api-token', namespace: 'external-dns' }, type: 'Opaque', stringData: { 'api-token': String(o.cloudflareToken) } }]
        : [],
    detect: async (session) => {
      const release = await helmRelease(session, 'external-dns', 'external-dns');
      return statusFrom(!!release, release);
    }
  },
  {
    id: 'local-path-provisioner',
    title: 'Local Path Provisioner',
    category: 'Storage',
    description: 'A default StorageClass backed by node-local directories, so PersistentVolumeClaims work on clusters without a storage provider.',
    docs: 'https://github.com/rancher/local-path-provisioner',
    steps: [{ type: 'manifest', url: 'https://raw.githubusercontent.com/rancher/local-path-provisioner/v0.0.30/deploy/local-path-storage.yaml' }],
    extraObjects: (o) =>
      o.makeDefault
        ? [{ apiVersion: 'storage.k8s.io/v1', kind: 'StorageClass', metadata: { name: 'local-path', annotations: { 'storageclass.kubernetes.io/is-default-class': 'true' } }, provisioner: 'rancher.io/local-path', volumeBindingMode: 'WaitForFirstConsumer', reclaimPolicy: 'Delete' }]
        : [],
    options: [{ id: 'makeDefault', label: 'Make it the default StorageClass', type: 'boolean', default: () => true }],
    detect: async (session) => {
      try {
        await session.get(getKind('storageclasses')!, 'local-path');
        return { installed: true, managed: false };
      } catch (err) {
        if (isNotFound(err)) {
          return { installed: false, managed: false };
        }
        throw err;
      }
    }
  }
];

export function getAddon(id: string): Addon | undefined {
  return ADDONS.find((a) => a.id === id);
}

export function defaultOptions(addon: Addon, env: ClusterEnv): Record<string, unknown> {
  return Object.fromEntries((addon.options ?? []).map((o) => [o.id, o.default(env)]));
}

export function valuesYaml(step: HelmStep, options: Record<string, unknown>, env: ClusterEnv): string {
  const values = step.values(options, env);
  return Object.keys(values).length ? yaml.dump(values, { lineWidth: -1 }) : '{}\n';
}

function randomPassword(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  return Array.from({ length: 20 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

/** Download a manifest over HTTPS (for manifest-based add-ons). */
export function fetchText(url: string, redirects = 3): Promise<string> {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { 'User-Agent': 'openlens-vscode' } }, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
          res.resume();
          resolve(fetchText(new URL(res.headers.location, url).toString(), redirects - 1));
          return;
        }
        if ((res.statusCode ?? 0) >= 400) {
          res.resume();
          reject(new Error(`GET ${url} failed with HTTP ${res.statusCode}`));
          return;
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve(body));
      })
      .on('error', reject)
      .setTimeout(30_000, function (this: any) {
        this.destroy(new Error(`GET ${url} timed out`));
      });
  });
}

export function parseManifest(text: string): K8sObject[] {
  return (yaml.loadAll(text) as K8sObject[]).filter((d) => d && typeof d === 'object' && d.kind && d.metadata?.name);
}
