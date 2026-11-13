// Parity of offline replay charts with the live charts stored in the captures (docs/recognition-replay.md).
//   npm run replay-parity -- --audio <captures dir> --charts <replayed charts dir> [--ids a,b]
// For each capture replay-audio uses (the latest per key): coverage identical, events (chord and
// startSec after 1 ms rounding) identical, beat times / first downbeat / beats per bar / bpm identical;
// confidence differences are reported apart. Exit 1 on any mismatch (first differences per song printed).
import * as esbuild from 'esbuild';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const USAGE = 'usage: npm run replay-parity -- --audio <captures dir> --charts <replayed charts dir> [--ids a,b]';
const SHOW = 8;

export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const k = { '--audio': 'audio', '--charts': 'charts', '--ids': 'ids' }[argv[i]];
    if (!k || argv[i + 1] === undefined) throw new Error(`bad argument ${argv[i]}\n${USAGE}`);
    out[k] = argv[++i];
  }
  if (!out.audio || !out.charts) throw new Error(`--audio and --charts are required\n${USAGE}`);
  return out;
}

async function loadModules() {
  const built = await esbuild.build({
    absWorkingDir: root,
    stdin: { contents: "export * from './src/replay/parity.ts'; export * from './src/replay/store.ts'; export { chartFromExport } from './src/eval/annotations.ts';", resolveDir: root, loader: 'ts' },
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    write: false,
    logLevel: 'error',
  });
  return import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const m = await loadModules();
  const ids = args.ids ? args.ids.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
  const { captures } = m.selectCaptures(path.resolve(args.audio), ids);
  if (!captures.length) throw new Error(`no captures under ${args.audio}`);
  let bad = 0;
  let maxConf = 0;
  for (const c of captures) {
    const file = path.join(args.charts, `${c.key}.json`);
    if (!existsSync(file)) {
      console.log(`MISMATCH ${c.key}: no offline chart ${file}`);
      bad++;
      continue;
    }
    const offline = m.chartFromExport(JSON.parse(readFileSync(file, 'utf8')));
    if (!offline) throw new Error(`${file} is not a chart`);
    const r = m.compareParity(c.meta.chart, offline);
    if (r.maxConfidenceDiff !== null) maxConf = Math.max(maxConf, r.maxConfidenceDiff);
    const conf = r.maxConfidenceDiff === null ? 'n/a' : r.maxConfidenceDiff.toFixed(3);
    if (r.ok) console.log(`ok ${c.key} ${c.captureId}: ${r.events.live} events identical; max confidence diff ${conf}`);
    else {
      bad++;
      console.log(`MISMATCH ${c.key} ${c.captureId}: ${r.diffs.length} differences (max confidence diff ${conf})`);
      for (const d of r.diffs.slice(0, SHOW)) console.log(`  ${d}`);
      if (r.diffs.length > SHOW) console.log(`  … ${r.diffs.length - SHOW} more`);
    }
  }
  console.log(`${captures.length - bad}/${captures.length} identical; max confidence diff ${maxConf.toFixed(3)}`);
  return bad ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.error(e.message ?? e);
      process.exit(1);
    },
  );
}
