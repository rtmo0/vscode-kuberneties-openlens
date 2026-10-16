/* Which row / details actions the current user may run, via SelfSubjectAccessReview. */
import type { ClusterSession } from './cluster';
import { getConfig } from './config';
import type { ActionId } from './protocol';
import type { ResourceKind } from './resources';

interface Check {
  verb: string;
  group: string;
  resource: string;
  subresource?: string;
  /** Checked cluster-wide instead of in the object's namespace. */
  clusterScoped?: boolean;
}

const pods = (verb: string, subresource?: string): Check => ({ verb, group: '', resource: 'pods', subresource });

function checksFor(action: ActionId, kind: ResourceKind): Check[] {
  const self = (verb: string): Check => ({ verb, group: kind.group, resource: kind.plural });
  switch (action) {
    case 'delete':
      return [self('delete')];
    case 'scale':
    case 'restart':
    case 'suspend':
    case 'resume':
    case 'cordon':
    case 'uncordon':
      return [self('patch')];
    case 'logs':
      return [pods('get', 'log')];
    case 'shell':
      return [pods('create', 'exec')];
    case 'forward':
      return [pods('create', 'portforward')];
    case 'debug':
      return [pods('patch', 'ephemeralcontainers'), pods('create', 'attach')];
    case 'trigger':
      return [{ verb: 'create', group: 'batch', resource: 'jobs' }];
    case 'drain':
      return [self('patch'), { ...pods('create', 'eviction'), clusterScoped: true }];
    case 'nodeShell':
      return [{ ...pods('create'), clusterScoped: true }, { ...pods('create', 'exec'), clusterScoped: true }];
    case 'helmUninstall':
      return [{ verb: 'delete', group: '', resource: 'secrets' }];
    case 'kubeconfig':
      return [{ verb: 'create', group: '', resource: 'serviceaccounts', subresource: 'token' }];
    default:
      return [];
  }
}

export interface ResourceRule {
  verbs?: string[];
  apiGroups?: string[];
  resources?: string[];
  resourceNames?: string[];
}

/** RBAC rule matching, as the API server does it for a request without an object name. */
export function rulesAllow(rules: ResourceRule[], verb: string, group: string, resource: string, subresource?: string): boolean {
  const combined = subresource ? `${resource}/${subresource}` : resource;
  return rules.some((rule) =>
    // Rules limited to named objects do not grant the action in general.
    !rule.resourceNames?.length &&
    (rule.verbs ?? []).some((v) => v === '*' || v === verb) &&
    (rule.apiGroups ?? []).some((g) => g === '*' || g === group) &&
    (rule.resources ?? []).some((r) => r === '*' || r === combined || (!!subresource && r === `*/${subresource}`))
  );
}

/** Actions from `actions` that the user may run in `namespace`. */
export async function allowedActions(session: ClusterSession, kind: ResourceKind, namespace: string | undefined, actions: ActionId[]): Promise<Set<ActionId>> {
  if (!getConfig().checkPermissions) {
    return new Set(actions);
  }
  const results = await Promise.all(
    actions.map(async (action) => {
      const checks = checksFor(action, kind);
      const ok = await Promise.all(
        checks.map((c) => session.can(c.verb, c.group, c.resource, c.clusterScoped || !kind.namespaced ? undefined : namespace, c.subresource))
      );
      return [action, ok.every(Boolean)] as const;
    })
  );
  return new Set(results.filter(([, ok]) => ok).map(([action]) => action));
}

/** Filter the actions of many rows, checking each namespace once. */
export async function filterRowActions<T extends { namespace?: string; actions: ActionId[] }>(session: ClusterSession, kind: ResourceKind, rows: T[]): Promise<T[]> {
  if (!getConfig().checkPermissions || rows.length === 0) {
    return rows;
  }
  const byNamespace = new Map<string, Set<ActionId>>();
  for (const row of rows) {
    const ns = row.namespace ?? '';
    const set = byNamespace.get(ns) ?? new Set<ActionId>();
    row.actions.forEach((a) => set.add(a));
    byNamespace.set(ns, set);
  }
  const allowed = new Map<string, Set<ActionId>>();
  await Promise.all(
    [...byNamespace.entries()].map(async ([ns, actions]) => {
      allowed.set(ns, await allowedActions(session, kind, ns || undefined, [...actions]));
    })
  );
  return rows.map((row) => ({ ...row, actions: row.actions.filter((a) => allowed.get(row.namespace ?? '')?.has(a)) }));
}
