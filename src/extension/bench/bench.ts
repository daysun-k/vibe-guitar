/** In-browser bench page (dist/bench.html): speed and synthetic accuracy with onnxruntime-web. */
import * as ort from 'onnxruntime-web';
import { measureLatency, runBench, type BenchModels } from '../../bench/run';
import { defaultSpecs } from '../../bench/synth';
import type { BtcMeta } from '../../recognize/chords';
import { MODEL_FILES, ortRunner } from '../../recognize/runner';

const out = document.getElementById('out')!;
const log = (s: string) => {
  out.textContent += `${s}\n`;
};

async function run(ep: 'wasm' | 'webgpu'): Promise<void> {
  out.textContent = '';
  ort.env.wasm.wasmPaths = chrome.runtime.getURL('ort/');
  ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
  const url = (f: string) => chrome.runtime.getURL(`models/${f}`);
  const meta = (await (await fetch(url(MODEL_FILES.btcMeta))).json()) as BtcMeta;
  const make = async (f: string, e: string) => ortRunner(await ort.InferenceSession.create(url(f), { executionProviders: [e] }), ort.Tensor);
  const models: BenchModels = { beat: await make(MODEL_FILES.beat, ep), chords: await make(MODEL_FILES.chords, 'wasm'), chordsMeta: meta.models.large };
  log(`onnxruntime-web ${ort.env.versions?.web ?? ''}; beat EP ${ep}, chords EP wasm; threads ${ort.env.wasm.numThreads}; ${navigator.userAgent}`);
  const lat = await measureLatency(models, 5);
  log(`latency: Beat This! 1500-frame chunk median ${lat.beatChunkMs.median.toFixed(1)} ms (p90 ${lat.beatChunkMs.p90.toFixed(1)}); BTC 108-frame window median ${lat.chordWindowMs.median.toFixed(1)} ms; CQT ${lat.cqtFramesPerSec.toFixed(0)} frames/s; mel ${lat.melFramesPerSec.toFixed(0)} frames/s`);
  const n = Number((document.getElementById('clips') as HTMLInputElement).value) || 6;
  const { summary } = await runBench(defaultSpecs().slice(0, n), models, (r, i) =>
    log(`${i + 1} ${r.id}: majmin ${((100 * r.wcsr.majmin.good) / (r.wcsr.majmin.total || 1)).toFixed(1)}% beatF ${r.beatF.f.toFixed(3)}`),
  );
  log(JSON.stringify(summary, null, 2));
}

document.getElementById('run-wasm')!.onclick = () => void run('wasm').catch((e) => log(String(e)));
document.getElementById('run-webgpu')!.onclick = () => void run('webgpu').catch((e) => log(String(e)));
