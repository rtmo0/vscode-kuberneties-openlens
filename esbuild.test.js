/* Bundles test/*.test.ts (unit) and test/integration/*.test.ts (needs a cluster) into out/test. */
const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const entries = (dir) =>
  fs.existsSync(dir)
    ? fs
        .readdirSync(dir)
        .filter((name) => name.endsWith('.test.ts'))
        .map((name) => path.join(dir, name))
    : [];

fs.rmSync(path.join(__dirname, 'out', 'test'), { recursive: true, force: true });

const common = { bundle: true, format: 'cjs', platform: 'node', target: 'node18', logLevel: 'warning' };

Promise.all([
  esbuild.build({
    entryPoints: [path.join(__dirname, 'src', 'webviews', 'table', 'index.ts')],
    outfile: path.join(__dirname, 'out', 'test', 'table-client.js'),
    bundle: true, platform: 'browser', format: 'iife', target: 'es2020', logLevel: 'warning'
  }),
  esbuild.build({
    ...common,
    entryPoints: entries(path.join(__dirname, 'test')),
    outdir: path.join(__dirname, 'out', 'test'),
    alias: { vscode: path.join(__dirname, 'test', 'integration', 'vscode-mock.ts') }
  }),
  esbuild.build({
    ...common,
    entryPoints: entries(path.join(__dirname, 'test', 'integration')),
    outdir: path.join(__dirname, 'out', 'test', 'integration'),
    alias: { vscode: path.join(__dirname, 'test', 'integration', 'vscode-mock.ts') }
  })
]).catch(() => process.exit(1));
