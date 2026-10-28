import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import type { WebviewMessage } from '../core/protocol';
import { onConfigChanged } from '../core/config';
import { isProtectedContext } from '../core/guard';
import { logger } from '../core/logger';

export type MessageHandler = (
  message: WebviewMessage,
  respond: (payload: unknown) => void
) => void | Promise<void>;

/**
 * Base class for every panel.
 *
 * Handles:
 *  - single-instance panels per key
 *  - CSP + nonce generation
 *  - request/response messaging with correlation ids
 *  - graceful error reporting back into the webview
 */
export abstract class BaseWebviewPanel implements vscode.Disposable {
  protected panel!: vscode.WebviewPanel;
  protected readonly disposables: vscode.Disposable[] = [];
  private readonly handlers = new Map<string, MessageHandler>();
  private disposed = false;
  private clientReady = false;
  private readonly pendingPosts: Array<{ type: string; payload: unknown }> = [];

  /** Unique key used to reuse an already-open panel. */
  protected abstract get panelKey(): string;
  protected abstract get title(): string;
  /** Folder under `dist/webviews/<name>` containing index.html. */
  protected abstract get webviewName(): string;

  private static readonly openPanels = new Map<string, BaseWebviewPanel>();

  protected constructor(protected readonly extensionUri: vscode.Uri) {}

  /** Close every open panel that shows the given context. */
  static closeForContext(context: string): void {
    for (const panel of [...BaseWebviewPanel.openPanels.values()]) {
      if (panel.contextName === context) {
        panel.dispose();
      }
    }
  }

  /**
   * Creates (or reveals) the webview panel.
   *
   * Must be called by subclasses at the END of their constructor, once all
   * state used by the abstract getters (`panelKey`, `title`, `webviewName`)
   * has been initialised — abstract members cannot be accessed from the
   * base-class constructor.
   */
  protected initializePanel(viewColumn: vscode.ViewColumn, preserveFocus = false): void {
    const existing = BaseWebviewPanel.openPanels.get(this.panelKey);
    if (existing && !existing.disposed) {
      existing.panel.reveal(viewColumn, preserveFocus);
      this.panel = existing.panel;
      this.onPanelReused();
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      `openLens.${this.webviewName}`,
      this.title,
      { viewColumn, preserveFocus },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(this.extensionUri, 'dist'),
          vscode.Uri.joinPath(this.extensionUri, 'resources')
        ]
      }
    );

    BaseWebviewPanel.openPanels.set(this.panelKey, this);

    this.panel.webview.html = this.renderHtml();
    this.registerHandler('ready', (_message, respond) => {
      this.clientReady = true;
      for (const { type, payload } of this.pendingPosts.splice(0)) {
        this.post(type, payload);
      }
      respond(true);
    });
    this.registerHandler('meta', (_message, respond) => respond(this.meta()));
    this.disposables.push(onConfigChanged(() => this.post('meta', this.meta())));
    this.panel.webview.onDidReceiveMessage(
      (message: WebviewMessage) => void this.handleMessage(message),
      undefined,
      this.disposables
    );
    this.panel.onDidDispose(() => this.onDispose(), undefined, this.disposables);
  }

  /**
   * Run `tick` now and then every `seconds` while the panel is visible, so
   * hidden panels do not keep polling the API server.
   */
  protected startPolling(tick: () => Promise<void>, seconds: () => number): void {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let running = false;
    let requested = false;
    const schedule = (): void => {
      if (timer) {
        clearTimeout(timer);
      }
      timer = setTimeout(() => void run(), seconds() * 1000);
    };
    const run = async (): Promise<void> => {
      if (this.disposed || running) {
        return;
      }
      if (!this.panel.visible) {
        timer = undefined;
        return;
      }
      running = true;
      try {
        await tick();
      } catch (err) {
        logger.warn('Panel refresh failed', { panel: this.panelKey, error: (err as Error).message });
      } finally {
        running = false;
      }
      if (!this.disposed) {
        if (requested) {
          requested = false;
          void run();
        } else {
          schedule();
        }
      }
    };
    this.panel.onDidChangeViewState(
      () => {
        if (this.panel.visible && !timer && !running) {
          void run();
        }
      },
      undefined,
      this.disposables
    );
    this.disposables.push({ dispose: () => timer && clearTimeout(timer) });
    this.pollNow = () => {
      if (running) {
        requested = true;
        return Promise.resolve();
      }
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      return run();
    };
    void run();
  }

  /** Refresh immediately (after an action) when polling is active. */
  protected pollNow: () => Promise<void> = async () => undefined;

  /** Context shown by the panel, for the protected-context banner. */
  protected get contextName(): string | undefined {
    return undefined;
  }

  private meta(): { context?: string; protected: boolean } {
    const context = this.contextName;
    return { context, protected: !!context && isProtectedContext(context) };
  }

  /** Called when an existing panel was revealed instead of creating a new one. */
  protected onPanelReused(): void {
    // override in subclasses to push fresh state
  }

  protected registerHandler(type: string, handler: MessageHandler): void {
    this.handlers.set(type, handler);
  }

  protected post(type: string, payload?: unknown): void {
    if (this.disposed) {
      return;
    }
    if (!this.clientReady) {
      // Fast responses can arrive before the webview has installed its listeners.
      this.pendingPosts.push({ type, payload });
      return;
    }
    void this.panel.webview.postMessage({ type, payload } satisfies WebviewMessage);
  }

  protected setTitle(title: string): void {
    this.panel.title = title;
  }

  private async handleMessage(message: WebviewMessage): Promise<void> {
    const handler = this.handlers.get(message.type);
    if (!handler) {
      logger.warn('Unhandled webview message', { type: message.type, panel: this.panelKey });
      return;
    }
    const respond = (payload: unknown): void => {
      if (this.disposed) {
        return;
      }
      void this.panel.webview.postMessage({
        type: 'response',
        requestId: message.requestId,
        payload
      } satisfies WebviewMessage);
    };
    try {
      await handler(message, respond);
    } catch (err) {
      const error = err as Error & { code?: number };
      logger.error('Webview handler failed', {
        type: message.type,
        error: error.message
      });
      if (this.disposed) {
        return;
      }
      void this.panel.webview.postMessage({
        type: 'response',
        requestId: message.requestId,
        error: { message: error.message, code: error.code }
      } satisfies WebviewMessage);
    }
  }

  protected onDispose(): void {
    this.disposed = true;
    this.pendingPosts.length = 0;
    if (BaseWebviewPanel.openPanels.get(this.panelKey) === this) {
      BaseWebviewPanel.openPanels.delete(this.panelKey);
    }
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables.length = 0;
  }

  dispose(): void {
    if (!this.disposed) {
      this.panel.dispose();
    }
    this.onDispose();
  }

  reveal(viewColumn = vscode.ViewColumn.Active): void {
    this.panel.reveal(viewColumn);
  }

  // ───────────────────────────── html ─────────────────────────────

  private renderHtml(): string {
    const webview = this.panel.webview;
    const distDir = path.join(this.extensionUri.fsPath, 'dist', 'webviews', this.webviewName);
    const htmlFile = path.join(distDir, 'index.html');

    if (!fs.existsSync(htmlFile)) {
      return this.fallbackHtml(
        `Webview bundle not found at <code>${htmlFile}</code>. Run <code>npm run build</code>.`
      );
    }

    let html = fs.readFileSync(htmlFile, 'utf8');
    const nonce = getNonce();

    html = html.replace(/{{nonce}}/g, nonce);
    html = html.replace(/{{cspSource}}/g, webview.cspSource);
    html = html.replace(/{{title}}/g, escapeHtml(this.title));

    // Rewrite relative asset references to webview URIs.
    html = html.replace(/(src|href)="\.\/([^"]+)"/g, (_match, attr: string, rel: string) => {
      const uri = webview.asWebviewUri(
        vscode.Uri.file(path.join(distDir, rel))
      );
      return `${attr}="${uri}"`;
    });

    // Shared stylesheet lives one level up.
    const sharedCss = vscode.Uri.file(
      path.join(this.extensionUri.fsPath, 'dist', 'webviews', 'styles.css')
    );
    if (fs.existsSync(sharedCss.fsPath)) {
      const cssUri = webview.asWebviewUri(sharedCss);
      html = html.replace(
        '</head>',
        `<link rel="stylesheet" href="${cssUri}">\n</head>`
      );
    }

    return html;
  }

  private fallbackHtml(message: string): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<title>${escapeHtml(this.title)}</title>
<style>
  body { font-family: var(--vscode-font-family); padding: 24px; color: var(--vscode-foreground); }
  code { background: var(--vscode-textCodeBlock-background); padding: 2px 4px; border-radius: 3px; }
</style>
</head>
<body>
  <h2>${escapeHtml(this.title)}</h2>
  <p>${message}</p>
</body>
</html>`;
  }
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i += 1) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
