import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { KubeConfig } from '@kubernetes/client-node';

import { getConfig } from './config';
import { readKubeconfigFile } from './kubeconfigFiles';
import { dumpKubeconfig, expandHome, LoadedFile, mergeFiles, MergedKubeconfig } from './kubeconfigModel';

/** Resolve the kubeconfig files to load: the setting, then $KUBECONFIG, then ~/.kube/config. */
export function kubeconfigPaths(): string[] {
  const configured = getConfig().kubeconfig.filter((p) => p.trim().length > 0);
  if (configured.length > 0) {
    return configured.map((p) => path.resolve(expandHome(p.trim())));
  }
  const env = process.env.KUBECONFIG;
  if (env) {
    const files = env.split(path.delimiter).filter(Boolean);
    if (files.length > 0) {
      return files.map((p) => path.resolve(expandHome(p)));
    }
  }
  return [path.join(os.homedir(), '.kube', 'config')];
}

/** Folders whose files are all loaded as kubeconfigs (like Lens kubeconfig syncs). */
export function kubeconfigFolders(): string[] {
  return getConfig()
    .kubeconfigFolders.filter((p) => p.trim())
    .map((p) => path.resolve(expandHome(p.trim())));
}

/** Files found in the synced folders; backups, temp and hidden files are skipped. */
export function folderKubeconfigFiles(): string[] {
  const files: string[] = [];
  for (const dir of kubeconfigFolders()) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const name = entry.name;
      if (name.startsWith('.') || /\.(backup-\d|tmp-|bak$|swp$|orig$)/.test(name) || /\.(md|txt|pem|crt|key)$/i.test(name)) {
        continue;
      }
      const full = path.join(dir, name);
      try {
        if (fs.statSync(full).isFile()) {
          files.push(full);
        }
      } catch {
        // broken symlink
      }
    }
  }
  return files.sort();
}

/** Every file that makes up the merged kubeconfig, in merge order. */
export function allKubeconfigFiles(): string[] {
  const main = kubeconfigPaths();
  return [...main, ...folderKubeconfigFiles().filter((f) => !main.includes(f))];
}

/** The file new contexts are written to (the first one, as kubectl does). */
export function primaryKubeconfigPath(): string {
  return kubeconfigPaths()[0];
}

export interface KubeconfigState extends MergedKubeconfig {
  files: string[];
  errors: string[];
}

/** Load and merge every kubeconfig file; files that fail to load are reported, not fatal. */
export function loadKubeconfigs(): KubeconfigState {
  const files = allKubeconfigFiles();
  const loaded: LoadedFile[] = [];
  const errors: string[] = [];
  for (const file of files) {
    try {
      loaded.push({ path: file, config: readKubeconfigFile(file, { resolvePaths: true }) });
    } catch (err) {
      errors.push(`${file}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { ...mergeFiles(loaded), files, errors };
}

/** Build a client KubeConfig bound to one context of the merged kubeconfig. */
export function buildKubeConfig(state: KubeconfigState, contextName: string): KubeConfig {
  const kc = new KubeConfig();
  kc.loadFromString(dumpKubeconfig({ ...state.config, 'current-context': contextName }));
  kc.setCurrentContext(contextName);
  return kc;
}
