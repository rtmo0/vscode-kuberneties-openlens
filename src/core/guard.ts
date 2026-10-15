import * as vscode from 'vscode';

import { getConfig } from './config';

/** Contexts marked as production: setting entries are names or globs like "*prod*". */
export function isProtectedContext(context: string): boolean {
  return getConfig().protectedContexts.some((pattern) => globMatch(pattern, context));
}

function globMatch(pattern: string, value: string): boolean {
  const regex = new RegExp(`^${pattern.split('*').map(escapeRegex).join('.*')}$`, 'i');
  return regex.test(value);
}

function escapeRegex(text: string): string {
  return text.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}

export interface ConfirmOptions {
  /** What is about to happen, e.g. `Delete Pod "web-1"`. */
  title: string;
  detail?: string;
  /** Button label for the normal confirmation. */
  button: string;
  /** Ask on normal contexts too (when confirmations are enabled); otherwise only protected contexts ask. */
  always?: boolean;
}

/**
 * Gate for every action that changes a cluster. On a protected context the
 * user has to type the context name; elsewhere a modal confirmation is shown
 * for destructive actions.
 */
export async function confirmAction(context: string, options: ConfirmOptions): Promise<boolean> {
  if (isProtectedContext(context)) {
    const typed = await vscode.window.showInputBox({
      title: `⚠ Protected context ${context}`,
      prompt: `${options.title}${options.detail ? ` — ${options.detail.split('\n')[0]}` : ''}. Type the context name to confirm.`,
      placeHolder: context,
      ignoreFocusOut: true,
      validateInput: (value) => (value === context ? undefined : `Type "${context}" to confirm`)
    });
    return typed === context;
  }
  if (options.always && getConfig().confirmDangerousOperations) {
    const choice = await vscode.window.showWarningMessage(options.title, { modal: true, detail: options.detail }, options.button);
    return choice === options.button;
  }
  return true;
}

/** Add or remove an exact context name from the protected list (user settings). */
export async function toggleProtection(context: string): Promise<boolean> {
  const config = vscode.workspace.getConfiguration('openLens');
  const current = config.get<string[]>('protectedContexts', []);
  const protectedNow = isProtectedContext(context);
  let next: string[];
  if (protectedNow) {
    next = current.filter((pattern) => !globMatch(pattern, context));
    if (next.length === current.length) {
      return true;
    }
    const removedGlobs = current.filter((p) => p.includes('*') && globMatch(p, context));
    if (removedGlobs.length) {
      const choice = await vscode.window.showWarningMessage(
        `"${context}" is protected by the pattern ${removedGlobs.map((p) => `"${p}"`).join(', ')}. Remove the pattern?`,
        { modal: true },
        'Remove Pattern'
      );
      if (choice !== 'Remove Pattern') {
        return true;
      }
    }
  } else {
    next = [...current, context];
  }
  await config.update('protectedContexts', next, vscode.ConfigurationTarget.Global);
  return !protectedNow;
}
