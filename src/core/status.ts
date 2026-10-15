/* Status derivation that mirrors what kubectl and Lens display. */
import type { K8sObject } from './cluster';
import type { Tone } from './protocol';

const ERROR_REASONS = new Set([
  'CrashLoopBackOff',
  'Error',
  'ImagePullBackOff',
  'ErrImagePull',
  'InvalidImageName',
  'CreateContainerConfigError',
  'CreateContainerError',
  'RunContainerError',
  'OOMKilled',
  'Failed',
  'Evicted',
  'ContainerStatusUnknown',
  'Unknown',
  'NodeLost',
  'DeadlineExceeded',
  'BackoffLimitExceeded'
]);

export function reasonTone(reason: string): Tone {
  if (ERROR_REASONS.has(reason) || reason.startsWith('Init:Error') || reason.startsWith('Init:CrashLoop') || reason.startsWith('Signal:') || reason.startsWith('ExitCode:')) {
    return 'error';
  }
  if (reason === 'Running') {
    return 'ok';
  }
  if (reason === 'Completed' || reason === 'Succeeded') {
    return 'muted';
  }
  return 'warn';
}

/** The STATUS column of `kubectl get pods`. */
export function podStatus(pod: K8sObject): { text: string; tone: Tone } {
  const status = pod.status ?? {};
  let reason: string = status.reason || status.phase || 'Unknown';

  const initStatuses: any[] = status.initContainerStatuses ?? [];
  const initCount = (pod.spec?.initContainers ?? []).length;
  let initializing = false;
  initStatuses.forEach((c, i) => {
    if (initializing) {
      return;
    }
    const term = c.state?.terminated;
    const wait = c.state?.waiting;
    if (term && term.exitCode === 0) {
      return;
    }
    // Restartable init containers (sidecars) that are running count as done.
    if (c.started && c.state?.running) {
      return;
    }
    initializing = true;
    if (term) {
      reason = term.reason ? `Init:${term.reason}` : term.signal ? `Init:Signal:${term.signal}` : `Init:ExitCode:${term.exitCode}`;
    } else if (wait?.reason && wait.reason !== 'PodInitializing') {
      reason = `Init:${wait.reason}`;
    } else {
      reason = `Init:${i}/${initCount}`;
    }
  });

  if (!initializing) {
    let hasRunning = false;
    const containers: any[] = status.containerStatuses ?? [];
    for (let i = containers.length - 1; i >= 0; i -= 1) {
      const c = containers[i];
      if (c.state?.waiting?.reason) {
        reason = c.state.waiting.reason;
      } else if (c.state?.terminated) {
        const t = c.state.terminated;
        reason = t.reason || (t.signal ? `Signal:${t.signal}` : `ExitCode:${t.exitCode}`);
      } else if (c.ready && c.state?.running) {
        hasRunning = true;
      }
    }
    if (reason === 'Completed' && hasRunning) {
      reason = 'Running';
    }
  }

  if (pod.metadata.deletionTimestamp) {
    reason = status.reason === 'NodeLost' ? 'Unknown' : 'Terminating';
  }

  let tone = reasonTone(reason);
  if (reason === 'Running') {
    const ready = (status.containerStatuses ?? []).every((c: any) => c.ready);
    tone = ready ? 'ok' : 'warn';
  }
  if (reason === 'Terminating') {
    tone = 'muted';
  }
  return { text: reason, tone };
}

export function containerState(c: any): { text: string; tone: Tone } {
  if (!c) {
    return { text: 'Waiting', tone: 'warn' };
  }
  if (c.state?.running) {
    return c.ready ? { text: 'Running', tone: 'ok' } : { text: 'Running (not ready)', tone: 'warn' };
  }
  if (c.state?.waiting) {
    const reason = c.state.waiting.reason || 'Waiting';
    return { text: reason, tone: reasonTone(reason) };
  }
  if (c.state?.terminated) {
    const t = c.state.terminated;
    const text = t.reason || `ExitCode:${t.exitCode}`;
    return { text, tone: t.exitCode === 0 ? 'muted' : 'error' };
  }
  return { text: 'Unknown', tone: 'warn' };
}

export function containerDots(pod: K8sObject): Array<{ tone: Tone; title: string }> {
  const statuses = new Map<string, any>();
  for (const c of [...(pod.status?.initContainerStatuses ?? []), ...(pod.status?.containerStatuses ?? [])]) {
    statuses.set(c.name, c);
  }
  const dots: Array<{ tone: Tone; title: string }> = [];
  for (const c of pod.spec?.initContainers ?? []) {
    const state = containerState(statuses.get(c.name));
    dots.push({ tone: state.tone === 'muted' ? 'muted' : state.tone, title: `${c.name} (init): ${state.text}` });
  }
  for (const c of pod.spec?.containers ?? []) {
    const state = containerState(statuses.get(c.name));
    dots.push({ tone: state.tone, title: `${c.name}: ${state.text}` });
  }
  return dots;
}

export function podRestarts(pod: K8sObject): number {
  return (pod.status?.containerStatuses ?? []).reduce((sum: number, c: any) => sum + (c.restartCount ?? 0), 0);
}

export function podReady(pod: K8sObject): string {
  const statuses: any[] = pod.status?.containerStatuses ?? [];
  const total = (pod.spec?.containers ?? []).length;
  return `${statuses.filter((c) => c.ready).length}/${total}`;
}

export function nodeReady(node: K8sObject): boolean {
  return (node.status?.conditions ?? []).some((c: any) => c.type === 'Ready' && c.status === 'True');
}

export function nodeStatus(node: K8sObject): { text: string; tone: Tone } {
  const parts: string[] = [nodeReady(node) ? 'Ready' : 'NotReady'];
  if (node.spec?.unschedulable) {
    parts.push('SchedulingDisabled');
  }
  for (const c of node.status?.conditions ?? []) {
    if (c.type !== 'Ready' && c.status === 'True') {
      parts.push(c.type);
    }
  }
  const tone: Tone = !nodeReady(node) ? 'error' : parts.length > 1 ? 'warn' : 'ok';
  return { text: parts.join(', '), tone };
}

export function nodeRoles(node: K8sObject): string {
  const roles = Object.keys(node.metadata.labels ?? {})
    .filter((label) => label.startsWith('node-role.kubernetes.io/'))
    .map((label) => label.slice('node-role.kubernetes.io/'.length))
    .filter(Boolean);
  return roles.length ? roles.join(', ') : '<none>';
}

/** Health of a workload controller from its ready vs desired replicas. */
export function workloadHealth(obj: K8sObject, kindId: string): { ready: number; desired: number; tone: Tone } {
  const s = obj.status ?? {};
  let ready = 0;
  let desired = 0;
  switch (kindId) {
    case 'deployments':
    case 'statefulsets':
    case 'replicasets':
      desired = obj.spec?.replicas ?? 1;
      ready = s.readyReplicas ?? 0;
      break;
    case 'daemonsets':
      desired = s.desiredNumberScheduled ?? 0;
      ready = s.numberReady ?? 0;
      break;
    case 'jobs':
      desired = obj.spec?.completions ?? 1;
      ready = s.succeeded ?? 0;
      if ((s.conditions ?? []).some((c: any) => c.type === 'Failed' && c.status === 'True')) {
        return { ready, desired, tone: 'error' };
      }
      return { ready, desired, tone: ready >= desired ? 'muted' : s.active ? 'ok' : 'warn' };
    default:
      return { ready: 0, desired: 0, tone: 'muted' };
  }
  const tone: Tone = desired === 0 ? 'muted' : ready >= desired ? 'ok' : ready === 0 ? 'error' : 'warn';
  return { ready, desired, tone };
}

export function ownerOf(obj: K8sObject): { kind: string; name: string } | undefined {
  const owner = (obj.metadata.ownerReferences ?? []).find((o: any) => o.controller) ?? obj.metadata.ownerReferences?.[0];
  return owner ? { kind: owner.kind, name: owner.name } : undefined;
}

export function selectorString(selector: Record<string, string> | undefined): string {
  return Object.entries(selector ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join(',');
}

/** Turn a LabelSelector (matchLabels + matchExpressions) into the query syntax. */
export function labelSelectorString(selector: any): string {
  if (!selector) {
    return '';
  }
  const parts = Object.entries(selector.matchLabels ?? {}).map(([k, v]) => `${k}=${v}`);
  for (const expr of selector.matchExpressions ?? []) {
    const values = (expr.values ?? []).join(',');
    switch (expr.operator) {
      case 'In':
        parts.push(`${expr.key} in (${values})`);
        break;
      case 'NotIn':
        parts.push(`${expr.key} notin (${values})`);
        break;
      case 'Exists':
        parts.push(expr.key);
        break;
      case 'DoesNotExist':
        parts.push(`!${expr.key}`);
        break;
    }
  }
  return parts.join(',');
}

/** The pod selector of a workload or service, or undefined if it selects nothing. */
export function podSelectorOf(obj: K8sObject, kindId: string): string | undefined {
  if (kindId === 'services') {
    const s = selectorString(obj.spec?.selector);
    return s || undefined;
  }
  if (kindId === 'cronjobs') {
    return undefined;
  }
  const s = labelSelectorString(obj.spec?.selector);
  return s || undefined;
}
