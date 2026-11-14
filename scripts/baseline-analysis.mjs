// VGT-18 baseline analyses of replayed DEV captures (docs/recognition-candidates.md "Baseline analyses").
// Bundles src/replay/analysis-node.ts for Node with esbuild (like scripts/replay-audio.mjs) and runs it:
//   npm run baseline-analysis -- --audio <captures dir> --maps docs/recognition-dev-maps.json --annotations <dir>
//     --out <result.json> [--config <json>] [--ids songId,…] [--songs <list.json>]… [--models <dir>]
// Only map songs are read; annotations are read through the evaluator code under each song's frozen map.
import * as esbuild from 'esbuild';
import { spawnSync } from 'node:child_process';
import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'bench-out', 'analysis-node.mjs');
const args = process.argv.slice(2);

try {
  await access(path.join(root, 'models', 'btc_majmin.onnx'));
} catch {
  console.error('models/ is missing: run `npm run fetch-models` first');
  process.exit(1);
}

await esbuild.build({
  absWorkingDir: root,
  entryPoints: ['src/replay/analysis-node.ts'],
  outfile: out,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  external: ['onnxruntime-node', 'onnxruntime-web'],
  logLevel: 'warning',
});
const r = spawnSync(process.execPath, [out, ...args], { cwd: root, stdio: 'inherit' });
process.exit(r.status ?? 1);
