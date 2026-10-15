/* Wizards that create or connect clusters and import their kubeconfig. */
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { importFrom, KubeconfigCommandDeps } from '../commands/kubeconfigCommands';
import { getConfig } from '../core/config';
import { readKubeconfigFile, writeKubeconfigFile } from '../core/kubeconfigFiles';
import { removeContext } from '../core/kubeconfigModel';
import { errorMessage } from '../core/kubeRest';
import { CloudCluster, credentialArgs, listArgs, parseClusters, Provider, PROVIDERS, suggestedContext } from './cloud';
import { agentScript, CLEANUP_COPIES, FETCH_KUBECONFIG, FETCH_TOKEN, hostOf, interactiveRemote, K3sServerOptions, rewriteK3sKubeconfig, serverScript, sshArgs } from './k3s';
import {
  contextFor,
  Engine,
  engineQuickPickItems,
  k3dCreateArgs,
  kindConfig,
  LocalCluster,
  LocalClusterOptions,
  minikubeStartArgs,
  parseK3dClusters,
  parseKindClusters,
  parseMinikubeProfiles,
  tempKubeconfig,
  validateClusterName
} from './localClusters';
import { findTool, requireTool, runInTerminal, runTool } from './tools';

export interface WizardDeps extends KubeconfigCommandDeps {
  openAddons: (context: string) => void;
}

async function importFile(deps: WizardDeps, file: string, label: string, suggestedName: string): Promise<string[]> {
  const text = fs.readFileSync(file, 'utf8');
  try {
    return await importFrom({ text, baseDir: path.dirname(file), label, suggestedName }, deps);
  } finally {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
}

async function offerNextSteps(deps: WizardDeps, contexts: string[], what: string): Promise<void> {
  if (contexts.length !== 1) {
    return;
  }
  const choice = await vscode.window.showInformationMessage(`${what} is ready as context "${contexts[0]}".`, 'Install Add-ons…', 'Open Overview');
  if (choice === 'Install Add-ons…') {
    deps.openAddons(contexts[0]);
  } else if (choice === 'Open Overview') {
    deps.openDashboard(contexts[0]);
  }
}

// ─────────────────────────── add cluster ───────────────────────────

export async function addCluster(deps: WizardDeps): Promise<void> {
  const picked = await vscode.window.showQuickPick(
    [
      { id: 'import', label: '$(cloud-download) Import a Kubeconfig', detail: 'From a file, the clipboard or pasted text' },
      { id: 'local', label: '$(vm) Create a Local Cluster', detail: 'kind, k3d or minikube on this machine' },
      { id: 'cloud', label: '$(cloud) Connect a Managed Cluster', detail: 'Yandex Cloud, AWS EKS, Google GKE or Azure AKS' },
      { id: 'k3s', label: '$(server) Install k3s on Your Servers', detail: 'Over SSH, with optional worker nodes' },
      { id: 'folder', label: '$(folder-library) Sync a Kubeconfig Folder', detail: 'Load every kubeconfig file in a folder' }
    ],
    { title: 'Add a Kubernetes cluster' }
  );
  switch (picked?.id) {
    case 'import':
      await vscode.commands.executeCommand('openLens.importKubeconfig');
      break;
    case 'local':
      await createLocalCluster(deps);
      break;
    case 'cloud':
      await connectCloudCluster(deps);
      break;
    case 'k3s':
      await installK3s(deps);
      break;
    case 'folder':
      await vscode.commands.executeCommand('openLens.addKubeconfigFolder');
      break;
  }
}

// ─────────────────────────── local clusters ───────────────────────────

async function ensureDocker(): Promise<void> {
  const docker = await requireTool('docker');
  try {
    await runTool(docker, ['info', '--format', '{{.ServerVersion}}']);
  } catch {
    const choice = await vscode.window.showErrorMessage('Docker is not running. Start Docker Desktop (or your Docker engine) and try again.', ...(process.platform === 'darwin' ? ['Start Docker Desktop'] : []));
    if (choice) {
      await runTool('/usr/bin/open', ['-a', 'Docker']).catch(() => undefined);
    }
    throw new Error('Docker is not running.');
  }
}

export async function createLocalCluster(deps: WizardDeps): Promise<void> {
  const installed = { kind: !!findTool('kind'), k3d: !!findTool('k3d'), minikube: !!findTool('minikube') };
  const engineItem = await vscode.window.showQuickPick(engineQuickPickItems(installed), { title: 'Create a local cluster (1/4): engine' });
  if (!engineItem) {
    return;
  }
  const engine = engineItem.engine;
  const tool = await requireTool(engine);

  const existing = new Set(deps.clusters.contexts().map((c) => c.name));
  const name = await vscode.window.showInputBox({
    title: 'Create a local cluster (2/4): name',
    value: 'dev',
    validateInput: (v) => validateClusterName(v.trim()) ?? (existing.has(contextFor(engine, v.trim())) ? `Context ${contextFor(engine, v.trim())} already exists` : undefined)
  });
  if (!name) {
    return;
  }
  const shape = await vscode.window.showQuickPick(
    [
      { label: 'Single node', workers: 0, description: 'fastest, enough for most development' },
      { label: '1 control plane + 2 workers', workers: 2, description: 'to try scheduling, drains and DaemonSets' },
      { label: '1 control plane + 3 workers', workers: 3 }
    ],
    { title: 'Create a local cluster (3/4): nodes' }
  );
  if (!shape) {
    return;
  }
  const version = await vscode.window.showInputBox({
    title: 'Create a local cluster (4/4): Kubernetes version',
    prompt: 'Leave empty for the default of the tool, or enter e.g. v1.31.0',
    validateInput: (v) => (!v.trim() || /^v?\d+\.\d+\.\d+/.test(v.trim()) ? undefined : 'Enter a version like v1.31.0')
  });
  if (version === undefined) {
    return;
  }
  const ingress = await vscode.window.showQuickPick(
    [
      { label: 'Map ports 80 and 443 to localhost', value: true, detail: 'So an ingress controller is reachable at http://localhost' },
      { label: 'No port mappings', value: false }
    ],
    { title: 'Ingress' }
  );
  if (!ingress) {
    return;
  }

  const options: LocalClusterOptions = { engine, name: name.trim(), workers: shape.workers, version: version.trim(), ingressPorts: ingress.value };
  if (engine !== 'minikube') {
    await ensureDocker();
  }
  const kubeconfig = tempKubeconfig();
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Creating ${engine} cluster "${options.name}"`, cancellable: true },
    async (progress, token) => {
      const onLine = (line: string): void => progress.report({ message: line.replace(/\x1b\[[0-9;]*m/g, '').slice(0, 100) });
      if (engine === 'kind') {
        const config = path.join(path.dirname(kubeconfig), 'kind.yaml');
        fs.writeFileSync(config, kindConfig(options));
        await runTool(tool, ['create', 'cluster', '--name', options.name, '--config', config, '--kubeconfig', kubeconfig, '--wait', '120s'], { onLine, cancellation: token });
      } else if (engine === 'k3d') {
        await runTool(tool, k3dCreateArgs(options), { onLine, cancellation: token });
        fs.writeFileSync(kubeconfig, await runTool(tool, ['kubeconfig', 'get', options.name]), { mode: 0o600 });
      } else {
        await runTool(tool, minikubeStartArgs(options), { onLine, cancellation: token, env: { KUBECONFIG: kubeconfig } });
      }
    }
  );
  const imported = await importFile(deps, kubeconfig, `the new ${engine} cluster`, contextFor(engine, options.name));
  await offerNextSteps(deps, imported, `Cluster "${options.name}"`);
}

export async function listLocalClusters(): Promise<LocalCluster[]> {
  const result: LocalCluster[] = [];
  const kind = findTool('kind');
  const k3d = findTool('k3d');
  const minikube = findTool('minikube');
  await Promise.all([
    kind && runTool(kind, ['get', 'clusters']).then((out) => result.push(...parseKindClusters(out)), () => undefined),
    k3d && runTool(k3d, ['cluster', 'list', '-o', 'json']).then((out) => result.push(...parseK3dClusters(out)), () => undefined),
    minikube && runTool(minikube, ['profile', 'list', '-o', 'json']).then((out) => result.push(...parseMinikubeProfiles(out)), () => undefined)
  ]);
  return result;
}

export async function deleteLocalCluster(deps: WizardDeps): Promise<void> {
  const clusters = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'Looking for local clusters…' }, () => listLocalClusters());
  if (!clusters.length) {
    void vscode.window.showInformationMessage('No kind, k3d or minikube clusters were found.');
    return;
  }
  const picked = await vscode.window.showQuickPick(
    clusters.map((c) => ({ label: c.name, description: `${c.engine}${c.status ? ` · ${c.status}` : ''}`, detail: `context ${c.context}`, cluster: c })),
    { title: 'Delete a local cluster' }
  );
  if (!picked) {
    return;
  }
  const c = picked.cluster;
  const choice = await vscode.window.showWarningMessage(`Delete ${c.engine} cluster "${c.name}" and everything in it?`, { modal: true, detail: `Its context "${c.context}" is removed from the kubeconfig too.` }, 'Delete');
  if (choice !== 'Delete') {
    return;
  }
  const tool = await requireTool(c.engine);
  const args: Record<Engine, string[]> = {
    kind: ['delete', 'cluster', '--name', c.name, '--kubeconfig', tempKubeconfig()],
    k3d: ['cluster', 'delete', c.name],
    minikube: ['delete', '--profile', c.name]
  };
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Deleting ${c.engine} cluster "${c.name}"…` }, () =>
    runTool(tool, args[c.engine], { env: c.engine === 'minikube' ? { KUBECONFIG: tempKubeconfig() } : undefined })
  );
  const file = deps.clusters.kubeconfig.contextOrigin.get(c.context);
  if (file) {
    writeKubeconfigFile(file, removeContext(readKubeconfigFile(file), c.context), { backup: getConfig().backupKubeconfig });
    deps.forwards.stopAll(c.context);
    deps.clusters.reload();
  }
  void vscode.window.showInformationMessage(`Deleted ${c.engine} cluster "${c.name}".`);
}

// ─────────────────────────── k3s over ssh ───────────────────────────

export async function installK3s(deps: WizardDeps): Promise<void> {
  const ssh = await requireTool('ssh');
  const target = await vscode.window.showInputBox({
    title: 'Install k3s (1/5): server',
    prompt: 'SSH destination of the server node: host, user@host or an alias from ~/.ssh/config. Key-based login and sudo are needed.',
    placeHolder: 'ubuntu@203.0.113.10',
    ignoreFocusOut: true,
    validateInput: (v) => (/^[\w.@:-]+$/.test(v.trim()) ? undefined : 'Enter an ssh destination')
  });
  if (!target) {
    return;
  }
  const portText = await vscode.window.showInputBox({ title: 'Install k3s (2/5): SSH port', value: '22', validateInput: (v) => (/^\d+$/.test(v) ? undefined : 'Enter a port') });
  if (!portText) {
    return;
  }
  const port = Number(portText) === 22 ? undefined : Number(portText);
  const address = await vscode.window.showInputBox({
    title: 'Install k3s (3/5): API address',
    prompt: 'Address you will reach the API server at (public IP or DNS name). It goes into the certificate and the kubeconfig.',
    value: hostOf(target.trim()),
    ignoreFocusOut: true
  });
  if (!address) {
    return;
  }
  const agentsText = await vscode.window.showInputBox({
    title: 'Install k3s (4/5): worker nodes',
    prompt: 'Optional: SSH destinations of worker nodes, separated by spaces or commas',
    placeHolder: 'ubuntu@10.0.0.11 ubuntu@10.0.0.12',
    ignoreFocusOut: true
  });
  if (agentsText === undefined) {
    return;
  }
  const flavour = await vscode.window.showQuickPick(
    [
      { label: 'Stable channel, with Traefik ingress', channel: 'stable', traefik: true },
      { label: 'Stable channel, without Traefik', channel: 'stable', traefik: false, detail: 'If you will install ingress-nginx' },
      { label: 'Latest channel, with Traefik', channel: 'latest', traefik: true },
      { label: 'Specific version…', channel: '', traefik: true }
    ],
    { title: 'Install k3s (5/5): version' }
  );
  if (!flavour) {
    return;
  }
  let channel = flavour.channel;
  if (!channel) {
    channel = (await vscode.window.showInputBox({ title: 'k3s version', placeHolder: 'v1.31.4+k3s1' })) ?? '';
    if (!channel) {
      return;
    }
  }
  const name = await vscode.window.showInputBox({ title: 'Context name', value: `k3s-${hostOf(target.trim()).replace(/[^a-z0-9-]/gi, '-')}`.toLowerCase() });
  if (!name) {
    return;
  }
  const options: K3sServerOptions = { target: target.trim(), port, address: address.trim(), channel, disableTraefik: !flavour.traefik, clusterName: name };
  const agents = agentsText.split(/[\s,]+/).filter(Boolean);

  // Interactive terminal: the host key prompt and sudo password, if any, go there.
  const ok = await runInTerminal(`k3s: ${options.target}`, '', { shellPath: ssh, shellArgs: [...sshArgs(options.target, port, true), interactiveRemote(serverScript(options))] });
  if (!ok) {
    void vscode.window.showErrorMessage('The k3s installation did not finish successfully; see the terminal output.');
    return;
  }
  const rawKubeconfig = await runTool(ssh, [...sshArgs(options.target, port, false), FETCH_KUBECONFIG]);
  const token = (await runTool(ssh, [...sshArgs(options.target, port, false), FETCH_TOKEN])).trim();

  for (const agent of agents) {
    const joined = await runInTerminal(`k3s agent: ${agent}`, '', { shellPath: ssh, shellArgs: [...sshArgs(agent, port, true), interactiveRemote(agentScript(`https://${options.address}:6443`, token, channel))] });
    if (!joined) {
      void vscode.window.showWarningMessage(`Worker ${agent} did not join; you can retry later with the same wizard.`);
    }
  }
  await runTool(ssh, [...sshArgs(options.target, port, false), CLEANUP_COPIES]).catch(() => undefined);

  const file = tempKubeconfig();
  fs.writeFileSync(file, rewriteK3sKubeconfig(rawKubeconfig, options.address, name), { mode: 0o600 });
  const imported = await importFile(deps, file, `k3s on ${options.target}`, name);
  await offerNextSteps(deps, imported, `k3s on ${options.target}`);
}

// ─────────────────────────── managed clusters ───────────────────────────

export async function connectCloudCluster(deps: WizardDeps): Promise<void> {
  const providerItem = await vscode.window.showQuickPick(
    (Object.keys(PROVIDERS) as Provider[]).map((p) => ({
      provider: p,
      label: PROVIDERS[p].title,
      description: findTool(PROVIDERS[p].tool) ? `${PROVIDERS[p].tool} found` : `${PROVIDERS[p].tool} not installed`,
      detail: PROVIDERS[p].detail
    })),
    { title: 'Connect a managed cluster: provider' }
  );
  if (!providerItem) {
    return;
  }
  const provider = providerItem.provider;
  const tool = await requireTool(PROVIDERS[provider].tool);

  let scope: string | undefined;
  if (provider === 'aws') {
    const configured = (await runTool(tool, ['configure', 'get', 'region']).catch(() => '')).trim();
    scope = await vscode.window.showInputBox({ title: 'AWS region', value: configured || 'eu-central-1' });
    if (!scope) {
      return;
    }
  }

  let clusters: CloudCluster[];
  try {
    clusters = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Listing ${PROVIDERS[provider].title} clusters…` }, async () =>
      parseClusters(provider, await runTool(tool, listArgs(provider, scope)), scope)
    );
  } catch (err) {
    const hint = { yc: 'Run "yc init" to sign in.', aws: 'Run "aws configure" or "aws sso login".', gcloud: 'Run "gcloud auth login".', az: 'Run "az login".' }[provider];
    throw new Error(`${errorMessage(err)} ${hint}`);
  }
  if (provider === 'yc' && clusters.length === 0) {
    const folders = JSON.parse(await runTool(tool, ['resource-manager', 'folder', 'list', '--format', 'json']).catch(() => '[]')) as Array<{ id: string; name: string }>;
    const folder = folders.length ? await vscode.window.showQuickPick(folders.map((f) => ({ label: f.name, description: f.id, id: f.id })), { title: 'No clusters in the default folder — choose a folder' }) : undefined;
    if (folder) {
      clusters = parseClusters(provider, await runTool(tool, listArgs(provider, folder.id)), folder.id);
    }
  }
  if (!clusters.length) {
    void vscode.window.showInformationMessage(`No ${PROVIDERS[provider].title} clusters found for the current account${scope ? ` in ${scope}` : ''}.`);
    return;
  }
  const picked = await vscode.window.showQuickPick(
    clusters.map((c) => ({ label: c.name, description: [c.status, c.location].filter(Boolean).join(' · '), detail: c.id !== c.name ? c.id : undefined, cluster: c })),
    { title: `Connect ${PROVIDERS[provider].title}`, canPickMany: false }
  );
  if (!picked) {
    return;
  }
  let internal = false;
  if (provider === 'yc') {
    const endpoint = await vscode.window.showQuickPick(
      [
        { label: 'Public endpoint', internal: false, detail: 'From anywhere (the cluster must have a public address)' },
        { label: 'Internal endpoint', internal: true, detail: 'From inside the cloud network or over VPN' }
      ],
      { title: 'API endpoint' }
    );
    if (!endpoint) {
      return;
    }
    internal = endpoint.internal;
  }
  const file = tempKubeconfig();
  const { args, env } = credentialArgs(picked.cluster, file, { internal });
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Fetching credentials for ${picked.cluster.name}…` }, () => runTool(tool, args, { env }));
  const imported = await importFile(deps, file, `${PROVIDERS[provider].title} cluster ${picked.cluster.name}`, suggestedContext(picked.cluster));
  await offerNextSteps(deps, imported, `Cluster "${picked.cluster.name}"`);
}

