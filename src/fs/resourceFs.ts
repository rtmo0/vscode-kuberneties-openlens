import * as yaml from 'js-yaml';
import * as vscode from 'vscode';

import type { ClusterManager, K8sObject } from '../core/cluster';
import { confirmAction } from '../core/guard';
import { errorMessage, KubeApiError } from '../core/kubeRest';
import { logger } from '../core/logger';
import { getKind } from '../core/resources';

export const RESOURCE_SCHEME = 'k8s';

export interface ResourceUriParts {
  context: string;
  kindId: string;
  namespace?: string;
  name: string;
}

/** k8s:/<context>/<kindId>/<namespace|_>/<name>.yaml */
export function resourceUri(parts: ResourceUriParts): vscode.Uri {
  const segments = [parts.context, parts.kindId, parts.namespace || '_'].map(encodeURIComponent);
  return vscode.Uri.from({ scheme: RESOURCE_SCHEME, path: `/${segments.join('/')}/${encodeURIComponent(parts.name)}.yaml` });
}

export function parseResourceUri(uri: vscode.Uri): ResourceUriParts {
  const segments = uri.path.split('/').filter(Boolean).map(decodeURIComponent);
  if (segments.length !== 4 || !segments[3].endsWith('.yaml')) {
    throw vscode.FileSystemError.FileNotFound(uri);
  }
  const [context, kindId, namespace, file] = segments;
  return { context, kindId, namespace: namespace === '_' ? undefined : namespace, name: file.slice(0, -'.yaml'.length) };
}

/** Strip server-managed noise that `kubectl edit` hides too. */
export function cleanForEdit(obj: K8sObject): K8sObject {
  const copy: K8sObject = JSON.parse(JSON.stringify(obj));
  delete copy.metadata.managedFields;
  if (copy.metadata.annotations) {
    delete copy.metadata.annotations['kubectl.kubernetes.io/last-applied-configuration'];
    if (Object.keys(copy.metadata.annotations).length === 0) {
      delete copy.metadata.annotations;
    }
  }
  return copy;
}

export function toYaml(obj: unknown): string {
  return yaml.dump(obj, { lineWidth: -1, noRefs: true, sortKeys: false });
}

/**
 * Exposes cluster objects as YAML files: opening reads the live object,
 * saving replaces it on the server (with optimistic locking through
 * resourceVersion, so a concurrent change is reported instead of overwritten).
 */
export class ResourceFileSystem implements vscode.FileSystemProvider {
  private readonly changeEmitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.changeEmitter.event;
  private readonly mtimes = new Map<string, number>();

  constructor(private readonly clusters: ClusterManager) {}

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => undefined);
  }

  stat(uri: vscode.Uri): vscode.FileStat {
    parseResourceUri(uri);
    const key = uri.toString();
    if (!this.mtimes.has(key)) {
      this.mtimes.set(key, Date.now());
    }
    return { type: vscode.FileType.File, ctime: 0, mtime: this.mtimes.get(key)!, size: 0 };
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const parts = parseResourceUri(uri);
    try {
      const session = this.clusters.session(parts.context);
      const kind = await session.kind(parts.kindId);
      const obj = await session.get(kind, parts.name, parts.namespace);
      return Buffer.from(toYaml(cleanForEdit(obj)), 'utf8');
    } catch (err) {
      if (err instanceof KubeApiError && err.status === 404) {
        throw vscode.FileSystemError.FileNotFound(uri);
      }
      throw vscode.FileSystemError.Unavailable(errorMessage(err));
    }
  }

  async writeFile(uri: vscode.Uri, content: Uint8Array): Promise<void> {
    const parts = parseResourceUri(uri);
    const kind = getKind(parts.kindId);
    if (!kind) {
      throw vscode.FileSystemError.NoPermissions('Unknown resource kind; reopen the resource from the explorer.');
    }
    let obj: K8sObject;
    try {
      obj = yaml.load(Buffer.from(content).toString('utf8')) as K8sObject;
    } catch (err) {
      throw vscode.FileSystemError.NoPermissions(`Invalid YAML: ${(err as Error).message.split('\n')[0]}`);
    }
    if (!obj || typeof obj !== 'object' || !obj.metadata) {
      throw vscode.FileSystemError.NoPermissions('The document must be a Kubernetes object with metadata.');
    }
    if (obj.metadata.name !== parts.name || (kind.namespaced && (obj.metadata.namespace ?? parts.namespace) !== parts.namespace)) {
      throw vscode.FileSystemError.NoPermissions('Changing the name or namespace is not supported; use Apply to create a copy.');
    }
    const confirmed = await confirmAction(parts.context, { title: `Save ${kind.kind} ${parts.name} to ${parts.context}`, button: 'Save' });
    if (!confirmed) {
      throw vscode.FileSystemError.NoPermissions('Save cancelled.');
    }
    try {
      await this.clusters.session(parts.context).replace(kind, obj);
      logger.info(`Saved ${kind.kind} ${parts.namespace ? `${parts.namespace}/` : ''}${parts.name} in ${parts.context}`);
    } catch (err) {
      if (err instanceof KubeApiError && err.status === 409) {
        throw vscode.FileSystemError.NoPermissions(
          'The object was changed on the server since you opened it. Copy your edits, use "File: Revert File" to reload, and apply them again.'
        );
      }
      throw vscode.FileSystemError.NoPermissions(errorMessage(err));
    }
    // Reload the editor with the new resourceVersion.
    this.mtimes.set(uri.toString(), Date.now());
    this.changeEmitter.fire([{ type: vscode.FileChangeType.Changed, uri }]);
  }

  readDirectory(): [string, vscode.FileType][] {
    return [];
  }

  createDirectory(): void {
    throw vscode.FileSystemError.NoPermissions();
  }

  delete(): void {
    throw vscode.FileSystemError.NoPermissions('Use the Delete action in the explorer.');
  }

  rename(): void {
    throw vscode.FileSystemError.NoPermissions();
  }
}
