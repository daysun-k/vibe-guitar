// Builds the unpacked MV3 extension into dist/.
//   --latency-probe: dev-only capture-latency probe build into dist-probe/ (docs/latency-probe.md).
//   The default build never contains the probe: __LATENCY_PROBE__ is false and dist/ is untouched.
//   --audio-dump: dev-only audio dump build into dist-dump/ (docs/recognition-replay.md). The default
//   build does not bundle the dump hooks at all (scripts/build-config.mjs).
import * as esbuild from 'esbuild';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { audioDumpInfo, audioDumpPlugin, buildDefine, buildFlags } from './build-config.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const flags = buildFlags(process.argv);
const { probe, dump, watch } = flags;
const dist = path.join(root, flags.outDir);

const entryPoints = {
  background: 'src/extension/background.ts',
  'content-youtube': 'src/extension/content/youtube.ts',
  'youtube-main': 'src/extension/content/youtube-main.ts',
  'content-applemusic': 'src/extension/content/applemusic.ts',
  'applemusic-main': 'src/extension/content/applemusic-main.ts',
  offscreen: 'src/extension/offscreen/offscreen.ts',
  'capture-worklet': 'src/extension/offscreen/capture-worklet.ts',
  'model-worker': 'src/extension/offscreen/model-worker.ts',
  bench: 'src/extension/bench/bench.ts',
  sidepanel: 'src/extension/sidepanel/sidepanel.ts',
  'level-worker': 'src/extension/sidepanel/level-worker.ts',
};
if (probe) entryPoints['probe-content'] = 'src/extension/probe/probe-content.ts';

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await cp(path.join(root, 'src/extension/static'), dist, { recursive: true });
if (probe) {
  // Same manifest plus one content script for the local probe page (http://127.0.0.1).
  const built = await esbuild.build({ absWorkingDir: root, entryPoints: ['src/probe/manifest.ts'], bundle: true, platform: 'node', format: 'esm', write: false, logLevel: 'error' });
  const { latencyProbeManifest } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
  const manifestPath = path.join(dist, 'manifest.json');
  const base = JSON.parse(await readFile(manifestPath, 'utf8'));
  await writeFile(manifestPath, `${JSON.stringify(latencyProbeManifest(base), null, 2)}\n`);
}
if (dump) {
  // Same manifest; only the name says it is the dev dump build (it POSTs to 127.0.0.1, see the doc).
  const manifestPath = path.join(dist, 'manifest.json');
  const base = JSON.parse(await readFile(manifestPath, 'utf8'));
  await writeFile(manifestPath, `${JSON.stringify({ ...base, name: `${base.name} [audio dump, dev]` }, null, 2)}\n`);
}

// Recognition models (fetched by scripts/fetch-models.mjs) and the onnxruntime-web WASM binary.
// Everything is packaged: the extension makes no network calls at runtime.
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
  define: buildDefine(flags, dump ? audioDumpInfo(root, path.join(dist, 'models')) : null),
  ...(dump ? { plugins: [audioDumpPlugin(root)] } : {}),
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
    'model-worker.js',
    'level-worker.js',
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
