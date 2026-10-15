import * as fs from 'fs';
import * as path from 'path';
import { KubeConfig } from '@kubernetes/client-node';

import { dumpKubeconfig, emptyKubeconfig, parseKubeconfig, RawKubeconfig, resolveRelativePaths } from './kubeconfigModel';

const BACKUPS_TO_KEEP = 5;

/** Read a kubeconfig file; a missing file reads as an empty kubeconfig. */
export function readKubeconfigFile(file: string, options: { resolvePaths?: boolean } = {}): RawKubeconfig {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return emptyKubeconfig();
    }
    throw err;
  }
  const config = parseKubeconfig(text);
  return options.resolvePaths ? resolveRelativePaths(config, path.dirname(file)) : config;
}

/**
 * Write a kubeconfig file safely:
 *  - validates the result with the Kubernetes client first,
 *  - follows symlinks so a linked ~/.kube/config stays a link,
 *  - keeps a timestamped backup of the previous content (last 5 are kept),
 *  - writes to a temporary file and renames it, so a crash never leaves a
 *    half-written config,
 *  - keeps the existing file mode, or 0600 for a new file.
 *
 * Returns the backup path, if one was made.
 */
export function writeKubeconfigFile(file: string, config: RawKubeconfig, options: { backup?: boolean } = {}): string | undefined {
  const text = dumpKubeconfig(config);
  validateKubeconfigText(text);

  const target = resolveSymlink(file);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });

  let mode = 0o600;
  let backup: string | undefined;
  if (fs.existsSync(target)) {
    mode = fs.statSync(target).mode & 0o777;
    if (options.backup !== false) {
      backup = `${target}.backup-${timestamp()}`;
      fs.copyFileSync(target, backup);
      fs.chmodSync(backup, 0o600);
      pruneBackups(target);
    }
  }

  const temp = `${target}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(temp, text, { mode });
    fs.renameSync(temp, target);
  } catch (err) {
    fs.rmSync(temp, { force: true });
    throw err;
  }
  return backup;
}

export function validateKubeconfigText(text: string): void {
  const kc = new KubeConfig();
  kc.loadFromString(text);
}

function resolveSymlink(file: string): string {
  try {
    return fs.realpathSync(file);
  } catch {
    return file;
  }
}

function pruneBackups(target: string): void {
  const dir = path.dirname(target);
  const prefix = `${path.basename(target)}.backup-`;
  const backups = fs
    .readdirSync(dir)
    .filter((name) => name.startsWith(prefix))
    .sort();
  for (const name of backups.slice(0, Math.max(0, backups.length - BACKUPS_TO_KEEP))) {
    fs.rmSync(path.join(dir, name), { force: true });
  }
}

function timestamp(): string {
  const d = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}
