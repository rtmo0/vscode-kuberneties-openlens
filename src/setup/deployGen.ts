/* Manifests for "Deploy an Image": Deployment, Service, Ingress and HPA from a short form. */
import type { K8sObject } from '../core/cluster';

export interface DeployForm {
  name: string;
  namespace: string;
  image: string;
  port?: number;
  replicas: number;
  /** KEY=VALUE per line. */
  env: string;
  envFromSecret?: string;
  envFromConfigMap?: string;
  imagePullSecret?: string;
  resources: 'none' | 'small' | 'medium' | 'large';
  healthPath?: string;
  expose: 'none' | 'ClusterIP' | 'NodePort' | 'LoadBalancer';
  host?: string;
  path?: string;
  ingressClass?: string;
  /** cert-manager ClusterIssuer for a TLS certificate. */
  tlsIssuer?: string;
  hpa: boolean;
  hpaMin: number;
  hpaMax: number;
  hpaCpu: number;
}

export const RESOURCE_PRESETS: Record<DeployForm['resources'], { requests?: Record<string, string>; limits?: Record<string, string> }> = {
  none: {},
  small: { requests: { cpu: '50m', memory: '64Mi' }, limits: { memory: '128Mi' } },
  medium: { requests: { cpu: '250m', memory: '256Mi' }, limits: { memory: '512Mi' } },
  large: { requests: { cpu: '1', memory: '1Gi' }, limits: { memory: '2Gi' } }
};

export function parseEnvLines(text: string): Array<{ name: string; value: string }> {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => ({ name: l.slice(0, l.indexOf('=')).trim(), value: l.slice(l.indexOf('=') + 1).trim() }))
    .filter((e) => /^[A-Za-z_][A-Za-z0-9_.-]*$/.test(e.name));
}

export function validateDeployForm(form: DeployForm): string[] {
  const errors: string[] = [];
  if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(form.name)) {
    errors.push('Name: lowercase letters, digits and "-".');
  }
  if (!form.image.trim()) {
    errors.push('Image is required.');
  }
  if (form.host && (form.expose === 'none' || !form.port)) {
    errors.push('An ingress host needs a container port and a service.');
  }
  if (form.hpa && form.hpaMin > form.hpaMax) {
    errors.push('Autoscaling: min replicas must not exceed max replicas.');
  }
  if (form.hpa && form.resources === 'none') {
    errors.push('Autoscaling on CPU needs CPU requests: choose a resources preset.');
  }
  return errors;
}

export function generateDeployment(form: DeployForm): K8sObject[] {
  const labels = { 'app.kubernetes.io/name': form.name };
  const ns = form.namespace;
  const container: Record<string, unknown> = { name: form.name, image: form.image.trim() };
  if (form.port) {
    container.ports = [{ name: 'http', containerPort: form.port }];
  }
  const env = parseEnvLines(form.env);
  if (env.length) {
    container.env = env;
  }
  const envFrom = [
    ...(form.envFromSecret ? [{ secretRef: { name: form.envFromSecret } }] : []),
    ...(form.envFromConfigMap ? [{ configMapRef: { name: form.envFromConfigMap } }] : [])
  ];
  if (envFrom.length) {
    container.envFrom = envFrom;
  }
  const preset = RESOURCE_PRESETS[form.resources];
  if (preset.requests) {
    container.resources = preset;
  }
  if (form.port && form.healthPath) {
    container.readinessProbe = { httpGet: { path: form.healthPath, port: 'http' }, periodSeconds: 5 };
    container.livenessProbe = { httpGet: { path: form.healthPath, port: 'http' }, initialDelaySeconds: 15, periodSeconds: 10 };
  } else if (form.port) {
    container.readinessProbe = { tcpSocket: { port: 'http' }, periodSeconds: 5 };
  }

  const objects: K8sObject[] = [
    {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: form.name, namespace: ns, labels },
      spec: {
        replicas: form.hpa ? undefined : form.replicas,
        selector: { matchLabels: labels },
        template: {
          metadata: { labels },
          spec: {
            ...(form.imagePullSecret ? { imagePullSecrets: [{ name: form.imagePullSecret }] } : {}),
            containers: [container]
          }
        }
      }
    }
  ];
  if (form.hpa) {
    delete (objects[0].spec as Record<string, unknown>).replicas;
  }

  if (form.expose !== 'none' && form.port) {
    objects.push({
      apiVersion: 'v1',
      kind: 'Service',
      metadata: { name: form.name, namespace: ns, labels },
      spec: { type: form.expose, selector: labels, ports: [{ name: 'http', port: form.port === 80 ? 80 : form.port, targetPort: 'http' }] }
    });
  }

  if (form.host && form.port && form.expose !== 'none') {
    const ingress: K8sObject = {
      apiVersion: 'networking.k8s.io/v1',
      kind: 'Ingress',
      metadata: { name: form.name, namespace: ns, labels, ...(form.tlsIssuer ? { annotations: { 'cert-manager.io/cluster-issuer': form.tlsIssuer } } : {}) },
      spec: {
        ...(form.ingressClass ? { ingressClassName: form.ingressClass } : {}),
        rules: [
          {
            host: form.host,
            http: { paths: [{ path: form.path || '/', pathType: 'Prefix', backend: { service: { name: form.name, port: { name: 'http' } } } }] }
          }
        ],
        ...(form.tlsIssuer ? { tls: [{ hosts: [form.host], secretName: `${form.name}-tls` }] } : {})
      }
    };
    objects.push(ingress);
  }

  if (form.hpa) {
    objects.push({
      apiVersion: 'autoscaling/v2',
      kind: 'HorizontalPodAutoscaler',
      metadata: { name: form.name, namespace: ns, labels },
      spec: {
        scaleTargetRef: { apiVersion: 'apps/v1', kind: 'Deployment', name: form.name },
        minReplicas: form.hpaMin,
        maxReplicas: form.hpaMax,
        metrics: [{ type: 'Resource', resource: { name: 'cpu', target: { type: 'Utilization', averageUtilization: form.hpaCpu } } }]
      }
    });
  }
  return objects;
}
