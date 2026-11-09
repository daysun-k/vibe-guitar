/**
 * Node benchmark entry (bundled and run by scripts/bench.mjs).
 *   --runtime node|web   onnxruntime-node (CPU) or onnxruntime-web (WASM in Node)
 *   --clips N            first N clips of the default synthetic set
 *   --compare a.json b.json   compare two chart JSON files (reference, estimate) and exit
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Chart } from '../chart/types';
import { validateChart } from '../chart/validate';
import { compareCharts } from '../eval/metrics';
import type { BtcMeta } from '../recognize/chords';
import { MODEL_FILES, ortRunner, type ModelRunner } from '../recognize/runner';
import { measureLatency, runBench, type BenchModels } from './run';
import { defaultSpecs } from './synth';

const args = process.argv.slice(2);
const opt = (name: string, def: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};

async function compare(): Promise<void> {
  const i = args.indexOf('--compare');
  const load = (p: string): Chart => {
    const v = validateChart(JSON.parse(readFileSync(p, 'utf8')));
    if (!v.ok) throw new Error(`${p}: ${v.errors.join('; ')}`);
    return v.chart!;
  };
  const c = compareCharts(load(args[i + 1]), load(args[i + 2]));
  console.log(JSON.stringify(c, null, 2));
}

async function main(): Promise<void> {
  if (args.includes('--compare')) return compare();
  const runtime = opt('runtime', 'node');
  const clips = Number(opt('clips', '24'));
  const modelsDir = path.resolve(opt('models', 'models'));
  const outDir = path.resolve(opt('out', 'bench-out'));
  mkdirSync(outDir, { recursive: true });

  let make: (file: string) => Promise<ModelRunner>;
  let ortVersion = '';
  if (runtime === 'web') {
    const ort = await import('onnxruntime-web');
    ort.env.wasm.numThreads = 1;
    ortVersion = `onnxruntime-web ${ort.env.versions?.web ?? ''} (wasm, 1 thread)`;
    make = async (file) => ortRunner(await ort.InferenceSession.create(readFileSync(path.join(modelsDir, file)), { executionProviders: ['wasm'] }), ort.Tensor);
  } else {
    const ort = await import('onnxruntime-node');
    ortVersion = `onnxruntime-node ${ort.env.versions?.node ?? ''} (cpu)`;
    make = async (file) => ortRunner(await ort.InferenceSession.create(path.join(modelsDir, file), { executionProviders: ['cpu'] }), ort.Tensor);
  }
  const meta = JSON.parse(readFileSync(path.join(modelsDir, MODEL_FILES.btcMeta), 'utf8')) as BtcMeta;
  const models: BenchModels = {
    beat: await make(MODEL_FILES.beat),
    chords: await make(MODEL_FILES.chords),
    chordsMeta: meta.models.large,
    majmin: await make(MODEL_FILES.chordsMajmin),
    majminMeta: meta.models.majmin,
  };
  console.log(`runtime: ${ortVersion}; node ${process.version}; ${process.platform}/${process.arch}`);
  const latency = await measureLatency(models, 10);
  console.log('latency', JSON.stringify(latency));
  const specs = defaultSpecs().slice(0, clips);
  const { results, summary } = await runBench(specs, models, (r, i) => {
    const s = r.spec;
    const pct = (x: { good: number; total: number }) => (x.total ? ((100 * x.good) / x.total).toFixed(1) : 'n/a');
    console.log(
      `${String(i + 1).padStart(2)} ${r.id} ${s.bpm}bpm ${s.beatsPerBar}/4 ${s.timbre}/${s.voicing}${s.drums ? '+drums' : ''}${s.bass ? '+bass' : ''}${s.snrDb !== null ? ` snr${s.snrDb}` : ''}: ` +
        `majmin ${pct(r.wcsr.majmin)} root ${pct(r.wcsr.root)} 7ths ${pct(r.wcsr.sevenths)} | beatF ${r.beatF.f.toFixed(3)} downF ${r.downbeatF.f.toFixed(3)} | bpm ${r.bpm.est?.toFixed(1)} meter ${r.meter.est}`,
    );
  });
  const out = { date: new Date().toISOString(), runtime: ortVersion, node: process.version, platform: `${process.platform}/${process.arch}`, latency, summary, results };
  const file = path.join(outDir, `bench-${runtime}.json`);
  writeFileSync(file, JSON.stringify(out, null, 2));
  console.log('summary', JSON.stringify(summary, null, 2));
  console.log(`wrote ${path.relative(process.cwd(), file)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
