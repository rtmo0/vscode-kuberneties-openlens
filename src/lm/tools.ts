/* Read-only Kubernetes tools for Copilot Chat and other language-model agents. */
import * as vscode from 'vscode';

import type { ClusterManager, ClusterSession } from '../core/cluster';
import { buildTable, eventTime } from '../core/columns';
import { buildDashboard } from '../core/dashboard';
import { buildDetails, MetricsHistory } from '../core/details';
import { formatAge, formatBytes, formatCpu } from '../core/format';
import { errorMessage } from '../core/kubeRest';
import type { Section } from '../core/protocol';
import { findKindByKind, getKind, KINDS, ResourceKind } from '../core/resources';

const MAX_OUTPUT = 14_000;
const MAX_ROWS = 150;

function truncate(text: string): string {
  return text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}\n… (output truncated)` : text;
}

function result(text: string): vscode.LanguageModelToolResult {
  return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(truncate(text))]);
}

function resolveContext(clusters: ClusterManager, context?: string): string {
  const name = context?.trim() || clusters.currentContext;
  if (!name) {
    throw new Error('No context given and no current context is set.');
  }
  if (!clusters.hasContext(name)) {
    throw new Error(`Unknown context "${name}". Known contexts: ${clusters.contexts().map((c) => c.name).join(', ')}`);
  }
  return name;
}

/** Accepts "pods", "pod", "Pod", "deploy", "svc", "cm", CRD kinds… */
function resolveKind(session: ClusterSession, kind: string): Promise<ResourceKind> | ResourceKind {
  const k = kind.trim().toLowerCase();
  const aliases: Record<string, string> = { po: 'pods', deploy: 'deployments', svc: 'services', cm: 'configmaps', ns: 'namespaces', no: 'nodes', sts: 'statefulsets', ds: 'daemonsets', rs: 'replicasets', cj: 'cronjobs', ing: 'ingresses', ev: 'events', sa: 'serviceaccounts', pvc: 'pvc', pv: 'pv', hpa: 'hpa', helm: 'helmreleases', release: 'helmreleases', releases: 'helmreleases' };
  const byId = getKind(aliases[k] ?? k);
  if (byId) {
    return byId;
  }
  const builtin = KINDS.find((x) => x.kind.toLowerCase() === k || x.plural === k || x.title.toLowerCase() === k || `${x.kind.toLowerCase()}s` === k);
  if (builtin) {
    return builtin;
  }
  const known = findKindByKind(undefined, kind);
  if (known) {
    return known;
  }
  return session.customResourceKinds().then((kinds) => {
    const match = kinds.find((x) => x.kind.toLowerCase() === k || x.plural === k || `${x.plural}.${x.group}` === k);
    if (!match) {
      throw new Error(`Unknown resource kind "${kind}".`);
    }
    return match;
  });
}

function sectionText(section: Section): string {
  switch (section.type) {
    case 'kv':
      return section.items.map((i) => `${i.key}: ${i.value}`).join('\n');
    case 'labels':
      return section.items.map((i) => `${i.key}=${i.value}`).join('\n') || 'none';
    case 'conditions':
      return section.items.map((c) => `${c.type}=${c.status}${c.reason ? ` (${c.reason})` : ''}${c.message ? `: ${c.message}` : ''}`).join('\n') || 'none';
    case 'containers':
      return section.items
        .map((c) =>
          [
            `- ${c.name}${c.init ? ' (init)' : ''}: ${c.state}, ready=${c.ready}, restarts=${c.restarts}`,
            `  image: ${c.image}`,
            c.lastState ? `  last state: ${c.lastState}` : '',
            `  requests: ${c.requests}; limits: ${c.limits}${c.usage ? `; usage: ${c.usage}` : ''}`,
            c.command ? `  command: ${c.command}` : '',
            c.ports.length ? `  ports: ${c.ports.map((p) => `${p.port}/${p.protocol}`).join(', ')}` : '',
            c.env.length ? `  env: ${c.env.map((e) => `${e.name}=${e.value}`).join(', ')}` : ''
          ]
            .filter(Boolean)
            .join('\n')
        )
        .join('\n');
    case 'metrics': {
      const last = section.series[0]?.points.at(-1);
      return last ? `current CPU ${formatCpu(last.cpu)}, memory ${formatBytes(last.memory)}` : section.unavailable ?? 'no metrics';
    }
    case 'usage':
      return section.items.map((i) => `${i.label}: used ${i.used} of ${i.capacity}${i.requested !== undefined ? `, requested ${i.requested}` : ''}${i.limit !== undefined ? `, limits ${i.limit}` : ''}`).join('\n');
    case 'table':
      return [section.data.columns.map((c) => c.title).join(' | '), ...section.data.rows.slice(0, 50).map((r) => r.cells.map((c) => c.text || (c.time ? formatAge(c.time) : '')).join(' | '))].join('\n');
    case 'secret':
      // Never hand secret values to a model.
      return section.encoded ? `keys: ${section.items.map((i) => `${i.key} (${i.size} bytes)`).join(', ') || 'none'}` : section.items.map((i) => `${i.key}: ${i.value.slice(0, 500)}`).join('\n');
    case 'ports':
      return section.items.map((p) => `${p.name ?? ''} ${p.port} → ${p.targetPort}/${p.protocol}`).join('\n');
    case 'code':
      return section.text.slice(0, 4000);
    case 'events':
      return section.items.map((e) => `${e.type} ${e.reason} x${e.count} (${formatAge(e.time)} ago): ${e.message}`).join('\n') || 'no events';
    case 'revisions':
      return section.items.map((r) => `revision ${r.revision}${r.current ? ' (current)' : ''}${r.status ? ` ${r.status}` : ''}: ${r.description}`).join('\n');
  }
}

interface ContextInput {
  context?: string;
}

export function registerLanguageModelTools(context: vscode.ExtensionContext, clusters: ClusterManager): void {
  if (!vscode.lm?.registerTool) {
    return;
  }
  const tool = <T extends ContextInput>(
    name: string,
    describe: (input: T) => string,
    run: (input: T, session: ClusterSession) => Promise<string>
  ): void => {
    context.subscriptions.push(
      vscode.lm.registerTool<T>(name, {
        prepareInvocation: (options) => ({ invocationMessage: describe(options.input) }),
        invoke: async (options) => {
          try {
            const ctx = resolveContext(clusters, options.input.context);
            const session = clusters.session(ctx);
            await session.connect();
            return result(`Context: ${ctx}\n${await run(options.input, session)}`);
          } catch (err) {
            return result(`Error: ${errorMessage(err)}`);
          }
        }
      })
    );
  };

  context.subscriptions.push(
    vscode.lm.registerTool<Record<string, never>>('kubernetes_list_contexts', {
      prepareInvocation: () => ({ invocationMessage: 'Listing Kubernetes contexts' }),
      invoke: async () =>
        result(
          clusters
            .contexts()
            .map((c) => `${c.current ? '* ' : '  '}${c.name}  server=${c.server}  namespace=${c.namespace ?? 'default'}${c.health.problems.length ? `  problems: ${c.health.problems.join('; ')}` : ''}`)
            .join('\n') || 'No contexts in the kubeconfig.'
        )
    })
  );

  tool<ContextInput & { kind: string; namespace?: string; labelSelector?: string }>(
    'kubernetes_list_resources',
    (i) => `Listing ${i.kind}${i.namespace ? ` in ${i.namespace}` : ''}`,
    async (input, session) => {
      const kind = await resolveKind(session, input.kind);
      const namespace = input.namespace ?? '';
      if (kind.custom) {
        const list = await session.list(kind, namespace, { labelSelector: input.labelSelector });
        return list.items
          .slice(0, MAX_ROWS)
          .map((o) => `${o.metadata.namespace ? `${o.metadata.namespace}/` : ''}${o.metadata.name}  age=${formatAge(o.metadata.creationTimestamp)}`)
          .join('\n');
      }
      const list = await session.list(kind, namespace, { labelSelector: input.labelSelector });
      const metrics = kind.id === 'pods' ? await session.podMetrics(namespace || undefined) : undefined;
      const nodeMetrics = kind.id === 'nodes' ? await session.nodeMetrics() : undefined;
      const table = buildTable(kind, list.items, { podMetrics: metrics, nodeMetrics });
      const header = table.columns.map((c) => c.title).join(' | ');
      const rows = table.rows.slice(0, MAX_ROWS).map((r) => r.cells.map((c) => c.text || (c.time ? formatAge(c.time) : '') || (c.dots ? c.dots.map((d) => d.title).join('; ') : '')).join(' | '));
      return [
        `${kind.title}: ${table.rows.length}${table.rows.length > MAX_ROWS ? ` (first ${MAX_ROWS} shown)` : ''}${list.notice ? `\n${list.notice}` : ''}`,
        header,
        ...rows
      ].join('\n');
    }
  );

  tool<ContextInput & { kind: string; name: string; namespace?: string }>(
    'kubernetes_describe_resource',
    (i) => `Describing ${i.kind} ${i.namespace ? `${i.namespace}/` : ''}${i.name}`,
    async (input, session) => {
      const kind = await resolveKind(session, input.kind);
      const obj = await session.get(kind, input.name, input.namespace);
      const details = await buildDetails(session, kind, obj, new MetricsHistory());
      return [
        `${details.title} — ${details.subtitle}${details.status ? ` — status: ${details.status.text}` : ''}`,
        ...details.sections.map((s) => `\n## ${s.title}\n${sectionText(s)}`)
      ].join('\n');
    }
  );

  tool<ContextInput & { namespace: string; pod: string; container?: string; tailLines?: number; previous?: boolean; sinceSeconds?: number }>(
    'kubernetes_pod_logs',
    (i) => `Reading logs of ${i.namespace}/${i.pod}${i.container ? `/${i.container}` : ''}${i.previous ? ' (previous)' : ''}`,
    async (input, session) => {
      const pod = await session.get(getKind('pods')!, input.pod, input.namespace);
      const containers: string[] = input.container ? [input.container] : (pod.spec?.containers ?? []).map((c: any) => c.name);
      const tail = Math.min(Math.max(1, input.tailLines ?? 200), 2000);
      const parts = await Promise.all(
        containers.map(async (container) => {
          try {
            const text = await session.rest.text('GET', `/api/v1/namespaces/${encodeURIComponent(input.namespace)}/pods/${encodeURIComponent(input.pod)}/log`, {
              query: { container, tailLines: tail, previous: input.previous || undefined, sinceSeconds: input.sinceSeconds },
              accept: '*/*'
            });
            return `--- ${container} (last ${tail} lines) ---\n${text.trim() || '(empty)'}`;
          } catch (err) {
            return `--- ${container} ---\nError: ${errorMessage(err)}`;
          }
        })
      );
      return parts.join('\n');
    }
  );

  tool<ContextInput & { namespace?: string; warningsOnly?: boolean; involvedObject?: string }>(
    'kubernetes_events',
    (i) => `Reading ${i.warningsOnly === false ? '' : 'warning '}events${i.namespace ? ` in ${i.namespace}` : ''}`,
    async (input, session) => {
      const selectors = [input.warningsOnly === false ? '' : 'type=Warning', input.involvedObject ? `involvedObject.name=${input.involvedObject}` : ''].filter(Boolean).join(',');
      const events = await session.events(input.namespace || undefined, selectors || undefined);
      events.sort((a, b) => (Date.parse(eventTime(b) ?? '') || 0) - (Date.parse(eventTime(a) ?? '') || 0));
      return (
        events
          .slice(0, 80)
          .map((e) => {
            const ref = e.involvedObject ?? {};
            return `${formatAge(eventTime(e))} ago  ${e.type} ${e.reason} x${e.count ?? 1}  ${ref.kind}/${ref.namespace ? `${ref.namespace}/` : ''}${ref.name}: ${e.message}`;
          })
          .join('\n') || 'No matching events.'
      );
    }
  );

  tool<ContextInput & { namespace?: string }>(
    'kubernetes_cluster_overview',
    (i) => `Summarising the cluster${i.namespace ? ` (namespace ${i.namespace})` : ''}`,
    async (input, session) => {
      const d = await buildDashboard(session, input.namespace ?? '');
      return [
        `Server ${d.server}, version ${d.version ?? 'unknown'}`,
        `Nodes: ${d.nodes.ready}/${d.nodes.total} ready`,
        `CPU: usage ${formatCpu(d.cpu.usage)}, requests ${formatCpu(d.cpu.requests)}, limits ${formatCpu(d.cpu.limits)}, allocatable ${formatCpu(d.cpu.allocatable)}`,
        `Memory: usage ${formatBytes(d.memory.usage)}, requests ${formatBytes(d.memory.requests)}, limits ${formatBytes(d.memory.limits)}, allocatable ${formatBytes(d.memory.allocatable)}`,
        `Pods: ${d.pods.usage} of ${d.pods.capacity} capacity; ${d.podPhases.map((p) => `${p.label} ${p.count}`).join(', ')}`,
        `Workloads: ${d.workloads.map((w) => `${w.title} ${w.total} (${w.error} failing, ${w.warn} pending)`).join('; ')}`,
        ...d.notices.map((n) => `Note: ${n}`),
        '',
        'Recent warnings:',
        ...d.warnings.slice(0, 25).map((w) => `- ${w.reason} ${w.namespace ? `${w.namespace}/` : ''}${w.object} x${w.count}: ${w.message}`)
      ].join('\n');
    }
  );
}
