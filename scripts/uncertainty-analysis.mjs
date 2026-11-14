// VGT-19 uncertain-section measurement of replayed captures (docs/uncertainty-protocol.md).
// Bundles src/replay/uncertainty-analysis-node.ts for Node with esbuild (like scripts/replay-audio.mjs) and runs it:
//   npm run uncertainty-analysis -- --audio <captures dir> --maps <maps.json> --annotations <dir> --out <result.json>
//     [--ids songId,…] [--songs <list.json>]… [--models <dir>] [--config <json>]
//     [--signal S1..S5 --threshold <number> [--dev-result <DEV result.json>] [--charts-out <dir>]]
// Without --signal: the DEV sweep and criterion steps 1-4; with it: the fixed (TEST) setting. Exit 3 when R1 fails.
import * as esbuild from 'esbuild';
import { spawnSync } from 'node:child_process';
import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'bench-out', 'uncertainty-analysis-node.mjs');
const args = process.argv.slice(2);

try {
  await access(path.join(root, 'models', 'btc_large_voca.onnx'));
} catch {
  console.error('models/ is missing: run `npm run fetch-models` first');
  process.exit(1);
}

await esbuild.build({
  absWorkingDir: root,
  entryPoints: ['src/replay/uncertainty-analysis-node.ts'],
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
