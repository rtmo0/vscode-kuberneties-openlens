/* Installing add-ons and arbitrary Helm charts, with values edited in an editor. */
import * as fs from 'fs';
import * as https from 'https';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import type { ClusterManager, ClusterSession, K8sObject } from '../core/cluster';
import { confirmAction } from '../core/guard';
import { runHelm } from '../core/helmCli';
import { errorMessage, isNotFound, KubeApiError } from '../core/kubeRest';
import { logger } from '../core/logger';
import { Addon, ClusterEnv, fetchText, getAddon, HelmStep, parseManifest, valuesYaml } from './addons';
import { findTool, requireTool, runTool } from './tools';

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ─────────────────────────── add-ons ───────────────────────────

/** Apply objects whose CRDs may still be registering (e.g. ClusterIssuers right after cert-manager). */
async function applyWithRetry(session: ClusterSession, objects: K8sObject[], timeoutMs = 120_000): Promise<void> {
  const ordered = [...objects].sort((a, b) => rank(a) - rank(b));
  for (const obj of ordered) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        await session.apply(obj);
        break;
      } catch (err) {
        const retryable = (err instanceof KubeApiError && (err.status === 404 || err.status === 500 || err.status === 503)) || /does not serve|no matches|webhook/i.test(errorMessage(err));
        if (!retryable || Date.now() > deadline) {
          throw new Error(`${obj.kind}/${obj.metadata.name}: ${errorMessage(err)}`);
        }
        await wait(3000);
      }
    }
  }
}

function rank(obj: K8sObject): number {
  return obj.kind === 'Namespace' ? 0 : obj.kind === 'CustomResourceDefinition' ? 1 : obj.kind?.endsWith('Role') || obj.kind === 'ServiceAccount' ? 2 : 3;
}

function helmArgs(step: HelmStep, valuesFile: string, version?: string): string[] {
  return ['upgrade', '--install', step.release, step.chart, '--repo', step.repo, ...(version ? ['--version', version] : []), '--namespace', step.namespace, '--create-namespace', '--values', valuesFile, '--wait', '--timeout', '10m'];
}

export async function installAddon(
  session: ClusterSession,
  addon: Addon,
  options: Record<string, unknown>,
  env: ClusterEnv,
  report: (message: string) => void,
  valuesOverride?: string
): Promise<string[]> {
  if (addon.steps.some((s) => s.type === 'helm')) {
    await requireTool('helm');
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openlens-addon-'));
  try {
    for (const [index, step] of addon.steps.entries()) {
      if (step.type === 'helm') {
        report(`helm upgrade --install ${step.release} (${step.chart})…`);
        const file = path.join(dir, `values-${index}.yaml`);
        fs.writeFileSync(file, index === 0 && valuesOverride !== undefined ? valuesOverride : valuesYaml(step, options, env), { mode: 0o600 });
        await runHelm(session.context, helmArgs(step, file));
      } else {
        report(`Applying ${step.url}…`);
        await applyWithRetry(session, parseManifest(await fetchText(step.url)));
      }
    }
    const extra = addon.extraObjects?.(options, env) ?? [];
    if (extra.length) {
      report(`Creating ${extra.map((o) => `${o.kind}/${o.metadata.name}`).join(', ')}…`);
      await applyWithRetry(session, extra);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return (await addon.notes?.(session, options).catch(() => [])) ?? [];
}

export async function uninstallAddon(session: ClusterSession, addon: Addon, report: (message: string) => void): Promise<void> {
  for (const step of [...addon.steps].reverse()) {
    if (step.type === 'helm') {
      report(`helm uninstall ${step.release}…`);
      await runHelm(session.context, ['uninstall', step.release, '--namespace', step.namespace, '--wait']).catch((err) => {
        if (!/not found/i.test(errorMessage(err))) {
          throw err;
        }
      });
    } else {
      report(`Deleting the objects of ${step.url}…`);
      for (const obj of parseManifest(await fetchText(step.url)).reverse()) {
        try {
          const kind = await session.resolveKind(obj.apiVersion, obj.kind);
          await session.delete(kind, obj.metadata.name, obj.metadata.namespace);
        } catch (err) {
          if (!isNotFound(err)) {
            logger.warn(`Could not delete ${obj.kind}/${obj.metadata.name}`, errorMessage(err));
          }
        }
      }
    }
  }
}

// ─────────────────────────── values editor ───────────────────────────

type PendingInstall =
  | { type: 'addon'; context: string; addonId: string; options: Record<string, unknown>; env: ClusterEnv }
  | { type: 'chart'; context: string; release: string; namespace: string; chartRef: string; repo?: string; version: string };

export const pendingInstalls = new Map<string, PendingInstall>();
export const HELM_INSTALL_CONTEXT = 'openLens.helmInstallEditor';

async function openValuesEditor(pending: PendingInstall, header: string[], values: string, schema?: string): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openlens-install-'));
  const file = path.join(dir, 'values.yaml');
  const lines = header.map((l) => `# ${l}`);
  if (schema) {
    const schemaFile = path.join(dir, 'values.schema.json');
    fs.writeFileSync(schemaFile, schema);
    // The YAML extension validates and completes the values against the chart's schema.
    lines.unshift(`# yaml-language-server: $schema=${vscode.Uri.file(schemaFile).toString()}`);
  }
  fs.writeFileSync(file, `${lines.join('\n')}\n\n${values}`, { mode: 0o600 });
  pendingInstalls.set(file, pending);
  await vscode.window.showTextDocument(vscode.Uri.file(file), { preview: false });
  void vscode.commands.executeCommand('setContext', HELM_INSTALL_CONTEXT, true);
}

export async function editAddonValues(session: ClusterSession, addon: Addon, options: Record<string, unknown>, env: ClusterEnv): Promise<void> {
  const step = addon.steps.find((s): s is HelmStep => s.type === 'helm');
  if (!step) {
    throw new Error(`${addon.title} is installed from a manifest and has no values.`);
  }
  await openValuesEditor(
    { type: 'addon', context: session.context, addonId: addon.id, options, env },
    [`Values for ${addon.title} (${step.chart} from ${step.repo}) in ${session.context}.`, 'Edit, then click "Helm Install" in the editor title.'],
    valuesYaml(step, options, env)
  );
}

/** "Helm Install" button of a values editor. */
export async function installFromEditor(clusters: ClusterManager): Promise<string | undefined> {
  const doc = vscode.window.activeTextEditor?.document;
  const pending = doc ? pendingInstalls.get(doc.uri.fsPath) : undefined;
  if (!doc || !pending) {
    throw new Error('Open the values of a chart or add-on to install first.');
  }
  if (doc.isDirty) {
    await doc.save();
  }
  const session = clusters.session(pending.context);
  const values = fs.readFileSync(doc.uri.fsPath, 'utf8');
  const title = pending.type === 'addon' ? getAddon(pending.addonId)!.title : `${pending.release} (${pending.chartRef} ${pending.version})`;
  if (!(await confirmAction(pending.context, { title: `Install ${title} into ${pending.context}?`, button: 'Install', always: true }))) {
    return undefined;
  }
  let notes: string[] = [];
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Installing ${title}` }, async (progress) => {
    if (pending.type === 'addon') {
      notes = await installAddon(session, getAddon(pending.addonId)!, pending.options, pending.env, (m) => progress.report({ message: m }), values);
    } else {
      await requireTool('helm');
      const args = ['upgrade', '--install', pending.release, pending.chartRef, ...(pending.repo ? ['--repo', pending.repo] : []), '--version', pending.version, '--namespace', pending.namespace, '--create-namespace', '--values', doc.uri.fsPath, '--wait', '--timeout', '10m'];
      await runHelm(pending.context, args);
    }
  });
  pendingInstalls.delete(doc.uri.fsPath);
  await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
  fs.rmSync(path.dirname(doc.uri.fsPath), { recursive: true, force: true });
  void vscode.window.showInformationMessage([`Installed ${title}.`, ...notes].join(' '));
  return pending.type === 'chart' ? pending.release : undefined;
}

// ─────────────────────────── Artifact Hub ───────────────────────────

export interface HubPackage {
  package_id: string;
  name: string;
  version: string;
  app_version?: string;
  description?: string;
  stars?: number;
  repository: { name: string; url: string; display_name?: string; verified_publisher?: boolean; official?: boolean };
}

function hubGet(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { 'User-Agent': 'openlens-vscode', Accept: 'application/json' } }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      })
      .on('error', reject)
      .setTimeout(20_000, function (this: any) {
        this.destroy(new Error('Artifact Hub did not answer in time'));
      });
  });
}

export async function searchCharts(query: string): Promise<HubPackage[]> {
  const res = await hubGet(`https://artifacthub.io/api/v1/packages/search?kind=0&limit=25&sort=relevance&ts_query_web=${encodeURIComponent(query)}`);
  if (res.status !== 200) {
    throw new Error(`Artifact Hub search failed (HTTP ${res.status})`);
  }
  return (JSON.parse(res.body).packages ?? []) as HubPackage[];
}

async function chartVersions(pkg: HubPackage): Promise<string[]> {
  const res = await hubGet(`https://artifacthub.io/api/v1/packages/helm/${encodeURIComponent(pkg.repository.name)}/${encodeURIComponent(pkg.name)}`);
  if (res.status !== 200) {
    return [pkg.version];
  }
  const versions = (JSON.parse(res.body).available_versions ?? []) as Array<{ version: string; prerelease?: boolean }>;
  return versions.filter((v) => !v.prerelease).map((v) => v.version).slice(0, 30);
}

async function chartValues(pkg: HubPackage, version: string): Promise<{ values: string; schema?: string }> {
  const [values, schema] = await Promise.all([
    hubGet(`https://artifacthub.io/api/v1/packages/${pkg.package_id}/${encodeURIComponent(version)}/values`),
    hubGet(`https://artifacthub.io/api/v1/packages/${pkg.package_id}/${encodeURIComponent(version)}/values-schema`)
  ]);
  return { values: values.status === 200 ? values.body : '# No default values published.\n', schema: schema.status === 200 && schema.body.trim().startsWith('{') ? schema.body : undefined };
}

/** Search Artifact Hub, pick a chart and version, then edit its values before installing. */
export async function installChart(clusters: ClusterManager, context: string): Promise<void> {
  await requireTool('helm');
  type Item = vscode.QuickPickItem & { pkg?: HubPackage };
  const pick = vscode.window.createQuickPick<Item>();
  pick.title = `Install a Helm chart into ${context}`;
  pick.placeholder = 'Search Artifact Hub, e.g. redis, postgresql, keycloak';
  pick.matchOnDescription = true;
  pick.matchOnDetail = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let generation = 0;
  pick.onDidChangeValue((value) => {
    if (timer) {
      clearTimeout(timer);
    }
    if (value.trim().length < 2) {
      return;
    }
    timer = setTimeout(async () => {
      const current = ++generation;
      pick.busy = true;
      try {
        const packages = await searchCharts(value.trim());
        if (current === generation) {
          pick.items = packages.map((p) => ({
            label: `${p.repository.official ? '$(verified-filled) ' : p.repository.verified_publisher ? '$(verified) ' : ''}${p.name}`,
            description: `${p.repository.display_name ?? p.repository.name} · ${p.version}${p.app_version ? ` (app ${p.app_version})` : ''}${p.stars ? ` · ★${p.stars}` : ''}`,
            detail: p.description,
            pkg: p,
            alwaysShow: true
          }));
        }
      } catch (err) {
        pick.items = [{ label: `$(error) ${errorMessage(err)}` }];
      } finally {
        if (current === generation) {
          pick.busy = false;
        }
      }
    }, 300);
  });
  const pkg = await new Promise<HubPackage | undefined>((resolve) => {
    pick.onDidAccept(() => {
      resolve(pick.selectedItems[0]?.pkg);
      pick.hide();
    });
    pick.onDidHide(() => {
      resolve(undefined);
      pick.dispose();
    });
    pick.show();
  });
  if (!pkg) {
    return;
  }
  const versions = await chartVersions(pkg);
  const version = versions.length > 1 ? await vscode.window.showQuickPick(versions, { title: `${pkg.name}: version`, placeHolder: versions[0] }) : versions[0];
  if (!version) {
    return;
  }
  const release = await vscode.window.showInputBox({ title: 'Release name', value: pkg.name, validateInput: (v) => (/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(v) && v.length <= 53 ? undefined : 'Lowercase letters, digits and "-", at most 53 characters') });
  if (!release) {
    return;
  }
  const namespace = await vscode.window.showInputBox({ title: 'Namespace (created if missing)', value: clusters.namespaceFilter(context) || pkg.name, validateInput: (v) => (/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(v) ? undefined : 'Enter a namespace name') });
  if (!namespace) {
    return;
  }
  const { values, schema } = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Loading the values of ${pkg.name} ${version}…` }, () => chartValues(pkg, version));
  const oci = pkg.repository.url.startsWith('oci://');
  await openValuesEditor(
    { type: 'chart', context, release, namespace, chartRef: oci ? `${pkg.repository.url.replace(/\/$/, '')}/${pkg.name}` : pkg.name, repo: oci ? undefined : pkg.repository.url, version },
    [
      `Values for ${pkg.name} ${version} from ${pkg.repository.url}, release "${release}" in namespace "${namespace}" of ${context}.`,
      'These are the chart defaults: change what you need (or delete the rest), then click "Helm Install" in the editor title.'
    ],
    values,
    schema
  );
}

// ─────────────────────────── repositories ───────────────────────────

export async function manageRepositories(): Promise<void> {
  const helm = await requireTool('helm');
  const list = JSON.parse((await runTool(helm, ['repo', 'list', '-o', 'json']).catch(() => '[]')) || '[]') as Array<{ name: string; url: string }>;
  const picked = await vscode.window.showQuickPick(
    [
      { label: '$(add) Add a Repository…', id: 'add' },
      ...(list.length ? [{ label: '$(sync) Update All Repositories', id: 'update' }] : []),
      ...list.map((r) => ({ label: r.name, description: r.url, detail: 'Select to remove', id: `remove:${r.name}` }))
    ],
    { title: 'Helm repositories (used by the helm CLI; installs from this extension use the repository URL directly)' }
  );
  if (!picked) {
    return;
  }
  if (picked.id === 'add') {
    const name = await vscode.window.showInputBox({ title: 'Repository name', placeHolder: 'bitnami' });
    const url = name ? await vscode.window.showInputBox({ title: 'Repository URL', placeHolder: 'https://charts.bitnami.com/bitnami' }) : undefined;
    if (name && url) {
      await runTool(helm, ['repo', 'add', name, url]);
      void vscode.window.showInformationMessage(`Added Helm repository ${name}.`);
    }
  } else if (picked.id === 'update') {
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'helm repo update…' }, () => runTool(helm, ['repo', 'update']));
  } else {
    const name = picked.id.slice('remove:'.length);
    const choice = await vscode.window.showWarningMessage(`Remove Helm repository "${name}"?`, { modal: true }, 'Remove');
    if (choice === 'Remove') {
      await runTool(helm, ['repo', 'remove', name]);
    }
  }
}

export function helmAvailable(): boolean {
  return !!findTool('helm');
}

export { isNotFound };
