import * as vscode from 'vscode';

let channel: vscode.OutputChannel | undefined;

export function getOutputChannel(): vscode.OutputChannel {
  if (!channel) {
    channel = vscode.window.createOutputChannel('Kubernetes OpenLens');
  }
  return channel;
}

function stamp(): string {
  return new Date().toISOString();
}

export const logger = {
  info(message: string, meta?: unknown): void {
    getOutputChannel().appendLine(`[${stamp()}] INFO  ${message}${formatMeta(meta)}`);
  },
  warn(message: string, meta?: unknown): void {
    getOutputChannel().appendLine(`[${stamp()}] WARN  ${message}${formatMeta(meta)}`);
  },
  error(message: string, meta?: unknown): void {
    getOutputChannel().appendLine(`[${stamp()}] ERROR ${message}${formatMeta(meta)}`);
  },
  show(): void {
    getOutputChannel().show(true);
  },
  dispose(): void {
    channel?.dispose();
    channel = undefined;
  }
};

function formatMeta(meta: unknown): string {
  if (meta === undefined) {
    return '';
  }
  try {
    return ` ${typeof meta === 'string' ? meta : JSON.stringify(meta)}`;
  } catch {
    return ` ${String(meta)}`;
  }
}
