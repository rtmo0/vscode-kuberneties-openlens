/* Wizards for team onboarding, secrets and docker-compose conversion. */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import { importFrom, KubeconfigCommandDeps, tildify } from '../commands/kubeconfigCommands';
import type { ClusterSession, K8sObject } from '../core/cluster';
import { confirmAction } from '../core/guard';
import { dumpKubeconfig, RawKubeconfig } from '../core/kubeconfigModel';
import { errorMessage, isNotFound } from '../core/kubeRest';
import type { ObjectRef } from '../core/protocol';
import { getKind } from '../core/resources';
import { toYaml } from '../fs/resourceFs';
import { composeToManifests } from './compose';
import { QUOTA_PRESETS, serviceAccountKubeconfig, teamManifests, TeamOptions, tokenSecretName, validateDnsLabel } from './onboarding';
import { checkTlsPair, dataObject, keyFromFileName, parseDotEnv, registrySecret, REGISTRIES, tlsSecret } from './secretBuilders';

export interface WorkloadWizardDeps extends KubeconfigCommandDeps {
  openDetails: (context: string, ref: ObjectRef) => void;
}

async function pickNamespace(session: ClusterSession, title: string, preset: string): Promise<string | undefined> {
  const namespaces = await session.namespaces().catch(() => [] as string[]);
  const items = [...new Set([preset, ...namespaces].filter(Boolean))].map((ns) => ({ label: ns }));
  const picked = await vscode.window.showQuickPick([...items, { label: '$(add) Other namespace…' }], { title, placeHolder: 'Namespace' });
  if (!picked) {
    return undefined;
  }
  if (picked.label.startsWith('$(')) {
    return vscode.window.showInputBox({ title: 'Namespace', validateInput: validateDnsLabel });
  }
  return picked.label;
}

async function applyAll(session: ClusterSession, objects: K8sObject[]): Promise<void> {
  for (const obj of objects) {
    await session.apply(obj, obj.metadata.namespace);
  }
}

// ─────────────────────────── kubeconfig delivery ───────────────────────────

/** Hand a generated kubeconfig to the user: clipboard, base64, file, editor, or this machine's kubeconfig. */
export async function deliverKubeconfig(config: RawKubeconfig, name: string, deps: KubeconfigCommandDeps): Promise<void> {
  const text = dumpKubeconfig(config);
  const picked = await vscode.window.showQuickPick(
    [
      { id: 'clipboard', label: '$(clippy) Copy to Clipboard', detail: 'YAML, to send to the person who needs access' },
      { id: 'base64', label: '$(clippy) Copy as Base64', detail: 'A single line, e.g. for a CI variable' },
      { id: 'file', label: '$(save) Save to File…' },
      { id: 'editor', label: '$(go-to-file) Open in Editor' },
      { id: 'import', label: '$(add) Add to My Kubeconfig', detail: 'To test the access yourself' }
    ],
    { title: `Kubeconfig "${name}"`, placeHolder: 'It contains a token — share it only over a secure channel.' }
  );
  switch (picked?.id) {
    case 'clipboard':
    case 'base64':
      await vscode.env.clipboard.writeText(picked.id === 'base64' ? Buffer.from(text).toString('base64') : text);
      void vscode.window.showInformationMessage(`Kubeconfig "${name}" copied to the clipboard.`);
      break;
    case 'file': {
      const uri = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(path.join(os.homedir(), `${name.replace(/[^\w.-]+/g, '_')}.kubeconfig.yaml`)) });
      if (uri) {
        fs.writeFileSync(uri.fsPath, text, { mode: 0o600 });
        void vscode.window.showInformationMessage(`Saved ${tildify(uri.fsPath)} (mode 600).`);
      }
      break;
    }
    case 'editor':
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ language: 'yaml', content: text }));
      break;
    case 'import':
      await importFrom({ text, label: `kubeconfig "${name}"`, suggestedName: name }, deps);
      break;
  }
}

async function tokenFor(session: ClusterSession, namespace: string, serviceAccount: string, lifetime: number | 'permanent'): Promise<string> {
  if (lifetime === 'permanent') {
    const secretName = tokenSecretName(serviceAccount);
    try {
      await session.get(getKind('secrets')!, secretName, namespace);
    } catch (err) {
      if (!isNotFound(err)) {
        throw err;
      }
      await session.create(getKind('secrets')!, {
        apiVersion: 'v1',
        kind: 'Secret',
        type: 'kubernetes.io/service-account-token',
        metadata: { name: secretName, namespace, annotations: { 'kubernetes.io/service-account.name': serviceAccount } }
      } as K8sObject);
    }
    // The token controller fills the secret in asynchronously.
    for (let i = 0; i < 30; i += 1) {
      const secret = await session.get(getKind('secrets')!, secretName, namespace);
      if (secret.data?.token) {
        return Buffer.from(secret.data.token, 'base64').toString('utf8');
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error(`The token secret ${namespace}/${secretName} was not filled in.`);
  }
  const response = await session.rest.json<{ status: { token: string; expirationTimestamp?: string } }>(
    'POST',
    `/api/v1/namespaces/${encodeURIComponent(namespace)}/serviceaccounts/${encodeURIComponent(serviceAccount)}/token`,
    { body: { apiVersion: 'authentication.k8s.io/v1', kind: 'TokenRequest', spec: { expirationSeconds: lifetime } } }
  );
  return response.status.token;
}

async function pickLifetime(): Promise<number | 'permanent' | undefined> {
  const picked = await vscode.window.showQuickPick(
    [
      { label: 'Valid for 30 days', value: 30 * 86400 as number | 'permanent' },
      { label: 'Valid for 1 year', value: 365 * 86400 as number | 'permanent', detail: 'The API server may cap the lifetime (--service-account-max-token-expiration)' },
      { label: 'Does not expire', value: 'permanent' as const, detail: 'A token Secret; delete the secret to revoke it' }
    ],
    { title: 'Token lifetime' }
  );
  return picked?.value;
}

/** Kubeconfig for an existing service account (row action on Service Accounts). */
export async function serviceAccountAccess(session: ClusterSession, namespace: string, serviceAccount: string, deps: KubeconfigCommandDeps): Promise<void> {
  const lifetime = await pickLifetime();
  if (lifetime === undefined) {
    return;
  }
  if (!(await confirmAction(session.context, { title: `Issue a token for service account ${namespace}/${serviceAccount}`, button: 'Issue' }))) {
    return;
  }
  const token = await tokenFor(session, namespace, serviceAccount, lifetime);
  const cluster = session.kc.getCurrentCluster()!;
  const name = `${session.context}-${namespace}-${serviceAccount}`;
  await deliverKubeconfig(serviceAccountKubeconfig({ contextName: name, server: cluster.server, caData: cluster.caData, insecure: cluster.skipTLSVerify, token, namespace, serviceAccount }), name, deps);
}

// ─────────────────────────── team onboarding ───────────────────────────

export async function onboardTeam(session: ClusterSession, deps: WorkloadWizardDeps): Promise<void> {
  await session.connect();
  const namespace = await vscode.window.showInputBox({ title: 'Onboard a team (1/6): namespace', placeHolder: 'team-payments', validateInput: validateDnsLabel, ignoreFocusOut: true });
  if (!namespace) {
    return;
  }
  const role = await vscode.window.showQuickPick(
    [
      { label: 'edit', detail: 'Deploy and change workloads, services, config maps and secrets in the namespace', role: 'edit' as const },
      { label: 'view', detail: 'Read-only access (no secrets)', role: 'view' as const },
      { label: 'admin', detail: 'Everything in the namespace, including roles and bindings', role: 'admin' as const }
    ],
    { title: 'Onboard a team (2/6): access level' }
  );
  if (!role) {
    return;
  }
  const quota = await vscode.window.showQuickPick(QUOTA_PRESETS.map((q) => ({ label: q.label, quota: q.quota })), { title: 'Onboard a team (3/6): resource quota' });
  if (!quota) {
    return;
  }
  const defaults = quota.quota
    ? { value: true }
    : await vscode.window.showQuickPick(
        [
          { label: 'Default requests and limits for containers', value: true, detail: 'LimitRange: 100m CPU / 128Mi requested, 500m / 512Mi limit unless set' },
          { label: 'No defaults', value: false }
        ],
        { title: 'Onboard a team (4/6): container defaults' }
      );
  if (!defaults) {
    return;
  }
  const isolation = await vscode.window.showQuickPick(
    [
      { label: 'Isolate the namespace', value: true, detail: 'NetworkPolicy: only pods of this namespace, ingress controllers and monitoring may connect (needs a CNI that enforces policies)' },
      { label: 'No network isolation', value: false }
    ],
    { title: 'Onboard a team (5/6): network' }
  );
  if (!isolation) {
    return;
  }
  const lifetime = await pickLifetime();
  if (lifetime === undefined) {
    return;
  }
  const serviceAccount = await vscode.window.showInputBox({ title: 'Onboard a team (6/6): service account', value: `${namespace}-deployer`, validateInput: validateDnsLabel });
  if (!serviceAccount) {
    return;
  }
  const options: TeamOptions = { namespace, serviceAccount, role: role.role, quota: quota.quota, defaults: defaults.value, isolate: isolation.value, permanentToken: lifetime === 'permanent' };
  const objects = teamManifests(options);
  for (;;) {
    const choice = await vscode.window.showWarningMessage(
      `Create namespace "${namespace}" in ${session.context}?`,
      { modal: true, detail: objects.map((o) => `${o.kind} ${o.metadata.name}`).join('\n') },
      'Create',
      'Show YAML'
    );
    if (choice === 'Show YAML') {
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ language: 'yaml', content: objects.map((o) => toYaml(o)).join('---\n') }), { preview: true });
      continue;
    }
    if (choice !== 'Create') {
      return;
    }
    break;
  }
  if (!(await confirmAction(session.context, { title: `Create namespace ${namespace}`, button: 'Create' }))) {
    return;
  }
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Creating ${namespace}…` }, () => applyAll(session, objects));
  const token = await tokenFor(session, namespace, serviceAccount, lifetime);
  const cluster = session.kc.getCurrentCluster()!;
  const name = `${session.context}-${namespace}`;
  await deliverKubeconfig(serviceAccountKubeconfig({ contextName: name, server: cluster.server, caData: cluster.caData, insecure: cluster.skipTLSVerify, token, namespace, serviceAccount }), name, deps);
}

// ─────────────────────────── secrets ───────────────────────────

async function finishSecret(session: ClusterSession, obj: K8sObject, deps: WorkloadWizardDeps): Promise<void> {
  if (!(await confirmAction(session.context, { title: `Create ${obj.kind} ${obj.metadata.namespace}/${obj.metadata.name}`, button: 'Create' }))) {
    return;
  }
  await session.apply(obj, obj.metadata.namespace);
  deps.openDetails(session.context, { kindId: obj.kind === 'Secret' ? 'secrets' : 'configmaps', name: obj.metadata.name, namespace: obj.metadata.namespace });
}

export async function newRegistrySecret(session: ClusterSession, presetNamespace: string): Promise<void> {
  const registry = await vscode.window.showQuickPick([...REGISTRIES.map((r) => ({ label: r.label, description: r.server, server: r.server })), { label: 'Other registry…', description: '', server: '' }], {
    title: 'Image pull secret: registry'
  });
  if (!registry) {
    return;
  }
  const server = registry.server || (await vscode.window.showInputBox({ title: 'Registry host', placeHolder: 'registry.example.com' })) || '';
  if (!server) {
    return;
  }
  const username = await vscode.window.showInputBox({ title: `Username for ${server}`, ignoreFocusOut: true, placeHolder: server === 'cr.yandex' ? 'oauth, iam or json_key' : undefined });
  if (!username) {
    return;
  }
  const password = await vscode.window.showInputBox({ title: `Password or access token for ${username}@${server}`, password: true, ignoreFocusOut: true });
  if (!password) {
    return;
  }
  const namespace = await pickNamespace(session, 'Image pull secret: namespace', presetNamespace);
  if (!namespace) {
    return;
  }
  const name = await vscode.window.showInputBox({ title: 'Secret name', value: `regcred-${server.replace(/^https?:\/\//, '').split(/[/.]/)[0]}`.toLowerCase(), validateInput: validateDnsLabel });
  if (!name) {
    return;
  }
  const attach = await vscode.window.showQuickPick(
    [
      { label: 'Use it for every pod in the namespace', value: true, detail: 'Adds it to imagePullSecrets of the "default" service account' },
      { label: 'Only create the secret', value: false, detail: 'Reference it with imagePullSecrets in your pods' }
    ],
    { title: 'Image pull secret' }
  );
  if (!attach) {
    return;
  }
  const secret = registrySecret(name, namespace, server, username, password);
  if (!(await confirmAction(session.context, { title: `Create image pull secret ${namespace}/${name}`, button: 'Create' }))) {
    return;
  }
  await session.apply(secret, namespace);
  if (attach.value) {
    const sa = await session.get(getKind('serviceaccounts')!, 'default', namespace);
    const existing: Array<{ name: string }> = sa.imagePullSecrets ?? [];
    if (!existing.some((s) => s.name === name)) {
      await session.patch(getKind('serviceaccounts')!, 'default', namespace, { imagePullSecrets: [...existing, { name }] });
    }
  }
  void vscode.window.showInformationMessage(`Created image pull secret ${namespace}/${name}${attach.value ? ' and attached it to the default service account' : ''}.`);
}

export async function newTlsSecret(session: ClusterSession, presetNamespace: string, deps: WorkloadWizardDeps): Promise<void> {
  const cert = await vscode.window.showOpenDialog({ title: 'TLS secret: certificate (PEM, may include the chain)', canSelectMany: false, filters: { Certificates: ['crt', 'pem', 'cer'], 'All files': ['*'] } });
  if (!cert?.[0]) {
    return;
  }
  const key = await vscode.window.showOpenDialog({ title: 'TLS secret: private key (PEM)', canSelectMany: false, defaultUri: vscode.Uri.file(path.dirname(cert[0].fsPath)), filters: { Keys: ['key', 'pem'], 'All files': ['*'] } });
  if (!key?.[0]) {
    return;
  }
  const certPem = fs.readFileSync(cert[0].fsPath, 'utf8');
  const keyPem = fs.readFileSync(key[0].fsPath, 'utf8');
  const check = checkTlsPair(certPem, keyPem);
  if (!check.ok) {
    throw new Error(check.error);
  }
  const namespace = await pickNamespace(session, `TLS secret for ${check.dnsNames ?? check.subject} (valid until ${check.validTo})`, presetNamespace);
  if (!namespace) {
    return;
  }
  const name = await vscode.window.showInputBox({ title: 'Secret name', value: `${path.basename(cert[0].fsPath).replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9-]+/g, '-')}-tls`, validateInput: validateDnsLabel });
  if (name) {
    await finishSecret(session, tlsSecret(name, namespace, certPem, keyPem), deps);
  }
}

export async function newDataFromFiles(session: ClusterSession, presetNamespace: string, deps: WorkloadWizardDeps, mode: 'env' | 'files'): Promise<void> {
  const files = await vscode.window.showOpenDialog({
    title: mode === 'env' ? 'Choose a .env file' : 'Choose files (each becomes a key)',
    canSelectMany: mode === 'files',
    canSelectFiles: true,
    canSelectFolders: false
  });
  if (!files?.length) {
    return;
  }
  let entries: Record<string, Buffer | string>;
  if (mode === 'env') {
    entries = parseDotEnv(fs.readFileSync(files[0].fsPath, 'utf8'));
    if (!Object.keys(entries).length) {
      throw new Error(`${path.basename(files[0].fsPath)} has no KEY=value lines.`);
    }
  } else {
    entries = Object.fromEntries(files.map((f) => [keyFromFileName(f.fsPath), fs.readFileSync(f.fsPath)]));
  }
  const kind = await vscode.window.showQuickPick(
    [
      { label: 'Secret', objectKind: 'Secret' as const, detail: 'For passwords, tokens and keys' },
      { label: 'ConfigMap', objectKind: 'ConfigMap' as const, detail: 'For non-sensitive configuration' }
    ],
    { title: `Create from ${Object.keys(entries).length} key(s): ${Object.keys(entries).slice(0, 6).join(', ')}${Object.keys(entries).length > 6 ? '…' : ''}` }
  );
  if (!kind) {
    return;
  }
  const namespace = await pickNamespace(session, `${kind.objectKind}: namespace`, presetNamespace);
  if (!namespace) {
    return;
  }
  const base = path.basename(files[0].fsPath).replace(/^\./, '').replace(/\.[^.]+$/, '') || 'config';
  const name = await vscode.window.showInputBox({ title: `${kind.objectKind} name`, value: base.toLowerCase().replace(/[^a-z0-9-]+/g, '-'), validateInput: validateDnsLabel });
  if (name) {
    await finishSecret(session, dataObject(kind.objectKind, name, namespace, entries), deps);
  }
}

// ─────────────────────────── docker-compose ───────────────────────────

export async function convertCompose(uri: vscode.Uri | undefined, namespace: string): Promise<void> {
  let text: string;
  let label: string;
  if (uri instanceof vscode.Uri) {
    text = fs.readFileSync(uri.fsPath, 'utf8');
    label = path.basename(uri.fsPath);
  } else {
    const doc = vscode.window.activeTextEditor?.document;
    if (!doc) {
      throw new Error('Open a docker-compose file first.');
    }
    text = doc.getText();
    label = path.basename(doc.fileName);
  }
  const ns = await vscode.window.showInputBox({ title: 'Namespace for the converted manifests', value: namespace || 'default', validateInput: validateDnsLabel });
  if (!ns) {
    return;
  }
  let result;
  try {
    result = composeToManifests(text, ns);
  } catch (err) {
    throw new Error(`${label}: ${errorMessage(err)}`);
  }
  const header = [
    `# Converted from ${label}. Review, then click "Apply YAML to Cluster" in the editor title.`,
    ...(result.warnings.length ? ['#', '# Notes:', ...result.warnings.map((w) => `#  - ${w}`)] : []),
    ''
  ].join('\n');
  const doc = await vscode.workspace.openTextDocument({ language: 'yaml', content: header + result.objects.map((o) => toYaml(o)).join('---\n') });
  await vscode.window.showTextDocument(doc);
}

