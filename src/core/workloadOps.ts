/* Rollout history / rollback, node drain, node shell, debug containers and file copy. */
import * as fs from 'fs';
import * as path from 'path';
import { PassThrough, Writable } from 'stream';
import { Exec } from '@kubernetes/client-node';
import * as tar from 'tar-fs';

import type { ClusterSession, K8sObject } from './cluster';
import { errorMessage, isNotFound, KubeApiError } from './kubeRest';
import { getKind, ResourceKind } from './resources';
import { labelSelectorString } from './status';

const CONTROLLER_REVISIONS: ResourceKind = {
  id: 'controllerrevisions',
  kind: 'ControllerRevision',
  group: 'apps',
  version: 'v1',
  plural: 'controllerrevisions',
  namespaced: true,
  title: 'Controller Revisions',
  category: 'workloads',
  icon: 'history'
};

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ─────────────────────────── rollout history ───────────────────────────

export interface Revision {
  revision: number;
  /** ReplicaSet or ControllerRevision name. */
  name: string;
  created?: string;
  images: string;
  changeCause?: string;
  current: boolean;
  /** Pod template of the revision, for diffs. */
  template: unknown;
}

export const ROLLOUT_KINDS = new Set(['deployments', 'statefulsets', 'daemonsets']);

function owned(items: K8sObject[], owner: K8sObject): K8sObject[] {
  return items.filter((item) => (item.metadata.ownerReferences ?? []).some((ref: any) => ref.uid === owner.metadata.uid));
}

function templateImages(template: any): string {
  return (template?.spec?.containers ?? []).map((c: any) => c.image).join(', ');
}

/** Pod template without the label the controller adds, as `kubectl rollout undo` uses it. */
function cleanTemplate(template: any): any {
  const copy = JSON.parse(JSON.stringify(template ?? {}));
  if (copy.metadata?.labels) {
    delete copy.metadata.labels['pod-template-hash'];
    delete copy.metadata.labels['controller-revision-hash'];
  }
  return copy;
}

export async function rolloutHistory(session: ClusterSession, kindId: string, obj: K8sObject): Promise<Revision[]> {
  const ns = obj.metadata.namespace ?? '';
  const selector = labelSelectorString(obj.spec?.selector);
  if (kindId === 'deployments') {
    const sets = owned((await session.list(getKind('replicasets')!, ns, { labelSelector: selector })).items, obj);
    const currentRevision = obj.metadata.annotations?.['deployment.kubernetes.io/revision'];
    return sets
      .map((rs) => {
        const revision = Number(rs.metadata.annotations?.['deployment.kubernetes.io/revision'] ?? 0);
        return {
          revision,
          name: rs.metadata.name,
          created: rs.metadata.creationTimestamp,
          images: templateImages(rs.spec?.template),
          changeCause: rs.metadata.annotations?.['kubernetes.io/change-cause'],
          current: String(revision) === currentRevision,
          template: cleanTemplate(rs.spec?.template)
        };
      })
      .sort((a, b) => b.revision - a.revision);
  }
  const revisions = owned((await session.list(CONTROLLER_REVISIONS, ns, { labelSelector: selector })).items, obj).sort(
    (a, b) => (b.revision ?? 0) - (a.revision ?? 0)
  );
  const currentName = kindId === 'statefulsets' ? obj.status?.updateRevision ?? obj.status?.currentRevision : revisions[0]?.metadata.name;
  return revisions.map((cr) => ({
    revision: cr.revision ?? 0,
    name: cr.metadata.name,
    created: cr.metadata.creationTimestamp,
    images: templateImages(cr.data?.spec?.template),
    changeCause: cr.metadata.annotations?.['kubernetes.io/change-cause'],
    current: cr.metadata.name === currentName,
    template: cleanTemplate(cr.data?.spec?.template)
  }));
}

/** `kubectl rollout undo --to-revision`. */
export async function rollbackTo(session: ClusterSession, kind: ResourceKind, obj: K8sObject, revision: number): Promise<void> {
  const ns = obj.metadata.namespace;
  if (kind.id === 'deployments') {
    const history = await rolloutHistory(session, kind.id, obj);
    const target = history.find((r) => r.revision === revision);
    if (!target) {
      throw new Error(`Revision ${revision} of ${obj.metadata.name} was not found.`);
    }
    await session.patch(kind, obj.metadata.name, ns, [{ op: 'replace', path: '/spec/template', value: target.template }], 'json');
    return;
  }
  const revisions = owned((await session.list(CONTROLLER_REVISIONS, ns ?? '', { labelSelector: labelSelectorString(obj.spec?.selector) })).items, obj);
  const target = revisions.find((cr) => cr.revision === revision);
  if (!target) {
    throw new Error(`Revision ${revision} of ${obj.metadata.name} was not found.`);
  }
  // ControllerRevision data is the strategic merge patch that restores the template.
  await session.patch(kind, obj.metadata.name, ns, target.data, 'strategic');
}

// ─────────────────────────── drain ───────────────────────────

export interface DrainPlan {
  evict: K8sObject[];
  daemonSet: K8sObject[];
  mirror: K8sObject[];
  unmanaged: K8sObject[];
  emptyDir: K8sObject[];
}

export async function planDrain(session: ClusterSession, nodeName: string): Promise<DrainPlan> {
  const pods = (await session.list(getKind('pods')!, '', { fieldSelector: `spec.nodeName=${nodeName}` })).items;
  const plan: DrainPlan = { evict: [], daemonSet: [], mirror: [], unmanaged: [], emptyDir: [] };
  for (const pod of pods) {
    if (pod.metadata.annotations?.['kubernetes.io/config.mirror']) {
      plan.mirror.push(pod);
      continue;
    }
    const controller = (pod.metadata.ownerReferences ?? []).find((ref: any) => ref.controller);
    if (controller?.kind === 'DaemonSet') {
      plan.daemonSet.push(pod);
      continue;
    }
    if (!controller && pod.status?.phase !== 'Succeeded' && pod.status?.phase !== 'Failed') {
      plan.unmanaged.push(pod);
    }
    if ((pod.spec?.volumes ?? []).some((v: any) => v.emptyDir)) {
      plan.emptyDir.push(pod);
    }
    plan.evict.push(pod);
  }
  return plan;
}

export interface DrainProgress {
  report: (message: string) => void;
  cancelled: () => boolean;
}

/**
 * Evict the pods of a cordoned node, honouring PodDisruptionBudgets: an
 * eviction refused with 429 is retried until the timeout, like `kubectl drain`.
 */
export async function evictPods(session: ClusterSession, pods: K8sObject[], progress: DrainProgress, timeoutMs = 5 * 60_000): Promise<{ evicted: number; failed: string[] }> {
  const deadline = Date.now() + timeoutMs;
  const failed: string[] = [];
  let evicted = 0;
  await Promise.all(
    pods.map(async (pod) => {
      const { name, namespace } = pod.metadata;
      for (;;) {
        if (progress.cancelled()) {
          failed.push(`${namespace}/${name}: cancelled`);
          return;
        }
        try {
          await session.rest.json('POST', `/api/v1/namespaces/${encodeURIComponent(namespace!)}/pods/${encodeURIComponent(name)}/eviction`, {
            body: { apiVersion: 'policy/v1', kind: 'Eviction', metadata: { name, namespace } }
          });
          evicted += 1;
          progress.report(`Evicted ${evicted}/${pods.length}: ${namespace}/${name}`);
          return;
        } catch (err) {
          if (isNotFound(err)) {
            evicted += 1;
            return;
          }
          if (err instanceof KubeApiError && err.status === 429 && Date.now() < deadline) {
            progress.report(`Waiting for the disruption budget of ${namespace}/${name}…`);
            await wait(5000);
            continue;
          }
          failed.push(`${namespace}/${name}: ${errorMessage(err)}`);
          return;
        }
      }
    })
  );
  // Wait for the evicted pods to be gone.
  const remaining = new Set(pods.map((p) => `${p.metadata.namespace}/${p.metadata.name}`));
  while (remaining.size && Date.now() < deadline && !progress.cancelled()) {
    for (const key of [...remaining]) {
      const [ns, name] = key.split('/');
      try {
        const pod = await session.get(getKind('pods')!, name, ns);
        if (!pods.some((p) => p.metadata.uid === pod.metadata.uid)) {
          remaining.delete(key);
        }
      } catch (err) {
        if (isNotFound(err)) {
          remaining.delete(key);
        }
      }
    }
    if (remaining.size) {
      progress.report(`Waiting for ${remaining.size} pod(s) to terminate…`);
      await wait(2000);
    }
  }
  return { evicted, failed };
}

// ─────────────────────────── node shell ───────────────────────────

/** Runs a host shell from a privileged pod sharing the node's PID namespace. */
export const NODE_SHELL_COMMAND = ['nsenter', '-t', '1', '-m', '-u', '-i', '-n', '-p', '--', 'sh', '-c', 'clear; (bash || ash || sh)'];

export async function createNodeShellPod(session: ClusterSession, nodeName: string, image: string, namespace: string): Promise<string> {
  const suffix = Math.random().toString(36).slice(2, 7);
  const name = `node-shell-${nodeName.replace(/[^a-z0-9-]/g, '-').slice(0, 40)}-${suffix}`;
  await session.create(getKind('pods')!, {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: { name, namespace, labels: { 'app.kubernetes.io/managed-by': 'openlens-vscode', 'openlens.dev/node-shell': 'true' } },
    spec: {
      nodeName,
      hostPID: true,
      hostNetwork: true,
      hostIPC: true,
      restartPolicy: 'Never',
      terminationGracePeriodSeconds: 0,
      priorityClassName: 'system-node-critical',
      tolerations: [{ operator: 'Exists' }],
      containers: [
        {
          name: 'shell',
          image,
          command: ['sleep', '14400'],
          stdin: true,
          tty: true,
          securityContext: { privileged: true }
        }
      ]
    }
  } as K8sObject);
  await waitForContainer(session, namespace, name, (pod) => pod.status?.containerStatuses?.find((c: any) => c.name === 'shell'));
  return name;
}

/** Wait until a container is running; fail fast on pull errors. */
async function waitForContainer(session: ClusterSession, namespace: string, pod: string, status: (pod: K8sObject) => any, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const obj = await session.get(getKind('pods')!, pod, namespace);
    const st = status(obj);
    if (st?.state?.running) {
      return;
    }
    const reason = st?.state?.waiting?.reason ?? st?.state?.terminated?.reason;
    if (reason && /ErrImagePull|ImagePullBackOff|InvalidImageName|CreateContainerError|Error|Completed/.test(reason)) {
      throw new Error(`Container failed to start: ${reason}${st?.state?.waiting?.message ? ` — ${st.state.waiting.message}` : ''}`);
    }
    if (obj.status?.phase === 'Failed') {
      throw new Error(`Pod ${pod} failed: ${obj.status?.reason ?? obj.status?.message ?? 'unknown reason'}`);
    }
    await wait(1000);
  }
  throw new Error(`Timed out waiting for ${pod} to start.`);
}

// ─────────────────────────── debug containers ───────────────────────────

/** `kubectl debug -it --target=<container>`: adds an ephemeral container and returns its name. */
export async function addDebugContainer(session: ClusterSession, namespace: string, pod: string, targetContainer: string | undefined, image: string): Promise<string> {
  const name = `debugger-${Math.random().toString(36).slice(2, 7)}`;
  await session.rest.json('PATCH', `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods/${encodeURIComponent(pod)}/ephemeralcontainers`, {
    contentType: 'application/strategic-merge-patch+json',
    body: {
      spec: {
        ephemeralContainers: [
          {
            name,
            image,
            targetContainerName: targetContainer,
            stdin: true,
            tty: true,
            terminationMessagePolicy: 'File',
            imagePullPolicy: 'IfNotPresent'
          }
        ]
      }
    }
  });
  await waitForContainer(session, namespace, pod, (obj) => obj.status?.ephemeralContainerStatuses?.find((c: any) => c.name === name));
  return name;
}

// ─────────────────────────── file copy ───────────────────────────

function execToCompletion(
  session: ClusterSession,
  namespace: string,
  pod: string,
  container: string,
  command: string[],
  stdout: Writable | null,
  stdin: NodeJS.ReadableStream | null
): Promise<void> {
  const stderr: Buffer[] = [];
  const errStream = new Writable({
    write: (chunk: Buffer, _encoding, callback) => {
      stderr.push(chunk);
      callback();
    }
  });
  return new Promise<void>((resolve, reject) => {
    new Exec(session.kc)
      .exec(namespace, pod, container, command, stdout, errStream, stdin as any, false, (status) => {
        if (status.status === 'Success') {
          resolve();
        } else {
          const text = Buffer.concat(stderr).toString('utf8').trim();
          reject(new Error(text || status.message || 'The command failed.'));
        }
      })
      .catch(reject);
  });
}

/** Copy a file or folder from a container into `localDir` (needs `tar` in the container). */
export async function downloadFromContainer(session: ClusterSession, namespace: string, pod: string, container: string, remotePath: string, localDir: string): Promise<string> {
  const clean = remotePath.replace(/\/+$/, '') || '/';
  const parent = path.posix.dirname(clean);
  const base = path.posix.basename(clean);
  fs.mkdirSync(localDir, { recursive: true });
  const extract = tar.extract(localDir);
  const finished = new Promise<void>((resolve, reject) => {
    extract.on('finish', () => resolve());
    extract.on('error', reject);
  });
  const sink = new PassThrough();
  sink.pipe(extract);
  await execToCompletion(session, namespace, pod, container, ['tar', 'cf', '-', '-C', parent, base], sink, null);
  sink.end();
  await finished;
  return path.join(localDir, base);
}

/** Copy a local file or folder into `remoteDir` of a container (needs `tar` in the container). */
export async function uploadToContainer(session: ClusterSession, namespace: string, pod: string, container: string, localPath: string, remoteDir: string): Promise<void> {
  const pack = tar.pack(path.dirname(localPath), { entries: [path.basename(localPath)] });
  await execToCompletion(session, namespace, pod, container, ['tar', 'xf', '-', '-C', remoteDir], null, pack as unknown as NodeJS.ReadableStream);
}
