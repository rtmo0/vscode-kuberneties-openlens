/* Installing k3s on your own machines over SSH. */
import { dumpKubeconfig, parseKubeconfig } from '../core/kubeconfigModel';

export interface K3sServerOptions {
  /** ssh destination: host, user@host or an alias from ~/.ssh/config. */
  target: string;
  port?: number;
  /** Address clients use for the API server (goes into the certificate and the kubeconfig). */
  address: string;
  /** "stable", "latest" or a version such as v1.31.4+k3s1. */
  channel: string;
  disableTraefik: boolean;
  clusterName: string;
}

const KUBECONFIG_COPY = '~/.kube/openlens-k3s.yaml';
const TOKEN_COPY = '~/.kube/openlens-k3s-token';

const quote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

function installEnv(channel: string): string {
  return /^v\d/.test(channel) ? `INSTALL_K3S_VERSION=${quote(channel)}` : `INSTALL_K3S_CHANNEL=${quote(channel || 'stable')}`;
}

/** Host part of an ssh destination ("user@host" → "host"). */
export function hostOf(target: string): string {
  return target.includes('@') ? target.slice(target.lastIndexOf('@') + 1) : target;
}

export function sshArgs(target: string, port: number | undefined, interactive: boolean): string[] {
  return [...(interactive ? ['-t'] : ['-o', 'BatchMode=yes']), ...(port ? ['-p', String(port)] : []), '-o', 'StrictHostKeyChecking=accept-new', target];
}

/**
 * Installs the k3s server and leaves a copy of the admin kubeconfig and the
 * join token in the user's ~/.kube (mode 600), so they can be fetched over
 * ssh without another sudo prompt.
 */
export function serverScript(options: K3sServerOptions): string {
  const extra = options.disableTraefik ? ' --disable traefik' : '';
  return [
    'set -e',
    'SUDO=""; if [ "$(id -u)" -ne 0 ]; then SUDO=sudo; fi',
    'echo "Installing k3s server on $(hostname)…"',
    `curl -sfL https://get.k3s.io | $SUDO env ${installEnv(options.channel)} sh -s - server --tls-san ${quote(options.address)} --write-kubeconfig-mode 600${extra}`,
    'mkdir -p ~/.kube && chmod 700 ~/.kube',
    `$SUDO cat /etc/rancher/k3s/k3s.yaml > ${KUBECONFIG_COPY}`,
    `$SUDO cat /var/lib/rancher/k3s/server/node-token > ${TOKEN_COPY}`,
    `chmod 600 ${KUBECONFIG_COPY} ${TOKEN_COPY}`,
    'echo "Waiting for the node to become ready…"',
    'for i in $(seq 1 60); do if $SUDO k3s kubectl get nodes 2>/dev/null | grep -q " Ready"; then break; fi; sleep 2; done',
    '$SUDO k3s kubectl get nodes'
  ].join('\n');
}

export function agentScript(serverUrl: string, token: string, channel: string): string {
  return [
    'set -e',
    'SUDO=""; if [ "$(id -u)" -ne 0 ]; then SUDO=sudo; fi',
    'echo "Joining $(hostname) to the k3s cluster…"',
    `curl -sfL https://get.k3s.io | $SUDO env ${installEnv(channel)} K3S_URL=${quote(serverUrl)} K3S_TOKEN=${quote(token)} sh -s - agent`
  ].join('\n');
}

export const FETCH_KUBECONFIG = `cat ${KUBECONFIG_COPY}`;
export const FETCH_TOKEN = `cat ${TOKEN_COPY}`;
export const CLEANUP_COPIES = `rm -f ${KUBECONFIG_COPY} ${TOKEN_COPY}`;

/** Point the k3s kubeconfig at the server address and rename its "default" entries. */
export function rewriteK3sKubeconfig(text: string, address: string, name: string): string {
  const config = parseKubeconfig(text);
  const host = address.includes(':') && !address.startsWith('[') ? `[${address}]` : address;
  for (const cluster of config.clusters) {
    const server = String(cluster.cluster.server ?? '');
    cluster.cluster.server = server.replace(/\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?/, `//${host}$2`);
    cluster.name = name;
  }
  for (const user of config.users) {
    user.name = `${name}-admin`;
  }
  for (const ctx of config.contexts) {
    ctx.name = name;
    ctx.context.cluster = name;
    ctx.context.user = `${name}-admin`;
  }
  config['current-context'] = name;
  return dumpKubeconfig(config);
}

/** Remote command for an interactive ssh session that keeps the output visible until Enter is pressed. */
export function interactiveRemote(script: string): string {
  return `sh -c ${quote(script)}; status=$?; echo; if [ $status -eq 0 ]; then echo "✔ Done. Press Enter to continue."; else echo "✖ Failed with exit code $status. Press Enter to close."; fi; read -r _; exit $status`;
}
