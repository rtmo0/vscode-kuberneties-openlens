/* eslint-disable @typescript-eslint/no-var-requires */
const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

const webviewEntryDir = path.join(__dirname, 'src', 'webviews');

/** Discover every `src/webviews/<name>/index.ts` as a separate bundle. */
function collectWebviewEntries() {
  const entries = {};
  if (!fs.existsSync(webviewEntryDir)) {
    return entries;
  }
  for (const dir of fs.readdirSync(webviewEntryDir)) {
    const candidate = path.join(webviewEntryDir, dir, 'index.ts');
    if (fs.existsSync(candidate)) {
      // Emit to dist/webviews/<dir>/index.js so the copied index.html
      // (which references "./index.js") resolves correctly.
      entries[`webviews/${dir}/index`] = candidate;
    }
  }
  return entries;
}

/** Copy every `src/webviews/<name>/index.html` + shared assets into dist. */
function copyWebviewAssets() {
  const distWebviews = path.join(__dirname, 'dist', 'webviews');
  fs.mkdirSync(distWebviews, { recursive: true });

  for (const dir of fs.readdirSync(webviewEntryDir)) {
    const html = path.join(webviewEntryDir, dir, 'index.html');
    if (fs.existsSync(html)) {
      fs.mkdirSync(path.join(distWebviews, dir), { recursive: true });
      fs.copyFileSync(html, path.join(distWebviews, dir, 'index.html'));
    }
  }

  const sharedCss = path.join(webviewEntryDir, 'shared', 'styles.css');
  if (fs.existsSync(sharedCss)) {
    fs.copyFileSync(sharedCss, path.join(distWebviews, 'styles.css'));
  }
}

async function main() {
  const extensionOptions = {
    entryPoints: [path.join(__dirname, 'src', 'extension.ts')],
    bundle: true,
    outfile: path.join(__dirname, 'dist', 'extension.js'),
    external: ['vscode'],
    format: 'cjs',
    platform: 'node',
    target: 'node18',
    sourcemap: !production,
    minify: production,
    logLevel: 'info'
  };

  const webviewOptions = {
    entryPoints: collectWebviewEntries(),
    bundle: true,
    outdir: path.join(__dirname, 'dist'),
    outbase: path.join(__dirname, 'src'),
    format: 'iife',
    platform: 'browser',
    target: 'es2020',
    sourcemap: !production,
    minify: production,
    logLevel: 'info'
  };

  copyWebviewAssets();

  if (watch) {
    const extensionCtx = await esbuild.context(extensionOptions);
    const webviewCtx = await esbuild.context(webviewOptions);
    await Promise.all([extensionCtx.watch(), webviewCtx.watch()]);
    console.log('[esbuild] watching…');
  } else {
    await esbuild.build(extensionOptions);
    if (Object.keys(webviewOptions.entryPoints).length > 0) {
      await esbuild.build(webviewOptions);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
