import * as vscode from 'vscode';

import type { ClusterManager, ContextInfo } from '../core/cluster';
import { isProtectedContext } from '../core/guard';
import { errorMessage } from '../core/kubeRest';
import { ActivePortForward, describe, forwardUrl, PortForwardManager } from '../core/portForward';
import { CATEGORIES, Category, getKind, kindsInCategory, ResourceKind } from '../core/resources';

type Node = ContextNode | DashboardNode | CategoryNode | KindNode | GroupNode | MessageNode;

export class ContextNode extends vscode.TreeItem {
  readonly type = 'context';

  constructor(
    readonly info: ContextInfo,
    clusters: ClusterManager
  ) {
    super(info.name, vscode.TreeItemCollapsibleState.Collapsed);
    const session = clusters.peekSession(info.name);
    const status = clusters.isDisconnected(info.name) ? 'disconnected' : session?.status ?? 'idle';
    const namespace = clusters.namespaceFilter(info.name);
    this.id = `ctx:${info.name}`;
    const health = info.health;
    const prot = isProtectedContext(info.name);
    this.description =
      [
        prot ? '🔒 protected' : '',
        info.current ? '● current' : '',
        namespace ? `ns: ${namespace}` : '',
        health.problems.length ? `✖ ${health.problems[0]}` : health.warnings.length ? `⚠ ${health.warnings[0]}` : ''
      ]
        .filter(Boolean)
        .join('  ') || undefined;
    this.tooltip = new vscode.MarkdownString(
      [
        `**${info.name}**${info.current ? ' (current)' : ''}`,
        `Server: \`${info.server}\``,
        `Cluster: \`${info.cluster}\` · User: \`${info.user}\``,
        `Default namespace: \`${info.namespace ?? 'default'}\``,
        session?.version ? `Version: ${session.version}` : '',
        session?.error ? `$(error) ${session.error}` : '',
        `Auth: ${health.authMethod}`,
        health.certExpires ? `Client certificate valid until ${health.certExpires.slice(0, 10)}` : '',
        health.tokenExpires ? `Token valid until ${health.tokenExpires.slice(0, 10)}` : '',
        ...health.problems.map((p) => `$(error) ${p}`),
        ...health.warnings.map((w) => `$(warning) ${w}`),
        prot ? '$(lock) Protected: changes need the context name typed to confirm' : '',
        info.file ? `File: \`${info.file}\`` : ''
      ]
        .filter(Boolean)
        .join('\n\n'),
      true
    );
    const icons: Record<string, vscode.ThemeIcon> = {
      idle: new vscode.ThemeIcon('vm-outline'),
      disconnected: new vscode.ThemeIcon('debug-disconnect', new vscode.ThemeColor('disabledForeground')),
      connecting: new vscode.ThemeIcon('loading~spin'),
      connected: new vscode.ThemeIcon('vm-active', new vscode.ThemeColor('testing.iconPassed')),
      error: new vscode.ThemeIcon('vm-outline', new vscode.ThemeColor('errorForeground'))
    };
    this.iconPath =
      status === 'idle' && health.problems.length ? new vscode.ThemeIcon('warning', new vscode.ThemeColor('errorForeground')) : icons[status];
    this.contextValue = `context.${status}${prot ? '.protected' : ''}${info.current ? '.current' : ''}`;
  }

  get contextName(): string {
    return this.info.name;
  }
}

class DashboardNode extends vscode.TreeItem {
  readonly type = 'dashboard';

  constructor(readonly contextName: string) {
    super('Overview', vscode.TreeItemCollapsibleState.None);
    this.id = `ctx:${contextName}:overview`;
    this.iconPath = new vscode.ThemeIcon('dashboard');
    this.command = { command: 'openLens.openDashboard', title: 'Open Overview', arguments: [{ contextName }] };
    this.contextValue = 'dashboard';
  }
}

class CategoryNode extends vscode.TreeItem {
  readonly type = 'category';

  constructor(
    readonly contextName: string,
    readonly category: Category,
    title: string,
    iconId: string
  ) {
    super(title, vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `ctx:${contextName}:cat:${category}`;
    this.iconPath = new vscode.ThemeIcon(iconId);
    this.contextValue = `category.${category}`;
  }
}

export class KindNode extends vscode.TreeItem {
  readonly type = 'kind';

  constructor(
    readonly contextName: string,
    readonly kind: ResourceKind,
    label = kind.title
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.id = `ctx:${contextName}:kind:${kind.id}`;
    this.iconPath = new vscode.ThemeIcon(kind.icon);
    this.description = kind.custom ? kind.group : undefined;
    this.tooltip = `${kind.kind} (${kind.group ? `${kind.group}/` : ''}${kind.version})`;
    this.command = { command: 'openLens.openTable', title: 'Open', arguments: [{ contextName, kindId: kind.id }] };
    this.contextValue = `kind.${kind.id}`;
  }
}

class GroupNode extends vscode.TreeItem {
  readonly type = 'group';

  constructor(
    readonly contextName: string,
    readonly group: string,
    readonly kinds: ResourceKind[]
  ) {
    super(group, vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `ctx:${contextName}:crdgroup:${group}`;
    this.iconPath = new vscode.ThemeIcon('folder');
    this.description = String(kinds.length);
  }
}

class MessageNode extends vscode.TreeItem {
  readonly type = 'message';

  constructor(message: string, iconId = 'info', command?: vscode.Command) {
    super(message, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon(iconId, iconId === 'error' ? new vscode.ThemeColor('errorForeground') : undefined);
    this.tooltip = message;
    this.command = command;
  }
}

export class ClusterExplorerProvider implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changeEmitter.event;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly contextNodes = new Map<string, ContextNode>();

  constructor(private readonly clusters: ClusterManager) {
    this.disposables.push(
      clusters.onDidChange(() => this.refresh()),
      clusters.onDidChangeStatus((name) => {
        // Re-render only the context row so expanded children stay as they are.
        const node = this.contextNodes.get(name);
        this.changeEmitter.fire(node ? this.refreshContextNode(node) : undefined);
      })
    );
  }

  refresh(): void {
    this.contextNodes.clear();
    this.changeEmitter.fire(undefined);
  }

  private refreshContextNode(node: ContextNode): ContextNode {
    const updated = new ContextNode(node.info, this.clusters);
    Object.assign(node, {
      description: updated.description,
      iconPath: updated.iconPath,
      tooltip: updated.tooltip,
      contextValue: updated.contextValue
    });
    return node;
  }

  getTreeItem(element: Node): vscode.TreeItem {
    return element;
  }

  getParent(): undefined {
    return undefined;
  }

  async getChildren(element?: Node): Promise<Node[]> {
    if (!element) {
      const errors = this.clusters.kubeconfig.errors.map((e) => new MessageNode(e, 'error', { command: 'openLens.openKubeconfigFile', title: 'Open' }));
      const contexts = this.clusters
        .contexts()
        .sort((a, b) => Number(b.current) - Number(a.current) || a.name.localeCompare(b.name))
        .map((info) => {
          const node = new ContextNode(info, this.clusters);
          this.contextNodes.set(info.name, node);
          return node;
        });
      return [...errors, ...contexts];
    }

    switch (element.type) {
      case 'context':
        return this.contextChildren(element);
      case 'category':
        return this.categoryChildren(element);
      case 'group':
        return element.kinds.map((kind) => new KindNode(element.contextName, kind));
      default:
        return [];
    }
  }

  private async contextChildren(node: ContextNode): Promise<Node[]> {
    if (this.clusters.isDisconnected(node.contextName)) {
      return [new MessageNode('Disconnected — click to connect', 'plug', { command: 'openLens.connect', title: 'Connect', arguments: [{ contextName: node.contextName }] })];
    }
    const session = this.clusters.session(node.contextName);
    try {
      await session.connect();
    } catch (err) {
      return [
        new MessageNode(errorMessage(err), 'error'),
        new MessageNode('Retry', 'refresh', { command: 'openLens.reconnect', title: 'Retry', arguments: [{ contextName: node.contextName }] })
      ];
    }
    return [
      new DashboardNode(node.contextName),
      ...CATEGORIES.map((c) => new CategoryNode(node.contextName, c.id, c.title, c.icon))
    ];
  }

  private async categoryChildren(node: CategoryNode): Promise<Node[]> {
    if (node.category !== 'custom') {
      return kindsInCategory(node.category).map((kind) => new KindNode(node.contextName, kind));
    }
    const session = this.clusters.session(node.contextName);
    const definitions = new KindNode(node.contextName, getKind('crds')!);
    try {
      const kinds = await session.customResourceKinds();
      const groups = new Map<string, ResourceKind[]>();
      for (const kind of kinds) {
        groups.set(kind.group, [...(groups.get(kind.group) ?? []), kind]);
      }
      return [definitions, ...[...groups.entries()].map(([group, list]) => new GroupNode(node.contextName, group, list))];
    } catch (err) {
      return [definitions, new MessageNode(errorMessage(err), 'error')];
    }
  }

  dispose(): void {
    this.changeEmitter.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}

// ─────────────────────────── port forwards ───────────────────────────

export class PortForwardNode extends vscode.TreeItem {
  constructor(readonly forward: ActivePortForward) {
    super(`${forward.localPort} → ${forward.name}:${forward.remotePort}`, vscode.TreeItemCollapsibleState.None);
    this.id = forward.id;
    this.description = `${forward.context} · ${forward.namespace}${forward.connections ? ` · ${forward.connections} conn` : ''}`;
    this.tooltip = `${describe(forward)}\n${forwardUrl(forward)}${forward.lastError ? `\n\nLast error: ${forward.lastError}` : ''}`;
    this.iconPath = new vscode.ThemeIcon(
      forward.lastError ? 'warning' : 'plug',
      forward.lastError ? new vscode.ThemeColor('editorWarning.foreground') : new vscode.ThemeColor('testing.iconPassed')
    );
    this.contextValue = 'portForward';
    this.command = { command: 'openLens.openPortForward', title: 'Open in Browser', arguments: [this] };
  }
}

export class PortForwardsProvider implements vscode.TreeDataProvider<PortForwardNode>, vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changeEmitter.event;
  private readonly subscription: vscode.Disposable;

  constructor(private readonly forwards: PortForwardManager) {
    this.subscription = forwards.onDidChange(() => this.changeEmitter.fire());
  }

  getTreeItem(element: PortForwardNode): vscode.TreeItem {
    return element;
  }

  getChildren(): PortForwardNode[] {
    return this.forwards.list().map((f) => new PortForwardNode(f));
  }

  dispose(): void {
    this.subscription.dispose();
    this.changeEmitter.dispose();
  }
}
