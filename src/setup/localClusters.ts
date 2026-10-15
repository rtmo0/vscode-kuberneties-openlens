/* Local clusters in Docker (kind, k3d) or a VM / Docker (minikube). */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';
import * as vscode from 'vscode';

export type Engine = 'kind' | 'k3d' | 'minikube';

export interface LocalClusterOptions {
  engine: Engine;
  name: string;
  workers: number;
  /** e.g. "v1.31.0"; empty for the tool's default. */
  version: string;
  /** Map host ports 80/443 to the cluster for an ingress controller. */
  ingressPorts: boolean;
}

export interface LocalCluster {
  engine: Engine;
  name: string;
  /** Context the tool creates for it. */
  context: string;
  status?: string;
}

export const ENGINES: Record<Engine, { title: string; detail: string; needsDocker: boolean }> = {
  kind: { title: 'kind', detail: 'Upstream Kubernetes in Docker containers — closest to a real cluster', needsDocker: true },
  k3d: { title: 'k3d', detail: 'Lightweight k3s in Docker — starts in seconds, uses little memory', needsDocker: true },
  minikube: { title: 'minikube', detail: 'Kubernetes in a VM or Docker, with many built-in addons', needsDocker: false }
};

export function contextFor(engine: Engine, name: string): string {
  return engine === 'kind' ? `kind-${name}` : engine === 'k3d' ? `k3d-${name}` : name;
}

export function validateClusterName(name: string): string | undefined {
  if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(name)) {
    return 'Use lowercase letters, digits and "-" (it becomes part of Docker container names).';
  }
  return name.length > 40 ? 'Use at most 40 characters.' : undefined;
}

/** kind cluster config: control plane (with ingress ports and label) plus workers. */
export function kindConfig(options: LocalClusterOptions): string {
  const image = options.version ? `kindest/node:${options.version.startsWith('v') ? options.version : `v${options.version}`}` : undefined;
  const controlPlane: Record<string, unknown> = { role: 'control-plane' };
  if (image) {
    controlPlane.image = image;
  }
  if (options.ingressPorts) {
    // The ingress-ready label is what the ingress-nginx kind setup schedules on.
    controlPlane.kubeadmConfigPatches = ['kind: InitConfiguration\nnodeRegistration:\n  kubeletExtraArgs:\n    node-labels: "ingress-ready=true"\n'];
    controlPlane.extraPortMappings = [
      { containerPort: 80, hostPort: 80, protocol: 'TCP' },
      { containerPort: 443, hostPort: 443, protocol: 'TCP' }
    ];
  }
  const nodes = [controlPlane, ...Array.from({ length: options.workers }, () => (image ? { role: 'worker', image } : { role: 'worker' }))];
  return yaml.dump({ kind: 'Cluster', apiVersion: 'kind.x-k8s.io/v1alpha4', name: options.name, nodes }, { lineWidth: -1 });
}

export function k3dCreateArgs(options: LocalClusterOptions): string[] {
  const args = ['cluster', 'create', options.name, '--agents', String(options.workers), '--kubeconfig-update-default=false', '--kubeconfig-switch-context=false', '--wait'];
  if (options.version) {
    const v = options.version.replace(/^v?/, 'v');
    args.push('--image', `rancher/k3s:${v.includes('k3s') ? v : `${v}-k3s1`}`);
  }
  if (options.ingressPorts) {
    args.push('-p', '80:80@loadbalancer', '-p', '443:443@loadbalancer');
  }
  return args;
}

export function minikubeStartArgs(options: LocalClusterOptions): string[] {
  const args = ['start', '--profile', options.name, '--nodes', String(options.workers + 1)];
  if (options.version) {
    args.push('--kubernetes-version', options.version.replace(/^v?/, 'v'));
  }
  if (options.ingressPorts) {
    args.push('--addons', 'ingress', '--ports', '80:80,443:443');
  }
  return args;
}

export function parseKindClusters(stdout: string): LocalCluster[] {
  return stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('No kind clusters'))
    .map((name) => ({ engine: 'kind' as const, name, context: contextFor('kind', name) }));
}

export function parseK3dClusters(stdout: string): LocalCluster[] {
  try {
    return (JSON.parse(stdout) as Array<{ name: string; serversRunning?: number; serversCount?: number }>).map((c) => ({
      engine: 'k3d' as const,
      name: c.name,
      context: contextFor('k3d', c.name),
      status: c.serversRunning === undefined ? undefined : c.serversRunning > 0 ? 'running' : 'stopped'
    }));
  } catch {
    return [];
  }
}

export function parseMinikubeProfiles(stdout: string): LocalCluster[] {
  try {
    const parsed = JSON.parse(stdout) as { valid?: Array<{ Name: string; Status?: string }> };
    return (parsed.valid ?? []).map((p) => ({ engine: 'minikube' as const, name: p.Name, context: p.Name, status: p.Status?.toLowerCase() }));
  } catch {
    return [];
  }
}

export function tempKubeconfig(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openlens-local-'));
  return path.join(dir, 'kubeconfig');
}

export function engineQuickPickItems(installed: Record<Engine, boolean>): Array<vscode.QuickPickItem & { engine: Engine }> {
  return (Object.keys(ENGINES) as Engine[]).map((engine) => ({
    engine,
    label: ENGINES[engine].title,
    description: installed[engine] ? 'installed' : 'not installed — will offer to install',
    detail: ENGINES[engine].detail
  }));
}
