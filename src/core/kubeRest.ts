import * as http from 'http';
import * as https from 'https';
import type { KubeConfig } from '@kubernetes/client-node';

export class KubeApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly reason?: string
  ) {
    super(message);
    this.name = 'KubeApiError';
  }
}

export type QueryValue = string | number | boolean | undefined;

export interface RestOptions {
  query?: Record<string, QueryValue>;
  body?: unknown;
  contentType?: string;
  accept?: string;
  /** Request timeout; 0 disables it (used for streams). */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Minimal raw REST client for the Kubernetes API.
 *
 * Objects are kept as plain JSON so that reads, edits and replaces are
 * lossless — the generated typed models drop fields they do not know.
 * Authentication (certificates, tokens, exec plugins, proxies) comes from
 * the KubeConfig itself.
 */
export class KubeRest {
  constructor(private readonly kc: KubeConfig) {}

  get server(): string {
    return this.kc.getCurrentCluster()?.server ?? '';
  }

  async json<T>(method: string, path: string, options: RestOptions = {}): Promise<T> {
    const text = await this.text(method, path, options);
    return (text ? JSON.parse(text) : undefined) as T;
  }

  get<T>(path: string, query?: Record<string, QueryValue>, options: RestOptions = {}): Promise<T> {
    return this.json<T>('GET', path, { ...options, query });
  }

  async text(method: string, path: string, options: RestOptions = {}): Promise<string> {
    const res = await this.open(method, path, options);
    return readBody(res);
  }

  /**
   * Open a streaming GET (logs, watches). The caller consumes the response and
   * calls `abort()` to stop it.
   */
  async stream(
    path: string,
    query: Record<string, QueryValue>,
    onData: (chunk: Buffer) => void
  ): Promise<{ abort: () => void; done: Promise<void> }> {
    const controller = { aborted: false, request: undefined as http.ClientRequest | undefined };
    const res = await this.open('GET', path, { query, timeoutMs: 0, accept: '*/*' }, (req) => {
      controller.request = req;
    });
    const done = new Promise<void>((resolve, reject) => {
      res.on('data', (chunk: Buffer) => onData(chunk));
      res.on('end', () => resolve());
      res.on('close', () => resolve());
      res.on('error', (err) => (controller.aborted ? resolve() : reject(err)));
    });
    return {
      abort: () => {
        controller.aborted = true;
        res.destroy();
        controller.request?.destroy();
      },
      done
    };
  }

  private async open(
    method: string,
    path: string,
    options: RestOptions,
    onRequest?: (req: http.ClientRequest) => void
  ): Promise<http.IncomingMessage> {
    const server = this.server;
    if (!server) {
      throw new Error('The context has no cluster server URL.');
    }
    const url = new URL(server.replace(/\/+$/, '') + path);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined && value !== '') {
        url.searchParams.set(key, String(value));
      }
    }

    const requestOptions: https.RequestOptions = {
      method,
      headers: { Accept: options.accept ?? 'application/json' }
    };
    if (url.protocol === 'http:') {
      // The client refuses plain HTTP outright, but kubectl allows it (e.g. `kubectl proxy`):
      // apply only the credentials, there is no TLS to configure.
      await (this.kc as unknown as { applyOptions(opts: https.RequestOptions): Promise<void> }).applyOptions(requestOptions);
    } else {
      await this.kc.applyToHTTPSOptions(requestOptions);
    }

    let payload: string | undefined;
    if (options.body !== undefined) {
      payload = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
      requestOptions.headers = {
        ...requestOptions.headers,
        'Content-Type': options.contentType ?? 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      };
    }

    const transport = url.protocol === 'http:' ? http : https;
    const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    return new Promise<http.IncomingMessage>((resolve, reject) => {
      const req = transport.request(url, requestOptions, (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 400) {
          readBody(res)
            .then((body) => reject(toApiError(status, body)))
            .catch(reject);
          return;
        }
        resolve(res);
      });
      onRequest?.(req);
      if (timeout > 0) {
        req.setTimeout(timeout, () => {
          req.destroy(new Error(`Request to ${url.host} timed out after ${Math.round(timeout / 1000)}s`));
        });
      }
      req.on('error', reject);
      if (payload !== undefined) {
        req.write(payload);
      }
      req.end();
    });
  }
}

function readBody(res: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    res.on('data', (chunk: Buffer) => chunks.push(chunk));
    res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    res.on('error', reject);
  });
}

function toApiError(status: number, body: string): KubeApiError {
  try {
    const parsed = JSON.parse(body) as { message?: string; reason?: string };
    if (parsed && typeof parsed.message === 'string') {
      return new KubeApiError(parsed.message, status, parsed.reason);
    }
  } catch {
    // not a Status object
  }
  const text = body.trim().slice(0, 300) || `HTTP ${status}`;
  return new KubeApiError(text, status);
}

export function isForbidden(err: unknown): boolean {
  return err instanceof KubeApiError && (err.status === 403 || err.status === 401);
}

export function isNotFound(err: unknown): boolean {
  return err instanceof KubeApiError && err.status === 404;
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}
