import * as net from 'net';
import { Writable } from 'stream';
import * as vscode from 'vscode';
import { PortForward } from '@kubernetes/client-node';

import type { ClusterManager, K8sObject } from './cluster';
import { errorMessage } from './kubeRest';
import { logger } from './logger';
import { getKind } from './resources';
import { selectorString } from './status';

export interface PortForwardSpec {
  context: string;
  namespace: string;
  /** Forward to a pod directly, or to a ready pod behind a service. */
  target: 'pod' | 'service';
  name: string;
  /** Container port for pods, service port for services. */
  remotePort: number;
  /** 0 picks a free port. */
  localPort: number;
  address: string;
}

export interface ActivePortForward extends PortForwardSpec {
  id: string;
  localPort: number;
  connections: number;
  startedAt: number;
  lastError?: string;
}

interface Entry {
  info: ActivePortForward;
  server: net.Server;
  sockets: Set<net.Socket>;
}

/** Minimal shape of the websocket returned by the client. */
interface Socketish {
  on(event: 'close' | 'error', listener: (...args: unknown[]) => void): void;
  close(): void;
}

/**
 * Port forwarding without kubectl: a local TCP server whose every connection
 * gets its own port-forward websocket to the pod. Service forwards resolve a
 * ready pod per connection, so they survive pod restarts and rollouts.
 */
export class PortForwardManager implements vscode.Disposable {
  private readonly entries = new Map<string, Entry>();
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changeEmitter.event;
  private counter = 0;

  constructor(private readonly clusters: ClusterManager) {}

  list(): ActivePortForward[] {
    return [...this.entries.values()].map((e) => e.info);
  }

  find(spec: Pick<PortForwardSpec, 'context' | 'namespace' | 'target' | 'name' | 'remotePort'>): ActivePortForward | undefined {
    return this.list().find(
      (f) =>
        f.context === spec.context &&
        f.namespace === spec.namespace &&
        f.target === spec.target &&
        f.name === spec.name &&
        f.remotePort === spec.remotePort
    );
  }

  async start(spec: PortForwardSpec): Promise<ActivePortForward> {
    const existing = this.find(spec);
    if (existing) {
      return existing;
    }
    const session = this.clusters.session(spec.context);
    const resolver = spec.target === 'service' ? await this.serviceResolver(spec) : async () => ({ pod: spec.name, port: spec.remotePort });

    const id = `pf-${++this.counter}`;
    const sockets = new Set<net.Socket>();
    const info: ActivePortForward = { ...spec, id, connections: 0, startedAt: Date.now() };
    const forwarder = new PortForward(session.kc, true);

    const server = net.createServer((socket) => {
      sockets.add(socket);
      info.connections += 1;
      this.changeEmitter.fire();
      socket.on('error', () => socket.destroy());
      socket.on('close', () => {
        sockets.delete(socket);
        info.connections -= 1;
        this.changeEmitter.fire();
      });

      void (async () => {
        try {
          const target = await resolver();
          const errors = new Writable({
            write: (chunk: Buffer, _encoding, callback) => {
              const message = chunk.toString('utf8').trim();
              if (message) {
                info.lastError = message;
                logger.warn(`Port forward ${describe(info)}: ${message}`);
                this.changeEmitter.fire();
              }
              callback();
            }
          });
          const ws = (await forwarder.portForward(spec.namespace, target.pod, [target.port], socket, errors, socket)) as unknown as Socketish;
          ws.on('close', () => socket.destroy());
          ws.on('error', () => socket.destroy());
          socket.on('close', () => ws.close());
          if (info.lastError) {
            info.lastError = undefined;
            this.changeEmitter.fire();
          }
        } catch (err) {
          info.lastError = errorMessage(err);
          logger.error(`Port forward ${describe(info)} failed`, info.lastError);
          this.changeEmitter.fire();
          socket.destroy();
        }
      })();
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', (err: NodeJS.ErrnoException) => {
        reject(
          err.code === 'EADDRINUSE'
            ? new Error(`Local port ${spec.localPort} is already in use.`)
            : err.code === 'EACCES'
              ? new Error(`No permission to listen on port ${spec.localPort}.`)
              : err
        );
      });
      server.listen(spec.localPort, spec.address, () => resolve());
    });
    server.on('error', (err) => logger.error(`Port forward ${describe(info)} server error`, err.message));

    info.localPort = (server.address() as net.AddressInfo).port;
    this.entries.set(id, { info, server, sockets });
    logger.info(`Port forward started: ${describe(info)}`);
    this.changeEmitter.fire();
    return info;
  }

  stop(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) {
      return;
    }
    this.entries.delete(id);
    for (const socket of entry.sockets) {
      socket.destroy();
    }
    entry.server.close();
    logger.info(`Port forward stopped: ${describe(entry.info)}`);
    this.changeEmitter.fire();
  }

  stopAll(context?: string): void {
    for (const entry of [...this.entries.values()]) {
      if (!context || entry.info.context === context) {
        this.stop(entry.info.id);
      }
    }
  }

  /** Resolve the service port to a container port of a ready pod, per connection. */
  private async serviceResolver(spec: PortForwardSpec): Promise<() => Promise<{ pod: string; port: number }>> {
    const session = this.clusters.session(spec.context);
    const service = await session.get(getKind('services')!, spec.name, spec.namespace);
    const selector = selectorString(service.spec?.selector);
    if (!selector) {
      throw new Error(`Service ${spec.name} has no selector, so it has no pods to forward to.`);
    }
    const servicePort = (service.spec?.ports ?? []).find((p: any) => p.port === spec.remotePort);
    if (!servicePort) {
      throw new Error(`Service ${spec.name} has no port ${spec.remotePort}.`);
    }
    const targetPort = servicePort.targetPort ?? servicePort.port;

    return async () => {
      const pods = await session.list(getKind('pods')!, spec.namespace, { labelSelector: selector });
      const pod = pods.items.find(isPodReady) ?? pods.items.find((p) => p.status?.phase === 'Running');
      if (!pod) {
        throw new Error(`No running pods behind service ${spec.name}.`);
      }
      return { pod: pod.metadata.name, port: resolveContainerPort(pod, targetPort) };
    };
  }

  dispose(): void {
    this.stopAll();
    this.changeEmitter.dispose();
  }
}

function isPodReady(pod: K8sObject): boolean {
  return (
    pod.status?.phase === 'Running' &&
    !pod.metadata.deletionTimestamp &&
    (pod.status?.conditions ?? []).some((c: any) => c.type === 'Ready' && c.status === 'True')
  );
}

/** A named targetPort refers to a container port name. */
export function resolveContainerPort(pod: K8sObject, port: number | string): number {
  if (typeof port === 'number') {
    return port;
  }
  if (/^\d+$/.test(port)) {
    return Number(port);
  }
  for (const container of pod.spec?.containers ?? []) {
    const match = (container.ports ?? []).find((p: any) => p.name === port);
    if (match) {
      return match.containerPort;
    }
  }
  throw new Error(`Pod ${pod.metadata.name} has no container port named "${port}".`);
}

export function describe(f: ActivePortForward | PortForwardSpec): string {
  return `${f.address}:${f.localPort} → ${f.target}/${f.name}:${f.remotePort} (${f.context}/${f.namespace})`;
}

export function forwardUrl(f: ActivePortForward): string {
  const host = f.address === '0.0.0.0' || f.address === '127.0.0.1' ? 'localhost' : f.address;
  const scheme = f.remotePort === 443 || f.remotePort === 8443 ? 'https' : 'http';
  return `${scheme}://${host}:${f.localPort}`;
}
