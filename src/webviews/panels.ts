import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import type { ResourceActions, Target } from '../commands/resourceActions';
import type { ClusterManager, ClusterSession, K8sObject } from '../core/cluster';
import { buildServerTable, buildTable, TableContext } from '../core/columns';
import { getConfig } from '../core/config';
import { buildDashboard } from '../core/dashboard';
import { buildDetails, MetricsHistory } from '../core/details';
import { buildTopology } from '../core/topology';
import { confirmAction } from '../core/guard';
import { errorMessage, isNotFound } from '../core/kubeRest';
import { allowedActions, filterRowActions } from '../core/permissions';
import type { ActionId, ObjectRef, TableInit } from '../core/protocol';
import { getKind, registerCustomKind, ResourceKind } from '../core/resources';
import type { ResourceWatcher } from '../core/watch';
import { BaseWebviewPanel } from './baseWebview';

export interface PanelServices {
  extensionUri: vscode.Uri;
  clusters: ClusterManager;
  actions: ResourceActions;
  favorites: {
    isPinned(context: string, ref: ObjectRef): boolean;
    toggle(context: string, ref: ObjectRef, label: string): boolean;
  };
}

function iconPath(services: PanelServices): vscode.Uri {
  return vscode.Uri.joinPath(services.extensionUri, 'resources', 'icon.png');
}

/** Open a link coming from a webview: a table when there is no name, details otherwise. */
function openRef(services: PanelServices, context: string, ref: ObjectRef): void {
  if (!ref.name) {
    services.actions.openTable(context, ref.kindId);
  } else {
    services.actions.openDetails(context, ref);
  }
}

// ─────────────────────────── dashboard ───────────────────────────

export class DashboardPanel extends BaseWebviewPanel {
  private static readonly panels = new Map<string, DashboardPanel>();

  static show(services: PanelServices, context: string): void {
    const existing = DashboardPanel.panels.get(context);
    if (existing) {
      existing.reveal();
      return;
    }
    DashboardPanel.panels.set(context, new DashboardPanel(services, context));
  }

  private constructor(
    private readonly services: PanelServices,
    private readonly context: string
  ) {
    super(services.extensionUri);
    this.initializePanel(vscode.ViewColumn.Active);
    this.panel.iconPath = iconPath(services);
    this.registerHandler('setNamespace', async (message, respond) => {
      const { namespace } = message.payload as { namespace: string };
      await this.services.clusters.setNamespaceFilter(this.context, namespace);
      respond(true);
      await this.pollNow();
    });
    this.registerHandler('refresh', async (_message, respond) => {
      respond(true);
      await this.pollNow();
    });
    this.registerHandler('open', (message, respond) => {
      openRef(this.services, this.context, message.payload as ObjectRef);
      respond(true);
    });
    this.registerHandler('metricsRange', async (message, respond) => {
      this.range = (message.payload as { range: number }).range;
      respond(true);
      await this.pollNow();
    });
    this.registerHandler('topology', (_message, respond) => {
      void vscode.commands.executeCommand('openLens.openTopology', { contextName: this.context });
      respond(true);
    });
    this.startPolling(() => this.load(), () => getConfig().refreshInterval);
  }

  private range = 3600;

  protected get panelKey(): string {
    return `dashboard:${this.context}`;
  }

  protected override get contextName(): string {
    return this.context;
  }

  protected get title(): string {
    return `Cluster · ${this.context}`;
  }

  protected get webviewName(): string {
    return 'dashboard';
  }

  private async load(): Promise<void> {
    try {
      const session = this.services.clusters.session(this.context);
      await session.connect();
      const data = await buildDashboard(session, this.services.clusters.namespaceFilter(this.context), this.range);
      this.post('data', data);
    } catch (err) {
      this.post('error', { message: errorMessage(err) });
    }
  }

  protected override onDispose(): void {
    DashboardPanel.panels.delete(this.context);
    super.onDispose();
  }
}

// ─────────────────────────── table ───────────────────────────

const BULK_ACTIONS: ActionId[] = ['delete', 'restart', 'suspend', 'resume', 'cordon', 'uncordon'];

export class ResourceTablePanel extends BaseWebviewPanel {
  private static readonly panels = new Map<string, ResourceTablePanel>();

  static show(services: PanelServices, context: string, kindId: string): void {
    const key = `${context}\u0000${kindId}`;
    const existing = ResourceTablePanel.panels.get(key);
    if (existing) {
      existing.reveal();
      return;
    }
    ResourceTablePanel.panels.set(key, new ResourceTablePanel(services, context, kindId));
  }

  private readonly kindTitle: string;

  private constructor(
    private readonly services: PanelServices,
    private readonly context: string,
    private readonly kindId: string
  ) {
    super(services.extensionUri);
    this.kindTitle = getKind(kindId)?.title ?? kindId;
    this.initializePanel(vscode.ViewColumn.Active);
    this.panel.iconPath = iconPath(services);

    this.registerHandler('init', async (_message, respond) => {
      const session = this.services.clusters.session(this.context);
      const kind = await session.kind(this.kindId);
      const namespaces = kind.namespaced ? await session.namespaces().catch(() => []) : [];
      const init: TableInit = {
        context: this.context,
        kindId: this.kindId,
        title: kind.title,
        namespaced: kind.namespaced,
        namespace: this.services.clusters.namespaceFilter(this.context),
        namespaces,
        bulkActions: BULK_ACTIONS
      };
      respond(init);
    });
    this.registerHandler('setNamespace', async (message, respond) => {
      const { namespace } = message.payload as { namespace: string };
      await this.services.clusters.setNamespaceFilter(this.context, namespace);
      respond(true);
      await this.pollNow();
    });
    this.registerHandler('refresh', async (_message, respond) => {
      respond(true);
      await this.pollNow();
    });
    this.registerHandler('action', async (message, respond) => {
      const { action, targets } = message.payload as { action: ActionId; targets: Target[] };
      const changed = await this.services.actions.run(action, this.context, this.kindId, targets);
      respond(changed);
      if (changed) {
        await this.pollNow();
      }
    });
    this.registerHandler('open', (message, respond) => {
      openRef(this.services, this.context, message.payload as ObjectRef);
      respond(true);
    });
    this.startPolling(() => this.load(), () => getConfig().refreshInterval);
  }

  protected get panelKey(): string {
    return `table:${this.context}:${this.kindId}`;
  }

  protected override get contextName(): string {
    return this.context;
  }

  protected get title(): string {
    return `${this.kindTitle} · ${this.context}`;
  }

  protected get webviewName(): string {
    return 'table';
  }

  private watch?: { key: string; watcher: ResourceWatcher; release: () => void };
  private tableContext: TableContext = {};

  /** Poll tick: metrics (and the whole list for custom resources, which are not watched). */
  private async load(): Promise<void> {
    try {
      const session = this.services.clusters.session(this.context);
      await session.connect();
      const kind = await session.kind(this.kindId);
      const namespace = this.services.clusters.namespaceFilter(this.context);
      if (kind.custom) {
        const table = buildServerTable(kind.id, kind.namespaced, await session.listTable(kind, namespace));
        table.rows = await filterRowActions(session, kind, table.rows);
        this.post('data', { ...table, namespace });
        return;
      }
      const key = `${kind.id}|${namespace}`;
      if (this.watch?.key !== key) {
        this.watch?.release();
        const { watcher, release } = session.watch(kind, namespace);
        const unsubscribe = watcher.onChange(() => void this.render());
        this.watch = {
          key,
          watcher,
          release: () => {
            unsubscribe();
            release();
          }
        };
      }
      await this.refreshMetrics(session, kind, namespace);
      await this.watch.watcher.whenReady();
      await this.render();
    } catch (err) {
      this.post('error', { message: errorMessage(err) });
    }
  }

  private async refreshMetrics(session: ClusterSession, kind: ResourceKind, namespace: string): Promise<void> {
    const ctx: TableContext = {};
    if (kind.id === 'pods') {
      ctx.podMetrics = await session.podMetrics(namespace || undefined);
    } else if (kind.id === 'nodes') {
      const [metrics, pods] = await Promise.all([
        session.nodeMetrics(),
        session.list(getKind('pods')!, '', { fieldSelector: 'status.phase!=Succeeded,status.phase!=Failed' }).catch(() => undefined)
      ]);
      ctx.nodeMetrics = metrics;
      if (pods) {
        ctx.podsPerNode = new Map();
        for (const pod of pods.items) {
          const node = pod.spec?.nodeName;
          if (node) {
            ctx.podsPerNode.set(node, (ctx.podsPerNode.get(node) ?? 0) + 1);
          }
        }
      }
    }
    this.tableContext = ctx;
  }

  /** Rebuild the table from the watched objects. */
  private async render(): Promise<void> {
    if (!this.watch) {
      return;
    }
    const session = this.services.clusters.session(this.context);
    const kind = await session.kind(this.kindId);
    const state = this.watch.watcher.state;
    if (state.error && !state.items.length) {
      this.post('error', { message: state.error });
      return;
    }
    if (kind.id === 'crds') {
      for (const crd of state.items) {
        registerCustomKind(crd as unknown as Parameters<typeof registerCustomKind>[0]);
      }
    }
    const table = buildTable(kind, state.items, this.tableContext);
    table.rows = await filterRowActions(session, kind, table.rows);
    const notices = [
      state.notice,
      state.error ? `Live updates interrupted, reconnecting: ${state.error}` : undefined,
      (kind.id === 'pods' || kind.id === 'nodes') && session.metricsStatus ? `Metrics: ${session.metricsStatus}` : undefined
    ].filter(Boolean);
    this.post('data', { ...table, namespace: this.services.clusters.namespaceFilter(this.context), notice: notices.join(' ') || undefined });
  }

  protected override onDispose(): void {
    this.watch?.release();
    ResourceTablePanel.panels.delete(`${this.context}\u0000${this.kindId}`);
    super.onDispose();
  }
}

// ─────────────────────────── details ───────────────────────────

/** One details panel per context that navigates between objects, with Back. */
export class DetailsPanel extends BaseWebviewPanel {
  private static readonly panels = new Map<string, DetailsPanel>();

  static show(services: PanelServices, context: string, ref: ObjectRef): void {
    const existing = DetailsPanel.panels.get(context);
    if (existing) {
      existing.navigate(ref, true);
      existing.reveal();
      return;
    }
    DetailsPanel.panels.set(context, new DetailsPanel(services, context, ref));
  }

  private readonly history: ObjectRef[] = [];
  private readonly metrics = new MetricsHistory();
  private metricsRange = 3600;
  private current: ObjectRef;
  private currentObject?: K8sObject;

  private constructor(
    private readonly services: PanelServices,
    private readonly context: string,
    ref: ObjectRef
  ) {
    super(services.extensionUri);
    this.current = ref;
    this.initializePanel(vscode.ViewColumn.Active);
    this.panel.iconPath = iconPath(services);
    this.updateTitle();

    this.registerHandler('refresh', async (_message, respond) => {
      respond(true);
      await this.pollNow();
    });
    this.registerHandler('back', async (_message, respond) => {
      const previous = this.history.pop();
      respond(true);
      if (previous) {
        this.navigate(previous, false);
      }
    });
    this.registerHandler('open', (message, respond) => {
      const ref = message.payload as ObjectRef;
      if (ref.name) {
        this.navigate(ref, true);
      } else {
        openRef(this.services, this.context, ref);
      }
      respond(true);
    });
    this.registerHandler('action', async (message, respond) => {
      const { action, target } = message.payload as { action: ActionId; target?: ObjectRef };
      const ref = target ?? this.current;
      const changed = await this.services.actions.run(action, this.context, ref.kindId, [{ name: ref.name, namespace: ref.namespace }]);
      respond(changed);
      if (changed) {
        await this.pollNow();
      }
    });
    this.registerHandler('containerAction', async (message, respond) => {
      const { action, container, previous } = message.payload as { action: 'logs' | 'shell' | 'download' | 'upload' | 'debug'; container: string; previous?: boolean };
      const session = this.services.clusters.session(this.context);
      const target = { name: this.current.name, namespace: this.current.namespace };
      try {
        if (action === 'logs') {
          await this.services.actions.logs(session, getKind('pods')!, target, { container, previous });
        } else if (action === 'shell') {
          await this.services.actions.shell(session, target, container);
        } else if (action === 'download') {
          await this.services.actions.downloadFile(session, target, container);
        } else if (action === 'upload') {
          await this.services.actions.uploadFile(session, target, container);
        } else {
          await this.services.actions.debug(session, target, container);
          await this.pollNow();
        }
      } catch (err) {
        void vscode.window.showErrorMessage(errorMessage(err));
      }
      respond(true);
    });
    this.registerHandler('revision', async (message, respond) => {
      const { action, revision } = message.payload as { action: 'diff' | 'rollback' | 'diffValues' | 'diffManifest' | 'helmRollback'; revision: number };
      const target = { name: this.current.name, namespace: this.current.namespace };
      let changed = false;
      try {
        switch (action) {
          case 'diff':
            await this.services.actions.diffRevision(this.context, this.current.kindId, target, revision);
            break;
          case 'rollback':
            changed = await this.services.actions.rollback(this.context, this.current.kindId, target, revision);
            break;
          case 'diffValues':
          case 'diffManifest':
            await this.services.actions.helmDiff(this.context, target, revision, action === 'diffValues' ? 'values' : 'manifest');
            break;
          case 'helmRollback':
            changed = await this.services.actions.helmRollback(this.context, target, revision);
            break;
        }
      } catch (err) {
        void vscode.window.showErrorMessage(errorMessage(err));
      }
      respond(changed);
      if (changed) {
        await this.pollNow();
      }
    });
    this.registerHandler('helmEditValues', async (_message, respond) => {
      try {
        await this.services.actions.helmEditValues(this.context, { name: this.current.name, namespace: this.current.namespace });
      } catch (err) {
        void vscode.window.showErrorMessage(errorMessage(err));
      }
      respond(true);
    });
    this.registerHandler('metricsRange', async (message, respond) => {
      this.metricsRange = (message.payload as { range: number }).range;
      respond(true);
      await this.pollNow();
    });
    this.registerHandler('togglePin', async (_message, respond) => {
      const pinned = this.services.favorites.toggle(this.context, this.current, this.current.name);
      respond(pinned);
      await this.pollNow();
    });
    this.registerHandler('forward', async (message, respond) => {
      const { port, kindId, name } = message.payload as { port: number; kindId: string; name: string };
      const session = this.services.clusters.session(this.context);
      try {
        await this.services.actions.forward(session, getKind(kindId)!, { name, namespace: this.current.namespace }, port);
      } catch (err) {
        void vscode.window.showErrorMessage(`Port forward failed: ${errorMessage(err)}`);
      }
      respond(true);
    });
    this.registerHandler('saveEntry', async (message, respond) => {
      const { key, value, previousKey } = message.payload as { key: string; value: string; previousKey?: string };
      await this.saveEntry(key, value, previousKey);
      respond(true);
      await this.pollNow();
    });
    this.registerHandler('deleteEntry', async (message, respond) => {
      const { key } = message.payload as { key: string };
      const choice = await vscode.window.showWarningMessage(`Delete key "${key}" from ${this.current.name}?`, { modal: true }, 'Delete');
      if (choice === 'Delete') {
        await this.saveEntry(undefined, undefined, key);
      }
      respond(choice === 'Delete');
      await this.pollNow();
    });
    this.registerHandler('copy', async (message, respond) => {
      const { text, label } = message.payload as { text: string; label?: string };
      await vscode.env.clipboard.writeText(text);
      void vscode.window.setStatusBarMessage(`Copied ${label ?? 'value'} to the clipboard`, 3000);
      respond(true);
    });
    this.startPolling(() => this.load(), () => getConfig().refreshInterval);
  }

  protected get panelKey(): string {
    return `details:${this.context}`;
  }

  protected override get contextName(): string {
    return this.context;
  }

  protected get title(): string {
    return this.current?.name ?? 'Details';
  }

  protected get webviewName(): string {
    return 'details';
  }

  private navigate(ref: ObjectRef, pushHistory: boolean): void {
    if (pushHistory && (ref.kindId !== this.current.kindId || ref.name !== this.current.name || ref.namespace !== this.current.namespace)) {
      this.history.push(this.current);
      if (this.history.length > 50) {
        this.history.shift();
      }
    }
    this.current = ref;
    this.currentObject = undefined;
    this.updateTitle();
    this.post('loading', { ref });
    void this.pollNow();
  }

  private updateTitle(): void {
    if (this.panel) {
      this.setTitle(`${this.current.name} · ${getKind(this.current.kindId)?.kind ?? this.current.kindId}`);
    }
  }

  private async load(): Promise<void> {
    const ref = this.current;
    try {
      const session = this.services.clusters.session(this.context);
      await session.connect();
      const kind = await session.kind(ref.kindId);
      let obj: K8sObject;
      if (kind.id === 'helmreleases') {
        const secrets = await session.list(getKind('secrets')!, ref.namespace ?? '', { labelSelector: `owner=helm,name=${ref.name}` });
        const latest = secrets.items.sort((a, b) => Number(b.metadata.labels?.version) - Number(a.metadata.labels?.version))[0];
        if (!latest) {
          throw Object.assign(new Error('not found'), { status: 404 });
        }
        obj = latest;
      } else {
        obj = await session.get(kind, ref.name, ref.namespace);
      }
      this.currentObject = obj;
      const details = await buildDetails(session, kind, obj, this.metrics, { range: this.metricsRange });
      const allowed = await allowedActions(session, kind, obj.metadata.namespace, details.actions);
      details.actions = details.actions.filter((a) => allowed.has(a));
      details.pinned = this.services.favorites.isPinned(this.context, ref);
      details.ref = ref;
      if (ref === this.current) {
        this.services.actions.onOpened(this.context, ref);
        this.post('data', { ref, details, canGoBack: this.history.length > 0 });
      }
    } catch (err) {
      if (ref !== this.current) {
        return;
      }
      const gone = isNotFound(err) || (err as { status?: number }).status === 404;
      this.post('error', {
        ref,
        canGoBack: this.history.length > 0,
        message: gone ? `${getKind(ref.kindId)?.kind ?? 'Object'} "${ref.name}" no longer exists.` : errorMessage(err)
      });
    }
  }

  /** Add, change, rename or delete one key of a Secret or ConfigMap. */
  private async saveEntry(key: string | undefined, value: string | undefined, previousKey?: string): Promise<void> {
    const ref = this.current;
    const kind = getKind(ref.kindId)!;
    const session = this.services.clusters.session(this.context);
    const confirmed = await confirmAction(this.context, {
      title: `${key === undefined ? 'Delete' : 'Change'} key "${key ?? previousKey}" of ${kind.kind} ${ref.name}`,
      button: 'Save'
    });
    if (!confirmed) {
      throw new Error('Cancelled.');
    }
    const data: Record<string, string | null> = {};
    if (previousKey && previousKey !== key) {
      data[previousKey] = null;
    }
    if (key !== undefined && value !== undefined) {
      data[key] = kind.id === 'secrets' ? Buffer.from(value, 'utf8').toString('base64') : value;
    }
    const patch: Record<string, unknown> = { data };
    if (kind.id === 'configmaps' && previousKey && this.currentObject?.binaryData?.[previousKey] !== undefined) {
      patch.binaryData = { [previousKey]: null };
      delete data[previousKey];
    }
    try {
      await session.patch(kind, ref.name, ref.namespace, patch);
      void vscode.window.setStatusBarMessage(`Saved ${ref.name}`, 3000);
    } catch (err) {
      void vscode.window.showErrorMessage(`Failed to save ${ref.name}: ${errorMessage(err)}`);
      throw err;
    }
  }

  protected override onDispose(): void {
    DetailsPanel.panels.delete(this.context);
    super.onDispose();
  }
}


// ─────────────────────────── logs ───────────────────────────

export interface LogsOptions {
  namespace: string;
  sources: Array<{ pod: string; container: string }>;
  previous: boolean;
  tailLines: number;
  title: string;
}

interface LogLine {
  s: number;
  t?: string;
  m: string;
}

const LOG_BATCH_MS = 150;

/** Log viewer with search, level filter, JSON formatting and download; streams every source in parallel. */
export class LogsPanel extends BaseWebviewPanel {
  private static counter = 0;
  private readonly id = ++LogsPanel.counter;
  private streams: Array<{ abort: () => void }> = [];
  private pending: LogLine[] = [];
  private flushTimer?: ReturnType<typeof setTimeout>;
  private generation = 0;
  private lastTimestamp?: string;

  static show(services: PanelServices, context: string, options: LogsOptions): void {
    new LogsPanel(services, context, options);
  }

  private constructor(
    private readonly services: PanelServices,
    private readonly context: string,
    private options: LogsOptions
  ) {
    super(services.extensionUri);
    this.initializePanel(vscode.ViewColumn.Active);
    this.panel.iconPath = iconPath(services);

    this.registerHandler('init', (_message, respond) => {
      respond({
        title: options.title,
        context,
        namespace: options.namespace,
        sources: options.sources.map((s) => (new Set(options.sources.map((x) => x.pod)).size > 1 ? `${s.pod}/${s.container}` : s.container)),
        previous: options.previous,
        tailLines: options.tailLines
      });
      this.start({});
    });
    this.registerHandler('restart', (message, respond) => {
      const { sinceSeconds, tailLines, previous } = message.payload as { sinceSeconds?: number; tailLines?: number; previous?: boolean };
      this.options = { ...this.options, tailLines: tailLines ?? this.options.tailLines, previous: previous ?? this.options.previous };
      this.start({ sinceSeconds });
      respond(true);
    });
    this.registerHandler('pause', (_message, respond) => {
      this.stop();
      respond(true);
    });
    this.registerHandler('resume', (_message, respond) => {
      // Continue right after the last line we received.
      this.start({ sinceTime: this.lastTimestamp, keep: true });
      respond(true);
    });
    this.registerHandler('download', async (message, respond) => {
      const { text } = message.payload as { text: string };
      const uri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(path.join(os.homedir(), `${options.title.replace(/[^\w.-]+/g, '_')}.log`)),
        filters: { Logs: ['log', 'txt'] }
      });
      if (uri) {
        await vscode.workspace.fs.writeFile(uri, Buffer.from(text, 'utf8'));
        void vscode.window.setStatusBarMessage(`Saved ${uri.fsPath}`, 4000);
      }
      respond(!!uri);
    });
    this.registerHandler('copy', async (message, respond) => {
      await vscode.env.clipboard.writeText((message.payload as { text: string }).text);
      respond(true);
    });
  }

  protected get panelKey(): string {
    return `logs:${this.id}`;
  }

  protected override get contextName(): string {
    return this.context;
  }

  protected get title(): string {
    return `Logs · ${this.options.title}`;
  }

  protected get webviewName(): string {
    return 'logs';
  }

  private stop(): void {
    this.generation += 1;
    for (const stream of this.streams) {
      stream.abort();
    }
    this.streams = [];
    this.flush();
  }

  private start(opts: { sinceSeconds?: number; sinceTime?: string; keep?: boolean }): void {
    this.stop();
    const generation = this.generation;
    if (!opts.keep) {
      this.post('reset');
    }
    this.post('state', { streaming: true });
    const session = this.services.clusters.session(this.context);
    let remaining = this.options.sources.length;
    this.options.sources.forEach((source, index) => {
      let partial = '';
      const logPath = `/api/v1/namespaces/${encodeURIComponent(this.options.namespace)}/pods/${encodeURIComponent(source.pod)}/log`;
      const query = {
        container: source.container,
        follow: !this.options.previous,
        previous: this.options.previous || undefined,
        timestamps: true,
        tailLines: opts.sinceSeconds || opts.sinceTime ? undefined : this.options.tailLines || undefined,
        sinceSeconds: opts.sinceSeconds,
        sinceTime: opts.sinceTime
      };
      const onLine = (line: string): void => {
        if (generation !== this.generation) {
          return;
        }
        const match = /^(\d{4}-\d\d-\d\dT[\d:.]+Z) (.*)$/s.exec(line);
        if (match) {
          // On resume, skip the line the stream starts with if we already have it.
          if (opts.sinceTime && match[1] <= opts.sinceTime) {
            return;
          }
          this.lastTimestamp = match[1];
        }
        this.pending.push(match ? { s: index, t: match[1], m: match[2] } : { s: index, m: line });
        this.scheduleFlush();
      };
      session.rest
        .stream(logPath, query, (chunk) => {
          const lines = (partial + chunk.toString('utf8')).split('\n');
          partial = lines.pop() ?? '';
          lines.forEach(onLine);
        })
        .then((stream) => {
          if (generation !== this.generation) {
            stream.abort();
            return;
          }
          this.streams.push(stream);
          return stream.done;
        })
        .catch((err) => {
          if (generation === this.generation) {
            this.pending.push({ s: index, m: `⚠ ${errorMessage(err)}` });
            this.scheduleFlush();
          }
        })
        .finally(() => {
          if (partial) {
            onLine(partial);
          }
          remaining -= 1;
          if (remaining === 0 && generation === this.generation) {
            this.flush();
            this.post('state', { streaming: false });
          }
        });
    });
  }

  private scheduleFlush(): void {
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flush(), LOG_BATCH_MS);
    }
  }

  private flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    if (this.pending.length) {
      this.post('lines', this.pending);
      this.pending = [];
    }
  }

  protected override onDispose(): void {
    this.stop();
    super.onDispose();
  }
}

// ─────────────────────────── topology ───────────────────────────

export class TopologyPanel extends BaseWebviewPanel {
  private static readonly panels = new Map<string, TopologyPanel>();

  static show(services: PanelServices, context: string, namespace: string): void {
    const key = `${context}\u0000${namespace}`;
    const existing = TopologyPanel.panels.get(key);
    if (existing) {
      existing.reveal();
      return;
    }
    TopologyPanel.panels.set(key, new TopologyPanel(services, context, namespace));
  }

  private constructor(
    private readonly services: PanelServices,
    private readonly context: string,
    private readonly namespace: string
  ) {
    super(services.extensionUri);
    this.initializePanel(vscode.ViewColumn.Active);
    this.panel.iconPath = iconPath(services);
    this.registerHandler('refresh', async (_message, respond) => {
      respond(true);
      await this.pollNow();
    });
    this.registerHandler('open', (message, respond) => {
      openRef(this.services, this.context, { ...(message.payload as ObjectRef), namespace: this.namespace });
      respond(true);
    });
    this.startPolling(() => this.load(), () => Math.max(10, getConfig().refreshInterval * 2));
  }

  protected get panelKey(): string {
    return `topology:${this.context}:${this.namespace}`;
  }

  protected get title(): string {
    return `Topology · ${this.namespace}`;
  }

  protected override get contextName(): string {
    return this.context;
  }

  protected get webviewName(): string {
    return 'topology';
  }

  private async load(): Promise<void> {
    try {
      const session = this.services.clusters.session(this.context);
      await session.connect();
      this.post('data', { context: this.context, ...(await buildTopology(session, this.namespace)) });
    } catch (err) {
      this.post('error', { message: errorMessage(err) });
    }
  }

  protected override onDispose(): void {
    TopologyPanel.panels.delete(`${this.context}\u0000${this.namespace}`);
    super.onDispose();
  }
}
