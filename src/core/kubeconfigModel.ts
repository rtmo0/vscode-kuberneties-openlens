/*
 * Pure kubeconfig manipulation: parsing, path resolution, kubectl-style
 * merging of several files and importing one kubeconfig into another.
 *
 * Works on the raw YAML structure so that every field (exec plugins,
 * extensions, proxy-url, tls-server-name, …) survives a round trip.
 */
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';

export type Fields = Record<string, unknown>;

export interface NamedCluster extends Fields {
  name: string;
  cluster: Fields;
}

export interface NamedUser extends Fields {
  name: string;
  user: Fields;
}

export interface ContextFields extends Fields {
  cluster: string;
  user: string;
  namespace?: string;
}

export interface NamedContext extends Fields {
  name: string;
  context: ContextFields;
}

export interface RawKubeconfig extends Fields {
  apiVersion?: string;
  kind?: string;
  clusters: NamedCluster[];
  users: NamedUser[];
  contexts: NamedContext[];
  'current-context'?: string;
}

export class KubeconfigParseError extends Error {}

export function emptyKubeconfig(): RawKubeconfig {
  return { apiVersion: 'v1', kind: 'Config', preferences: {}, clusters: [], users: [], contexts: [], 'current-context': '' };
}

// ───────────────────────────── parsing ─────────────────────────────

/**
 * Parse kubeconfig text as YAML or JSON. Base64-encoded kubeconfigs (as some
 * providers and CI secrets hand them out) are decoded first.
 */
export function parseKubeconfig(text: string): RawKubeconfig {
  let source = text.replace(/^﻿/, '').trim();
  if (!source) {
    throw new KubeconfigParseError('The kubeconfig is empty.');
  }
  const decoded = tryDecodeBase64(source);
  if (decoded) {
    source = decoded;
  }

  let doc: unknown;
  try {
    doc = yaml.load(source);
  } catch (err) {
    throw new KubeconfigParseError(`Not valid YAML: ${(err as Error).message.split('\n')[0]}`);
  }
  if (doc === undefined || doc === null) {
    return emptyKubeconfig();
  }
  if (typeof doc !== 'object' || Array.isArray(doc)) {
    throw new KubeconfigParseError('A kubeconfig must be a YAML mapping with clusters, users and contexts.');
  }
  return normalize(doc as Fields);
}

function tryDecodeBase64(text: string): string | undefined {
  const compact = text
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('')
    .replace(/\s+/g, '');
  if (compact.length < 32 || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(compact)) {
    return undefined;
  }
  const decoded = Buffer.from(compact, 'base64').toString('utf8');
  return /(^|\n)\s*(clusters|users|contexts|apiVersion)\s*:/.test(decoded) || decoded.trim().startsWith('{')
    ? decoded
    : undefined;
}

function normalize(doc: Fields): RawKubeconfig {
  const result: RawKubeconfig = {
    ...doc,
    clusters: namedList(doc.clusters, 'clusters', 'cluster') as unknown as NamedCluster[],
    users: namedList(doc.users, 'users', 'user') as unknown as NamedUser[],
    contexts: namedList(doc.contexts, 'contexts', 'context') as unknown as NamedContext[]
  };
  for (const ctx of result.contexts) {
    if (typeof ctx.context.cluster !== 'string' || typeof ctx.context.user !== 'string') {
      throw new KubeconfigParseError(`Context "${ctx.name}" must reference a cluster and a user.`);
    }
  }
  if (result['current-context'] === null) {
    result['current-context'] = '';
  }
  return result;
}

function namedList(value: unknown, section: string, key: string): Array<{ name: string } & Fields> {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new KubeconfigParseError(`"${section}" must be a list.`);
  }
  return value.map((entry, index) => {
    if (!entry || typeof entry !== 'object') {
      throw new KubeconfigParseError(`${section}[${index}] is not a mapping.`);
    }
    const item = entry as Fields;
    if (typeof item.name !== 'string' || !item.name) {
      throw new KubeconfigParseError(`${section}[${index}] has no name.`);
    }
    const inner = item[key];
    return { ...item, name: item.name, [key]: inner && typeof inner === 'object' ? inner : {} };
  });
}

export function dumpKubeconfig(config: RawKubeconfig): string {
  return yaml.dump(config, { lineWidth: -1, noRefs: true, sortKeys: false });
}

// ───────────────────────────── paths ─────────────────────────────

const CLUSTER_PATH_FIELDS = ['certificate-authority'];
const USER_PATH_FIELDS = ['client-certificate', 'client-key', 'tokenFile'];

/**
 * Resolve relative file references against the kubeconfig's directory, as
 * kubectl does. Needed when a file-based kubeconfig is merged into another
 * file in a different directory.
 */
export function resolveRelativePaths(config: RawKubeconfig, baseDir: string): RawKubeconfig {
  const fix = (value: unknown): unknown =>
    typeof value === 'string' && value && !path.isAbsolute(value) ? path.resolve(baseDir, expandHome(value)) : value;
  return {
    ...config,
    clusters: config.clusters.map((c) => ({ ...c, cluster: mapFields(c.cluster, CLUSTER_PATH_FIELDS, fix) })),
    users: config.users.map((u) => {
      const user = mapFields(u.user, USER_PATH_FIELDS, fix);
      const exec = user.exec as Fields | undefined;
      if (exec && typeof exec.command === 'string' && /^\.\.?[\\/]/.test(exec.command)) {
        user.exec = { ...exec, command: path.resolve(baseDir, exec.command) };
      }
      return { ...u, user };
    })
  };
}

/** File references that cannot be resolved because the kubeconfig came from pasted text. */
export function relativePathReferences(config: RawKubeconfig): string[] {
  const refs: string[] = [];
  const check = (owner: string, fields: Fields, keys: string[]): void => {
    for (const key of keys) {
      const value = fields[key];
      if (typeof value === 'string' && value && !path.isAbsolute(expandHome(value))) {
        refs.push(`${owner}: ${key}: ${value}`);
      }
    }
  };
  config.clusters.forEach((c) => check(`cluster ${c.name}`, c.cluster, CLUSTER_PATH_FIELDS));
  config.users.forEach((u) => check(`user ${u.name}`, u.user, USER_PATH_FIELDS));
  return refs;
}

function mapFields(fields: Fields, keys: string[], fn: (value: unknown) => unknown): Fields {
  const copy: Fields = { ...fields };
  for (const key of keys) {
    if (key in copy) {
      copy[key] = fn(copy[key]);
    }
  }
  return copy;
}

export function expandHome(p: string): string {
  return p === '~' || p.startsWith('~/') ? path.join(os.homedir(), p.slice(1)) : p;
}

// ───────────────────────────── multi-file merge ─────────────────────────────

export interface LoadedFile {
  path: string;
  config: RawKubeconfig;
}

export interface MergedKubeconfig {
  config: RawKubeconfig;
  /** File each context was taken from. */
  contextOrigin: Map<string, string>;
}

/** Merge files in $KUBECONFIG order: the first file to define a name wins, like kubectl. */
export function mergeFiles(files: LoadedFile[]): MergedKubeconfig {
  const merged = emptyKubeconfig();
  const contextOrigin = new Map<string, string>();
  const seen = { clusters: new Set<string>(), users: new Set<string>(), contexts: new Set<string>() };
  for (const file of files) {
    for (const c of file.config.clusters) {
      if (!seen.clusters.has(c.name)) {
        seen.clusters.add(c.name);
        merged.clusters.push(c);
      }
    }
    for (const u of file.config.users) {
      if (!seen.users.has(u.name)) {
        seen.users.add(u.name);
        merged.users.push(u);
      }
    }
    for (const ctx of file.config.contexts) {
      if (!seen.contexts.has(ctx.name)) {
        seen.contexts.add(ctx.name);
        merged.contexts.push(ctx);
        contextOrigin.set(ctx.name, file.path);
      }
    }
    if (!merged['current-context'] && file.config['current-context']) {
      merged['current-context'] = file.config['current-context'];
    }
  }
  return { config: merged, contextOrigin };
}

// ───────────────────────────── import ─────────────────────────────

export type ImportStatus = 'new' | 'identical' | 'conflict';

export interface ImportCandidate {
  name: string;
  server: string;
  namespace?: string;
  status: ImportStatus;
}

export interface ImportDecision {
  /** Context name in the imported kubeconfig. */
  source: string;
  /** Context name to use in the target kubeconfig. */
  target: string;
  /** Replace an existing context with the same target name. */
  overwrite?: boolean;
}

export interface ImportReport {
  config: RawKubeconfig;
  added: string[];
  replaced: string[];
  unchanged: string[];
  renamedClusters: Array<[string, string]>;
  renamedUsers: Array<[string, string]>;
}

/**
 * Kubeconfigs handed out by installers often contain a cluster and a user but
 * no context. Create one per cluster so they can be imported.
 */
export function ensureContexts(config: RawKubeconfig): RawKubeconfig {
  if (config.contexts.length > 0 || config.clusters.length === 0 || config.users.length === 0) {
    return config;
  }
  const user = config.users[0].name;
  return {
    ...config,
    contexts: config.clusters.map((c) => ({ name: c.name, context: { cluster: c.name, user } })),
    'current-context': config['current-context'] || config.clusters[0].name
  };
}

/** Describe every context of `source` relative to `target`. */
export function analyzeImport(target: RawKubeconfig, source: RawKubeconfig): ImportCandidate[] {
  return source.contexts.map((ctx) => {
    const cluster = findByName(source.clusters, ctx.context.cluster);
    const existing = findByName(target.contexts, ctx.name);
    let status: ImportStatus = 'new';
    if (existing) {
      status = sameResolvedContext(target, existing, source, ctx) ? 'identical' : 'conflict';
    }
    return {
      name: ctx.name,
      server: typeof cluster?.cluster.server === 'string' ? cluster.cluster.server : '',
      namespace: ctx.context.namespace,
      status
    };
  });
}

/** Check that every context of `source` references a defined cluster and user. */
export function missingReferences(source: RawKubeconfig): string[] {
  const problems: string[] = [];
  for (const ctx of source.contexts) {
    if (!findByName(source.clusters, ctx.context.cluster)) {
      problems.push(`Context "${ctx.name}" references missing cluster "${ctx.context.cluster}".`);
    }
    if (!findByName(source.users, ctx.context.user)) {
      problems.push(`Context "${ctx.name}" references missing user "${ctx.context.user}".`);
    }
  }
  return problems;
}

/**
 * Import the chosen contexts (with their clusters and users) from `source`
 * into a copy of `target`.
 *
 * Clusters and users are matched by content, not just by name: an identical
 * entry is reused, and a different entry with a taken name is renamed (for
 * example "kubernetes-admin" → "kubernetes-admin-prod") with the context
 * references updated — so generic names from installers never overwrite
 * unrelated credentials.
 */
export function applyImport(
  target: RawKubeconfig,
  source: RawKubeconfig,
  decisions: ImportDecision[],
  options: { setCurrent?: string } = {}
): ImportReport {
  const config: RawKubeconfig = clone(target);
  config.apiVersion = config.apiVersion || 'v1';
  config.kind = config.kind || 'Config';
  const report: ImportReport = { config, added: [], replaced: [], unchanged: [], renamedClusters: [], renamedUsers: [] };

  for (const decision of decisions) {
    const srcCtx = findByName(source.contexts, decision.source);
    if (!srcCtx) {
      throw new Error(`Context "${decision.source}" is not in the imported kubeconfig.`);
    }
    const srcCluster = findByName(source.clusters, srcCtx.context.cluster);
    const srcUser = findByName(source.users, srcCtx.context.user);
    if (!srcCluster || !srcUser) {
      throw new Error(missingReferences({ ...source, contexts: [srcCtx] }).join(' '));
    }

    const existing = findByName(config.contexts, decision.target);
    if (existing && sameResolvedContext(config, existing, source, srcCtx)) {
      report.unchanged.push(decision.target);
      continue;
    }
    if (existing && !decision.overwrite) {
      throw new Error(`Context "${decision.target}" already exists.`);
    }

    const replaceable = (list: 'clusters' | 'users', name: string): boolean => {
      if (!existing) {
        return false;
      }
      const ref = list === 'clusters' ? existing.context.cluster : existing.context.user;
      return ref === name && countReferences(config, list, name, existing.name) === 0;
    };

    const clusterName = placeEntry(config.clusters, 'cluster', srcCluster, decision.target, (n) =>
      replaceable('clusters', n)
    );
    const userName = placeEntry(config.users, 'user', srcUser, decision.target, (n) => replaceable('users', n));
    if (clusterName !== srcCluster.name) {
      report.renamedClusters.push([srcCluster.name, clusterName]);
    }
    if (userName !== srcUser.name) {
      report.renamedUsers.push([srcUser.name, userName]);
    }

    const newContext: NamedContext = {
      ...clone(srcCtx),
      name: decision.target,
      context: { ...clone(srcCtx.context), cluster: clusterName, user: userName }
    };
    if (existing) {
      const index = config.contexts.indexOf(existing);
      config.contexts[index] = newContext;
      removeOrphans(config, existing.context.cluster, existing.context.user);
      report.replaced.push(decision.target);
    } else {
      config.contexts.push(newContext);
      report.added.push(decision.target);
    }
  }

  const imported = [...report.added, ...report.replaced];
  if (options.setCurrent) {
    config['current-context'] = options.setCurrent;
  } else if (!config['current-context'] && imported.length > 0) {
    config['current-context'] = imported[0];
  }
  return report;
}

/**
 * Put `entry` into `list` and return the name it ended up with: an identical
 * entry is reused, a free name is kept, otherwise a unique name is derived.
 */
function placeEntry<K extends 'cluster' | 'user'>(
  list: Array<{ name: string } & Fields>,
  key: K,
  entry: { name: string } & Fields,
  contextName: string,
  canReplace: (name: string) => boolean
): string {
  const content = stableStringify(entry[key]);
  const sameName = findByName(list, entry.name);
  if (sameName && stableStringify(sameName[key]) === content) {
    return entry.name;
  }
  const sameContent = list.find((item) => stableStringify(item[key]) === content);
  if (sameContent) {
    return sameContent.name;
  }
  if (!sameName) {
    list.push(clone(entry));
    return entry.name;
  }
  if (canReplace(entry.name)) {
    list[list.indexOf(sameName)] = clone(entry);
    return entry.name;
  }
  const taken = new Set(list.map((item) => item.name));
  const candidates = [`${entry.name}-${contextName}`, contextName];
  let name = candidates.find((candidate) => !taken.has(candidate));
  for (let i = 2; !name; i += 1) {
    if (!taken.has(`${entry.name}-${i}`)) {
      name = `${entry.name}-${i}`;
    }
  }
  list.push({ ...clone(entry), name });
  return name;
}

function sameResolvedContext(
  a: RawKubeconfig,
  aCtx: NamedContext,
  b: RawKubeconfig,
  bCtx: NamedContext
): boolean {
  const resolve = (config: RawKubeconfig, ctx: NamedContext): string => {
    const { cluster, user, ...rest } = ctx.context;
    return stableStringify({
      rest,
      cluster: findByName(config.clusters, cluster)?.cluster ?? null,
      user: findByName(config.users, user)?.user ?? null
    });
  };
  return resolve(a, aCtx) === resolve(b, bCtx);
}

// ───────────────────────────── editing ─────────────────────────────

/** Remove a context and the cluster / user only it was using. */
export function removeContext(config: RawKubeconfig, name: string): RawKubeconfig {
  const result = clone(config);
  const ctx = findByName(result.contexts, name);
  if (!ctx) {
    return result;
  }
  result.contexts = result.contexts.filter((c) => c.name !== name);
  removeOrphans(result, ctx.context.cluster, ctx.context.user);
  if (result['current-context'] === name) {
    result['current-context'] = '';
  }
  return result;
}

export function renameContext(config: RawKubeconfig, from: string, to: string): RawKubeconfig {
  if (from === to) {
    return config;
  }
  const result = clone(config);
  if (findByName(result.contexts, to)) {
    throw new Error(`Context "${to}" already exists.`);
  }
  const ctx = findByName(result.contexts, from);
  if (!ctx) {
    throw new Error(`Context "${from}" not found.`);
  }
  ctx.name = to;
  if (result['current-context'] === from) {
    result['current-context'] = to;
  }
  return result;
}

export function setContextNamespace(config: RawKubeconfig, name: string, namespace: string | undefined): RawKubeconfig {
  const result = clone(config);
  const ctx = findByName(result.contexts, name);
  if (!ctx) {
    throw new Error(`Context "${name}" not found.`);
  }
  if (namespace) {
    ctx.context.namespace = namespace;
  } else {
    delete ctx.context.namespace;
  }
  return result;
}

function removeOrphans(config: RawKubeconfig, cluster: string, user: string): void {
  if (countReferences(config, 'clusters', cluster) === 0) {
    config.clusters = config.clusters.filter((c) => c.name !== cluster);
  }
  if (countReferences(config, 'users', user) === 0) {
    config.users = config.users.filter((u) => u.name !== user);
  }
}

function countReferences(config: RawKubeconfig, list: 'clusters' | 'users', name: string, exceptContext?: string): number {
  return config.contexts.filter(
    (ctx) => ctx.name !== exceptContext && (list === 'clusters' ? ctx.context.cluster : ctx.context.user) === name
  ).length;
}

// ───────────────────────────── utils ─────────────────────────────

export function findByName<T extends { name: string }>(list: T[], name: string): T | undefined {
  return list.find((item) => item.name === name);
}

export function uniqueName(taken: Iterable<string>, base: string): string {
  const set = new Set(taken);
  if (!set.has(base)) {
    return base;
  }
  for (let i = 2; ; i += 1) {
    if (!set.has(`${base}-${i}`)) {
      return `${base}-${i}`;
    }
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value ?? null);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const entries = Object.entries(value as Fields)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}
