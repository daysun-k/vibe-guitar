// Bundles src/bench/node.ts for Node with esbuild and runs it. Arguments are passed through:
//   npm run bench -- --runtime node|web --clips 24
//   npm run bench -- --compare reference.json estimate.json
import * as esbuild from 'esbuild';
import { spawnSync } from 'node:child_process';
import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'bench-out', 'node-bench.mjs');
const args = process.argv.slice(2);

if (!args.includes('--compare')) {
  try {
    await access(path.join(root, 'models', 'beat_this_small.onnx'));
  } catch {
    console.error('models/ is missing: run `npm run fetch-models` first');
    process.exit(1);
  }
}

await esbuild.build({
  absWorkingDir: root,
  entryPoints: ['src/bench/node.ts'],
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
