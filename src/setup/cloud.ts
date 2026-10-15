/* Managed clusters: list them with the provider CLI and fetch a kubeconfig. */
import type { ToolName } from './tools';

export type Provider = 'yc' | 'aws' | 'gcloud' | 'az';

export interface CloudCluster {
  provider: Provider;
  id: string;
  name: string;
  location?: string;
  status?: string;
  /** Extra identifiers needed to fetch credentials (resource group, region…). */
  scope?: string;
}

export const PROVIDERS: Record<Provider, { title: string; tool: ToolName; detail: string }> = {
  yc: { title: 'Yandex Managed Service for Kubernetes', tool: 'yc', detail: 'yc managed-kubernetes cluster get-credentials' },
  aws: { title: 'Amazon EKS', tool: 'aws', detail: 'aws eks update-kubeconfig' },
  gcloud: { title: 'Google Kubernetes Engine', tool: 'gcloud', detail: 'gcloud container clusters get-credentials' },
  az: { title: 'Azure Kubernetes Service', tool: 'az', detail: 'az aks get-credentials' }
};

export function listArgs(provider: Provider, scope?: string): string[] {
  switch (provider) {
    case 'yc':
      return ['managed-kubernetes', 'cluster', 'list', '--format', 'json', ...(scope ? ['--folder-id', scope] : [])];
    case 'aws':
      return ['eks', 'list-clusters', '--output', 'json', ...(scope ? ['--region', scope] : [])];
    case 'gcloud':
      return ['container', 'clusters', 'list', '--format=json', ...(scope ? ['--project', scope] : [])];
    case 'az':
      return ['aks', 'list', '-o', 'json'];
  }
}

export function parseClusters(provider: Provider, stdout: string, scope?: string): CloudCluster[] {
  const data = stdout.trim() ? JSON.parse(stdout) : [];
  switch (provider) {
    case 'yc':
      return (data as any[]).map((c) => ({
        provider,
        id: c.id,
        name: c.name,
        status: c.status,
        location: c.master?.zonal_master?.zone_id ?? c.master?.regional_master?.region_id ?? c.master?.locations?.[0]?.zone_id,
        scope: c.master?.endpoints?.external_v4_endpoint ? 'external' : 'internal'
      }));
    case 'aws':
      return ((data.clusters ?? []) as string[]).map((name) => ({ provider, id: name, name, location: scope, scope }));
    case 'gcloud':
      return (data as any[]).map((c) => ({ provider, id: c.name, name: c.name, status: c.status, location: c.location ?? c.zone, scope: c.location ?? c.zone }));
    case 'az':
      return (data as any[]).map((c) => ({ provider, id: c.id ?? c.name, name: c.name, status: c.powerState?.code ?? c.provisioningState, location: c.location, scope: c.resourceGroup }));
  }
}

/** Command that writes the cluster's kubeconfig to `file` (gcloud uses $KUBECONFIG instead). */
export function credentialArgs(cluster: CloudCluster, file: string, options: { internal?: boolean } = {}): { args: string[]; env?: Record<string, string> } {
  switch (cluster.provider) {
    case 'yc':
      return { args: ['managed-kubernetes', 'cluster', 'get-credentials', '--id', cluster.id, options.internal ? '--internal' : '--external', '--kubeconfig', file, '--force'] };
    case 'aws':
      return { args: ['eks', 'update-kubeconfig', '--name', cluster.name, ...(cluster.scope ? ['--region', cluster.scope] : []), '--kubeconfig', file, '--alias', cluster.name] };
    case 'gcloud':
      return { args: ['container', 'clusters', 'get-credentials', cluster.name, '--location', cluster.scope ?? ''], env: { KUBECONFIG: file } };
    case 'az':
      return { args: ['aks', 'get-credentials', '--name', cluster.name, '--resource-group', cluster.scope ?? '', '--file', file, '--overwrite-existing'] };
  }
}

/** Context name to suggest, e.g. "yc-prod" or "eks-api". */
export function suggestedContext(cluster: CloudCluster): string {
  const prefix = { yc: 'yc', aws: 'eks', gcloud: 'gke', az: 'aks' }[cluster.provider];
  return `${prefix}-${cluster.name}`;
}
