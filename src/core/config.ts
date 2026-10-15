import * as vscode from 'vscode';

export interface OpenLensConfig {
  kubeconfig: string[];
  kubeconfigFolders: string[];
  confirmDangerousOperations: boolean;
  protectedContexts: string[];
  refreshInterval: number;
  logTailLines: number;
  logTimestamps: boolean;
  logViewer: 'panel' | 'terminal';
  shell: string;
  backupKubeconfig: boolean;
  portForwardAddress: string;
  openPortForwardInBrowser: boolean;
  nodeShellImage: string;
  nodeShellNamespace: string;
  debugImage: string;
  prometheus: Record<string, string>;
  checkPermissions: boolean;
}

const SECTION = 'openLens';

export function getConfig(): OpenLensConfig {
  const cfg = vscode.workspace.getConfiguration(SECTION);
  return {
    kubeconfig: cfg.get<string[]>('kubeconfig', []),
    kubeconfigFolders: cfg.get<string[]>('kubeconfigFolders', []),
    confirmDangerousOperations: cfg.get<boolean>('confirmDangerousOperations', true),
    protectedContexts: cfg.get<string[]>('protectedContexts', []),
    refreshInterval: Math.max(2, cfg.get<number>('refreshInterval', 5)),
    logTailLines: Math.max(0, cfg.get<number>('logs.tailLines', 500)),
    logTimestamps: cfg.get<boolean>('logs.timestamps', false),
    logViewer: cfg.get<'panel' | 'terminal'>('logs.viewer', 'panel'),
    shell: cfg.get<string>('shell', ''),
    backupKubeconfig: cfg.get<boolean>('backupKubeconfig', true),
    portForwardAddress: cfg.get<string>('portForward.address', '127.0.0.1'),
    openPortForwardInBrowser: cfg.get<boolean>('portForward.openInBrowser', false),
    nodeShellImage: cfg.get<string>('nodeShell.image', 'busybox:1.36'),
    nodeShellNamespace: cfg.get<string>('nodeShell.namespace', 'kube-system'),
    debugImage: cfg.get<string>('debug.image', 'busybox:1.36'),
    prometheus: cfg.get<Record<string, string>>('prometheus', {}),
    checkPermissions: cfg.get<boolean>('checkPermissions', true)
  };
}

export function onConfigChanged(listener: (config: OpenLensConfig, event: vscode.ConfigurationChangeEvent) => void): vscode.Disposable {
  return vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration(SECTION)) {
      listener(getConfig(), e);
    }
  });
}
