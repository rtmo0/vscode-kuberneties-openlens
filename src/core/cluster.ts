import * as vscode from 'vscode';
import type { KubeConfig } from '@kubernetes/client-node';

import { buildKubeConfig, KubeconfigState, loadKubeconfigs } from './kubeconfig';
import { ContextHealth, staticHealth } from './kubeconfigHealth';
import { findByName, stableStringify } from './kubeconfigModel';
import { errorMessage, isForbidden, isNotFound, KubeApiError, KubeRest } from './kubeRest';
import { logger } from './logger';
import { parseQuantity } from './format';
import { ResourceWatcher } from './watch';
import {
  apiBase,
  apiVersionOf,
  collectionPath,
  findKindByKind,
  getKind,
  objectPath,
  registerCustomKind,
  registerKind,
  ResourceKind
} from './resources';

export type K8sObject = Record<string, any> & {
  apiVersion?: string;
  kind?: string;
  metadata: Record<string, any> & { name: string; namespace?: string; uid?: string };
};

export type ConnectionStatus = 'idle' | 'connecting' | 'connected' | 'error';

export interface ListResult {
  items: K8sObject[];
  /** Set when the requested scope was narrowed, e.g. no cluster-wide access. */
  notice?: string;
}

export interface Usage {
  cpu: number;
  memory: number;
}

export interface PodUsage extends Usage {
  containers: Map<string, Usage>;
}

const METRICS_RETRY_MS = 60_000;
const NAMESPACE_CACHE_MS = 30_000;
const CONNECT_TIMEOUT_MS = 15_000;
const ACCESS_CACHE_MS = 60_000;

/** One connection to one kubeconfig context. */
export class ClusterSession {
  readonly rest: KubeRest;
  status: ConnectionStatus = 'idle';
  version?: string;
  error?: string;

  private connecting?: Promise<void>;
  private namespacesCache?: { at: number; items: string[] };
  private metricsUnavailableUntil = 0;
  private metricsError?: string;
  private readonly discovery = new Map<string, Promise<Array<{ name: string; kind: string; namespaced: boolean }>>>();

  constructor(
    readonly context: string,
    readonly kc: KubeConfig,
    readonly defaultNamespace: string | undefined,
    private readonly onStatus: () => void
  ) {
    this.rest = new KubeRest(kc);
  }

  get server(): string {
    return this.rest.server;
  }

  /** Check connectivity once; later calls reuse the result until `reconnect`. */
  connect(): Promise<void> {
    if (this.status === 'connected') {
      return Promise.resolve();
    }
    if (!this.connecting) {
      this.status = 'connecting';
      this.onStatus();
      this.connecting = this.rest
        .get<{ gitVersion?: string }>('/version', undefined, { timeoutMs: CONNECT_TIMEOUT_MS })
        .then((info) => {
          this.version = info?.gitVersion;
          this.status = 'connected';
          this.error = undefined;
          logger.info(`Connected to ${this.context}`, { server: this.server, version: this.version });
        })
        .catch((err) => {
          // A cluster can deny /version but still serve resources.
          if (isForbidden(err)) {
            this.status = 'connected';
            this.error = undefined;
            return;
          }
          this.status = 'error';
          this.error = errorMessage(err);
          logger.error(`Failed to connect to ${this.context}`, this.error);
          throw err;
        })
        .finally(() => {
          this.connecting = undefined;
          this.onStatus();
        });
    }
    return this.connecting;
  }

  reconnect(): Promise<void> {
    this.status = 'idle';
    this.namespacesCache = undefined;
    this.metricsUnavailableUntil = 0;
    this.discovery.clear();
    this.accessCache.clear();
    return this.connect();
  }

  // ─────────────────────────── watches ───────────────────────────

  private readonly watchers = new Map<string, ResourceWatcher>();

  /** A shared list+watch of a collection; call `release` when done. */
  watch(kind: ResourceKind, namespace: string): { watcher: ResourceWatcher; release: () => void } {
    const query = kind.id === 'helmreleases' ? { labelSelector: 'owner=helm' } : {};
    const key = `${kind.id}|${kind.namespaced ? namespace : ''}`;
    let watcher = this.watchers.get(key);
    if (!watcher) {
      watcher = new ResourceWatcher(this, kind, namespace, query);
      this.watchers.set(key, watcher);
    }
    watcher.refs += 1;
    const w = watcher;
    let released = false;
    return {
      watcher: w,
      release: () => {
        if (released) {
          return;
        }
        released = true;
        w.refs -= 1;
        if (w.refs <= 0) {
          w.stop();
          this.watchers.delete(key);
        }
      }
    };
  }

  dispose(): void {
    for (const watcher of this.watchers.values()) {
      watcher.stop();
    }
    this.watchers.clear();
  }

  // ─────────────────────────── RBAC ───────────────────────────

  private readonly accessCache = new Map<string, { at: number; allowed: Promise<boolean> }>();

  /**
   * SelfSubjectAccessReview: may the current user do `verb` on the resource?
   * Errors count as allowed, so a failing check never hides an action.
   */
  can(verb: string, group: string, resource: string, namespace?: string, subresource?: string): Promise<boolean> {
    const key = [verb, group, resource, subresource ?? '', namespace ?? ''].join('|');
    const cached = this.accessCache.get(key);
    if (cached && Date.now() - cached.at < ACCESS_CACHE_MS) {
      return cached.allowed;
    }
    const allowed = this.rest
      .json<{ status?: { allowed?: boolean } }>('POST', '/apis/authorization.k8s.io/v1/selfsubjectaccessreviews', {
        body: {
          apiVersion: 'authorization.k8s.io/v1',
          kind: 'SelfSubjectAccessReview',
          spec: { resourceAttributes: { verb, group, resource, subresource, namespace: namespace || undefined } }
        }
      })
      .then((review) => review?.status?.allowed !== false)
      .catch(() => true);
    this.accessCache.set(key, { at: Date.now(), allowed });
    return allowed;
  }

  // ─────────────────────────── namespaces ───────────────────────────

  async namespaces(force = false): Promise<string[]> {
    if (!force && this.namespacesCache && Date.now() - this.namespacesCache.at < NAMESPACE_CACHE_MS) {
      return this.namespacesCache.items;
    }
    let items: string[];
    try {
      const list = await this.rest.get<{ items: K8sObject[] }>('/api/v1/namespaces');
      items = list.items.map((ns) => ns.metadata.name).sort();
    } catch (err) {
      if (!isForbidden(err)) {
        throw err;
      }
      items = [this.defaultNamespace ?? 'default'];
    }
    this.namespacesCache = { at: Date.now(), items };
    return items;
  }

  // ─────────────────────────── objects ───────────────────────────

  async list(kind: ResourceKind, namespace: string, query: Record<string, string | undefined> = {}): Promise<ListResult> {
    if (kind.id === 'helmreleases') {
      query = { ...query, labelSelector: 'owner=helm' };
    }
    const scope = kind.namespaced ? namespace : '';
    try {
      const list = await this.rest.get<{ items: K8sObject[] }>(collectionPath(kind, scope || undefined), query);
      return { items: list.items ?? [] };
    } catch (err) {
      if (kind.namespaced && !scope && isForbidden(err)) {
        const fallback = this.defaultNamespace ?? 'default';
        const list = await this.rest.get<{ items: K8sObject[] }>(collectionPath(kind, fallback), query);
        return {
          items: list.items ?? [],
          notice: `No permission to list ${kind.title.toLowerCase()} in all namespaces; showing namespace "${fallback}".`
        };
      }
      throw err;
    }
  }

  /** Server-side Table rendering (used for custom resources). */
  async listTable(kind: ResourceKind, namespace: string): Promise<any> {
    const scope = kind.namespaced ? namespace : '';
    return this.rest.get(collectionPath(kind, scope || undefined), undefined, {
      accept: 'application/json;as=Table;v=v1;g=meta.k8s.io,application/json'
    });
  }

  get(kind: ResourceKind, name: string, namespace?: string): Promise<K8sObject> {
    return this.rest.get<K8sObject>(objectPath(kind, name, namespace));
  }

  replace(kind: ResourceKind, object: K8sObject): Promise<K8sObject> {
    return this.rest.json<K8sObject>('PUT', objectPath(kind, object.metadata.name, object.metadata.namespace), {
      body: object
    });
  }

  patch(kind: ResourceKind, name: string, namespace: string | undefined, patch: unknown, type: 'merge' | 'strategic' | 'json' = 'merge'): Promise<K8sObject> {
    const contentType = {
      merge: 'application/merge-patch+json',
      strategic: 'application/strategic-merge-patch+json',
      json: 'application/json-patch+json'
    }[type];
    return this.rest.json<K8sObject>('PATCH', objectPath(kind, name, namespace), { body: patch, contentType });
  }

  delete(kind: ResourceKind, name: string, namespace?: string): Promise<unknown> {
    return this.rest.json('DELETE', objectPath(kind, name, namespace), {
      body: { kind: 'DeleteOptions', apiVersion: 'v1', propagationPolicy: 'Background' }
    });
  }

  create(kind: ResourceKind, object: K8sObject): Promise<K8sObject> {
    return this.rest.json<K8sObject>('POST', collectionPath(kind, object.metadata.namespace), { body: object });
  }

  /** Server-side apply: creates or updates the object like `kubectl apply --server-side`. */
  async apply(object: K8sObject, defaultNamespace?: string, dryRun = false): Promise<{ kind: ResourceKind; object: K8sObject }> {
    const kind = await this.resolveKind(object.apiVersion, object.kind);
    const namespace = kind.namespaced ? object.metadata.namespace || defaultNamespace || this.defaultNamespace || 'default' : undefined;
    const body = { ...object, metadata: { ...object.metadata, namespace } };
    if (!kind.namespaced) {
      delete body.metadata.namespace;
    }
    const result = await this.rest.json<K8sObject>('PATCH', objectPath(kind, object.metadata.name, namespace), {
      body,
      contentType: 'application/apply-patch+yaml',
      query: { fieldManager: 'openlens-vscode', force: true, dryRun: dryRun ? 'All' : undefined }
    });
    return { kind, object: result };
  }

  /** Find the resource for an apiVersion/kind, using API discovery for unknown kinds. */
  async resolveKind(apiVersion: string | undefined, kindName: string | undefined): Promise<ResourceKind> {
    if (!apiVersion || !kindName) {
      throw new Error('The object has no apiVersion or kind.');
    }
    const known = findKindByKind(apiVersion, kindName);
    if (known && apiVersionOf(known) === apiVersion) {
      return known;
    }
    const [group, version] = apiVersion.includes('/') ? apiVersion.split('/') : ['', apiVersion];
    const key = `${group}/${version}`;
    let resources = this.discovery.get(key);
    if (!resources) {
      resources = this.rest
        .get<{ resources: Array<{ name: string; kind: string; namespaced: boolean }> }>(apiBase(group, version))
        .then((r) => r.resources.filter((res) => !res.name.includes('/')));
      this.discovery.set(key, resources);
      resources.catch(() => this.discovery.delete(key));
    }
    const resource = (await resources).find((r) => r.kind === kindName);
    if (!resource) {
      throw new Error(`The server does not serve ${kindName} in ${apiVersion}.`);
    }
    return discoveredKind(group, version, resource);
  }

  /** Look up a kind id, loading CRDs / discovery for custom kinds not seen in this session yet. */
  async kind(kindId: string): Promise<ResourceKind> {
    const known = getKind(kindId);
    if (known) {
      return known;
    }
    if (kindId.startsWith('cr:')) {
      await this.customResourceKinds();
    } else if (kindId.startsWith('api:')) {
      const parts = kindId.slice(4).split('/');
      const plural = parts.pop()!;
      const [group, version] = parts;
      const list = await this.rest.get<{ resources: Array<{ name: string; kind: string; namespaced: boolean }> }>(apiBase(group, version));
      const resource = list.resources.find((r) => r.name === plural);
      if (resource) {
        return discoveredKind(group, version, resource);
      }
    }
    const loaded = getKind(kindId);
    if (!loaded) {
      throw new Error(`The cluster does not serve the resource "${kindId}".`);
    }
    return loaded;
  }

  async customResourceKinds(): Promise<ResourceKind[]> {
    const list = await this.rest.get<{ items: K8sObject[] }>('/apis/apiextensions.k8s.io/v1/customresourcedefinitions');
    return (list.items ?? [])
      .map((crd) => registerCustomKind(crd as unknown as Parameters<typeof registerCustomKind>[0]))
      .filter((kind): kind is ResourceKind => !!kind)
      .sort((a, b) => a.group.localeCompare(b.group) || a.kind.localeCompare(b.kind));
  }

  async events(namespace: string | undefined, fieldSelector?: string): Promise<K8sObject[]> {
    const path = namespace ? `/api/v1/namespaces/${encodeURIComponent(namespace)}/events` : '/api/v1/events';
    try {
      const list = await this.rest.get<{ items: K8sObject[] }>(path, { fieldSelector });
      return list.items ?? [];
    } catch (err) {
      if (isForbidden(err)) {
        return [];
      }
      throw err;
    }
  }

  // ─────────────────────────── metrics ───────────────────────────

  get metricsStatus(): string | undefined {
    return Date.now() < this.metricsUnavailableUntil ? this.metricsError : undefined;
  }

  async podMetrics(namespace?: string): Promise<Map<string, PodUsage> | undefined> {
    const path = namespace
      ? `/apis/metrics.k8s.io/v1beta1/namespaces/${encodeURIComponent(namespace)}/pods`
      : '/apis/metrics.k8s.io/v1beta1/pods';
    const list = await this.metricsRequest<{ items: any[] }>(path);
    if (!list) {
      return undefined;
    }
    const result = new Map<string, PodUsage>();
    for (const item of list.items ?? []) {
      const containers = new Map<string, Usage>();
      let cpu = 0;
      let memory = 0;
      for (const c of item.containers ?? []) {
        const usage = { cpu: parseQuantity(c.usage?.cpu), memory: parseQuantity(c.usage?.memory) };
        containers.set(c.name, usage);
        cpu += usage.cpu;
        memory += usage.memory;
      }
      result.set(`${item.metadata.namespace}/${item.metadata.name}`, { cpu, memory, containers });
    }
    return result;
  }

  async nodeMetrics(): Promise<Map<string, Usage> | undefined> {
    const list = await this.metricsRequest<{ items: any[] }>('/apis/metrics.k8s.io/v1beta1/nodes');
    if (!list) {
      return undefined;
    }
    return new Map(
      (list.items ?? []).map((item) => [
        item.metadata.name as string,
        { cpu: parseQuantity(item.usage?.cpu), memory: parseQuantity(item.usage?.memory) }
      ])
    );
  }

  private async metricsRequest<T>(path: string): Promise<T | undefined> {
    if (Date.now() < this.metricsUnavailableUntil) {
      return undefined;
    }
    try {
      return await this.rest.get<T>(path, undefined, { timeoutMs: 10_000 });
    } catch (err) {
      const status = err instanceof KubeApiError ? err.status : 0;
      this.metricsError =
        isNotFound(err) || status === 503
          ? 'metrics-server is not installed or not ready in this cluster.'
          : isForbidden(err)
            ? 'No permission to read metrics.k8s.io.'
            : errorMessage(err);
      this.metricsUnavailableUntil = Date.now() + METRICS_RETRY_MS;
      return undefined;
    }
  }
}

function discoveredKind(group: string, version: string, resource: { name: string; kind: string; namespaced: boolean }): ResourceKind {
  const kind: ResourceKind = {
    id: `api:${group}/${version}/${resource.name}`,
    kind: resource.kind,
    group,
    version,
    plural: resource.name,
    namespaced: resource.namespaced,
    title: resource.kind,
    category: 'custom',
    icon: 'symbol-object',
    custom: true
  };
  registerKind(kind);
  return kind;
}

export interface ContextInfo {
  name: string;
  cluster: string;
  user: string;
  namespace?: string;
  server: string;
  current: boolean;
  file?: string;
  health: ContextHealth;
}

/** Owns the merged kubeconfig and one lazily created session per context. */
export class ClusterManager implements vscode.Disposable {
  private state: KubeconfigState;
  private readonly sessions = new Map<string, { session: ClusterSession; fingerprint: string }>();
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  private readonly statusEmitter = new vscode.EventEmitter<string>();

  /** Fired when the kubeconfig was reloaded. */
  readonly onDidChange = this.changeEmitter.event;
  /** Fired with a context name when its connection status changed. */
  readonly onDidChangeStatus = this.statusEmitter.event;

  constructor(private readonly memento: vscode.Memento) {
    this.state = loadKubeconfigs();
    this.logErrors();
  }

  get kubeconfig(): KubeconfigState {
    return this.state;
  }

  get currentContext(): string {
    return this.state.config['current-context'] ?? '';
  }

  contexts(): ContextInfo[] {
    const current = this.currentContext;
    return this.state.config.contexts.map((ctx) => {
      const cluster = findByName(this.state.config.clusters, ctx.context.cluster);
      return {
        name: ctx.name,
        cluster: ctx.context.cluster,
        user: ctx.context.user,
        namespace: ctx.context.namespace,
        server: typeof cluster?.cluster.server === 'string' ? cluster.cluster.server : '',
        current: ctx.name === current,
        file: this.state.contextOrigin.get(ctx.name),
        health: this.healthOf(ctx.name)
      };
    });
  }

  private healthCache = new Map<string, ContextHealth>();

  private healthOf(name: string): ContextHealth {
    let health = this.healthCache.get(name);
    if (!health) {
      health = staticHealth(this.state.config, name);
      this.healthCache.set(name, health);
    }
    return health;
  }

  hasContext(name: string): boolean {
    return !!findByName(this.state.config.contexts, name);
  }

  /** Session for a context; created on first use. */
  session(context: string): ClusterSession {
    const existing = this.sessions.get(context);
    if (existing) {
      return existing.session;
    }
    const ctx = findByName(this.state.config.contexts, context);
    if (!ctx) {
      throw new Error(`Context "${context}" is not in the kubeconfig.`);
    }
    const kc = buildKubeConfig(this.state, context);
    const session = new ClusterSession(context, kc, ctx.context.namespace, () => this.statusEmitter.fire(context));
    this.sessions.set(context, { session, fingerprint: this.fingerprint(context) });
    return session;
  }

  peekSession(context: string): ClusterSession | undefined {
    return this.sessions.get(context)?.session;
  }

  /** Re-read the kubeconfig files; sessions whose context changed are dropped. */
  reload(): void {
    this.state = loadKubeconfigs();
    this.healthCache.clear();
    this.logErrors();
    for (const [name, entry] of [...this.sessions]) {
      if (!this.hasContext(name) || this.fingerprint(name) !== entry.fingerprint) {
        entry.session.dispose();
        this.sessions.delete(name);
      }
    }
    this.changeEmitter.fire();
  }

  /** Namespace filter of a context; '' means all namespaces. */
  namespaceFilter(context: string): string {
    return this.memento.get<string>(`namespace:${context}`, '');
  }

  async setNamespaceFilter(context: string, namespace: string): Promise<void> {
    await this.memento.update(`namespace:${context}`, namespace);
    this.statusEmitter.fire(context);
  }

  private fingerprint(context: string): string {
    const ctx = findByName(this.state.config.contexts, context);
    if (!ctx) {
      return '';
    }
    return stableStringify({
      ctx,
      cluster: findByName(this.state.config.clusters, ctx.context.cluster),
      user: findByName(this.state.config.users, ctx.context.user)
    });
  }

  private logErrors(): void {
    for (const error of this.state.errors) {
      logger.warn('Failed to load kubeconfig', error);
    }
  }

  dispose(): void {
    for (const entry of this.sessions.values()) {
      entry.session.dispose();
    }
    this.sessions.clear();
    this.changeEmitter.dispose();
    this.statusEmitter.dispose();
  }
}
