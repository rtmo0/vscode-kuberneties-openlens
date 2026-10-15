import { PassThrough, Writable } from 'stream';
import * as vscode from 'vscode';
import { Attach, Exec } from '@kubernetes/client-node';

import type { ClusterSession } from '../core/cluster';
import { errorMessage } from '../core/kubeRest';

/** Tries bash, then ash, then sh — the same fallback Lens uses. */
export const DEFAULT_SHELL = ['sh', '-c', 'clear; (bash || ash || sh)'];

/** stdout stream that also reports the terminal size, which turns on TTY resizing in the client. */
class TerminalOutput extends Writable {
  columns = 80;
  rows = 24;

  constructor(private readonly sink: (text: string) => void) {
    super();
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.sink(chunk.toString('utf8'));
    callback();
  }

  resize(columns: number, rows: number): void {
    this.columns = columns;
    this.rows = rows;
    this.emit('resize');
  }
}

interface Socketish {
  close(): void;
  on(event: string, listener: () => void): void;
}

/** Opens the remote session: exec for shells, attach for debug containers. */
type Connector = (stdout: TerminalOutput, stdin: PassThrough, onStatus: (status: { status?: string; message?: string }) => void) => Promise<Socketish>;

class RemotePty implements vscode.Pseudoterminal {
  private readonly writeEmitter = new vscode.EventEmitter<string>();
  private readonly closeEmitter = new vscode.EventEmitter<number | void>();
  readonly onDidWrite = this.writeEmitter.event;
  readonly onDidClose = this.closeEmitter.event;

  private readonly stdin = new PassThrough();
  private readonly stdout = new TerminalOutput((text) => this.writeEmitter.fire(text));
  private socket?: Socketish;
  private closed = false;
  private cleanedUp = false;

  constructor(
    private readonly banner: string,
    private readonly connect: Connector,
    private readonly cleanup?: () => Promise<void>
  ) {}

  open(dimensions: vscode.TerminalDimensions | undefined): void {
    if (dimensions) {
      this.stdout.columns = dimensions.columns;
      this.stdout.rows = dimensions.rows;
    }
    this.writeEmitter.fire(`\x1b[2m${this.banner}\x1b[0m\r\n`);
    this.connect(this.stdout, this.stdin, (status) => {
      const message = status.status === 'Success' ? 'Session ended.' : status.message || 'Session ended with an error.';
      this.finish(message, status.status === 'Success' ? 0 : 1);
    })
      .then((ws) => {
        this.socket = ws;
        ws.on('close', () => this.finish('Connection closed.', 0));
      })
      .catch((err) => this.finish(errorMessage(err), 1));
  }

  handleInput(data: string): void {
    this.stdin.write(data);
  }

  setDimensions(dimensions: vscode.TerminalDimensions): void {
    this.stdout.resize(dimensions.columns, dimensions.rows);
  }

  private finish(message: string, code: number): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    void this.runCleanup();
    this.writeEmitter.fire(`\r\n\x1b[2m${message} Press any key to close.\x1b[0m\r\n`);
    this.handleInput = () => this.closeEmitter.fire(code);
  }

  private async runCleanup(): Promise<void> {
    if (this.cleanedUp || !this.cleanup) {
      return;
    }
    this.cleanedUp = true;
    try {
      await this.cleanup();
    } catch {
      // best effort
    }
  }

  close(): void {
    this.closed = true;
    this.stdin.end();
    this.socket?.close();
    void this.runCleanup();
  }
}

function openTerminal(name: string, icon: string, pty: RemotePty): vscode.Terminal {
  const terminal = vscode.window.createTerminal({ name, pty, iconPath: new vscode.ThemeIcon(icon) });
  terminal.show();
  return terminal;
}

export function openShellTerminal(
  session: ClusterSession,
  namespace: string,
  pod: string,
  container: string,
  command: string[],
  options: { name?: string; banner?: string; icon?: string; cleanup?: () => Promise<void> } = {}
): vscode.Terminal {
  const connect: Connector = (stdout, stdin, onStatus) =>
    new Exec(session.kc).exec(namespace, pod, container, command, stdout, null, stdin, true, onStatus) as unknown as Promise<Socketish>;
  return openTerminal(
    options.name ?? `${pod}/${container}`,
    options.icon ?? 'terminal',
    new RemotePty(options.banner ?? `Connecting to ${pod}/${container} in ${session.context}/${namespace}…`, connect, options.cleanup)
  );
}

/** Attach to a container's TTY (debug containers run their shell as the main process). */
export function openAttachTerminal(session: ClusterSession, namespace: string, pod: string, container: string): vscode.Terminal {
  const connect: Connector = async (stdout, stdin) => {
    const ws = (await new Attach(session.kc).attach(namespace, pod, container, stdout, null, stdin, true)) as unknown as Socketish;
    // Attach does not print a prompt by itself; a newline makes the shell show one.
    setTimeout(() => stdin.write('\n'), 300);
    return ws;
  };
  return openTerminal(
    `debug: ${pod}/${container}`,
    'debug',
    new RemotePty(`Attached to debug container ${container} in ${pod} (${session.context}/${namespace}). Exit the shell to end it.`, connect)
  );
}
