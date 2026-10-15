import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import type { ClusterManager } from '../core/cluster';
import { getConfig } from '../core/config';
import { kubeconfigFolders, primaryKubeconfigPath } from '../core/kubeconfig';
import { readKubeconfigFile, writeKubeconfigFile } from '../core/kubeconfigFiles';
import {
  analyzeImport,
  applyImport,
  dumpKubeconfig,
  ensureContexts,
  findByName,
  ImportDecision,
  KubeconfigParseError,
  missingReferences,
  parseKubeconfig,
  RawKubeconfig,
  relativePathReferences,
  removeContext,
  renameContext,
  resolveRelativePaths,
  setContextNamespace,
  uniqueName
} from '../core/kubeconfigModel';
import { errorMessage } from '../core/kubeRest';
import { logger } from '../core/logger';
import type { PortForwardManager } from '../core/portForward';
import { ContextHealth, daysLeft, exportContext, liveHealth } from '../core/kubeconfigHealth';
import type { VirtualDocuments } from '../fs/virtualDocs';

export const KUBECONFIG_EDITOR_CONTEXT = 'openLens.editorHasKubeconfig';

const PASTE_TEMPLATE = `# Paste the kubeconfig you received here (YAML, JSON or base64),
# then click "Import Kubeconfig" in the editor title bar
# or run "Kubernetes: Import Kubeconfig From Active Editor".
# This editor is discarded after a successful import.
`;

export interface ImportSource {
  text: string;
  /** Context name to propose when the kubeconfig has a single new context. */
  suggestedName?: string;
  /** Directory to resolve relative certificate paths against. */
  baseDir?: string;
  label: string;
  /** Untitled paste editor to discard after the import. */
  pasteDocument?: vscode.TextDocument;
}

export interface KubeconfigCommandDeps {
  clusters: ClusterManager;
  forwards: PortForwardManager;
  virtualDocs: VirtualDocuments;
  openDashboard: (context: string) => void;
}

export function registerKubeconfigCommands(context: vscode.ExtensionContext, deps: KubeconfigCommandDeps): void {
  const pasteDocuments = new WeakSet<vscode.TextDocument>();

  const register = (id: string, handler: (...args: any[]) => unknown): void => {
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

  register('openLens.importKubeconfig', async (uri?: vscode.Uri) => {
    const source = uri instanceof vscode.Uri ? readFileSource(uri) : await pickSource(pasteDocuments);
    if (source) {
      await importFrom(source, deps);
    }
  });
  register('openLens.importKubeconfigFromFile', async () => {
    const source = await pickFile();
    if (source) {
      await importFrom(source, deps);
    }
  });
  register('openLens.importKubeconfigFromClipboard', async () => {
    await importFrom({ text: await vscode.env.clipboard.readText(), label: 'the clipboard' }, deps);
  });
  register('openLens.importKubeconfigFromEditor', async () => {
    const source = editorSource(pasteDocuments);
    if (!source) {
      throw new Error('Open the kubeconfig in an editor first.');
    }
    await importFrom(source, deps);
  });
  register('openLens.pasteKubeconfig', async () => {
    await openPasteEditor(pasteDocuments);
  });

  register('openLens.setCurrentContext', async (node?: { contextName?: string }) => {
    const name = node?.contextName ?? (await pickContext(deps.clusters, 'Switch the current context'));
    if (!name) {
      return;
    }
    const file = currentContextFile(deps.clusters);
    const raw = readKubeconfigFile(file);
    raw['current-context'] = name;
    writeKubeconfigFile(file, raw, { backup: false });
    deps.clusters.reload();
    void vscode.window.setStatusBarMessage(`Current context: ${name}`, 4000);
  });

  register('openLens.removeContext', async (node?: { contextName?: string }) => {
    const name = node?.contextName ?? (await pickContext(deps.clusters, 'Remove a context from the kubeconfig'));
    if (!name) {
      return;
    }
    const file = originOf(deps.clusters, name);
    const choice = await vscode.window.showWarningMessage(
      `Remove context "${name}" from ${tildify(file)}?`,
      {
        modal: true,
        detail: 'Its cluster and user entries are removed too when no other context uses them. A backup of the file is kept.'
      },
      'Remove'
    );
    if (choice !== 'Remove') {
      return;
    }
    const backup = writeKubeconfigFile(file, removeContext(readKubeconfigFile(file), name), { backup: getConfig().backupKubeconfig });
    deps.forwards.stopAll(name);
    deps.clusters.reload();
    void vscode.window.showInformationMessage(`Removed context "${name}".${backup ? ` Backup: ${tildify(backup)}` : ''}`);
  });

  register('openLens.renameContext', async (node?: { contextName?: string }) => {
    const name = node?.contextName ?? (await pickContext(deps.clusters, 'Rename a context'));
    if (!name) {
      return;
    }
    const taken = new Set(deps.clusters.contexts().map((c) => c.name));
    const to = await vscode.window.showInputBox({
      title: `Rename context "${name}"`,
      value: name,
      validateInput: (v) => (!v.trim() ? 'Enter a name' : v.trim() !== name && taken.has(v.trim()) ? 'A context with this name already exists' : undefined)
    });
    if (!to || to.trim() === name) {
      return;
    }
    const newName = to.trim();
    const file = originOf(deps.clusters, name);
    writeKubeconfigFile(file, renameContext(readKubeconfigFile(file), name, newName), { backup: getConfig().backupKubeconfig });
    // current-context may live in another file.
    const currentFile = currentContextFile(deps.clusters);
    if (currentFile !== file) {
      const raw = readKubeconfigFile(currentFile);
      if (raw['current-context'] === name) {
        raw['current-context'] = newName;
        writeKubeconfigFile(currentFile, raw, { backup: false });
      }
    }
    await deps.clusters.setNamespaceFilter(newName, deps.clusters.namespaceFilter(name));
    deps.forwards.stopAll(name);
    deps.clusters.reload();
  });

  register('openLens.setDefaultNamespace', async (node?: { contextName?: string }) => {
    const name = node?.contextName ?? (await pickContext(deps.clusters, 'Set the default namespace of a context'));
    if (!name) {
      return;
    }
    const session = deps.clusters.session(name);
    const namespaces = await session.namespaces().catch(() => [] as string[]);
    const picked = await vscode.window.showQuickPick(
      [{ label: '$(close) No default (use "default")', value: '' }, ...namespaces.map((ns) => ({ label: ns, value: ns, description: ns === session.defaultNamespace ? 'current' : undefined }))],
      { title: `Default namespace of ${name} (written to the kubeconfig, like kubens)` }
    );
    if (!picked) {
      return;
    }
    const file = originOf(deps.clusters, name);
    writeKubeconfigFile(file, setContextNamespace(readKubeconfigFile(file), name, picked.value || undefined), { backup: false });
    deps.clusters.reload();
  });

  register('openLens.openKubeconfigFile', async () => {
    const files = deps.clusters.kubeconfig.files.filter((f) => fs.existsSync(f));
    const file = files.length <= 1 ? files[0] : (await vscode.window.showQuickPick(files.map(tildify), { title: 'Open kubeconfig' }))?.replace(/^~/, os.homedir());
    if (file) {
      await vscode.window.showTextDocument(vscode.Uri.file(file));
    }
  });

  register('openLens.checkKubeconfigHealth', async () => {
    await checkHealth(deps);
  });

  register('openLens.exportContext', async (node?: { contextName?: string }) => {
    const name = node?.contextName ?? (await pickContext(deps.clusters, 'Export a context as a standalone kubeconfig'));
    if (!name) {
      return;
    }
    const exported = exportContext(deps.clusters.kubeconfig.config, name);
    const text = dumpKubeconfig(exported);
    const usesExec = exported.users.some((u) => !!u.user.exec);
    const picked = await vscode.window.showQuickPick(
      [
        { id: 'clipboard', label: '$(clippy) Copy to Clipboard', detail: 'YAML' },
        { id: 'base64', label: '$(clippy) Copy as Base64', detail: 'A single line, handy for CI variables and chat' },
        { id: 'file', label: '$(save) Save to File…' },
        { id: 'editor', label: '$(go-to-file) Open in Editor' }
      ],
      {
        title: `Export context "${name}"`,
        placeHolder: `Contains credentials — share it only over a secure channel.${usesExec ? ' Uses an exec auth plugin: the recipient needs the same CLI.' : ''}`
      }
    );
    if (!picked) {
      return;
    }
    if (picked.id === 'clipboard' || picked.id === 'base64') {
      await vscode.env.clipboard.writeText(picked.id === 'base64' ? Buffer.from(text).toString('base64') : text);
      void vscode.window.showInformationMessage(`Kubeconfig of "${name}" copied to the clipboard. It contains credentials.`);
    } else if (picked.id === 'file') {
      const uri = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(path.join(os.homedir(), `${name.replace(/[^\w.-]+/g, '_')}.kubeconfig.yaml`)), filters: { Kubeconfig: ['yaml', 'yml', 'kubeconfig'] } });
      if (uri) {
        fs.writeFileSync(uri.fsPath, text, { mode: 0o600 });
        void vscode.window.showInformationMessage(`Saved ${tildify(uri.fsPath)} (mode 600).`);
      }
    } else {
      const doc = await vscode.workspace.openTextDocument({ language: 'yaml', content: text });
      await vscode.window.showTextDocument(doc);
    }
  });

  register('openLens.addKubeconfigFolder', async () => {
    const picked = await vscode.window.showOpenDialog({
      title: 'Folder with kubeconfig files to load',
      canSelectFiles: false,
      canSelectFolders: true,
      defaultUri: vscode.Uri.file(path.join(os.homedir(), '.kube')),
      openLabel: 'Load Kubeconfigs From Here'
    });
    if (!picked?.[0]) {
      return;
    }
    const config = vscode.workspace.getConfiguration('openLens');
    const folders = config.get<string[]>('kubeconfigFolders', []);
    const folder = tildify(picked[0].fsPath);
    if (kubeconfigFolders().includes(picked[0].fsPath)) {
      void vscode.window.showInformationMessage(`${folder} is already synced.`);
      return;
    }
    await config.update('kubeconfigFolders', [...folders, folder], vscode.ConfigurationTarget.Global);
    void vscode.window.showInformationMessage(`Every kubeconfig file in ${folder} is now loaded and watched. Imports still go to ${tildify(primaryKubeconfigPath())}.`);
  });

  // Show the "Import Kubeconfig" editor button for documents that look like a kubeconfig.
  const updateEditorContext = (): void => {
    const doc = vscode.window.activeTextEditor?.document;
    const isKubeconfig = !!doc && doc.uri.scheme !== 'k8s' && (pasteDocuments.has(doc) || looksLikeKubeconfig(doc.getText(new vscode.Range(0, 0, 400, 0))));
    void vscode.commands.executeCommand('setContext', KUBECONFIG_EDITOR_CONTEXT, isKubeconfig);
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(updateEditorContext),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document === vscode.window.activeTextEditor?.document) {
        if (timer) {
          clearTimeout(timer);
        }
        timer = setTimeout(updateEditorContext, 300);
      }
    })
  );
  updateEditorContext();
}

async function checkHealth(deps: KubeconfigCommandDeps): Promise<void> {
  const state = deps.clusters.kubeconfig;
  const names = state.config.contexts.map((c) => c.name);
  if (!names.length) {
    void vscode.window.showInformationMessage('There are no contexts to check.');
    return;
  }
  const results: ContextHealth[] = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Checking ${names.length} context(s)…` },
    () => Promise.all(names.map((name) => liveHealth(state, name)))
  );
  const row = (h: ContextHealth): string => {
    const icon = h.problems.length || h.reachable === false ? '❌' : h.warnings.length ? '⚠️' : '✅';
    const expiry = h.certExpires ? `${h.certExpires.slice(0, 10)} (${daysLeft(h.certExpires)}d)` : h.tokenExpires ? `token ${h.tokenExpires.slice(0, 10)}` : '—';
    const notes = [...h.problems, ...h.warnings, h.error ? `unreachable: ${h.error}` : ''].filter(Boolean).join('; ').replace(/\|/g, '\\|');
    return `| ${icon} | \`${h.context}\` | ${h.server} | ${h.reachable ? h.version ?? 'ok' : 'no'} | ${h.authMethod} | ${expiry} | ${notes || '—'} |`;
  };
  const report = [
    '# Kubeconfig health',
    '',
    `Checked ${new Date().toLocaleString()} · files: ${state.files.map((f) => `\`${tildify(f)}\``).join(', ')}`,
    '',
    '| | Context | Server | Reachable | Auth | Credentials valid until | Notes |',
    '|---|---|---|---|---|---|---|',
    ...results.map(row),
    ''
  ].join('\n');
  const uri = deps.virtualDocs.put('kubeconfig-health.md', report);
  await vscode.commands.executeCommand('markdown.showPreview', uri);

  const broken = results.filter((h) => h.problems.length || h.reachable === false);
  if (!broken.length) {
    void vscode.window.showInformationMessage(`All ${results.length} contexts are reachable and their credentials are valid.`);
    return;
  }
  const choice = await vscode.window.showWarningMessage(`${broken.length} of ${results.length} contexts are unreachable or have invalid credentials.`, 'Remove Some…');
  if (choice !== 'Remove Some…') {
    return;
  }
  const picks = await vscode.window.showQuickPick(
    broken.map((h) => ({ label: h.context, description: h.server, detail: [...h.problems, h.error].filter(Boolean).join('; '), picked: false })),
    { canPickMany: true, title: 'Remove these contexts from the kubeconfig (a backup is kept)' }
  );
  if (!picks?.length) {
    return;
  }
  const confirmed = await vscode.window.showWarningMessage(`Remove ${picks.length} context(s)?`, { modal: true, detail: picks.map((p) => p.label).join('\n') }, 'Remove');
  if (confirmed !== 'Remove') {
    return;
  }
  const byFile = new Map<string, string[]>();
  for (const pick of picks) {
    const file = state.contextOrigin.get(pick.label);
    if (file) {
      byFile.set(file, [...(byFile.get(file) ?? []), pick.label]);
    }
  }
  for (const [file, contexts] of byFile) {
    let raw = readKubeconfigFile(file);
    for (const name of contexts) {
      raw = removeContext(raw, name);
      deps.forwards.stopAll(name);
    }
    writeKubeconfigFile(file, raw, { backup: getConfig().backupKubeconfig });
  }
  deps.clusters.reload();
  void vscode.window.showInformationMessage(`Removed ${picks.length} context(s).`);
}

export function looksLikeKubeconfig(text: string): boolean {
  return /^\s*clusters\s*:/m.test(text) && /^\s*(contexts|users)\s*:/m.test(text);
}

// ─────────────────────────── sources ───────────────────────────

async function pickSource(pasteDocuments: WeakSet<vscode.TextDocument>): Promise<ImportSource | undefined> {
  type Item = vscode.QuickPickItem & { id: 'file' | 'clipboard' | 'editor' | 'paste' };
  const items: Item[] = [
    { id: 'file', label: '$(file) From File…', detail: 'A kubeconfig file you received or downloaded' },
    { id: 'clipboard', label: '$(clippy) From Clipboard', detail: 'Kubeconfig text (YAML, JSON or base64) you copied' },
    { id: 'paste', label: '$(edit) Paste Into an Editor…', detail: 'Opens an empty editor to paste and review the kubeconfig first' }
  ];
  if (vscode.window.activeTextEditor) {
    items.splice(2, 0, { id: 'editor', label: '$(go-to-file) From Active Editor', detail: vscode.window.activeTextEditor.document.fileName });
  }
  const picked = await vscode.window.showQuickPick(items, {
    title: 'Import Kubeconfig',
    placeHolder: `Contexts are merged into ${tildify(primaryKubeconfigPath())}`
  });
  switch (picked?.id) {
    case 'file':
      return pickFile();
    case 'clipboard':
      return { text: await vscode.env.clipboard.readText(), label: 'the clipboard' };
    case 'editor':
      return editorSource(pasteDocuments);
    case 'paste':
      await openPasteEditor(pasteDocuments);
      return undefined;
    default:
      return undefined;
  }
}

async function pickFile(): Promise<ImportSource | undefined> {
  const picked = await vscode.window.showOpenDialog({
    title: 'Import Kubeconfig',
    openLabel: 'Import',
    canSelectMany: false,
    defaultUri: vscode.Uri.file(os.homedir()),
    filters: { 'Kubeconfig': ['yaml', 'yml', 'conf', 'config', 'json', 'kubeconfig', 'txt', ''], 'All files': ['*'] }
  });
  return picked?.[0] ? readFileSource(picked[0]) : undefined;
}

function readFileSource(uri: vscode.Uri): ImportSource {
  return { text: fs.readFileSync(uri.fsPath, 'utf8'), baseDir: path.dirname(uri.fsPath), label: path.basename(uri.fsPath) };
}

function editorSource(pasteDocuments: WeakSet<vscode.TextDocument>): ImportSource | undefined {
  const doc = vscode.window.activeTextEditor?.document;
  if (!doc) {
    return undefined;
  }
  return {
    text: doc.getText(),
    baseDir: doc.uri.scheme === 'file' ? path.dirname(doc.uri.fsPath) : undefined,
    label: doc.isUntitled ? 'the editor' : path.basename(doc.fileName),
    pasteDocument: pasteDocuments.has(doc) ? doc : undefined
  };
}

async function openPasteEditor(pasteDocuments: WeakSet<vscode.TextDocument>): Promise<void> {
  const doc = await vscode.workspace.openTextDocument({ language: 'yaml', content: PASTE_TEMPLATE });
  pasteDocuments.add(doc);
  const editor = await vscode.window.showTextDocument(doc);
  const end = doc.lineAt(doc.lineCount - 1).range.end;
  editor.selection = new vscode.Selection(end, end);
  void vscode.commands.executeCommand('setContext', KUBECONFIG_EDITOR_CONTEXT, true);
}

// ─────────────────────────── import ───────────────────────────

export async function importFrom(source: ImportSource, deps: KubeconfigCommandDeps): Promise<string[]> {
  if (!source.text.trim()) {
    throw new Error(`${capitalize(source.label)} is empty.`);
  }
  let incoming: RawKubeconfig;
  try {
    incoming = parseKubeconfig(source.text);
  } catch (err) {
    if (err instanceof KubeconfigParseError) {
      throw new Error(`${capitalize(source.label)} is not a valid kubeconfig: ${err.message}`);
    }
    throw err;
  }

  if (source.baseDir) {
    incoming = resolveRelativePaths(incoming, source.baseDir);
  } else {
    const refs = relativePathReferences(incoming);
    if (refs.length) {
      const choice = await vscode.window.showWarningMessage(
        'The kubeconfig refers to certificate files by relative path, which cannot be resolved for pasted text.',
        { modal: true, detail: `${refs.join('\n')}\n\nImport the file itself instead, or continue and fix the paths later.` },
        'Import Anyway'
      );
      if (choice !== 'Import Anyway') {
        return [];
      }
    }
  }

  incoming = ensureContexts(incoming);
  if (incoming.contexts.length === 0) {
    throw new Error(`${capitalize(source.label)} has no contexts, clusters or users to import.`);
  }
  const problems = missingReferences(incoming);
  if (problems.length) {
    throw new Error(problems.join(' '));
  }

  const targetFile = primaryKubeconfigPath();
  const target = readKubeconfigFile(targetFile);
  const merged = deps.clusters.kubeconfig;
  const candidates = analyzeImport(merged.config, incoming);

  // 1. Which contexts.
  let chosen = candidates;
  if (candidates.length > 1) {
    const picks = await vscode.window.showQuickPick(
      candidates.map((c) => ({
        label: c.name,
        description: c.server,
        detail: c.status === 'new' ? 'New' : c.status === 'identical' ? 'Already imported (identical)' : 'Name already used by a different cluster — you will choose a new name',
        picked: c.status !== 'identical',
        candidate: c
      })),
      { title: `Import from ${source.label}`, placeHolder: 'Choose the contexts to import', canPickMany: true }
    );
    if (!picks || picks.length === 0) {
      return [];
    }
    chosen = picks.map((p) => p.candidate);
  }

  // 2. Names for each context.
  const taken = new Set(merged.config.contexts.map((c) => c.name));
  const decisions: ImportDecision[] = [];
  for (const candidate of chosen) {
    if (candidate.status === 'identical') {
      continue;
    }
    if (candidate.status === 'new') {
      if (chosen.length === 1) {
        const name = await askContextName(source.suggestedName && !taken.has(source.suggestedName) ? source.suggestedName : candidate.name, candidate.server, taken);
        if (!name) {
          return [];
        }
        decisions.push({ source: candidate.name, target: name });
        taken.add(name);
      } else {
        decisions.push({ source: candidate.name, target: candidate.name });
        taken.add(candidate.name);
      }
      continue;
    }
    // Conflict: the name is used by a different cluster or user.
    const inTarget = !!findByName(target.contexts, candidate.name) && merged.contextOrigin.get(candidate.name) === targetFile;
    const suggestion = uniqueName(taken, suggestName(candidate.name, candidate.server));
    type Item = vscode.QuickPickItem & { action: 'rename' | 'custom' | 'replace' | 'skip' };
    const items: Item[] = [
      { action: 'rename', label: `$(edit) Import as "${suggestion}"`, detail: 'Keep the existing context and add this one under a new name' },
      { action: 'custom', label: '$(pencil) Import under another name…' }
    ];
    if (inTarget) {
      items.push({ action: 'replace', label: `$(replace) Replace the existing "${candidate.name}"`, detail: 'Use when the credentials or endpoint of that cluster changed' });
    }
    items.push({ action: 'skip', label: '$(circle-slash) Skip this context' });
    const picked = await vscode.window.showQuickPick(items, {
      title: `Context "${candidate.name}" already exists`,
      placeHolder: `Importing ${candidate.server}`
    });
    if (!picked) {
      return [];
    }
    if (picked.action === 'skip') {
      continue;
    }
    if (picked.action === 'replace') {
      decisions.push({ source: candidate.name, target: candidate.name, overwrite: true });
      continue;
    }
    const name = picked.action === 'rename' ? suggestion : await askContextName(suggestion, candidate.server, taken);
    if (!name) {
      return [];
    }
    decisions.push({ source: candidate.name, target: name });
    taken.add(name);
  }

  if (decisions.length === 0) {
    void vscode.window.showInformationMessage('Nothing to import: the selected contexts are already in your kubeconfig.');
    return [];
  }

  // 3. Merge and write.
  const report = applyImport(target, incoming, decisions);
  const backup = writeKubeconfigFile(targetFile, report.config, { backup: getConfig().backupKubeconfig });
  logger.info(`Imported kubeconfig from ${source.label} into ${targetFile}`, {
    added: report.added,
    replaced: report.replaced,
    renamedClusters: report.renamedClusters,
    renamedUsers: report.renamedUsers,
    backup
  });
  deps.clusters.reload();

  if (source.pasteDocument) {
    await discardDocument(source.pasteDocument);
  }

  const imported = [...report.added, ...report.replaced];
  const renames = [
    ...report.renamedClusters.map(([from, to]) => `cluster ${from} → ${to}`),
    ...report.renamedUsers.map(([from, to]) => `user ${from} → ${to}`)
  ];
  const summary =
    `Imported ${imported.length === 1 ? `context "${imported[0]}"` : `${imported.length} contexts`} into ${tildify(targetFile)}.` +
    (renames.length ? ` Renamed to avoid clashes: ${renames.join(', ')}.` : '');
  const actions = imported.length === 1 ? ['Open Dashboard', 'Set as Current'] : ['Show Clusters'];
  const choice = await vscode.window.showInformationMessage(summary, ...actions);
  if (choice === 'Open Dashboard') {
    deps.openDashboard(imported[0]);
  } else if (choice === 'Set as Current') {
    await vscode.commands.executeCommand('openLens.setCurrentContext', { contextName: imported[0] });
  } else if (choice === 'Show Clusters') {
    await vscode.commands.executeCommand('openLens.clusters.focus');
  }
  return imported;
}

async function askContextName(initial: string, server: string, taken: Set<string>): Promise<string | undefined> {
  const name = await vscode.window.showInputBox({
    title: 'Context name',
    prompt: `Name for ${server || 'the imported cluster'} in your kubeconfig`,
    value: initial,
    validateInput: (v) => {
      const value = v.trim();
      if (!value) {
        return 'Enter a name';
      }
      return taken.has(value) ? 'A context with this name already exists' : undefined;
    }
  });
  return name?.trim() || undefined;
}

/** Derive a readable name from the API server host for generic names like "kubernetes-admin@kubernetes". */
function suggestName(name: string, server: string): string {
  try {
    const host = new URL(server).hostname;
    if (host && !/^(\d+\.){3}\d+$/.test(host) && host !== 'localhost') {
      return `${name}-${host.split('.')[0]}`;
    }
    if (host) {
      return `${name}-${host.replace(/\./g, '-')}`;
    }
  } catch {
    // not a URL
  }
  return name;
}

async function discardDocument(doc: vscode.TextDocument): Promise<void> {
  for (const editor of vscode.window.visibleTextEditors) {
    if (editor.document === doc) {
      await vscode.window.showTextDocument(doc, editor.viewColumn);
      await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
      return;
    }
  }
}

// ─────────────────────────── helpers ───────────────────────────

async function pickContext(clusters: ClusterManager, title: string): Promise<string | undefined> {
  const picked = await vscode.window.showQuickPick(
    clusters.contexts().map((c) => ({ label: c.name, description: c.current ? 'current' : c.server })),
    { title }
  );
  return picked?.label;
}

function originOf(clusters: ClusterManager, name: string): string {
  const file = clusters.kubeconfig.contextOrigin.get(name);
  if (!file) {
    throw new Error(`Context "${name}" was not found in the kubeconfig files.`);
  }
  return file;
}

/** The file whose current-context is in effect (the first that sets one), as kubectl uses. */
function currentContextFile(clusters: ClusterManager): string {
  for (const file of clusters.kubeconfig.files) {
    try {
      if (readKubeconfigFile(file)['current-context']) {
        return file;
      }
    } catch {
      // unreadable files are skipped
    }
  }
  return primaryKubeconfigPath();
}

export function tildify(file: string): string {
  const home = os.homedir();
  return file.startsWith(home) ? `~${file.slice(home.length)}` : file;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
