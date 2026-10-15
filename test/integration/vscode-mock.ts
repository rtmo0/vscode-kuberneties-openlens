/* The few vscode APIs the core modules touch, for running them under node:test. */
class EventEmitter<T> {
  private listeners: Array<(value: T) => void> = [];
  event = (listener: (value: T) => void): { dispose(): void } => {
    this.listeners.push(listener);
    return { dispose: () => undefined };
  };
  fire(value: T): void {
    this.listeners.forEach((l) => l(value));
  }
  dispose(): void {
    this.listeners = [];
  }
}

export { EventEmitter };
export const workspace = {
  getConfiguration: () => ({ get: <T>(_key: string, fallback: T): T => fallback }),
  onDidChangeConfiguration: () => ({ dispose: () => undefined })
};
export const window = {
  createOutputChannel: () => ({ appendLine: (line: string) => process.env.OPENLENS_TEST_VERBOSE && console.log(line), show: () => undefined, dispose: () => undefined })
};
export const FileSystemError = {};
export const commands = { executeCommand: async () => undefined };
export const Uri = {
  file: (fsPath: string) => ({ fsPath, toString: () => `file://${fsPath}` }),
  parse: (value: string) => ({ toString: () => value }),
  from: (parts: { scheme: string; path: string }) => ({ ...parts, toString: () => `${parts.scheme}:${parts.path}` })
};
export class Disposable {
  constructor(private readonly onDispose: () => void) {}
  dispose(): void {
    this.onDispose();
  }
}
export const FileType = { File: 1 };
export const FileChangeType = { Changed: 1 };
export const ConfigurationTarget = { Global: 1 };
export const ProgressLocation = { Notification: 15, Window: 10 };
export const extensions = { getExtension: () => undefined };
export const env = { openExternal: async () => true, clipboard: { writeText: async () => undefined } };
