/* Static and live checks of kubeconfig contexts: certificates, tokens, files, exec plugins, reachability. */
import { X509Certificate } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import type { KubeconfigState } from './kubeconfig';
import { buildKubeConfig } from './kubeconfig';
import { Fields, findByName, RawKubeconfig } from './kubeconfigModel';
import { errorMessage, isForbidden, KubeRest } from './kubeRest';

const WARN_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface ContextHealth {
  context: string;
  server: string;
  certExpires?: string;
  caExpires?: string;
  tokenExpires?: string;
  authMethod: string;
  problems: string[];
  warnings: string[];
  reachable?: boolean;
  version?: string;
  error?: string;
}

function readMaybe(file: unknown, data: unknown): Buffer | undefined {
  if (typeof data === 'string' && data) {
    return Buffer.from(data, 'base64');
  }
  if (typeof file === 'string' && file) {
    try {
      return fs.readFileSync(file);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function certExpiry(pem: Buffer | undefined): Date | undefined {
  if (!pem) {
    return undefined;
  }
  try {
    // A bundle may hold several certificates; the first is the leaf.
    const first = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/.exec(pem.toString('utf8'))?.[0];
    return new Date(new X509Certificate(first ?? pem).validTo);
  } catch {
    return undefined;
  }
}

function tokenExpiry(token: unknown): Date | undefined {
  if (typeof token !== 'string' || token.split('.').length !== 3) {
    return undefined;
  }
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return typeof payload.exp === 'number' ? new Date(payload.exp * 1000) : undefined;
  } catch {
    return undefined;
  }
}

function commandExists(command: string): boolean {
  if (path.isAbsolute(command) || command.includes('/') || command.includes('\\')) {
    return fs.existsSync(command);
  }
  const exts = process.platform === 'win32' ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [''];
  return (process.env.PATH ?? '').split(path.delimiter).some((dir) => exts.some((ext) => dir && fs.existsSync(path.join(dir, command + ext))));
}

function describeExpiry(label: string, date: Date | undefined, health: ContextHealth): void {
  if (!date) {
    return;
  }
  const days = Math.floor((date.getTime() - Date.now()) / DAY_MS);
  if (days < 0) {
    health.problems.push(`${label} expired on ${date.toISOString().slice(0, 10)}`);
  } else if (days < WARN_DAYS) {
    health.warnings.push(`${label} expires in ${days} day${days === 1 ? '' : 's'} (${date.toISOString().slice(0, 10)})`);
  }
}

export function daysLeft(iso: string | undefined): number | undefined {
  return iso ? Math.floor((Date.parse(iso) - Date.now()) / DAY_MS) : undefined;
}

/** Checks that need no network: expiry dates, referenced files, exec plugins. */
export function staticHealth(config: RawKubeconfig, contextName: string): ContextHealth {
  const ctx = findByName(config.contexts, contextName);
  const cluster = ctx ? findByName(config.clusters, ctx.context.cluster)?.cluster : undefined;
  const user: Fields = (ctx ? findByName(config.users, ctx.context.user)?.user : undefined) ?? {};
  const health: ContextHealth = {
    context: contextName,
    server: typeof cluster?.server === 'string' ? cluster.server : '',
    authMethod: 'none',
    problems: [],
    warnings: []
  };
  if (!ctx) {
    health.problems.push('Context not found');
    return health;
  }
  if (!cluster) {
    health.problems.push(`Cluster "${ctx.context.cluster}" is missing`);
  }
  if (!findByName(config.users, ctx.context.user)) {
    health.problems.push(`User "${ctx.context.user}" is missing`);
  }

  for (const [owner, fields, keys] of [
    ['cluster', cluster ?? {}, ['certificate-authority']],
    ['user', user, ['client-certificate', 'client-key', 'tokenFile']]
  ] as Array<[string, Fields, string[]]>) {
    for (const key of keys) {
      const value = fields[key];
      if (typeof value === 'string' && value && !fs.existsSync(value)) {
        health.problems.push(`${owner} ${key} file not found: ${value}`);
      }
    }
  }

  const caDate = certExpiry(readMaybe(cluster?.['certificate-authority'], cluster?.['certificate-authority-data']));
  health.caExpires = caDate?.toISOString();
  describeExpiry('Cluster CA certificate', caDate, health);

  const certDate = certExpiry(readMaybe(user['client-certificate'], user['client-certificate-data']));
  if (certDate) {
    health.authMethod = 'client certificate';
    health.certExpires = certDate.toISOString();
    describeExpiry('Client certificate', certDate, health);
  }

  const token = user.token ?? (typeof user.tokenFile === 'string' && fs.existsSync(user.tokenFile) ? fs.readFileSync(user.tokenFile, 'utf8').trim() : undefined);
  if (token) {
    health.authMethod = 'token';
    const exp = tokenExpiry(token);
    health.tokenExpires = exp?.toISOString();
    describeExpiry('Token', exp, health);
  }
  const exec = user.exec as Fields | undefined;
  if (exec && typeof exec.command === 'string') {
    health.authMethod = `exec: ${path.basename(exec.command)}`;
    if (!commandExists(exec.command)) {
      health.problems.push(`Auth plugin "${exec.command}" is not installed or not on PATH${typeof exec.installHint === 'string' ? ` — ${exec.installHint.trim().split('\n')[0]}` : ''}`);
    }
  }
  if (user['auth-provider']) {
    health.authMethod = `auth-provider: ${(user['auth-provider'] as Fields).name ?? ''}`;
  }
  if (user.username) {
    health.authMethod = 'basic auth';
  }
  if (cluster?.['insecure-skip-tls-verify']) {
    health.warnings.push('TLS verification is disabled (insecure-skip-tls-verify)');
  }
  return health;
}

/** Static checks plus a /version call with a short timeout (runs exec plugins like a real connection). */
export async function liveHealth(state: KubeconfigState, contextName: string, timeoutMs = 8000): Promise<ContextHealth> {
  const health = staticHealth(state.config, contextName);
  if (health.problems.some((p) => p.includes('missing') || p.includes('not installed'))) {
    health.reachable = false;
    return health;
  }
  try {
    const rest = new KubeRest(buildKubeConfig(state, contextName));
    const version = await Promise.race([
      rest.get<{ gitVersion?: string }>('/version', undefined, { timeoutMs }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`No answer within ${Math.round(timeoutMs / 1000)}s`)), timeoutMs + 1000))
    ]);
    health.reachable = true;
    health.version = version?.gitVersion;
  } catch (err) {
    if (isForbidden(err)) {
      health.reachable = true;
      health.warnings.push('Reachable, but /version is forbidden for this user');
    } else {
      health.reachable = false;
      health.error = errorMessage(err);
    }
  }
  return health;
}

/**
 * A standalone kubeconfig with one context, its cluster and user; file
 * references are inlined so the result works on another machine.
 */
export function exportContext(config: RawKubeconfig, contextName: string): RawKubeconfig {
  const ctx = findByName(config.contexts, contextName);
  if (!ctx) {
    throw new Error(`Context "${contextName}" not found.`);
  }
  const cluster = JSON.parse(JSON.stringify(findByName(config.clusters, ctx.context.cluster) ?? null));
  const user = JSON.parse(JSON.stringify(findByName(config.users, ctx.context.user) ?? null));
  if (!cluster || !user) {
    throw new Error(`Context "${contextName}" references a missing cluster or user.`);
  }
  const inline = (fields: Fields, fileKey: string, dataKey: string): void => {
    const file = fields[fileKey];
    if (typeof file === 'string' && file) {
      fields[dataKey] = fs.readFileSync(file).toString('base64');
      delete fields[fileKey];
    }
  };
  inline(cluster.cluster, 'certificate-authority', 'certificate-authority-data');
  inline(user.user, 'client-certificate', 'client-certificate-data');
  inline(user.user, 'client-key', 'client-key-data');
  if (typeof user.user.tokenFile === 'string') {
    user.user.token = fs.readFileSync(user.user.tokenFile, 'utf8').trim();
    delete user.user.tokenFile;
  }
  return {
    apiVersion: 'v1',
    kind: 'Config',
    preferences: {},
    clusters: [cluster],
    users: [user],
    contexts: [JSON.parse(JSON.stringify(ctx))],
    'current-context': contextName
  };
}
