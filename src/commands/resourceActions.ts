import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import type { ClusterManager, ClusterSession, K8sObject } from '../core/cluster';
import { getConfig } from '../core/config';
import { confirmAction } from '../core/guard';
import { decodeReleaseRaw, runHelm, storedChartUsable, writeStoredChart } from '../core/helmCli';
import { errorMessage } from '../core/kubeRest';
import { logger } from '../core/logger';
import { ActivePortForward, forwardUrl, PortForwardManager } from '../core/portForward';
import type { ActionId, ObjectRef } from '../core/protocol';
import { getKind, ResourceKind } from '../core/resources';
import { podSelectorOf } from '../core/status';
import {
  addDebugContainer,
  createNodeShellPod,
  downloadFromContainer,
  evictPods,
  NODE_SHELL_COMMAND,
  planDrain,
  rollbackTo,
  rolloutHistory,
  uploadToContainer
} from '../core/workloadOps';
import { cleanForEdit, resourceUri, toYaml } from '../fs/resourceFs';
import type { VirtualDocuments } from '../fs/virtualDocs';
import { LogSource, openLogTerminal } from '../terminals/logTerminal';
import { DEFAULT_SHELL, openAttachTerminal, openShellTerminal } from '../terminals/shellTerminal';

export interface Target {
  name: string;
  namespace?: string;
}

export interface LogsRequest {
  namespace: string;
  sources: LogSource[];
  previous: boolean;
  tailLines: number;
  title: string;
}

const MAX_LOG_STREAMS = 30;

/** Every action on cluster objects, shared by the tree, the tables and the details panel. */
export class ResourceActions {
  /** Set by the extension: opens the details panel. */
  openDetails: (context: string, ref: ObjectRef) => void = () => undefined;
  /** Set by the extension: opens a resource table. */
  openTable: (context: string, kindId: string) => void = () => undefined;
  /** Set by the extension: opens the log viewer panel. */
  openLogs: (context: string, request: LogsRequest) => void = () => undefined;
  /** Set by the extension: issues a kubeconfig for a service account. */
  serviceAccountKubeconfig: (context: string, namespace: string, name: string) => Promise<void> = async () => undefined;
  /** Set by the extension: remembers opened objects for the Recent list. */
  onOpened: (context: string, ref: ObjectRef) => void = () => undefined;

  constructor(
    private readonly clusters: ClusterManager,
    private readonly forwards: PortForwardManager,
    private readonly virtualDocs: VirtualDocuments
  ) {}

  /** Run an action; resolves to true when the cluster state was changed. */
  async run(action: ActionId, context: string, kindId: string, targets: Target[]): Promise<boolean> {
    if (targets.length === 0) {
      return false;
    }
    const session = this.clusters.session(context);
    const kind = await session.kind(kindId);
    const first = targets[0];
    const what = targets.length === 1 ? `${kind.kind} "${first.name}"` : `${targets.length} ${kind.title}`;
    try {
      switch (action) {
        case 'details':
          this.openDetails(context, { kindId, name: first.name, namespace: first.namespace });
          return false;
        case 'yaml':
          await this.openYaml(context, kind, first);
          return false;
        case 'delete':
          return await this.delete(session, kind, targets);
        case 'logs':
          await this.logs(session, kind, first);
          return false;
        case 'shell':
          await this.shell(session, first);
          return false;
        case 'forward':
          await this.forward(session, kind, first);
          return false;
        case 'scale':
          return await this.scale(session, kind, first);
        case 'restart':
          return await this.restart(session, kind, targets);
        case 'trigger':
          return await this.trigger(session, first);
        case 'suspend':
        case 'resume': {
          if (!(await confirmAction(context, { title: `${action === 'suspend' ? 'Suspend' : 'Resume'} ${what}`, button: actionTitle(action) }))) {
            return false;
          }
          await Promise.all(targets.map((t) => session.patch(kind, t.name, t.namespace, { spec: { suspend: action === 'suspend' } })));
          return true;
        }
        case 'cordon':
        case 'uncordon': {
          if (!(await confirmAction(context, { title: `${actionTitle(action)} ${what}`, button: actionTitle(action) }))) {
            return false;
          }
          await Promise.all(targets.map((t) => session.patch(kind, t.name, undefined, { spec: { unschedulable: action === 'cordon' } })));
          void vscode.window.showInformationMessage(`${targets.map((t) => t.name).join(', ')} ${action === 'cordon' ? 'cordoned' : 'uncordoned'}.`);
          return true;
        }
        case 'drain':
          return await this.drain(session, first.name);
        case 'nodeShell':
          await this.nodeShell(session, first.name);
          return false;
        case 'debug':
          await this.debug(session, first);
          return true;
        case 'helmUninstall':
          return await this.helmUninstall(context, first);
        case 'kubeconfig':
          await this.serviceAccountKubeconfig(context, first.namespace ?? 'default', first.name);
          return false;
      }
    } catch (err) {
      const message = errorMessage(err);
      logger.error(`${action} failed`, { context, kindId, targets, error: message });
      void vscode.window.showErrorMessage(`${actionTitle(action)} failed: ${message}`);
    }
    return false;
  }

  async openYaml(context: string, kind: ResourceKind, target: Target): Promise<void> {
    const uri = resourceUri({ context, kindId: kind.id, namespace: target.namespace, name: target.name });
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.languages.setTextDocumentLanguage(doc, 'yaml');
    await vscode.window.showTextDocument(doc, { preview: false });
  }

  private async delete(session: ClusterSession, kind: ResourceKind, targets: Target[]): Promise<boolean> {
    const names = targets.map((t) => (t.namespace ? `${t.namespace}/${t.name}` : t.name));
    const detail = names.length > 10 ? `${names.slice(0, 10).join('\n')}\n…and ${names.length - 10} more` : names.join('\n');
    const confirmed = await confirmAction(session.context, {
      title: `Delete ${names.length === 1 ? `${kind.kind} "${targets[0].name}"` : `${names.length} ${kind.title}`} in ${session.context}?`,
      detail,
      button: 'Delete',
      always: true
    });
    if (!confirmed) {
      return false;
    }
    const results = await Promise.allSettled(targets.map((t) => session.delete(kind, t.name, t.namespace)));
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failed.length) {
      void vscode.window.showErrorMessage(`Failed to delete ${failed.length} of ${targets.length}: ${errorMessage(failed[0].reason)}`);
    } else {
      void vscode.window.setStatusBarMessage(`Deleted ${names.join(', ')}`, 4000);
    }
    return true;
  }

  // ─────────────────────────── logs ───────────────────────────

  async logs(session: ClusterSession, kind: ResourceKind, target: Target, preset?: { container?: string; previous?: boolean }): Promise<void> {
    const namespace = target.namespace ?? '';
    let pods: K8sObject[];
    if (kind.id === 'pods') {
      pods = [await session.get(kind, target.name, namespace)];
    } else {
      const obj = await session.get(kind, target.name, namespace);
      const selector = podSelectorOf(obj, kind.id);
      if (!selector) {
        throw new Error(`${kind.kind} ${target.name} has no pod selector.`);
      }
      pods = (await session.list(getKind('pods')!, namespace, { labelSelector: selector })).items;
      if (pods.length === 0) {
        throw new Error(`${kind.kind} ${target.name} has no pods.`);
      }
      if (pods.length > 1) {
        const picked = await vscode.window.showQuickPick(
          [
            { label: `$(layers) All pods (${pods.length})`, pods },
            ...pods.map((p) => ({ label: p.metadata.name, description: p.status?.phase, pods: [p] }))
          ],
          { title: `Logs of ${kind.kind} ${target.name}`, placeHolder: 'Choose a pod' }
        );
        if (!picked) {
          return;
        }
        pods = picked.pods;
      }
    }

    let previous = preset?.previous ?? false;
    let sources: LogSource[];
    if (preset?.container) {
      sources = pods.map((p) => ({ pod: p.metadata.name, container: preset.container! }));
    } else {
      const containers: string[] = (pods[0].spec?.containers ?? []).map((c: any) => c.name);
      const initContainers: string[] = (pods[0].spec?.initContainers ?? []).map((c: any) => c.name);
      const restarted = new Set<string>((pods[0].status?.containerStatuses ?? []).filter((c: any) => c.restartCount > 0).map((c: any) => c.name));
      if (containers.length + initContainers.length === 1) {
        sources = pods.map((p) => ({ pod: p.metadata.name, container: containers[0] ?? initContainers[0] }));
      } else {
        type Item = vscode.QuickPickItem & { containers: string[]; previous?: boolean };
        const items: Item[] = [
          { label: `$(layers) All containers (${containers.length})`, containers },
          ...containers.map((c) => ({ label: c, containers: [c] })),
          ...initContainers.map((c) => ({ label: c, description: 'init container', containers: [c] })),
          ...[...restarted].map((c) => ({ label: `$(history) ${c}`, description: 'previous instance (before the last restart)', containers: [c], previous: true }))
        ];
        const picked = await vscode.window.showQuickPick(items, { title: 'Logs', placeHolder: 'Choose a container' });
        if (!picked) {
          return;
        }
        previous = !!picked.previous;
        sources = pods.flatMap((p) => picked.containers.map((container) => ({ pod: p.metadata.name, container })));
      }
    }
    if (sources.length > MAX_LOG_STREAMS) {
      void vscode.window.showWarningMessage(`Showing logs of the first ${MAX_LOG_STREAMS} of ${sources.length} containers.`);
      sources = sources.slice(0, MAX_LOG_STREAMS);
    }
    const config = getConfig();
    const title = pods.length === 1 && sources.length === 1 ? `${sources[0].pod}/${sources[0].container}` : target.name;
    if (config.logViewer === 'panel') {
      this.openLogs(session.context, { namespace, sources, previous, tailLines: config.logTailLines, title });
      return;
    }
    openLogTerminal(session, { namespace, sources, follow: !previous, previous, tailLines: config.logTailLines, timestamps: config.logTimestamps }, `logs: ${title}`);
  }

  // ─────────────────────────── shells ───────────────────────────

  async shell(session: ClusterSession, target: Target, container?: string): Promise<void> {
    const namespace = target.namespace ?? '';
    const pod = await session.get(getKind('pods')!, target.name, namespace);
    if (pod.status?.phase !== 'Running') {
      throw new Error(`Pod ${target.name} is ${pod.status?.phase ?? 'not running'}.`);
    }
    container = container ?? (await this.pickContainer(pod, `Shell into ${target.name}`, true));
    if (!container) {
      return;
    }
    const custom = getConfig().shell.trim();
    openShellTerminal(session, namespace, target.name, container, custom ? ['sh', '-c', custom] : DEFAULT_SHELL);
  }

  private async pickContainer(pod: K8sObject, title: string, runningOnly: boolean): Promise<string | undefined> {
    const running = new Set<string>(
      ([...(pod.status?.containerStatuses ?? []), ...(pod.status?.initContainerStatuses ?? [])] as any[]).filter((c) => c.state?.running).map((c) => c.name as string)
    );
    const names: string[] = [...(pod.spec?.containers ?? []), ...(pod.spec?.initContainers ?? [])]
      .map((c: any) => c.name as string)
      .filter((n: string) => !runningOnly || running.has(n));
    if (names.length === 0) {
      throw new Error(`Pod ${pod.metadata.name} has no running containers.`);
    }
    return names.length === 1 ? names[0] : vscode.window.showQuickPick(names, { title, placeHolder: 'Choose a container' });
  }

  /** Privileged pod on the node + nsenter into the host; the pod is deleted when the terminal closes. */
  private async nodeShell(session: ClusterSession, node: string): Promise<void> {
    const config = getConfig();
    const confirmed = await confirmAction(session.context, {
      title: `Open a root shell on node ${node}?`,
      detail: `Creates a privileged pod (${config.nodeShellImage}) in ${config.nodeShellNamespace} with host PID, network and IPC; it is deleted when the terminal closes.`,
      button: 'Open Shell',
      always: true
    });
    if (!confirmed) {
      return;
    }
    const podName = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Starting node shell on ${node}…` },
      () => createNodeShellPod(session, node, config.nodeShellImage, config.nodeShellNamespace)
    );
    openShellTerminal(session, config.nodeShellNamespace, podName, 'shell', NODE_SHELL_COMMAND, {
      name: `node: ${node}`,
      icon: 'server',
      banner: `Root shell on node ${node} (${session.context}) via pod ${config.nodeShellNamespace}/${podName}…`,
      cleanup: async () => {
        await session.delete(getKind('pods')!, podName, config.nodeShellNamespace);
        logger.info(`Deleted node shell pod ${config.nodeShellNamespace}/${podName}`);
      }
    });
  }

  /** `kubectl debug -it --target`: an ephemeral container sharing the target's process namespace. */
  async debug(session: ClusterSession, target: Target, container?: string): Promise<void> {
    const namespace = target.namespace ?? '';
    const pod = await session.get(getKind('pods')!, target.name, namespace);
    container = container ?? (await this.pickContainer(pod, `Debug ${target.name}: container to target`, true));
    if (!container) {
      return;
    }
    const image = await vscode.window.showQuickPick(
      [
        { label: getConfig().debugImage, description: 'default (openLens.debug.image)' },
        { label: 'nicolaka/netshoot', description: 'network tools: curl, dig, tcpdump, …' },
        { label: 'alpine:3.20', description: 'apk add what you need' },
        { label: '$(edit) Other image…' }
      ],
      { title: `Debug container for ${target.name}/${container}` }
    );
    if (!image) {
      return;
    }
    let imageName = image.label;
    if (imageName.startsWith('$(')) {
      imageName = (await vscode.window.showInputBox({ title: 'Debug container image', value: getConfig().debugImage })) ?? '';
      if (!imageName) {
        return;
      }
    }
    const confirmed = await confirmAction(session.context, {
      title: `Add debug container (${imageName}) to ${target.name}`,
      detail: 'Ephemeral containers cannot be removed; it stops when you exit its shell.',
      button: 'Add'
    });
    if (!confirmed) {
      return;
    }
    const name = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Starting debug container in ${target.name}…` },
      () => addDebugContainer(session, namespace, target.name, container, imageName)
    );
    openAttachTerminal(session, namespace, target.name, name);
  }

  // ─────────────────────────── files ───────────────────────────

  async downloadFile(session: ClusterSession, target: Target, container: string): Promise<void> {
    const remote = await vscode.window.showInputBox({
      title: `Download from ${target.name}/${container}`,
      prompt: 'Path of a file or folder in the container (needs tar in the image)',
      placeHolder: '/var/log/app.log'
    });
    if (!remote) {
      return;
    }
    const folder = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, openLabel: 'Download Here', defaultUri: vscode.Uri.file(path.join(os.homedir(), 'Downloads')) });
    if (!folder?.[0]) {
      return;
    }
    const local = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Downloading ${remote}…` }, () =>
      downloadFromContainer(session, target.namespace ?? '', target.name, container, remote, folder[0].fsPath)
    );
    const choice = await vscode.window.showInformationMessage(`Downloaded to ${local}`, 'Reveal');
    if (choice === 'Reveal') {
      await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(local));
    }
  }

  async uploadFile(session: ClusterSession, target: Target, container: string): Promise<void> {
    const picked = await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectFolders: true, canSelectMany: false, openLabel: 'Upload' });
    if (!picked?.[0]) {
      return;
    }
    const remoteDir = await vscode.window.showInputBox({ title: `Upload ${path.basename(picked[0].fsPath)} to ${target.name}/${container}`, prompt: 'Folder in the container (needs tar in the image)', value: '/tmp' });
    if (!remoteDir) {
      return;
    }
    if (!(await confirmAction(session.context, { title: `Upload ${path.basename(picked[0].fsPath)} to ${target.name}:${remoteDir}`, button: 'Upload' }))) {
      return;
    }
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Uploading ${path.basename(picked[0].fsPath)}…` }, () =>
      uploadToContainer(session, target.namespace ?? '', target.name, container, picked[0].fsPath, remoteDir)
    );
    void vscode.window.showInformationMessage(`Uploaded ${path.basename(picked[0].fsPath)} to ${target.name}:${remoteDir}`);
  }

  // ─────────────────────────── port forward ───────────────────────────

  async forward(session: ClusterSession, kind: ResourceKind, target: Target, remotePort?: number): Promise<ActivePortForward | undefined> {
    const namespace = target.namespace ?? '';
    const obj = await session.get(kind, target.name, namespace);
    const isService = kind.id === 'services';
    if (!isService && kind.id !== 'pods') {
      throw new Error('Port forwarding works with pods and services.');
    }

    if (remotePort === undefined) {
      type Item = vscode.QuickPickItem & { port?: number };
      const items: Item[] = isService
        ? (obj.spec?.ports ?? []).map((p: any) => ({
            label: `${p.port}/${p.protocol ?? 'TCP'}`,
            description: [p.name, `→ ${p.targetPort ?? p.port}`].filter(Boolean).join(' '),
            port: p.port
          }))
        : (obj.spec?.containers ?? []).flatMap((c: any) =>
            (c.ports ?? []).map((p: any) => ({
              label: `${p.containerPort}/${p.protocol ?? 'TCP'}`,
              description: [p.name, `container ${c.name}`].filter(Boolean).join(' · '),
              port: p.containerPort
            }))
          );
      items.push({ label: '$(edit) Other port…' });
      const picked = items.length === 2 ? items[0] : await vscode.window.showQuickPick(items, { title: `Forward a port of ${target.name}`, placeHolder: 'Remote port' });
      if (!picked) {
        return undefined;
      }
      remotePort = picked.port;
      if (remotePort === undefined) {
        const value = await vscode.window.showInputBox({ title: 'Remote port', validateInput: validatePort });
        if (!value) {
          return undefined;
        }
        remotePort = Number(value);
      }
    }

    const existing = this.forwards.find({ context: session.context, namespace, target: isService ? 'service' : 'pod', name: target.name, remotePort });
    if (existing) {
      await this.announceForward(existing, true);
      return existing;
    }

    const local = await vscode.window.showInputBox({
      title: `Local port for ${target.name}:${remotePort}`,
      value: String(remotePort >= 1024 ? remotePort : 0),
      prompt: '0 picks a free port',
      validateInput: (v) => (v === '0' ? undefined : validatePort(v))
    });
    if (local === undefined) {
      return undefined;
    }
    const forward = await this.forwards.start({
      context: session.context,
      namespace,
      target: isService ? 'service' : 'pod',
      name: target.name,
      remotePort,
      localPort: Number(local),
      address: getConfig().portForwardAddress
    });
    await this.announceForward(forward, false);
    return forward;
  }

  private async announceForward(forward: ActivePortForward, existing: boolean): Promise<void> {
    const url = forwardUrl(forward);
    if (!existing && getConfig().openPortForwardInBrowser) {
      await vscode.env.openExternal(vscode.Uri.parse(url));
      return;
    }
    const choice = await vscode.window.showInformationMessage(
      `${existing ? 'Already forwarding' : 'Forwarding'} ${url} → ${forward.target}/${forward.name}:${forward.remotePort}`,
      'Open in Browser',
      'Copy URL',
      'Stop'
    );
    if (choice === 'Open in Browser') {
      await vscode.env.openExternal(vscode.Uri.parse(url));
    } else if (choice === 'Copy URL') {
      await vscode.env.clipboard.writeText(url);
    } else if (choice === 'Stop') {
      this.forwards.stop(forward.id);
    }
  }

  // ─────────────────────────── workloads ───────────────────────────

  private async scale(session: ClusterSession, kind: ResourceKind, target: Target): Promise<boolean> {
    const obj = await session.get(kind, target.name, target.namespace);
    const value = await vscode.window.showInputBox({
      title: `Scale ${kind.kind} ${target.name}`,
      prompt: `Current replicas: ${obj.spec?.replicas ?? 1}`,
      value: String(obj.spec?.replicas ?? 1),
      validateInput: (v) => (/^\d+$/.test(v.trim()) ? undefined : 'Enter a non-negative number')
    });
    if (value === undefined) {
      return false;
    }
    const replicas = Number(value.trim());
    const confirmed = await confirmAction(session.context, {
      title: `Scale ${target.name} from ${obj.spec?.replicas ?? 1} to ${replicas} replicas${replicas === 0 ? '? All its pods will stop.' : ''}`,
      button: replicas === 0 ? 'Scale to 0' : 'Scale',
      always: replicas === 0
    });
    if (!confirmed) {
      return false;
    }
    await session.patch(kind, target.name, target.namespace, { spec: { replicas } });
    void vscode.window.setStatusBarMessage(`Scaled ${target.name} to ${replicas}`, 4000);
    return true;
  }

  /** `kubectl rollout restart`: bump an annotation on the pod template. */
  private async restart(session: ClusterSession, kind: ResourceKind, targets: Target[]): Promise<boolean> {
    const confirmed = await confirmAction(session.context, {
      title: `Restart ${targets.length === 1 ? `${kind.kind} "${targets[0].name}"` : `${targets.length} ${kind.title}`}? Pods are replaced with a rolling update.`,
      button: 'Restart',
      always: true
    });
    if (!confirmed) {
      return false;
    }
    const patch = { spec: { template: { metadata: { annotations: { 'kubectl.kubernetes.io/restartedAt': new Date().toISOString() } } } } };
    await Promise.all(targets.map((t) => session.patch(kind, t.name, t.namespace, patch, 'strategic')));
    void vscode.window.setStatusBarMessage(`Restarted ${targets.map((t) => t.name).join(', ')}`, 4000);
    return true;
  }

  /** `kubectl create job --from=cronjob/…` */
  private async trigger(session: ClusterSession, target: Target): Promise<boolean> {
    if (!(await confirmAction(session.context, { title: `Run CronJob ${target.name} now`, button: 'Run' }))) {
      return false;
    }
    const cronjob = await session.get(getKind('cronjobs')!, target.name, target.namespace);
    const suffix = Math.random().toString(36).slice(2, 7);
    const name = `${target.name.slice(0, 52 - suffix.length)}-manual-${suffix}`;
    const template = cronjob.spec?.jobTemplate ?? {};
    const job: K8sObject = {
      apiVersion: 'batch/v1',
      kind: 'Job',
      metadata: {
        name,
        namespace: target.namespace,
        labels: template.metadata?.labels,
        annotations: { ...(template.metadata?.annotations ?? {}), 'cronjob.kubernetes.io/instantiate': 'manual' },
        ownerReferences: [
          { apiVersion: 'batch/v1', kind: 'CronJob', name: cronjob.metadata.name, uid: cronjob.metadata.uid, controller: true, blockOwnerDeletion: true }
        ]
      },
      spec: template.spec
    };
    await session.create(getKind('jobs')!, job);
    const choice = await vscode.window.showInformationMessage(`Created Job ${name}.`, 'Open', 'Logs');
    if (choice === 'Open') {
      this.openDetails(session.context, { kindId: 'jobs', name, namespace: target.namespace });
    } else if (choice === 'Logs') {
      // Give the job controller a moment to create the pod.
      await new Promise((resolve) => setTimeout(resolve, 2000));
      await this.logs(session, getKind('jobs')!, { name, namespace: target.namespace });
    }
    return true;
  }

  private async drain(session: ClusterSession, node: string): Promise<boolean> {
    const plan = await planDrain(session, node);
    const lines = [
      `${plan.evict.length} pod(s) will be evicted (PodDisruptionBudgets are respected).`,
      plan.daemonSet.length ? `${plan.daemonSet.length} DaemonSet pod(s) stay.` : '',
      plan.mirror.length ? `${plan.mirror.length} static pod(s) stay.` : '',
      plan.emptyDir.length ? `${plan.emptyDir.length} pod(s) use emptyDir volumes; their data is lost.` : '',
      plan.unmanaged.length ? `${plan.unmanaged.length} pod(s) have no controller and will NOT be recreated: ${plan.unmanaged.map((p) => `${p.metadata.namespace}/${p.metadata.name}`).join(', ')}` : ''
    ].filter(Boolean);
    const confirmed = await confirmAction(session.context, { title: `Drain node ${node}?`, detail: lines.join('\n'), button: 'Drain', always: true });
    if (!confirmed) {
      return false;
    }
    await session.patch(getKind('nodes')!, node, undefined, { spec: { unschedulable: true } });
    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Draining ${node}`, cancellable: true },
      (progress, token) => evictPods(session, plan.evict, { report: (message) => progress.report({ message }), cancelled: () => token.isCancellationRequested })
    );
    if (result.failed.length) {
      logger.warn(`Drain of ${node} incomplete`, result.failed.join('\n'));
      void vscode.window.showWarningMessage(`Drained ${node} partially: ${result.failed.length} pod(s) were not evicted. The node stays cordoned.`, 'Show Output').then((c) => c && logger.show());
    } else {
      void vscode.window.showInformationMessage(`Drained ${node}: ${result.evicted} pod(s) evicted. The node stays cordoned until you uncordon it.`);
    }
    return true;
  }

  // ─────────────────────────── rollouts ───────────────────────────

  async rollback(context: string, kindId: string, target: Target, revision: number): Promise<boolean> {
    const session = this.clusters.session(context);
    const kind = getKind(kindId)!;
    const confirmed = await confirmAction(context, {
      title: `Roll ${kind.kind} ${target.name} back to revision ${revision}?`,
      detail: 'Pods are replaced with a rolling update.',
      button: 'Roll Back',
      always: true
    });
    if (!confirmed) {
      return false;
    }
    const obj = await session.get(kind, target.name, target.namespace);
    await rollbackTo(session, kind, obj, revision);
    void vscode.window.showInformationMessage(`${target.name} rolled back to revision ${revision}.`);
    return true;
  }

  async diffRevision(context: string, kindId: string, target: Target, revision: number): Promise<void> {
    const session = this.clusters.session(context);
    const obj = await session.get(getKind(kindId)!, target.name, target.namespace);
    const history = await rolloutHistory(session, kindId, obj);
    const left = history.find((r) => r.revision === revision);
    const right = history.find((r) => r.current) ?? history[0];
    if (!left || !right) {
      throw new Error('Revision not found.');
    }
    await this.virtualDocs.diff(
      { name: `${target.name}-rev${left.revision}.yaml`, text: toYaml(left.template) },
      { name: `${target.name}-rev${right.revision}.yaml`, text: toYaml(right.template) },
      `${target.name}: revision ${left.revision} ↔ ${right.revision}${right.current ? ' (current)' : ''}`
    );
  }

  // ─────────────────────────── helm ───────────────────────────

  private async releaseSecrets(context: string, target: Target): Promise<K8sObject[]> {
    const session = this.clusters.session(context);
    const list = await session.list(getKind('secrets')!, target.namespace ?? '', { labelSelector: `owner=helm,name=${target.name}` });
    return list.items.sort((a, b) => Number(b.metadata.labels?.version) - Number(a.metadata.labels?.version));
  }

  async helmDiff(context: string, target: Target, revision: number, what: 'values' | 'manifest'): Promise<void> {
    const secrets = await this.releaseSecrets(context, target);
    const latest = secrets[0];
    const old = secrets.find((s) => Number(s.metadata.labels?.version) === revision);
    if (!latest || !old) {
      throw new Error('Revision not found.');
    }
    const pick = (secret: K8sObject): string => {
      const release = decodeReleaseRaw(secret);
      return what === 'values' ? toYaml(release.config ?? {}) : release.manifest ?? '';
    };
    await this.virtualDocs.diff(
      { name: `${target.name}-r${revision}-${what}.yaml`, text: pick(old) },
      { name: `${target.name}-r${latest.metadata.labels?.version}-${what}.yaml`, text: pick(latest) },
      `${target.name} ${what}: revision ${revision} ↔ ${latest.metadata.labels?.version} (latest)`
    );
  }

  async helmRollback(context: string, target: Target, revision: number): Promise<boolean> {
    const confirmed = await confirmAction(context, { title: `Roll Helm release ${target.name} back to revision ${revision}?`, button: 'Roll Back', always: true });
    if (!confirmed) {
      return false;
    }
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `helm rollback ${target.name} ${revision}…` }, () =>
      runHelm(context, ['rollback', target.name, String(revision), '--namespace', target.namespace ?? 'default', '--wait', '--timeout', '5m'])
    );
    void vscode.window.showInformationMessage(`Helm release ${target.name} rolled back to revision ${revision}.`);
    return true;
  }

  /**
   * Edit the user-supplied values of a release in an editor, then run
   * `helm upgrade` with them (button in the editor title, see extension.ts).
   */
  async helmEditValues(context: string, target: Target): Promise<void> {
    const [latest] = await this.releaseSecrets(context, target);
    if (!latest) {
      throw new Error(`Release ${target.name} not found.`);
    }
    const release = decodeReleaseRaw(latest);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openlens-values-'));
    const file = path.join(dir, `${target.name}-values.yaml`);
    const header = [
      `# Values for Helm release ${target.name} (${target.namespace}) in ${context}, revision ${release.version}.`,
      `# Chart: ${release.chart?.metadata?.name}-${release.chart?.metadata?.version}`,
      '# Edit, then click "Helm Upgrade" in the editor title. These values replace the current user-supplied values.',
      ''
    ].join('\n');
    fs.writeFileSync(file, header + toYaml(release.config ?? {}), { mode: 0o600 });
    pendingHelmUpgrades.set(file, { context, name: target.name, namespace: target.namespace ?? 'default', secret: latest });
    await vscode.window.showTextDocument(vscode.Uri.file(file));
    void vscode.commands.executeCommand('setContext', 'openLens.helmValuesEditor', true);
  }

  async helmUpgradeFromEditor(): Promise<boolean> {
    const doc = vscode.window.activeTextEditor?.document;
    const pending = doc ? pendingHelmUpgrades.get(doc.uri.fsPath) : undefined;
    if (!doc || !pending) {
      throw new Error('Open the values of a Helm release with "Edit Values" first.');
    }
    if (doc.isDirty) {
      await doc.save();
    }
    const release = decodeReleaseRaw(pending.secret);
    const meta = release.chart?.metadata ?? {};
    type Item = vscode.QuickPickItem & { source: 'stored' | 'ref' };
    const items: Item[] = [];
    if (storedChartUsable(release)) {
      items.push({ source: 'stored', label: `$(package) Chart stored in the release (${meta.name}-${meta.version})`, detail: 'Same chart version, new values' });
    }
    items.push({ source: 'ref', label: '$(cloud-download) Chart from a repository or OCI registry…', detail: 'e.g. bitnami/nginx or oci://registry/charts/app — can upgrade the chart version too' });
    const choice = items.length === 1 ? items[0] : await vscode.window.showQuickPick(items, { title: `Upgrade ${pending.name}` });
    if (!choice) {
      return false;
    }
    let chartArgs: string[];
    let cleanupDir: string | undefined;
    if (choice.source === 'stored') {
      const chartDir = writeStoredChart(release);
      cleanupDir = path.dirname(chartDir);
      chartArgs = [chartDir];
    } else {
      const ref = await vscode.window.showInputBox({ title: 'Chart reference', value: meta.name, prompt: 'repo/chart, a local path or oci://…' });
      if (!ref) {
        return false;
      }
      const version = await vscode.window.showInputBox({ title: 'Chart version', value: meta.version, prompt: 'Leave empty for the latest version' });
      if (version === undefined) {
        return false;
      }
      chartArgs = [ref, ...(version ? ['--version', version] : [])];
    }
    const confirmed = await confirmAction(pending.context, { title: `helm upgrade ${pending.name} in ${pending.namespace}`, button: 'Upgrade', always: true });
    if (!confirmed) {
      return false;
    }
    try {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `helm upgrade ${pending.name}…` }, () =>
        runHelm(pending.context, ['upgrade', pending.name, ...chartArgs, '--namespace', pending.namespace, '--values', doc.uri.fsPath, '--wait', '--timeout', '5m'])
      );
    } finally {
      if (cleanupDir) {
        fs.rmSync(cleanupDir, { recursive: true, force: true });
      }
    }
    pendingHelmUpgrades.delete(doc.uri.fsPath);
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    fs.rmSync(path.dirname(doc.uri.fsPath), { recursive: true, force: true });
    void vscode.window.showInformationMessage(`Helm release ${pending.name} upgraded.`);
    return true;
  }

  private async helmUninstall(context: string, target: Target): Promise<boolean> {
    const confirmed = await confirmAction(context, {
      title: `Uninstall Helm release "${target.name}" from ${target.namespace} in ${context}?`,
      detail: 'Runs `helm uninstall`; the Helm CLI must be installed.',
      button: 'Uninstall',
      always: true
    });
    if (!confirmed) {
      return false;
    }
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `helm uninstall ${target.name}…` }, () =>
      runHelm(context, ['uninstall', target.name, '--namespace', target.namespace ?? 'default', '--wait'])
    );
    void vscode.window.showInformationMessage(`Helm release ${target.name} uninstalled.`);
    return true;
  }

  // ─────────────────────────── diff ───────────────────────────

  /** Diff the editor content of a resource with the live object. */
  async diffWithLive(context: string, kind: ResourceKind, target: Target, edited: string): Promise<void> {
    const live = cleanForEdit(await this.clusters.session(context).get(kind, target.name, target.namespace));
    await this.virtualDocs.diff({ name: `${target.name}.live.yaml`, text: toYaml(live) }, { name: `${target.name}.yaml`, text: edited }, `${target.name}: live ↔ editor`);
  }
}

interface PendingHelmUpgrade {
  context: string;
  name: string;
  namespace: string;
  secret: K8sObject;
}

export const pendingHelmUpgrades = new Map<string, PendingHelmUpgrade>();

export function actionTitle(action: ActionId): string {
  return (
    {
      details: 'Details',
      yaml: 'Edit YAML',
      delete: 'Delete',
      logs: 'Logs',
      shell: 'Shell',
      forward: 'Port Forward',
      scale: 'Scale',
      restart: 'Restart',
      trigger: 'Trigger',
      suspend: 'Suspend',
      resume: 'Resume',
      cordon: 'Cordon',
      uncordon: 'Uncordon',
      drain: 'Drain',
      nodeShell: 'Node Shell',
      debug: 'Debug',
      kubeconfig: 'Kubeconfig',
      helmUninstall: 'Uninstall'
    } as Record<ActionId, string>
  )[action];
}

function validatePort(value: string): string | undefined {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 && n < 65536 ? undefined : 'Enter a port between 1 and 65535';
}
