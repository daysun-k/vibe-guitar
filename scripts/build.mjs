// Builds the unpacked MV3 extension into dist/.
import * as esbuild from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const watch = process.argv.includes('--watch');

const entryPoints = {
  background: 'src/extension/background.ts',
  'content-youtube': 'src/extension/content/youtube.ts',
  'youtube-main': 'src/extension/content/youtube-main.ts',
  'content-applemusic': 'src/extension/content/applemusic.ts',
  'applemusic-main': 'src/extension/content/applemusic-main.ts',
  offscreen: 'src/extension/offscreen/offscreen.ts',
  'capture-worklet': 'src/extension/offscreen/capture-worklet.ts',
  bench: 'src/extension/bench/bench.ts',
  sidepanel: 'src/extension/sidepanel/sidepanel.ts',
};

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await cp(path.join(root, 'src/extension/static'), dist, { recursive: true });

// Recognition models (fetched by scripts/fetch-models.mjs) and the onnxruntime-web WASM binary.
// Everything is packaged: the extension makes no network calls at runtime.
const { readFile } = await import('node:fs/promises');
const modelManifest = JSON.parse(await readFile(path.join(root, 'scripts/models.manifest.json'), 'utf8'));
await mkdir(path.join(dist, 'models'), { recursive: true });
for (const f of [...modelManifest.files.filter((m) => m.packaged).map((m) => m.file), 'MODELS.txt']) {
  try {
    await cp(path.join(root, 'models', f), path.join(dist, 'models', f));
  } catch {
    console.error(`missing models/${f}: run \`npm run fetch-models\` first`);
    process.exit(1);
  }
}
await mkdir(path.join(dist, 'ort'), { recursive: true });
for (const f of ['ort-wasm-simd-threaded.jsep.wasm', 'ort-wasm-simd-threaded.jsep.mjs']) {
  await cp(path.join(root, 'node_modules/onnxruntime-web/dist', f), path.join(dist, 'ort', f));
}

const options = {
  absWorkingDir: root,
  entryPoints,
  outdir: dist,
  bundle: true,
  format: 'iife',
  target: 'chrome116',
  sourcemap: 'linked',
  // onnxruntime-web's bundle references import.meta.url; wasmPaths is set explicitly instead.
  define: { 'import.meta.url': '"chrome-extension://vibe-guitar/"' },
  minify: false,
  logLevel: 'info',
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log('watching… (static files are copied only at start)');
} else {
  await esbuild.build(options);
}

// Sanity check: every file the manifest references exists in dist/.
if (!watch) {
  const { access } = await import('node:fs/promises');
  const manifest = JSON.parse(await readFile(path.join(dist, 'manifest.json'), 'utf8'));
  const refs = [
    manifest.background.service_worker,
    manifest.side_panel.default_path,
    'offscreen.html',
    'capture-worklet.js',
    'bench.html',
    'bench.js',
    'ort/ort-wasm-simd-threaded.jsep.wasm',
    ...modelManifest.files.filter((m) => m.packaged).map((m) => `models/${m.file}`),
    ...manifest.content_scripts.flatMap((c) => c.js),
  ];
  const missing = [];
  for (const r of refs) {
    try {
      await access(path.join(dist, r));
    } catch {
      missing.push(r);
    }
  }
  if (manifest.manifest_version !== 3) missing.push('manifest_version must be 3');
  if (missing.length) {
    console.error('dist check failed, missing:', missing);
    process.exit(1);
  }
  console.log(`dist check ok: MV3 manifest + ${refs.length} referenced files present`);
}
