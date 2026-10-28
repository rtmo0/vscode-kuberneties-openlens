import * as path from 'path';
import * as yaml from 'js-yaml';
import * as vscode from 'vscode';

import { registerKubeconfigCommands } from './commands/kubeconfigCommands';
import { pendingHelmUpgrades, ResourceActions } from './commands/resourceActions';
import { goToResource } from './commands/search';
import { newResource } from './commands/templates';
import { ClusterManager, K8sObject } from './core/cluster';
import { onConfigChanged } from './core/config';
import { confirmAction, isProtectedContext, toggleProtection } from './core/guard';
import { allKubeconfigFiles, kubeconfigFolders } from './core/kubeconfig';
import { errorMessage, isNotFound } from './core/kubeRest';
import { logger } from './core/logger';
import { forwardUrl, PortForwardManager } from './core/portForward';
import { forgetPrometheus } from './core/prometheus';
import { ClusterExplorerProvider, PortForwardNode, PortForwardsProvider } from './explorer/clusterExplorer';
import { FavoritesProvider, RefNode } from './explorer/favorites';
import { cleanForEdit, parseResourceUri, RESOURCE_SCHEME, ResourceFileSystem, toYaml } from './fs/resourceFs';
import { VIRTUAL_SCHEME, VirtualDocuments } from './fs/virtualDocs';
import { registerLanguageModelTools } from './lm/tools';
import { addCluster, connectCloudCluster, createLocalCluster, deleteLocalCluster, installK3s, WizardDeps } from './setup/clusterWizards';
import { HELM_INSTALL_CONTEXT, installChart, installFromEditor, manageRepositories, pendingInstalls } from './setup/helmInstall';
import { convertCompose, newDataFromFiles, newRegistrySecret, newTlsSecret, onboardTeam, serviceAccountAccess, WorkloadWizardDeps } from './setup/workloadWizards';
import { BaseWebviewPanel } from './webviews/baseWebview';
import { AddonsPanel, DeployPanel, DoctorPanel } from './webviews/setupPanels';
import { ManifestSchemas } from './yaml/schemas';
import { DashboardPanel, DetailsPanel, LogsPanel, PanelServices, ResourceTablePanel, TopologyPanel } from './webviews/panels';

interface ContextArg {
  contextName?: string;
}

export function activate(context: vscode.ExtensionContext): void {
  logger.info('Activating Kubernetes OpenLens extension');

  const clusters = new ClusterManager(context.globalState);
  const forwards = new PortForwardManager(clusters);
  const virtualDocs = new VirtualDocuments();
  const favorites = new FavoritesProvider(context.globalState);
  const actions = new ResourceActions(clusters, forwards, virtualDocs);
  const services: PanelServices = { extensionUri: context.extensionUri, clusters, actions, favorites };
  actions.openDetails = (ctx, ref) => DetailsPanel.show(services, ctx, ref);
  actions.openTable = (ctx, kindId) => ResourceTablePanel.show(services, ctx, kindId);
  actions.openLogs = (ctx, request) => LogsPanel.show(services, ctx, request);
  actions.onOpened = (ctx, ref) => favorites.recordOpened(ctx, ref);

  const explorer = new ClusterExplorerProvider(clusters);
  const forwardsView = new PortForwardsProvider(forwards);

  context.subscriptions.push(
    clusters,
    forwards,
    explorer,
    forwardsView,
    favorites,
    vscode.window.registerTreeDataProvider('openLens.clusters', explorer),
    vscode.window.registerTreeDataProvider('openLens.favorites', favorites),
    vscode.window.registerTreeDataProvider('openLens.portForwards', forwardsView),
    vscode.workspace.registerFileSystemProvider(RESOURCE_SCHEME, new ResourceFileSystem(clusters), { isCaseSensitive: true }),
    vscode.workspace.registerTextDocumentContentProvider(VIRTUAL_SCHEME, virtualDocs),
    clusters.onDidChange(() => favorites.prune(new Set(clusters.contexts().map((c) => c.name))))
  );

  registerLanguageModelTools(context, clusters);

  const pickContext = async (arg: ContextArg | undefined, title: string): Promise<string | undefined> => {
    if (arg?.contextName) {
      return arg.contextName;
    }
    const picked = await vscode.window.showQuickPick(
      clusters
        .contexts()
        .sort((a, b) => Number(b.current) - Number(a.current))
        .map((c) => ({ label: c.name, description: [c.current ? 'current' : c.server, isProtectedContext(c.name) ? '🔒 protected' : ''].filter(Boolean).join(' · ') })),
      { title }
    );
    return picked?.label;
  };
  /** The context to act on: the argument, else the current context, else ask. */
  const contextOrCurrent = async (arg: ContextArg | undefined, title: string): Promise<string | undefined> =>
    arg?.contextName ?? (clusters.currentContext && clusters.hasContext(clusters.currentContext) ? clusters.currentContext : pickContext(undefined, title));

  const command = (id: string, handler: (...args: any[]) => unknown): void => {
    context.subscriptions.push(
      vscode.commands.registerCommand(id, async (...args: any[]) => {
        try {
          await handler(...args);
        } catch (err) {
          logger.error(`${id} failed`, errorMessage(err));
          void vscode.window.showErrorMessage(errorMessage(err));
        }
      })
    );
  };

  const kubeconfigDeps = {
    clusters,
    forwards,
    virtualDocs,
    openDashboard: (ctx: string) => DashboardPanel.show(services, ctx)
  };
  registerKubeconfigCommands(context, kubeconfigDeps);
  const wizardDeps: WizardDeps & WorkloadWizardDeps = {
    ...kubeconfigDeps,
    openAddons: (ctx) => AddonsPanel.show(services, ctx),
    openDetails: (ctx, ref) => DetailsPanel.show(services, ctx, ref)
  };
  actions.serviceAccountKubeconfig = (ctx, ns, name) => serviceAccountAccess(clusters.session(ctx), ns, name, kubeconfigDeps);

  const schemas = new ManifestSchemas(context, clusters);
  context.subscriptions.push(schemas);
  void schemas.activate().catch((err) => logger.warn('YAML schema registration failed', errorMessage(err)));

  command('openLens.refreshClusters', () => clusters.reload());
  command('openLens.showLogs', () => logger.show());
  command('openLens.connect', async (arg?: ContextArg) => {
    const name = await pickContext(arg, 'Connect to a cluster');
    if (name) {
      await clusters.session(name).reconnect();
    }
  });
  command('openLens.disconnect', async (arg?: ContextArg) => {
    const name = await pickContext(arg, 'Disconnect from a cluster');
    if (name) {
      const session = clusters.peekSession(name);
      if (session) {
        forgetPrometheus(session);
      }
      BaseWebviewPanel.closeForContext(name);
      forwards.stopAll(name);
      clusters.disconnect(name);
    }
  });
  command('openLens.reconnect', async (arg?: ContextArg) => {
    const name = await pickContext(arg, 'Reconnect to a cluster');
    if (name) {
      explorer.refresh();
      const session = clusters.session(name);
      forgetPrometheus(session);
      await session.reconnect();
    }
  });
  command('openLens.openDashboard', async (arg?: ContextArg) => {
    const name = await pickContext(arg, 'Open the overview of a cluster');
    if (name) {
      DashboardPanel.show(services, name);
    }
  });
  command('openLens.openTable', (arg: { contextName: string; kindId: string }) => {
    ResourceTablePanel.show(services, arg.contextName, arg.kindId);
  });
  command('openLens.openResource', (arg: { contextName: string; ref: { kindId: string; name: string; namespace?: string } }) => {
    DetailsPanel.show(services, arg.contextName, { kindId: arg.ref.kindId, name: arg.ref.name, namespace: arg.ref.namespace });
  });
  command('openLens.selectNamespace', async (arg?: ContextArg) => {
    const name = await pickContext(arg, 'Filter a cluster by namespace');
    if (!name) {
      return;
    }
    const session = clusters.session(name);
    await session.connect();
    const current = clusters.namespaceFilter(name);
    const namespaces = await session.namespaces(true);
    const picked = await vscode.window.showQuickPick(
      [
        { label: '$(globe) All namespaces', value: '', description: current === '' ? 'selected' : undefined },
        ...namespaces.map((ns) => ({ label: ns, value: ns, description: ns === current ? 'selected' : undefined }))
      ],
      { title: `Namespace filter for ${name}`, placeHolder: 'Applies to the overview and resource tables of this cluster' }
    );
    if (picked) {
      await clusters.setNamespaceFilter(name, picked.value);
    }
  });
  command('openLens.toggleProtection', async (arg?: ContextArg) => {
    const name = await pickContext(arg, 'Mark or unmark a context as protected (production)');
    if (!name) {
      return;
    }
    const nowProtected = await toggleProtection(name);
    explorer.refresh();
    void vscode.window.showInformationMessage(
      nowProtected ? `"${name}" is protected: changes to it need the context name typed to confirm.` : `"${name}" is no longer protected.`
    );
  });

  // ─────────────────────────── setup ───────────────────────────

  command('openLens.addCluster', () => addCluster(wizardDeps));
  command('openLens.createLocalCluster', () => createLocalCluster(wizardDeps));
  command('openLens.deleteLocalCluster', () => deleteLocalCluster(wizardDeps));
  command('openLens.installK3s', () => installK3s(wizardDeps));
  command('openLens.connectCloudCluster', () => connectCloudCluster(wizardDeps));
  command('openLens.openAddons', async (arg?: ContextArg) => {
    const name = await contextOrCurrent(arg, 'Add-ons for…');
    if (name) {
      AddonsPanel.show(services, name);
    }
  });
  command('openLens.runDoctor', async (arg?: ContextArg) => {
    const name = await contextOrCurrent(arg, 'Check the health of…');
    if (name) {
      DoctorPanel.show(services, name);
    }
  });
  command('openLens.installChart', async (arg?: ContextArg) => {
    const name = await contextOrCurrent(arg, 'Install a Helm chart into…');
    if (name) {
      await installChart(clusters, name);
    }
  });
  command('openLens.helmInstallFromEditor', async () => {
    const doc = vscode.window.activeTextEditor?.document;
    const pending = doc ? pendingInstalls.get(doc.uri.fsPath) : undefined;
    const release = await installFromEditor(clusters);
    if (release && pending?.type === 'chart') {
      DetailsPanel.show(services, pending.context, { kindId: 'helmreleases', name: release, namespace: pending.namespace });
    }
  });
  command('openLens.manageHelmRepos', () => manageRepositories());
  command('openLens.onboardTeam', async (arg?: ContextArg) => {
    const name = await contextOrCurrent(arg, 'Onboard a team in…');
    if (name) {
      await onboardTeam(clusters.session(name), wizardDeps);
    }
  });
  const secretCommand = (id: string, run: (ctx: string, ns: string) => Promise<void>): void =>
    command(id, async (arg?: ContextArg) => {
      const name = await contextOrCurrent(arg, 'Create it in…');
      if (name) {
        await clusters.session(name).connect();
        await run(name, clusters.namespaceFilter(name) || clusters.session(name).defaultNamespace || 'default');
      }
    });
  secretCommand('openLens.newRegistrySecret', (ctx, ns) => newRegistrySecret(clusters.session(ctx), ns));
  secretCommand('openLens.newTlsSecret', (ctx, ns) => newTlsSecret(clusters.session(ctx), ns, wizardDeps));
  secretCommand('openLens.newSecretFromEnv', (ctx, ns) => newDataFromFiles(clusters.session(ctx), ns, wizardDeps, 'env'));
  secretCommand('openLens.newDataFromFiles', (ctx, ns) => newDataFromFiles(clusters.session(ctx), ns, wizardDeps, 'files'));
  command('openLens.deployImage', async (arg?: ContextArg) => {
    const name = await contextOrCurrent(arg, 'Deploy into…');
    if (name) {
      DeployPanel.show(services, name);
    }
  });
  command('openLens.convertCompose', (uri?: vscode.Uri) => convertCompose(uri, clusters.currentContext ? clusters.namespaceFilter(clusters.currentContext) : ''));
  command('openLens.refreshYamlSchemas', () => {
    schemas.refresh();
    void vscode.window.showInformationMessage('Manifest schemas will be rebuilt from the cluster the next time a manifest is validated.');
  });
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      void vscode.commands.executeCommand('setContext', HELM_INSTALL_CONTEXT, !!editor && pendingInstalls.has(editor.document.uri.fsPath));
    })
  );

  // ─────────────────────────── navigation ───────────────────────────

  command('openLens.goToResource', async (arg?: ContextArg) => {
    const name = await contextOrCurrent(arg, 'Search resources in…');
    if (name) {
      await goToResource(clusters, name, (ctx, ref) => DetailsPanel.show(services, ctx, ref));
    }
  });
  command('openLens.openTopology', async (arg?: ContextArg) => {
    const name = await contextOrCurrent(arg, 'Topology of…');
    if (!name) {
      return;
    }
    let namespace = clusters.namespaceFilter(name);
    if (!namespace) {
      const session = clusters.session(name);
      await session.connect();
      namespace = (await vscode.window.showQuickPick(await session.namespaces(), { title: `Topology of ${name}`, placeHolder: 'Choose a namespace' })) ?? '';
    }
    if (namespace) {
      TopologyPanel.show(services, name, namespace);
    }
  });
  command('openLens.newResource', async (arg?: ContextArg) => {
    const name = arg?.contextName ?? clusters.currentContext;
    await newResource(name ? clusters.namespaceFilter(name) : '');
  });
  command('openLens.unpinFavorite', (node: RefNode) => favorites.remove(node));
  command('openLens.clearRecent', () => favorites.clearRecent());

  // ─────────────────────────── port forwards ───────────────────────────

  command('openLens.openPortForward', async (node: PortForwardNode) => {
    await vscode.env.openExternal(vscode.Uri.parse(forwardUrl(node.forward)));
  });
  command('openLens.copyPortForwardUrl', async (node: PortForwardNode) => {
    await vscode.env.clipboard.writeText(forwardUrl(node.forward));
    void vscode.window.setStatusBarMessage(`Copied ${forwardUrl(node.forward)}`, 3000);
  });
  command('openLens.stopPortForward', (node: PortForwardNode) => forwards.stop(node.forward.id));
  command('openLens.stopAllPortForwards', () => forwards.stopAll());

  // ─────────────────────────── YAML ───────────────────────────

  command('openLens.diffWithLive', async () => {
    const doc = vscode.window.activeTextEditor?.document;
    if (!doc || doc.uri.scheme !== RESOURCE_SCHEME) {
      throw new Error('Open a cluster resource with "Edit YAML" first.');
    }
    const parts = parseResourceUri(doc.uri);
    const kind = await clusters.session(parts.context).kind(parts.kindId);
    await actions.diffWithLive(parts.context, kind, { name: parts.name, namespace: parts.namespace }, doc.getText());
  });

  command('openLens.helmUpgradeFromEditor', async () => {
    await actions.helmUpgradeFromEditor();
  });
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      void vscode.commands.executeCommand('setContext', 'openLens.helmValuesEditor', !!editor && pendingHelmUpgrades.has(editor.document.uri.fsPath));
    })
  );

  command('openLens.applyYaml', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      throw new Error('Open a YAML manifest in the editor first.');
    }
    const text = editor.selection.isEmpty ? editor.document.getText() : editor.document.getText(editor.selection);
    const docs = (yaml.loadAll(text) as K8sObject[])
      .flatMap((doc) => (doc?.kind === 'List' && Array.isArray(doc.items) ? doc.items : [doc]))
      .filter((doc) => doc && typeof doc === 'object');
    if (docs.length === 0) {
      throw new Error('The editor has no Kubernetes objects.');
    }
    const invalid = docs.find((d) => !d.apiVersion || !d.kind || !d.metadata?.name);
    if (invalid) {
      throw new Error('Every document needs apiVersion, kind and metadata.name.');
    }
    const ctx = await pickContext(undefined, `Apply ${docs.length} object(s) to…`);
    if (!ctx) {
      return;
    }
    const session = clusters.session(ctx);
    const namespace = clusters.namespaceFilter(ctx) || session.defaultNamespace || 'default';
    const summary = docs.map((d) => `${d.kind}/${d.metadata.name}${d.metadata.namespace ? ` (${d.metadata.namespace})` : ''}`).join('\n');

    for (;;) {
      const choice = await vscode.window.showWarningMessage(
        `Apply ${docs.length} object(s) to ${ctx}?`,
        { modal: true, detail: `${summary}\n\nObjects without a namespace go to "${namespace}". Uses server-side apply.` },
        'Apply',
        'Preview Changes'
      );
      if (choice === 'Preview Changes') {
        // Server-side dry run: shows exactly what the API server would store.
        const live: string[] = [];
        const planned: string[] = [];
        for (const doc of docs) {
          try {
            const { kind, object } = await session.apply(doc, namespace, true);
            planned.push(toYaml(stripVolatile(cleanForEdit(object))));
            try {
              live.push(toYaml(stripVolatile(cleanForEdit(await session.get(kind, object.metadata.name, object.metadata.namespace)))));
            } catch (err) {
              live.push(isNotFound(err) ? `# ${doc.kind}/${doc.metadata.name} does not exist yet\n` : `# ${errorMessage(err)}\n`);
            }
          } catch (err) {
            planned.push(`# ${doc.kind}/${doc.metadata.name}: ${errorMessage(err)}\n`);
            live.push(`# ${doc.kind}/${doc.metadata.name}\n`);
          }
        }
        await virtualDocs.diff({ name: 'live.yaml', text: live.join('---\n') }, { name: 'after-apply.yaml', text: planned.join('---\n') }, `${ctx}: live ↔ after apply (dry run)`);
        continue;
      }
      if (choice !== 'Apply') {
        return;
      }
      break;
    }
    if (isProtectedContext(ctx) && !(await confirmAction(ctx, { title: `Apply ${docs.length} object(s)`, button: 'Apply' }))) {
      return;
    }

    const results: string[] = [];
    let failed = 0;
    for (const doc of docs) {
      try {
        const { kind, object } = await session.apply(doc, namespace);
        results.push(`✓ ${kind.kind}/${object.metadata.name}`);
      } catch (err) {
        failed += 1;
        results.push(`✗ ${doc.kind}/${doc.metadata.name}: ${errorMessage(err)}`);
      }
    }
    logger.info(`Applied manifest to ${ctx}`, results.join('\n'));
    const message = failed ? `Applied ${docs.length - failed} of ${docs.length}; ${failed} failed. See the output for details.` : `Applied ${docs.length} object(s) to ${ctx}.`;
    if (failed) {
      for (const line of results) {
        logger.info(line);
      }
      void vscode.window.showErrorMessage(message, 'Show Output').then((c) => c && logger.show());
    } else {
      void vscode.window.showInformationMessage(message);
    }
  });

  // ─────────────────────────── status bar ───────────────────────────

  const contextItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  contextItem.command = 'openLens.setCurrentContext';
  const forwardItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 49);
  forwardItem.command = 'openLens.portForwards.focus';
  const updateStatus = (): void => {
    const current = clusters.currentContext;
    if (current) {
      const namespace = clusters.namespaceFilter(current);
      const prot = isProtectedContext(current);
      contextItem.text = `$(${prot ? 'lock' : 'server-environment'}) ${current}${namespace ? ` · ${namespace}` : ''}`;
      contextItem.tooltip = `Current kubeconfig context${prot ? ' — PROTECTED' : ''} — click to switch`;
      contextItem.backgroundColor = prot ? new vscode.ThemeColor('statusBarItem.errorBackground') : undefined;
      contextItem.show();
    } else {
      contextItem.hide();
    }
    const count = forwards.list().length;
    forwardItem.text = `$(plug) ${count}`;
    forwardItem.tooltip = `${count} active port forward(s)`;
    if (count) {
      forwardItem.show();
    } else {
      forwardItem.hide();
    }
  };
  updateStatus();
  context.subscriptions.push(contextItem, forwardItem, clusters.onDidChange(updateStatus), clusters.onDidChangeStatus(updateStatus), forwards.onDidChange(updateStatus));

  // ─────────────────────────── kubeconfig watcher ───────────────────────────

  let watchers: vscode.Disposable[] = [];
  let reloadTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleReload = (): void => {
    if (reloadTimer) {
      clearTimeout(reloadTimer);
    }
    reloadTimer = setTimeout(() => clusters.reload(), 400);
  };
  const watch = (base: string, pattern: string): vscode.FileSystemWatcher => {
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(base), pattern));
    watcher.onDidChange(scheduleReload);
    watcher.onDidCreate(scheduleReload);
    watcher.onDidDelete(scheduleReload);
    return watcher;
  };
  const watchKubeconfigs = (): void => {
    watchers.forEach((w) => w.dispose());
    watchers = [
      ...allKubeconfigFiles()
        .filter((file) => !kubeconfigFolders().includes(path.dirname(file)))
        .map((file) => watch(path.dirname(file), path.basename(file))),
      ...kubeconfigFolders().map((dir) => watch(dir, '*'))
    ];
  };
  watchKubeconfigs();
  context.subscriptions.push(
    { dispose: () => watchers.forEach((w) => w.dispose()) },
    onConfigChanged((_config, event) => {
      if (event.affectsConfiguration('openLens.kubeconfig') || event.affectsConfiguration('openLens.kubeconfigFolders')) {
        watchKubeconfigs();
        clusters.reload();
      } else if (event.affectsConfiguration('openLens.protectedContexts')) {
        explorer.refresh();
        updateStatus();
      } else if (event.affectsConfiguration('openLens.prometheus')) {
        for (const ctx of clusters.contexts()) {
          const session = clusters.peekSession(ctx.name);
          if (session) {
            forgetPrometheus(session);
          }
        }
      }
    })
  );
}

/** Fields that always differ between a live object and a dry run and only add noise to diffs. */
function stripVolatile(obj: K8sObject): K8sObject {
  const copy: K8sObject = JSON.parse(JSON.stringify(obj));
  delete copy.metadata.resourceVersion;
  delete copy.metadata.generation;
  delete copy.metadata.uid;
  delete copy.metadata.creationTimestamp;
  delete copy.status;
  return copy;
}

export function deactivate(): void {
  logger.dispose();
}
