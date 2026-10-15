import * as vscode from 'vscode';

import type { ClusterManager } from '../core/cluster';
import { errorMessage } from '../core/kubeRest';
import type { ObjectRef } from '../core/protocol';
import { getKind } from '../core/resources';
import { podStatus } from '../core/status';

/** Kinds searched by "Go to Resource", most useful first. */
const SEARCH_KINDS = [
  'pods',
  'deployments',
  'statefulsets',
  'daemonsets',
  'cronjobs',
  'jobs',
  'services',
  'ingresses',
  'configmaps',
  'secrets',
  'pvc',
  'helmreleases',
  'nodes',
  'namespaces'
];

type Item = vscode.QuickPickItem & { ref?: ObjectRef };

/**
 * Quick pick over every resource of a context; lists load in parallel and
 * appear as they arrive.
 */
export async function goToResource(clusters: ClusterManager, context: string, open: (context: string, ref: ObjectRef) => void): Promise<void> {
  const session = clusters.session(context);
  const namespace = clusters.namespaceFilter(context);
  const pick = vscode.window.createQuickPick<Item>();
  pick.title = `Go to resource in ${context}${namespace ? ` (namespace ${namespace})` : ''}`;
  pick.placeholder = 'Type a name, kind or namespace';
  pick.matchOnDescription = true;
  pick.busy = true;
  pick.show();

  const byKind = new Map<string, Item[]>();
  const refresh = (): void => {
    const active = pick.activeItems[0]?.ref;
    pick.items = SEARCH_KINDS.flatMap((id) => {
      const items = byKind.get(id) ?? [];
      return items.length ? [{ label: getKind(id)!.title, kind: vscode.QuickPickItemKind.Separator } as Item, ...items] : [];
    });
    if (active) {
      const match = pick.items.find((i) => i.ref?.kindId === active.kindId && i.ref?.name === active.name && i.ref?.namespace === active.namespace);
      if (match) {
        pick.activeItems = [match];
      }
    }
  };

  let pending = SEARCH_KINDS.length;
  const errors: string[] = [];
  try {
    await session.connect();
  } catch (err) {
    pick.dispose();
    throw err;
  }
  for (const kindId of SEARCH_KINDS) {
    const kind = getKind(kindId)!;
    session
      .list(kind, namespace)
      .then((result) => {
        let items = result.items;
        if (kindId === 'helmreleases') {
          const latest = new Map<string, (typeof items)[0]>();
          for (const s of items) {
            const key = `${s.metadata.namespace}/${s.metadata.labels?.name}`;
            if (!latest.has(key) || Number(s.metadata.labels?.version) > Number(latest.get(key)!.metadata.labels?.version)) {
              latest.set(key, s);
            }
          }
          items = [...latest.values()];
        }
        byKind.set(
          kindId,
          items.map((obj) => {
            const name = kindId === 'helmreleases' ? obj.metadata.labels?.name ?? obj.metadata.name : obj.metadata.name;
            const status = kindId === 'pods' ? podStatus(obj).text : undefined;
            return {
              label: `$(${kind.icon}) ${name}`,
              description: [kind.kind === 'HelmRelease' ? 'Helm release' : kind.kind, obj.metadata.namespace, status].filter(Boolean).join(' · '),
              ref: { kindId, name, namespace: obj.metadata.namespace }
            };
          })
        );
        refresh();
      })
      .catch((err) => errors.push(`${kind.title}: ${errorMessage(err)}`))
      .finally(() => {
        pending -= 1;
        if (pending === 0) {
          pick.busy = false;
          if (errors.length && !pick.items.length) {
            pick.placeholder = errors[0];
          }
        }
      });
  }

  await new Promise<void>((resolve) => {
    pick.onDidAccept(() => {
      const ref = pick.selectedItems[0]?.ref;
      if (ref) {
        open(context, ref);
      }
      pick.hide();
    });
    pick.onDidHide(() => {
      pick.dispose();
      resolve();
    });
  });
}
