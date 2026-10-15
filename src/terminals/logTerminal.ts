import * as vscode from 'vscode';

import type { ClusterSession } from '../core/cluster';
import { errorMessage } from '../core/kubeRest';

export interface LogSource {
  pod: string;
  container: string;
}

export interface LogOptions {
  namespace: string;
  sources: LogSource[];
  follow: boolean;
  previous: boolean;
  tailLines: number;
  timestamps: boolean;
}

const COLORS = [36, 33, 35, 32, 34, 91, 96, 93, 95, 92];
const RESET = '\x1b[0m';

/**
 * Streams pod logs into a terminal, so the built-in find, copy and scrollback
 * work. Several pods / containers stream at once with a coloured prefix per
 * source (like stern).
 */
class LogPty implements vscode.Pseudoterminal {
  private readonly writeEmitter = new vscode.EventEmitter<string>();
  private readonly closeEmitter = new vscode.EventEmitter<number | void>();
  readonly onDidWrite = this.writeEmitter.event;
  readonly onDidClose = this.closeEmitter.event;

  private readonly streams: Array<{ abort: () => void }> = [];
  private closed = false;

  constructor(
    private readonly session: ClusterSession,
    private readonly options: LogOptions
  ) {}

  open(): void {
    const { sources } = this.options;
    const prefixed = sources.length > 1;
    const podCount = new Set(sources.map((s) => s.pod)).size;
    this.info(
      `Logs of ${sources.length === 1 ? `${sources[0].pod}/${sources[0].container}` : `${sources.length} containers in ${podCount} pod(s)`}` +
        ` in ${this.session.context}/${this.options.namespace}` +
        `${this.options.previous ? ' (previous instance)' : ''}. Use Cmd/Ctrl+F to search; close the terminal to stop.`
    );
    let remaining = sources.length;
    sources.forEach((source, index) => {
      const label = podCount > 1 ? `${source.pod}/${source.container}` : source.container;
      const prefix = prefixed ? `\x1b[${COLORS[index % COLORS.length]}m${label}${RESET} ` : '';
      void this.start(source, prefix).finally(() => {
        remaining -= 1;
        if (remaining === 0 && !this.closed) {
          this.info(this.options.follow ? 'All log streams ended.' : 'End of logs.');
        }
      });
    });
  }

  private async start(source: LogSource, prefix: string): Promise<void> {
    let pending = '';
    const emit = (text: string): void => {
      if (!this.closed) {
        this.writeEmitter.fire(text);
      }
    };
    try {
      const path = `/api/v1/namespaces/${encodeURIComponent(this.options.namespace)}/pods/${encodeURIComponent(source.pod)}/log`;
      const stream = await this.session.rest.stream(
        path,
        {
          container: source.container,
          follow: this.options.follow,
          previous: this.options.previous || undefined,
          tailLines: this.options.tailLines > 0 ? this.options.tailLines : undefined,
          timestamps: this.options.timestamps || undefined
        },
        (chunk) => {
          const lines = (pending + chunk.toString('utf8')).split('\n');
          pending = lines.pop() ?? '';
          if (lines.length) {
            emit(lines.map((line) => `${prefix}${line}`).join('\r\n') + '\r\n');
          }
        }
      );
      this.streams.push(stream);
      await stream.done;
      if (pending) {
        emit(`${prefix}${pending}\r\n`);
      }
    } catch (err) {
      emit(`${prefix}\x1b[31m${errorMessage(err)}${RESET}\r\n`);
    }
  }

  private info(message: string): void {
    this.writeEmitter.fire(`\x1b[2m${message}${RESET}\r\n`);
  }

  handleInput(data: string): void {
    // Enter adds a visual separator, handy to mark "from here on".
    if (data === '\r') {
      this.writeEmitter.fire(`\x1b[2m${'─'.repeat(40)} ${new Date().toLocaleTimeString()}${RESET}\r\n`);
    }
  }

  close(): void {
    this.closed = true;
    for (const stream of this.streams) {
      stream.abort();
    }
    this.streams.length = 0;
  }
}

export function openLogTerminal(session: ClusterSession, options: LogOptions, title: string): vscode.Terminal {
  const terminal = vscode.window.createTerminal({
    name: title,
    pty: new LogPty(session, options),
    iconPath: new vscode.ThemeIcon('output')
  });
  terminal.show();
  return terminal;
}
