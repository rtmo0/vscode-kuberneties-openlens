/* JSON schema for manifests built from the cluster's OpenAPI (built-in kinds and CRDs), served to the YAML extension. */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import type { ClusterManager } from '../core/cluster';
import { errorMessage } from '../core/kubeRest';
import { logger } from '../core/logger';
import { RESOURCE_SCHEME, parseResourceUri } from '../fs/resourceFs';

type Json = any;

const SKIP_KINDS = new Set(['DeleteOptions', 'WatchEvent', 'Status', 'APIGroup', 'APIGroupList', 'APIResourceList', 'APIVersions', 'Scale', 'Eviction', 'TokenRequest', 'Binding']);

const SCHEMA_MAPS = ['properties', 'definitions', 'patternProperties'];
const SCHEMA_LISTS = ['allOf', 'anyOf', 'oneOf'];
const SCHEMA_VALUES = ['items', 'additionalProperties', 'not', 'additionalItems'];

/**
 * Walk a schema and fix the spots where Kubernetes OpenAPI disagrees with
 * how people write YAML. Only schema positions are visited: property names
 * like "format" or "type" (JSONSchemaProps has them) and values under enum,
 * default or example are left alone.
 */
function normalize(node: Json): Json {
  if (!node || typeof node !== 'object' || Array.isArray(node)) {
    return node;
  }
  const out: Json = { ...node };
  for (const key of SCHEMA_MAPS) {
    if (out[key] && typeof out[key] === 'object') {
      out[key] = Object.fromEntries(Object.entries(out[key]).map(([name, schema]) => [name, normalize(schema)]));
    }
  }
  for (const key of SCHEMA_LISTS) {
    if (Array.isArray(out[key])) {
      out[key] = out[key].map(normalize);
    }
  }
  for (const key of SCHEMA_VALUES) {
    if (out[key] && typeof out[key] === 'object') {
      out[key] = Array.isArray(out[key]) ? out[key].map(normalize) : normalize(out[key]);
    }
  }
  if (out.format === 'int-or-string' || out['x-kubernetes-int-or-string'] === true) {
    delete out.type;
    delete out.format;
    out.anyOf = [{ type: 'integer' }, { type: 'string' }];
  }
  // Report unknown fields (typos), except where the API allows arbitrary content.
  if (out.type === 'object' && out.properties && out.additionalProperties === undefined && !out['x-kubernetes-preserve-unknown-fields']) {
    out.additionalProperties = false;
  }
  return out;
}

/**
 * One schema for every manifest kind: each GroupVersionKind is a branch of
 * a oneOf, pinned by apiVersion and kind.
 */
export function buildManifestSchema(openapi: { definitions?: Record<string, Json> }): Json {
  const source = openapi.definitions ?? {};
  const definitions: Record<string, Json> = {};
  for (const [name, def] of Object.entries(source)) {
    definitions[name] = normalize(def);
  }
  // Quantities are written as numbers too ("cpu: 1").
  for (const name of Object.keys(definitions)) {
    if (name.endsWith('.api.resource.Quantity')) {
      definitions[name] = { anyOf: [{ type: 'string' }, { type: 'number' }], description: definitions[name].description };
    }
    if (name.endsWith('.util.intstr.IntOrString')) {
      definitions[name] = { anyOf: [{ type: 'integer' }, { type: 'string' }], description: definitions[name].description };
    }
  }
  const branches: Json[] = [];
  for (const [name, def] of Object.entries(definitions)) {
    const gvks: Array<{ group: string; version: string; kind: string }> = def['x-kubernetes-group-version-kind'] ?? [];
    if (gvks.length !== 1 || !def.properties?.metadata || SKIP_KINDS.has(gvks[0].kind) || gvks[0].kind.endsWith('List')) {
      continue;
    }
    const { group, version, kind } = gvks[0];
    const apiVersion = group ? `${group}/${version}` : version;
    def.properties.apiVersion = { ...(def.properties.apiVersion ?? {}), type: 'string', enum: [apiVersion] };
    def.properties.kind = { ...(def.properties.kind ?? {}), type: 'string', enum: [kind] };
    def.required = [...new Set([...(def.required ?? []), 'apiVersion', 'kind'])];
    branches.push({ $ref: `#/definitions/${name}` });
  }
  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    title: 'Kubernetes manifest',
    definitions,
    oneOf: branches
  };
}

/** Text that looks like a Kubernetes manifest (and not a kubeconfig, Helm template or values file). */
export function looksLikeManifest(text: string): boolean {
  if (!/^apiVersion:\s*\S+/m.test(text) || !/^kind:\s*\S+/m.test(text)) {
    return false;
  }
  if (/^kind:\s*Config\s*$/m.test(text) && /^clusters:/m.test(text)) {
    return false;
  }
  return !text.includes('{{');
}

interface YamlApi {
  registerContributor(schema: string, requestSchema: (resource: string) => string | undefined, requestSchemaContent: (uri: string) => Promise<string> | string, label?: string): boolean;
}

const SCHEME = 'openlens-schema';

/** Serves cluster schemas to the Red Hat YAML extension. */
export class ManifestSchemas implements vscode.Disposable {
  private readonly memory = new Map<string, Promise<string>>();
  private generation = 0;
  private registered = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly clusters: ClusterManager
  ) {}

  async activate(): Promise<void> {
    if (!vscode.workspace.getConfiguration('openLens').get<boolean>('yamlSchemas.enabled', true)) {
      return;
    }
    const extension = vscode.extensions.getExtension<YamlApi>('redhat.vscode-yaml');
    if (!extension) {
      this.suggestYamlExtension();
      return;
    }
    const api = await extension.activate();
    if (!api?.registerContributor || this.registered) {
      return;
    }
    this.registered = api.registerContributor(SCHEME, (resource) => this.schemaFor(resource), (uri) => this.content(uri), 'Kubernetes (from your cluster)');
  }

  private suggestYamlExtension(): void {
    const key = 'yamlExtensionSuggested';
    if (this.context.globalState.get<boolean>(key)) {
      return;
    }
    const listener = vscode.window.onDidChangeActiveTextEditor(async (editor) => {
      if (!editor || editor.document.languageId !== 'yaml' || !looksLikeManifest(editor.document.getText())) {
        return;
      }
      listener.dispose();
      await this.context.globalState.update(key, true);
      const choice = await vscode.window.showInformationMessage(
        'Install the YAML extension by Red Hat to get completion and validation of manifests against the kinds and CRDs of your cluster.',
        'Install',
        'Not Now'
      );
      if (choice === 'Install') {
        await vscode.commands.executeCommand('workbench.extensions.installExtension', 'redhat.vscode-yaml');
        await this.activate();
      }
    });
    this.context.subscriptions.push(listener);
  }

  /** The schema URI for a document, or undefined to leave it alone. */
  private schemaFor(resource: string): string | undefined {
    let uri: vscode.Uri;
    try {
      uri = vscode.Uri.parse(resource);
    } catch {
      return undefined;
    }
    let context: string | undefined;
    if (uri.scheme === RESOURCE_SCHEME) {
      try {
        context = parseResourceUri(uri).context;
      } catch {
        return undefined;
      }
    } else {
      const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === resource);
      if (!doc || !looksLikeManifest(doc.getText())) {
        return undefined;
      }
      context = vscode.workspace.getConfiguration('openLens').get<string>('yamlSchemas.context') || this.clusters.currentContext;
    }
    if (!context || !this.clusters.hasContext(context)) {
      return undefined;
    }
    return `${SCHEME}://schema/${encodeURIComponent(context)}.json?g=${this.generation}`;
  }

  private content(uriText: string): Promise<string> {
    const uri = vscode.Uri.parse(uriText);
    const context = decodeURIComponent(uri.path.replace(/^\//, '').replace(/\.json$/, ''));
    let cached = this.memory.get(context);
    if (!cached) {
      cached = this.load(context);
      this.memory.set(context, cached);
      cached.catch(() => this.memory.delete(context));
    }
    return cached;
  }

  private async load(context: string): Promise<string> {
    const session = this.clusters.session(context);
    await session.connect();
    // Metadata only: CRD objects with their schemas can be megabytes.
    const crds = await session.rest
      .get<{ items?: Json[] }>('/apis/apiextensions.k8s.io/v1/customresourcedefinitions', undefined, { accept: 'application/json;as=PartialObjectMetadataList;g=meta.k8s.io;v=v1,application/json' })
      .catch(() => undefined);
    const crdKey = (crds?.items ?? []).map((c) => `${c.metadata?.name}:${c.metadata?.generation}`).sort().join(',');
    // The cache key changes with the server version and whenever CRDs are added, removed or changed.
    const key = crypto.createHash('sha1').update(`${context}|${session.server}|${session.version}|${crdKey}`).digest('hex');
    const dir = vscode.Uri.joinPath(this.context.globalStorageUri, 'schemas').fsPath;
    const file = path.join(dir, `${key}.json`);
    if (fs.existsSync(file)) {
      return fs.readFileSync(file, 'utf8');
    }
    try {
      const openapi = await session.rest.get<Json>('/openapi/v2', undefined, { timeoutMs: 60_000 });
      const text = JSON.stringify(buildManifestSchema(openapi));
      fs.mkdirSync(dir, { recursive: true });
      for (const old of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
        // Keep the cache small: one schema per context is plenty.
        if (Date.now() - fs.statSync(path.join(dir, old)).mtimeMs > 7 * 86_400_000) {
          fs.rmSync(path.join(dir, old), { force: true });
        }
      }
      fs.writeFileSync(file, text);
      logger.info(`Built the manifest schema for ${context} (${Math.round(text.length / 1024)} KiB)`);
      return text;
    } catch (err) {
      logger.warn(`Could not build the manifest schema for ${context}`, errorMessage(err));
      throw err;
    }
  }

  /** Drop cached schemas (after CRD changes) and make the YAML extension ask again. */
  refresh(): void {
    this.memory.clear();
    this.generation += 1;
    const dir = vscode.Uri.joinPath(this.context.globalStorageUri, 'schemas').fsPath;
    fs.rmSync(dir, { recursive: true, force: true });
  }

  dispose(): void {
    this.memory.clear();
  }
}
