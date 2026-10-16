/* List + watch of one resource collection, shared by every panel that shows it. */
import type { ClusterSession, K8sObject } from './cluster';
import { errorMessage, isForbidden, KubeApiError } from './kubeRest';
import { logger } from './logger';
import { collectionPath, ResourceKind } from './resources';

const WATCH_TIMEOUT_SECONDS = 290;
const LIST_PAGE_SIZE = 500;
const FIRST_PAGE_SIZE = 100;
const EMIT_DELAY_MS = 150;
const MAX_BACKOFF_MS = 30_000;

class GoneError extends Error {}

export interface WatchState {
  items: K8sObject[];
  /** The namespace actually watched (narrowed when cluster-wide access is denied). */
  namespace: string;
  notice?: string;
  error?: string;
  ready: boolean;
}

/**
 * Keeps an up-to-date copy of a collection: one LIST, then a WATCH from its
 * resourceVersion (with bookmarks). A 410 Gone triggers a fresh LIST, a
 * dropped connection a reconnect with backoff.
 */
export class ResourceWatcher {
  private objects = new Map<string, K8sObject>();
  private readonly listeners = new Set<() => void>();
  private resourceVersion?: string;
  private stopped = false;
  private abort?: () => void;
  private emitTimer?: ReturnType<typeof setTimeout>;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private finishRetry?: () => void;
  private effectiveNamespace: string;
  private notice?: string;
  private error?: string;
  private ready = false;
  private readyWaiters: Array<() => void> = [];
  refs = 0;

  constructor(
    private readonly session: ClusterSession,
    private readonly kind: ResourceKind,
    namespace: string,
    private readonly query: Record<string, string | undefined> = {}
  ) {
    this.effectiveNamespace = kind.namespaced ? namespace : '';
    void this.run();
  }

  get state(): WatchState {
    return { items: [...this.objects.values()], namespace: this.effectiveNamespace, notice: this.notice, error: this.error, ready: this.ready };
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Resolves after the first LIST (or its failure). */
  whenReady(): Promise<void> {
    return this.stopped || this.ready || this.error ? Promise.resolve() : new Promise((resolve) => this.readyWaiters.push(resolve));
  }

  stop(): void {
    this.stopped = true;
    this.abort?.();
    if (this.emitTimer) {
      clearTimeout(this.emitTimer);
    }
    this.listeners.clear();
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
    }
    this.finishRetry?.();
    for (const waiter of this.readyWaiters.splice(0)) {
      waiter();
    }
  }

  private path(): string {
    return collectionPath(this.kind, this.effectiveNamespace || undefined);
  }

  private async run(): Promise<void> {
    let backoff = 1000;
    while (!this.stopped) {
      try {
        if (!this.resourceVersion) {
          await this.list();
        }
        if (this.stopped) {
          return;
        }
        await this.watch();
        backoff = 1000;
      } catch (err) {
        if (this.stopped) {
          return;
        }
        if (err instanceof GoneError || (err instanceof KubeApiError && err.status === 410)) {
          this.resourceVersion = undefined;
          continue;
        }
        this.error = errorMessage(err);
        this.markReady();
        this.emit();
        logger.warn(`Watch ${this.kind.plural} in ${this.session.context} failed, retrying`, this.error);
        await new Promise<void>((resolve) => {
          this.finishRetry = resolve;
          this.retryTimer = setTimeout(resolve, backoff);
        });
        this.finishRetry = undefined;
        this.retryTimer = undefined;
        backoff = Math.min(MAX_BACKOFF_MS, backoff * 2);
        // Re-list after an error: events may have been missed.
        this.resourceVersion = undefined;
      }
    }
  }

  private async list(): Promise<void> {
    type Page = { items?: K8sObject[]; metadata?: { resourceVersion?: string; continue?: string } };
    // A re-list (410 Gone, reconnect) keeps showing the last complete list and swaps
    // it at the end; only the very first list is exposed page by page.
    const relist = this.ready && this.objects.size > 0;
    const objects = relist ? new Map<string, K8sObject>() : this.objects;
    if (!relist) {
      this.objects.clear();
      this.error = undefined;
      this.ready = false;
    }
    let continueToken: string | undefined;
    let firstPage = true;

    do {
      let page: Page;
      const query = { ...this.query, limit: firstPage ? FIRST_PAGE_SIZE : LIST_PAGE_SIZE, continue: continueToken };
      try {
        page = await this.session.rest.get(this.path(), query);
      } catch (err) {
        if (firstPage && this.kind.namespaced && !this.effectiveNamespace && isForbidden(err)) {
          this.effectiveNamespace = this.session.defaultNamespace ?? 'default';
          this.notice = `No permission to list ${this.kind.title.toLowerCase()} in all namespaces; showing namespace "${this.effectiveNamespace}".`;
          page = await this.session.rest.get(this.path(), query);
        } else {
          throw err;
        }
      }

      if (this.stopped) {
        return;
      }
      for (const item of page.items ?? []) {
        objects.set(keyOf(item), item);
      }
      this.resourceVersion = page.metadata?.resourceVersion ?? this.resourceVersion;
      continueToken = page.metadata?.continue || undefined;
      firstPage = false;
      if (continueToken && !relist) {
        this.emit(true);
      }
    } while (continueToken && !this.stopped);

    if (this.stopped) {
      return;
    }
    this.objects = objects;
    this.error = undefined;
    this.markReady();
    this.emit(true);
  }

  private async watch(): Promise<void> {
    let partial = '';
    let failure: Error | undefined;
    let abort: (() => void) | undefined;
    const stream = await this.session.rest.stream(
      this.path(),
      { ...this.query, watch: true, resourceVersion: this.resourceVersion, allowWatchBookmarks: true, timeoutSeconds: WATCH_TIMEOUT_SECONDS },
      (chunk) => {
        const lines = (partial + chunk.toString('utf8')).split('\n');
        partial = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) {
            continue;
          }
          try {
            this.handle(JSON.parse(line));
          } catch (err) {
            failure = err as Error;
            abort?.();
            break;
          }
        }
      }
    );
    this.abort = stream.abort;
    abort = stream.abort;
    if (this.stopped || failure) {
      stream.abort();
    }
    await stream.done;
    if (failure) {
      throw failure;
    }
  }

  private handle(event: { type: string; object: K8sObject & { code?: number; message?: string } }): void {
    const { type, object } = event;
    if (type === 'ERROR') {
      if (object.code === 410) {
        throw new GoneError(object.message);
      }
      throw new Error(object.message ?? 'watch error');
    }
    if (object?.metadata?.resourceVersion) {
      this.resourceVersion = object.metadata.resourceVersion;
    }
    switch (type) {
      case 'ADDED':
      case 'MODIFIED':
        this.objects.set(keyOf(object), object);
        this.emit();
        break;
      case 'DELETED':
        this.objects.delete(keyOf(object));
        this.emit();
        break;
    }
  }

  private markReady(): void {
    this.ready = true;
    for (const waiter of this.readyWaiters.splice(0)) {
      waiter();
    }
  }

  private emit(now = false): void {
    if (this.stopped) {
      return;
    }
    if (this.emitTimer) {
      if (!now) {
        return;
      }
      clearTimeout(this.emitTimer);
    }
    const fire = (): void => {
      this.emitTimer = undefined;
      for (const listener of this.listeners) {
        listener();
      }
    };
    if (now) {
      fire();
    } else {
      this.emitTimer = setTimeout(fire, EMIT_DELAY_MS);
    }
  }
}

function keyOf(obj: K8sObject): string {
  return obj.metadata.uid ?? `${obj.metadata.namespace ?? ''}/${obj.metadata.name}`;
}
