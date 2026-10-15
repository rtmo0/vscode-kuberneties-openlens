import * as vscode from 'vscode';

export const VIRTUAL_SCHEME = 'openlens-view';

/** Read-only in-memory documents, used for diffs (revisions, live vs. edited, dry runs). */
export class VirtualDocuments implements vscode.TextDocumentContentProvider {
  private readonly docs = new Map<string, string>();
  private readonly changeEmitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changeEmitter.event;
  private counter = 0;

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.docs.get(uri.toString()) ?? '';
  }

  /** Store `text` under a readable file name and return its URI. */
  put(name: string, text: string): vscode.Uri {
    const uri = vscode.Uri.from({ scheme: VIRTUAL_SCHEME, path: `/${++this.counter}/${name}` });
    this.docs.set(uri.toString(), text);
    // Keep memory bounded: diffs are short-lived.
    if (this.docs.size > 200) {
      const oldest = this.docs.keys().next().value as string;
      this.docs.delete(oldest);
    }
    return uri;
  }

  async diff(left: { name: string; text: string }, right: { name: string; text: string }, title: string): Promise<void> {
    await vscode.commands.executeCommand('vscode.diff', this.put(left.name, left.text), this.put(right.name, right.text), title, { preview: false });
  }

  async show(name: string, text: string, language = 'yaml'): Promise<void> {
    const doc = await vscode.workspace.openTextDocument(this.put(name, text));
    await vscode.languages.setTextDocumentLanguage(doc, language);
    await vscode.window.showTextDocument(doc, { preview: false });
  }
}
