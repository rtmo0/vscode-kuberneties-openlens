/* Finding, running and installing the command-line tools the setup wizards drive. */
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import { logger } from '../core/logger';

export type ToolName = 'kind' | 'k3d' | 'minikube' | 'helm' | 'yc' | 'aws' | 'gcloud' | 'az' | 'ssh' | 'docker' | 'kubectl';

interface ToolInfo {
  title: string;
  brew?: string;
  /** Install command for when Homebrew is not available. */
  script?: string;
  docs: string;
}

export const TOOLS: Record<ToolName, ToolInfo> = {
  kind: { title: 'kind', brew: 'kind', docs: 'https://kind.sigs.k8s.io/docs/user/quick-start/#installation' },
  k3d: { title: 'k3d', brew: 'k3d', script: 'curl -s https://raw.githubusercontent.com/k3d-io/k3d/main/install.sh | bash', docs: 'https://k3d.io/#installation' },
  minikube: { title: 'minikube', brew: 'minikube', docs: 'https://minikube.sigs.k8s.io/docs/start/' },
  helm: { title: 'Helm', brew: 'helm', script: 'curl -fsSL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash', docs: 'https://helm.sh/docs/intro/install/' },
  yc: { title: 'Yandex Cloud CLI', script: 'curl -sSL https://storage.yandexcloud.net/yandexcloud-yc/install.sh | bash', docs: 'https://yandex.cloud/docs/cli/quickstart' },
  aws: { title: 'AWS CLI', brew: 'awscli', docs: 'https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html' },
  gcloud: { title: 'Google Cloud CLI', brew: '--cask google-cloud-sdk', docs: 'https://cloud.google.com/sdk/docs/install' },
  az: { title: 'Azure CLI', brew: 'azure-cli', docs: 'https://learn.microsoft.com/cli/azure/install-azure-cli' },
  ssh: { title: 'OpenSSH client', docs: 'https://www.openssh.com/' },
  docker: { title: 'Docker', brew: '--cask docker', docs: 'https://docs.docker.com/get-docker/' },
  kubectl: { title: 'kubectl', brew: 'kubectl', docs: 'https://kubernetes.io/docs/tasks/tools/' }
};

/** Places tools end up in that a GUI-launched VS Code may not have on PATH. */
function extraDirs(): string[] {
  const home = os.homedir();
  return ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', path.join(home, '.local', 'bin'), path.join(home, 'bin'), path.join(home, 'yandex-cloud', 'bin'), path.join(home, 'google-cloud-sdk', 'bin'), '/snap/bin'];
}

/** Absolute path of a tool: the openLens.tools setting, then PATH, then well-known folders. */
export function findTool(name: ToolName): string | undefined {
  const configured = vscode.workspace.getConfiguration('openLens').get<Record<string, string>>('tools', {})[name];
  if (configured && fs.existsSync(configured)) {
    return configured;
  }
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
  const dirs = [...(process.env.PATH ?? '').split(path.delimiter), ...extraDirs()];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = dir && path.join(dir, name + ext);
      if (candidate && fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

export class ToolMissingError extends Error {
  constructor(readonly tool: ToolName) {
    super(`${TOOLS[tool].title} (${tool}) is not installed or not on PATH.`);
  }
}

/** A tool's path, offering to install it when it is missing. */
export async function requireTool(name: ToolName): Promise<string> {
  const found = findTool(name);
  if (found) {
    return found;
  }
  const info = TOOLS[name];
  const brew = findBrew();
  const actions: string[] = [];
  if (brew && info.brew) {
    actions.push('Install With Homebrew');
  } else if (info.script && process.platform !== 'win32') {
    actions.push('Install');
  }
  actions.push('Open Docs');
  const choice = await vscode.window.showWarningMessage(`${info.title} is needed for this and is not installed.`, ...actions);
  if (choice === 'Install With Homebrew' || choice === 'Install') {
    const command = choice === 'Install' ? info.script! : `${brew} install ${info.brew}`;
    const ok = await runInTerminal(`Install ${info.title}`, command);
    const after = findTool(name);
    if (ok && after) {
      return after;
    }
    throw new Error(`${info.title} was not found after the installation. Restart VS Code if it was installed to a new folder.`);
  }
  if (choice === 'Open Docs') {
    await vscode.env.openExternal(vscode.Uri.parse(info.docs));
  }
  throw new ToolMissingError(name);
}

function findBrew(): string | undefined {
  return ['/opt/homebrew/bin/brew', '/usr/local/bin/brew', '/home/linuxbrew/.linuxbrew/bin/brew'].find((p) => fs.existsSync(p));
}

export interface RunOptions {
  env?: NodeJS.ProcessEnv;
  input?: string;
  /** Called with each output line (stdout and stderr), e.g. for progress messages. */
  onLine?: (line: string) => void;
  cancellation?: vscode.CancellationToken;
}

/** Run a tool and collect stdout; output is logged, a non-zero exit rejects with the last stderr line. */
export function runTool(command: string, args: string[], options: RunOptions = {}): Promise<string> {
  logger.info(`$ ${path.basename(command)} ${args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}`);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: { ...process.env, PATH: [process.env.PATH, ...extraDirs()].join(path.delimiter), ...options.env } });
    let stdout = '';
    let stderr = '';
    const lines = (chunk: Buffer, sink: 'out' | 'err'): void => {
      const text = chunk.toString();
      if (sink === 'out') {
        stdout += text;
      } else {
        stderr += text;
      }
      for (const line of text.split('\n').map((l) => l.trim()).filter(Boolean)) {
        logger.info(`  ${line}`);
        options.onLine?.(line);
      }
    };
    child.stdout.on('data', (c: Buffer) => lines(c, 'out'));
    child.stderr.on('data', (c: Buffer) => lines(c, 'err'));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        const last = stderr.trim().split('\n').filter(Boolean).pop() ?? stdout.trim().split('\n').pop();
        reject(new Error(`${path.basename(command)} failed${last ? `: ${last}` : ` with exit code ${code}`}`));
      }
    });
    options.cancellation?.onCancellationRequested(() => child.kill('SIGINT'));
    if (options.input !== undefined) {
      child.stdin.end(options.input);
    } else {
      child.stdin.end();
    }
  });
}

/**
 * Run a command in a visible terminal (for long or interactive work such as
 * sudo prompts) and resolve with whether it exited with status 0.
 */
export function runInTerminal(name: string, command: string, options: { shellPath?: string; shellArgs?: string[] } = {}): Promise<boolean> {
  return new Promise((resolve) => {
    const shell = options.shellPath ?? (process.platform === 'win32' ? 'powershell.exe' : process.env.SHELL || '/bin/sh');
    const args = options.shellArgs ?? (process.platform === 'win32' ? ['-Command', command] : ['-lc', `${command}\nstatus=$?; echo; if [ $status -eq 0 ]; then echo "✔ Done. Press Enter to continue."; else echo "✖ Failed with exit code $status. Press Enter to close."; fi; read -r _; exit $status`]);
    const terminal = vscode.window.createTerminal({ name, shellPath: shell, shellArgs: args, env: { PATH: [process.env.PATH, ...extraDirs()].join(path.delimiter) } });
    terminal.show();
    const sub = vscode.window.onDidCloseTerminal((closed) => {
      if (closed === terminal) {
        sub.dispose();
        resolve(closed.exitStatus?.code === 0);
      }
    });
  });
}
