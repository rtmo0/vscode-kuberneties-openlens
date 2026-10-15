import * as vscode from 'vscode';

import type { ObjectRef } from '../core/protocol';
import { getKind } from '../core/resources';

export interface SavedRef extends ObjectRef {
  context: string;
  label: string;
}

const PINNED_KEY = 'favorites.pinned';
const RECENT_KEY = 'favorites.recent';
const MAX_RECENT = 20;

const same = (a: SavedRef, context: string, ref: ObjectRef): boolean =>
  a.context === context && a.kindId === ref.kindId && a.name === ref.name && (a.namespace ?? '') === (ref.namespace ?? '');

type Node = GroupNode | RefNode;

class GroupNode extends vscode.TreeItem {
  readonly type = 'group';

  constructor(
    readonly group: 'pinned' | 'recent',
    count: number
  ) {
    super(group === 'pinned' ? 'Pinned' : 'Recent', count ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
    this.id = `fav:${group}`;
    this.iconPath = new vscode.ThemeIcon(group === 'pinned' ? 'star-full' : 'history');
    this.description = count ? String(count) : 'empty';
    this.contextValue = `favorites.${group}`;
  }
}

export class RefNode extends vscode.TreeItem {
  readonly type = 'ref';

  constructor(
    readonly ref: SavedRef,
    readonly group: 'pinned' | 'recent'
  ) {
    super(ref.label, vscode.TreeItemCollapsibleState.None);
    const kind = getKind(ref.kindId);
    this.id = `fav:${group}:${ref.context}:${ref.kindId}:${ref.namespace ?? ''}:${ref.name}`;
    this.description = [kind?.kind ?? ref.kindId, ref.namespace, ref.context].filter(Boolean).join(' · ');
    this.iconPath = new vscode.ThemeIcon(kind?.icon ?? 'symbol-misc');
    this.tooltip = `${kind?.kind ?? ref.kindId} ${ref.namespace ? `${ref.namespace}/` : ''}${ref.name}\nContext: ${ref.context}`;
    this.contextValue = `favorite.${group}`;
    this.command = { command: 'openLens.openResource', title: 'Open', arguments: [{ contextName: ref.context, ref }] };
  }
}

/** Pinned resources and recently opened ones, across contexts. */
export class FavoritesProvider implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changeEmitter.event;

  constructor(private readonly memento: vscode.Memento) {}

  private get pinned(): SavedRef[] {
    return this.memento.get<SavedRef[]>(PINNED_KEY, []);
  }

  private get recent(): SavedRef[] {
    return this.memento.get<SavedRef[]>(RECENT_KEY, []);
  }

  isPinned(context: string, ref: ObjectRef): boolean {
    return this.pinned.some((p) => same(p, context, ref));
  }

  /** Pin or unpin; returns the new state. */
  toggle(context: string, ref: ObjectRef, label: string): boolean {
    const pinned = this.pinned;
    const exists = pinned.some((p) => same(p, context, ref));
    const next = exists ? pinned.filter((p) => !same(p, context, ref)) : [...pinned, { context, kindId: ref.kindId, name: ref.name, namespace: ref.namespace, label }];
    void this.memento.update(PINNED_KEY, next);
    this.changeEmitter.fire();
    return !exists;
  }

  recordOpened(context: string, ref: ObjectRef): void {
    const recent = this.recent.filter((r) => !same(r, context, ref));
    if (this.recent[0] && same(this.recent[0], context, ref)) {
      return;
    }
    recent.unshift({ context, kindId: ref.kindId, name: ref.name, namespace: ref.namespace, label: ref.name });
    void this.memento.update(RECENT_KEY, recent.slice(0, MAX_RECENT));
    this.changeEmitter.fire();
  }

  remove(node: RefNode): void {
    const key = node.group === 'pinned' ? PINNED_KEY : RECENT_KEY;
    const list = node.group === 'pinned' ? this.pinned : this.recent;
    void this.memento.update(key, list.filter((r) => !same(r, node.ref.context, node.ref)));
    this.changeEmitter.fire();
  }

  clearRecent(): void {
    void this.memento.update(RECENT_KEY, []);
    this.changeEmitter.fire();
  }

  /** Drop entries of contexts that no longer exist. */
  prune(contexts: Set<string>): void {
    const pinned = this.pinned.filter((r) => contexts.has(r.context));
    const recent = this.recent.filter((r) => contexts.has(r.context));
    if (pinned.length !== this.pinned.length || recent.length !== this.recent.length) {
      void this.memento.update(PINNED_KEY, pinned);
      void this.memento.update(RECENT_KEY, recent);
      this.changeEmitter.fire();
    }
  }

  getTreeItem(element: Node): vscode.TreeItem {
    return element;
  }

  getChildren(element?: Node): Node[] {
    if (!element) {
      return [new GroupNode('pinned', this.pinned.length), new GroupNode('recent', this.recent.length)];
    }
    if (element.type === 'group') {
      return (element.group === 'pinned' ? this.pinned : this.recent).map((ref) => new RefNode(ref, element.group));
    }
    return [];
  }

  dispose(): void {
    this.changeEmitter.dispose();
  }
}
