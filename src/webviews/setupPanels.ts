import * as vscode from 'vscode';

import type { K8sObject } from '../core/cluster';
import { confirmAction } from '../core/guard';
import { errorMessage } from '../core/kubeRest';
import { getKind } from '../core/resources';
import { toYaml } from '../fs/resourceFs';
import { ADDONS, ClusterEnv, defaultOptions, detectEnv, getAddon } from '../setup/addons';
import { DeployForm, generateDeployment, validateDeployForm } from '../setup/deployGen';
import { dnsTest, runDoctor } from '../setup/doctor';
import { editAddonValues, installAddon, installChart, uninstallAddon } from '../setup/helmInstall';
import { findTool } from '../setup/tools';
import { BaseWebviewPanel } from './baseWebview';
import type { PanelServices } from './panels';

function iconPath(services: PanelServices): vscode.Uri {
  return vscode.Uri.joinPath(services.extensionUri, 'resources', 'icon.png');
}

/** One panel per context and kind of page; reveals the existing one. */
abstract class ContextPanel extends BaseWebviewPanel {
  protected constructor(
    protected readonly services: PanelServices,
    protected readonly context: string
  ) {
    super(services.extensionUri);
  }

  protected override get contextName(): string {
    return this.context;
  }

  protected get session() {
    return this.services.clusters.session(this.context);
  }
}

// ─────────────────────────── add-ons ───────────────────────────

export class AddonsPanel extends ContextPanel {
  private static readonly panels = new Map<string, AddonsPanel>();
  private env?: ClusterEnv;

  static show(services: PanelServices, context: string): void {
    const existing = AddonsPanel.panels.get(context);
    if (existing) {
      existing.reveal();
      return;
    }
    AddonsPanel.panels.set(context, new AddonsPanel(services, context));
  }

  private constructor(services: PanelServices, context: string) {
    super(services, context);
    this.initializePanel(vscode.ViewColumn.Active);
    this.panel.iconPath = iconPath(services);
    this.registerHandler('load', async (_m, respond) => respond(await this.load()));
    this.registerHandler('install', async (message, respond) => {
      const { id, options } = message.payload as { id: string; options: Record<string, unknown> };
      respond(await this.install(id, options));
    });
    this.registerHandler('editValues', async (message, respond) => {
      const { id, options } = message.payload as { id: string; options: Record<string, unknown> };
      await editAddonValues(this.session, getAddon(id)!, options, this.env ?? (await detectEnv(this.session)));
      respond(true);
    });
    this.registerHandler('uninstall', async (message, respond) => {
      const addon = getAddon((message.payload as { id: string }).id)!;
      const ok = await confirmAction(this.context, { title: `Uninstall ${addon.title} from ${this.context}?`, detail: 'Its workloads are deleted. CustomResourceDefinitions installed by Helm are kept, together with your objects of those kinds.', button: 'Uninstall', always: true });
      if (ok) {
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Uninstalling ${addon.title}` }, (p) => uninstallAddon(this.session, addon, (m) => p.report({ message: m })));
      }
      respond(ok);
    });
    this.registerHandler('docs', async (message, respond) => {
      await vscode.env.openExternal(vscode.Uri.parse((message.payload as { url: string }).url));
      respond(true);
    });
    this.registerHandler('installChart', async (_m, respond) => {
      await installChart(this.services.clusters, this.context).catch((err) => vscode.window.showErrorMessage(errorMessage(err)));
      respond(true);
    });
  }

  private async load(): Promise<unknown> {
    const session = this.session;
    await session.connect();
    this.env = await detectEnv(session);
    const env = this.env;
    const statuses = await Promise.all(ADDONS.map((a) => a.detect(session).catch((err) => ({ installed: false, managed: false, detail: `Could not check: ${errorMessage(err)}` }))));
    return {
      context: this.context,
      env,
      helm: !!findTool('helm'),
      addons: ADDONS.map((a, i) => ({
        id: a.id,
        title: a.title,
        category: a.category,
        description: a.description,
        docs: a.docs,
        source: a.steps.map((s) => (s.type === 'helm' ? `${s.chart} · ${s.repo.replace(/^https?:\/\//, '')}` : s.url.replace(/^https?:\/\//, ''))).join(' + '),
        namespace: a.steps.find((s) => s.type === 'helm') ? (a.steps.find((s) => s.type === 'helm') as { namespace: string }).namespace : undefined,
        needsHelm: a.steps.some((s) => s.type === 'helm'),
        status: statuses[i],
        options: (a.options ?? []).map((o) => ({ id: o.id, label: o.label, type: o.type, description: o.description, value: defaultOptions(a, env)[o.id] }))
      }))
    };
  }

  private async install(id: string, options: Record<string, unknown>): Promise<{ ok: boolean; notes?: string[]; error?: string }> {
    const addon = getAddon(id)!;
    if (!(await confirmAction(this.context, { title: `Install ${addon.title} into ${this.context}?`, detail: addon.description, button: 'Install', always: true }))) {
      return { ok: false };
    }
    try {
      const env = this.env ?? (await detectEnv(this.session));
      const notes = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Installing ${addon.title}` }, (p) =>
        installAddon(this.session, addon, options, env, (m) => p.report({ message: m }))
      );
      void vscode.window.showInformationMessage([`${addon.title} installed.`, ...notes].join(' '));
      return { ok: true, notes };
    } catch (err) {
      void vscode.window.showErrorMessage(`${addon.title}: ${errorMessage(err)}`, 'Show Output').then((c) => c && vscode.commands.executeCommand('openLens.showLogs'));
      return { ok: false, error: errorMessage(err) };
    }
  }

  protected get panelKey(): string {
    return `addons:${this.context}`;
  }

  protected get title(): string {
    return `Add-ons · ${this.context}`;
  }

  protected get webviewName(): string {
    return 'addons';
  }

  protected override onDispose(): void {
    AddonsPanel.panels.delete(this.context);
    super.onDispose();
  }
}

// ─────────────────────────── doctor ───────────────────────────

export class DoctorPanel extends ContextPanel {
  private static readonly panels = new Map<string, DoctorPanel>();

  static show(services: PanelServices, context: string): void {
    const existing = DoctorPanel.panels.get(context);
    if (existing) {
      existing.reveal();
      return;
    }
    DoctorPanel.panels.set(context, new DoctorPanel(services, context));
  }

  private constructor(services: PanelServices, context: string) {
    super(services, context);
    this.initializePanel(vscode.ViewColumn.Active);
    this.panel.iconPath = iconPath(services);
    this.registerHandler('run', async (_m, respond) => {
      try {
        respond({ context: this.context, checks: await runDoctor(this.session), at: new Date().toISOString() });
      } catch (err) {
        respond({ context: this.context, error: errorMessage(err) });
      }
    });
    this.registerHandler('fix', async (message, respond) => {
      const { action, arg } = message.payload as { action: string; arg?: string };
      try {
        respond(await this.fix(action, arg));
      } catch (err) {
        void vscode.window.showErrorMessage(errorMessage(err));
        respond({ changed: false });
      }
    });
  }

  private async fix(action: string, arg?: string): Promise<{ changed: boolean; output?: string }> {
    switch (action) {
      case 'installAddon': {
        const addon = getAddon(arg!)!;
        if (!(await confirmAction(this.context, { title: `Install ${addon.title} into ${this.context}?`, button: 'Install', always: true }))) {
          return { changed: false };
        }
        const env = await detectEnv(this.session);
        const notes = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Installing ${addon.title}` }, (p) =>
          installAddon(this.session, addon, defaultOptions(addon, env), env, (m) => p.report({ message: m }))
        );
        void vscode.window.showInformationMessage([`${addon.title} installed.`, ...notes].join(' '));
        return { changed: true };
      }
      case 'makeDefaultStorageClass': {
        if (!(await confirmAction(this.context, { title: `Make StorageClass ${arg} the default`, button: 'Make Default' }))) {
          return { changed: false };
        }
        const kind = getKind('storageclasses')!;
        for (const sc of (await this.session.list(kind, '')).items) {
          const isDefault = sc.metadata.name === arg;
          if ((sc.metadata.annotations?.['storageclass.kubernetes.io/is-default-class'] === 'true') !== isDefault) {
            await this.session.patch(kind, sc.metadata.name, undefined, { metadata: { annotations: { 'storageclass.kubernetes.io/is-default-class': String(isDefault) } } });
          }
        }
        return { changed: true };
      }
      case 'dnsTest': {
        if (!(await confirmAction(this.context, { title: 'Run a DNS test pod (busybox) in "default"', button: 'Run' }))) {
          return { changed: false };
        }
        const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Running a DNS lookup from inside the cluster…' }, () => dnsTest(this.session));
        return { changed: false, output: `${result.ok ? '✔ DNS works' : '✖ DNS lookup failed'}\n\n${result.output}` };
      }
      case 'openTable':
        this.services.actions.openTable(this.context, arg!);
        return { changed: false };
      case 'openDocs':
        await vscode.env.openExternal(vscode.Uri.parse(arg!));
        return { changed: false };
      default:
        return { changed: false };
    }
  }

  protected get panelKey(): string {
    return `doctor:${this.context}`;
  }

  protected get title(): string {
    return `Doctor · ${this.context}`;
  }

  protected get webviewName(): string {
    return 'doctor';
  }

  protected override onDispose(): void {
    DoctorPanel.panels.delete(this.context);
    super.onDispose();
  }
}

// ─────────────────────────── deploy ───────────────────────────

export class DeployPanel extends ContextPanel {
  private static readonly panels = new Map<string, DeployPanel>();

  static show(services: PanelServices, context: string): void {
    const existing = DeployPanel.panels.get(context);
    if (existing) {
      existing.reveal();
      return;
    }
    DeployPanel.panels.set(context, new DeployPanel(services, context));
  }

  private constructor(services: PanelServices, context: string) {
    super(services, context);
    this.initializePanel(vscode.ViewColumn.Active);
    this.panel.iconPath = iconPath(services);
    this.registerHandler('init', async (_m, respond) => {
      const session = this.session;
      await session.connect();
      const [namespaces, classes, issuers] = await Promise.all([
        session.namespaces().catch(() => [] as string[]),
        session.list(getKind('ingressclasses')!, '').then((r) => r.items).catch(() => [] as K8sObject[]),
        session.rest.get<{ items: K8sObject[] }>('/apis/cert-manager.io/v1/clusterissuers').then((r) => r.items).catch(() => [] as K8sObject[])
      ]);
      const defaultClass = classes.find((c) => c.metadata.annotations?.['ingressclass.kubernetes.io/is-default-class'] === 'true')?.metadata.name;
      respond({
        context: this.context,
        namespace: this.services.clusters.namespaceFilter(this.context) || session.defaultNamespace || 'default',
        namespaces,
        ingressClasses: classes.map((c) => c.metadata.name),
        defaultIngressClass: defaultClass,
        issuers: issuers.map((i) => i.metadata.name),
        metrics: !session.metricsStatus
      });
    });
    this.registerHandler('namespaceData', async (message, respond) => {
      const { namespace } = message.payload as { namespace: string };
      const [secrets, configMaps] = await Promise.all([
        this.session.list(getKind('secrets')!, namespace).then((r) => r.items).catch(() => [] as K8sObject[]),
        this.session.list(getKind('configmaps')!, namespace).then((r) => r.items).catch(() => [] as K8sObject[])
      ]);
      respond({
        secrets: secrets.filter((s) => s.type === 'Opaque').map((s) => s.metadata.name),
        pullSecrets: secrets.filter((s) => s.type === 'kubernetes.io/dockerconfigjson').map((s) => s.metadata.name),
        configMaps: configMaps.map((c) => c.metadata.name).filter((n) => n !== 'kube-root-ca.crt')
      });
    });
    this.registerHandler('preview', (message, respond) => {
      const form = message.payload as DeployForm;
      const errors = validateDeployForm(form);
      respond({ errors, yaml: errors.length ? '' : generateDeployment(form).map((o) => toYaml(o)).join('---\n') });
    });
    this.registerHandler('openEditor', async (message, respond) => {
      const form = message.payload as DeployForm;
      const doc = await vscode.workspace.openTextDocument({ language: 'yaml', content: generateDeployment(form).map((o) => toYaml(o)).join('---\n') });
      await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
      respond(true);
    });
    this.registerHandler('apply', async (message, respond) => {
      const form = message.payload as DeployForm;
      const errors = validateDeployForm(form);
      if (errors.length) {
        respond({ ok: false, error: errors.join(' ') });
        return;
      }
      const objects = generateDeployment(form);
      const ok = await confirmAction(this.context, { title: `Deploy ${form.image} as ${form.namespace}/${form.name}`, detail: objects.map((o) => `${o.kind} ${o.metadata.name}`).join('\n'), button: 'Deploy', always: true });
      if (!ok) {
        respond({ ok: false });
        return;
      }
      try {
        const session = this.session;
        const namespaces = await session.namespaces(true).catch(() => [] as string[]);
        if (namespaces.length && !namespaces.includes(form.namespace)) {
          await session.apply({ apiVersion: 'v1', kind: 'Namespace', metadata: { name: form.namespace } } as K8sObject);
        }
        for (const obj of objects) {
          await session.apply(obj, form.namespace);
        }
        this.services.actions.openDetails(this.context, { kindId: 'deployments', name: form.name, namespace: form.namespace });
        respond({ ok: true });
      } catch (err) {
        respond({ ok: false, error: errorMessage(err) });
      }
    });
  }

  protected get panelKey(): string {
    return `deploy:${this.context}`;
  }

  protected get title(): string {
    return `Deploy · ${this.context}`;
  }

  protected get webviewName(): string {
    return 'deploy';
  }

  protected override onDispose(): void {
    DeployPanel.panels.delete(this.context);
    super.onDispose();
  }
}

