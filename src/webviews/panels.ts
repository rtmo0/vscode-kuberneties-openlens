import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import type { ResourceActions, Target } from '../commands/resourceActions';
import type { ClusterManager, ClusterSession, K8sObject } from '../core/cluster';
import { buildServerTable, buildTable, buildTableSupplement, rowActions, TableContext } from '../core/columns';
import { getConfig } from '../core/config';
import { buildDashboard } from '../core/dashboard';
import { buildDetails, MetricsHistory } from '../core/details';
import { buildTopology } from '../core/topology';
import { confirmAction } from '../core/guard';
import { errorMessage, isNotFound } from '../core/kubeRest';
import { allowedActions } from '../core/permissions';
import { logger } from '../core/logger';
import type { ActionId, Cell, DetailsData, ObjectRef, ResourceTableData, Row, TableData, TableInit, TablePatch, TableRowUpdate, TableSupplement } from '../core/protocol';
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

/** Namespaces whose row actions are checked concurrently (one rules review each). */
const PERMISSION_BATCH = 4;

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
      const init: TableInit = {
        context: this.context,
        kindId: this.kindId,
        title: kind.title,
        namespaced: kind.namespaced,
        namespace: this.services.clusters.namespaceFilter(this.context),
        namespaces: [],
        bulkActions: BULK_ACTIONS
      };
      respond(init);
    });
    this.registerHandler('painted', (message, respond) => {
      const { scope } = message.payload as { scope: number };
      respond(true);
      if (scope !== this.scope || this.tableDisposed || this.painted) {
        return;
      }
      this.painted = true;
      logger.info('Resource table first paint', { kind: this.kindId, rows: this.rawRows.size, elapsedMs: Date.now() - this.loadStarted });
      this.enrich();
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

  private watch?: { watcher: ResourceWatcher; release: () => void };
  private session?: ClusterSession;
  private kind?: ResourceKind;
  private namespace = '';
  private scopeKey?: string;
  private scope = 0;
  private painted = false;
  private firstRowsSent = false;
  private loadStarted = Date.now();
  private tableContext: TableContext = {};
  private rawRows = new Map<string, Row>();
  /** Rows of unchanged watch objects are reused instead of rebuilt. */
  private rowCache = new WeakMap<K8sObject, Row>();
  /** What the webview holds for this scope; later renders only send the difference. */
  private sent = new Map<string, { row: Row; json?: string }>();
  private sentColumns?: string;
  private columnIndex = new Map<string, number>();
  private readonly permissions = new Map<string, { checked: Set<ActionId>; allowed: Set<ActionId>; at: number }>();
  private permissionsRunning = false;
  private nodePods?: { release: () => void };
  private renderTimer?: ReturnType<typeof setTimeout>;
  private tableDisposed = false;
  private metricsScope?: number;
  private metricsAt = 0;
  private namespacesSession?: ClusterSession;

  private scheduleRender(): void {
    if (this.tableDisposed || !this.panel.visible || this.renderTimer) {
      return;
    }
    // The first batch should be posted as soon as it arrives. Later watch bursts are coalesced.
    if (!this.firstRowsSent) {
      this.render();
      return;
    }
    this.renderTimer = setTimeout(() => {
      this.renderTimer = undefined;
      if (this.panel.visible) {
        this.render();
      }
    }, 100);
  }

  private current(scope: number): boolean {
    return !this.tableDisposed && scope === this.scope &&
      this.namespace === this.services.clusters.namespaceFilter(this.context);
  }

  private supplement(update: Omit<TableSupplement, 'scope'>): void {
    this.post('supplement', { ...update, scope: this.scope } satisfies TableSupplement);
  }

  /** Start optional work only after the webview has painted its first resource batch. */
  private enrich(): void {
    if (!this.painted || !this.current(this.scope) || !this.panel.visible || !this.session || !this.kind) {
      return;
    }
    const session = this.session;
    const scope = this.scope;
    // /version is useful for cluster status, but must never gate resource access.
    void session.connect().catch(() => undefined);
    if (this.kind.namespaced && this.namespacesSession !== session) {
      this.namespacesSession = session;
      void session.namespaces().then((names) => {
        if (!this.tableDisposed && this.session === session) {
          this.post('namespaces', names);
        }
      }).catch(() => undefined);
    }
    if (this.kind.id === 'nodes') {
      this.watchNodePods(session);
    }
    if ((this.kind.id === 'pods' || this.kind.id === 'nodes') && this.metricsScope !== scope &&
        Date.now() - this.metricsAt >= getConfig().refreshInterval * 1000) {
      this.metricsScope = scope;
      void this.refreshMetrics(session, this.kind, this.namespace, scope)
        .catch((err) => {
          if (this.current(scope)) { this.supplement({ rows: [], metricsNotice: errorMessage(err) }); }
        })
        .finally(() => { if (this.metricsScope === scope) { this.metricsScope = undefined; } });
    }
    void this.refreshActions();
  }

  /** Share counts with the Pods tab, after the Nodes table is already visible. */
  private watchNodePods(session: ClusterSession): void {
    if (this.nodePods) { return; }
    const scope = this.scope;
    const { watcher, release } = session.watch(getKind('pods')!, '');
    const update = (): void => {
      if (!this.current(scope)) { return; }
      const state = watcher.state;
      const counts = state.ready && !state.error && !state.namespace ? new Map<string, number>() : undefined;
      if (counts) {
        for (const pod of state.items) {
          const node = pod.spec?.nodeName;
          if (node && pod.status?.phase !== 'Succeeded' && pod.status?.phase !== 'Failed') {
            counts.set(node, (counts.get(node) ?? 0) + 1);
          }
        }
      }
      this.tableContext.podsPerNode = counts;
      this.publishCells(['pods']);
    };
    const unsubscribe = watcher.onChange(update);
    this.nodePods = { release: () => { unsubscribe(); release(); } };
    update();
  }

  private async load(): Promise<void> {
    try {
      const session = this.services.clusters.session(this.context);
      // Built-in kinds require no discovery and no /version round-trip.
      const kind = getKind(this.kindId) ?? await session.kind(this.kindId);
      if (this.tableDisposed) { return; }
      const namespace = this.services.clusters.namespaceFilter(this.context);
      const key = `${kind.id}|${namespace}`;
      if (this.scopeKey !== key || this.session !== session) {
        this.watch?.release();
        this.watch = undefined;
        this.nodePods?.release();
        this.nodePods = undefined;
        this.scopeKey = key;
        this.scope++;
        this.session = session;
        this.kind = kind;
        this.namespace = namespace;
        this.tableContext = {};
        this.rawRows.clear();
        this.rowCache = new WeakMap();
        this.sent = new Map();
        this.sentColumns = undefined;
        this.permissions.clear();
        this.painted = false;
        this.firstRowsSent = false;
        this.metricsAt = 0;
        this.loadStarted = Date.now();
        if (!kind.custom) {
          const { watcher, release } = session.watch(kind, namespace);
          const unsubscribe = watcher.onChange(() => this.scheduleRender());
          this.watch = { watcher, release: () => { unsubscribe(); release(); } };
        }
      }
      const scope = this.scope;
      if (kind.custom) {
        const table = buildServerTable(kind.id, kind.namespaced, await session.listTable(kind, namespace));
        if (this.current(scope)) { this.publish(table); }
      } else {
        this.scheduleRender();
      }
      this.enrich();
    } catch (err) {
      this.post('error', { message: errorMessage(err) });
    }
  }

  private async refreshMetrics(session: ClusterSession, kind: ResourceKind, namespace: string, scope: number): Promise<void> {
    const ctx: TableContext = kind.id === 'pods'
      ? { podMetrics: await session.podMetrics(namespace || undefined) }
      : { nodeMetrics: await session.nodeMetrics() };
    if (!this.current(scope)) { return; }
    this.metricsAt = Date.now();
    this.tableContext = { ...this.tableContext, ...ctx };
    this.publishCells(['cpu', 'memory'], session.metricsStatus ?? '');
  }

  private publishCells(columns: string[], metricsNotice?: string): void {
    if (!this.kind || !this.watch) { return; }
    const items = this.watch.watcher.state.items;
    const rows: TableRowUpdate[] = [];
    // Send only cells that differ, and keep cached rows equal to what the webview shows.
    for (const update of buildTableSupplement(this.kind, items, this.tableContext, columns)) {
      const row = this.rawRows.get(update.key);
      const cells: Record<string, Cell> = {};
      for (const [column, cell] of Object.entries(update.cells ?? {})) {
        const index = this.columnIndex.get(column);
        if (row && index !== undefined && JSON.stringify(row.cells[index]) !== JSON.stringify(cell)) {
          row.cells[index] = cell;
          cells[column] = cell;
        }
      }
      if (Object.keys(cells).length) { rows.push({ key: update.key, cells }); }
    }
    if (rows.length || metricsNotice !== undefined) {
      this.supplement({ rows, metricsNotice });
    }
  }

  /** A few namespaces at a time: a large list must not launch thousands of RBAC requests at once. */
  private async refreshActions(): Promise<void> {
    if (this.permissionsRunning || !this.session || !this.kind) { return; }
    this.permissionsRunning = true;
    const scope = this.scope;
    const session = this.session;
    const kind = this.kind;
    try {
      while (this.current(scope)) {
        const candidates = new Map<string, Set<ActionId>>();
        for (const row of this.rawRows.values()) {
          const ns = row.namespace ?? '';
          const actions = candidates.get(ns) ?? new Set<ActionId>();
          row.actions.forEach((action) => actions.add(action));
          candidates.set(ns, actions);
        }
        const stale = [...candidates].filter(([ns, actions]) => {
          const cached = this.permissions.get(ns);
          return !cached || Date.now() - cached.at >= 60_000 || [...actions].some((action) => !cached.checked.has(action));
        }).slice(0, PERMISSION_BATCH);
        if (!stale.length) { break; }
        const results = await Promise.all(stale.map(async ([namespace, actions]) =>
          ({ namespace, actions, allowed: await allowedActions(session, kind, namespace || undefined, [...actions]) })));
        if (!this.current(scope)) { break; }
        for (const { namespace, actions, allowed } of results) {
          this.permissions.set(namespace, { checked: actions, allowed, at: Date.now() });
        }
        const done = new Map(results.map((result) => [result.namespace, result.allowed]));
        this.supplement({ rows: [...this.rawRows.values()]
          .filter((row) => done.has(row.namespace ?? ''))
          .map((row) => ({ key: row.key, actions: row.actions.filter((action) => done.get(row.namespace ?? '')!.has(action)) })) });
      }
    } catch (err) {
      logger.warn('Table action checks failed', errorMessage(err));
    } finally {
      this.permissionsRunning = false;
      if (scope !== this.scope && this.painted && !this.tableDisposed) { void this.refreshActions(); }
    }
  }

  /** Resource snapshots never await metrics, permission checks or namespace discovery. */
  private render(): void {
    if (!this.current(this.scope) || !this.watch || !this.kind) { return; }
    const state = this.watch.watcher.state;
    if (!state.ready && !state.items.length) { return; }
    if (state.error && !state.items.length) {
      this.post('error', { message: state.error });
      return;
    }
    if (this.kind.id === 'crds') {
      for (const crd of state.items) {
        registerCustomKind(crd as unknown as Parameters<typeof registerCustomKind>[0]);
      }
    }
    this.publish({
      ...buildTable(this.kind, state.items, this.tableContext, this.rowCache),
      loading: state.ready ? undefined : `Loading more resources… ${state.items.length} loaded`,
      notice: [state.notice, state.error ? `Live updates interrupted, reconnecting: ${state.error}` : undefined].filter(Boolean).join(' ') || undefined
    });
  }

  /** The first snapshot of a scope is sent whole; afterwards only added, changed and removed rows. */
  private publish(table: TableData): void {
    this.rawRows = new Map(table.rows.map((row) => [row.key, row]));
    const columns = JSON.stringify(table.columns);
    const full = this.sentColumns !== columns;
    const previous = full ? new Map<string, { row: Row; json?: string }>() : this.sent;
    const sent = new Map<string, { row: Row; json?: string }>();
    const upsert: Row[] = [];
    for (const row of table.rows) {
      const before = previous.get(row.key);
      if (before?.row === row) {
        sent.set(row.key, before);
        continue;
      }
      const json = before ? JSON.stringify(row) : undefined;
      if (before && (before.json ??= JSON.stringify(before.row)) === json) {
        sent.set(row.key, { row, json });
        continue;
      }
      sent.set(row.key, { row, json });
      upsert.push(row);
    }
    const remove = [...previous.keys()].filter((key) => !sent.has(key));
    this.sent = sent;
    this.sentColumns = columns;
    this.columnIndex = new Map(table.columns.map((column, index) => [column.id, index]));
    const visibleActions = (row: Row): Row => ({ ...row, actions: row.actions.filter((action) =>
      this.permissions.get(row.namespace ?? '')?.allowed.has(action) || action === 'details' || action === 'yaml') });
    if (full) {
      this.post('data', { ...table, namespace: this.namespace, scope: this.scope, rows: table.rows.map(visibleActions) } satisfies ResourceTableData);
    } else {
      this.post('patch', {
        scope: this.scope, namespace: this.namespace, upsert: upsert.map(visibleActions), remove,
        notice: table.notice, loading: table.loading, metricsAvailable: table.metricsAvailable
      } satisfies TablePatch);
    }
    if (!this.firstRowsSent) {
      this.firstRowsSent = true;
      logger.info('Resource table first rows', { kind: this.kindId, rows: table.rows.length, elapsedMs: Date.now() - this.loadStarted });
    }
    if (this.painted) { void this.refreshActions(); }
  }

  protected override onDispose(): void {
    this.tableDisposed = true;
    if (this.renderTimer) { clearTimeout(this.renderTimer); }
    this.nodePods?.release();
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
  /** The object already shown, so polling refreshes skip the quick first pass. */
  private shown?: ObjectRef;

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
      // /version is for the cluster status only; it must not delay the object.
      void session.connect().catch(() => undefined);
      const kind = getKind(ref.kindId) ?? await session.kind(ref.kindId);
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
      if (ref !== this.current) {
        return;
      }
      this.currentObject = obj;
      const permissions = allowedActions(session, kind, obj.metadata.namespace, rowActions(kind.id, obj));
      const publish = (details: DetailsData, allowed: Set<ActionId>): void => {
        details.actions = details.actions.filter((a) => allowed.has(a));
        details.pinned = this.services.favorites.isPinned(this.context, ref);
        details.ref = ref;
        if (ref === this.current) {
          this.post('data', { ref, details, canGoBack: this.history.length > 0 });
        }
      };
      if (this.shown !== ref && kind.id !== 'helmreleases') {
        // Show the object at once; actions appear once allowed, metrics and events follow.
        this.shown = ref;
        this.services.actions.onOpened(this.context, ref);
        // Permissions are usually cached by the table; otherwise the buttons come with the full details.
        const known = await Promise.race([permissions, new Promise<undefined>((resolve) => setTimeout(resolve, 0))]).catch(() => undefined);
        publish(await buildDetails(session, kind, obj, this.metrics, { range: this.metricsRange, quick: true }), known ?? new Set());
      }
      const details = await buildDetails(session, kind, obj, this.metrics, { range: this.metricsRange });
      await permissions.catch(() => undefined);
      const allowed = await allowedActions(session, kind, obj.metadata.namespace, details.actions);
      if (this.shown !== ref) {
        this.shown = ref;
        this.services.actions.onOpened(this.context, ref);
      }
      publish(details, allowed);
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
