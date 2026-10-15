/* Helm operations that need chart rendering run through the Helm CLI. */
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';
import * as yaml from 'js-yaml';

import type { K8sObject } from './cluster';
import { allKubeconfigFiles } from './kubeconfig';
import { logger } from './logger';
import { findTool } from '../setup/tools';

export class HelmNotInstalledError extends Error {
  constructor() {
    super('The Helm CLI is not installed or not on PATH. Install it from https://helm.sh/docs/intro/install/');
  }
}

/** Run helm against a context; output goes to the extension's output channel. */
export function runHelm(context: string, args: string[]): Promise<string> {
  const fullArgs = [...args, '--kube-context', context];
  logger.info(`helm ${fullArgs.join(' ')}`);
  return new Promise((resolve, reject) => {
    const child = spawn(findTool('helm') ?? 'helm', fullArgs, { env: { ...process.env, KUBECONFIG: allKubeconfigFiles().join(path.delimiter) } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      logger.info(chunk.toString().trimEnd());
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
      logger.warn(chunk.toString().trimEnd());
    });
    child.on('error', (err: NodeJS.ErrnoException) => reject(err.code === 'ENOENT' ? new HelmNotInstalledError() : err));
    child.on('close', (code) => (code === 0 ? resolve(stdout) : reject(new Error(stderr.trim().split('\n').pop() || `helm exited with code ${code}`))));
  });
}

/** The full release object Helm stores in `secret.data.release`. */
export function decodeReleaseRaw(secret: K8sObject): any {
  let raw = Buffer.from(Buffer.from(secret.data.release, 'base64').toString('utf8'), 'base64');
  if (raw[0] === 0x1f && raw[1] === 0x8b) {
    raw = zlib.gunzipSync(raw);
  }
  return JSON.parse(raw.toString('utf8'));
}

/**
 * Subcharts are not stored in the release, so the stored chart can only be
 * reused for charts without dependencies.
 */
export function storedChartUsable(release: any): boolean {
  return !!release.chart?.templates && !(release.chart?.metadata?.dependencies ?? []).length;
}

/** Write the chart stored in a release to a temporary directory for `helm upgrade`. */
export function writeStoredChart(release: any): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openlens-chart-'));
  const chart = release.chart;
  const root = path.join(dir, chart.metadata.name);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'Chart.yaml'), yaml.dump(chart.metadata));
  fs.writeFileSync(path.join(root, 'values.yaml'), yaml.dump(chart.values ?? {}));
  if (chart.schema) {
    fs.writeFileSync(path.join(root, 'values.schema.json'), Buffer.from(chart.schema, 'base64'));
  }
  for (const file of [...(chart.templates ?? []), ...(chart.files ?? [])]) {
    const target = path.join(root, file.name);
    if (!target.startsWith(root + path.sep)) {
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, Buffer.from(file.data ?? '', 'base64'));
  }
  return root;
}
