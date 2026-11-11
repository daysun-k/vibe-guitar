/** In-browser bench page (dist/bench.html): speed and synthetic accuracy with onnxruntime-web. */
import * as ort from 'onnxruntime-web';
import { measureLatency, runBench, type BenchModels } from '../../bench/run';
import { defaultSpecs } from '../../bench/synth';
import type { BtcMeta } from '../../recognize/chords';
import { ModelWorkerClient } from '../../recognize/model-worker-client';
import { MODEL_FILES, ortRunner } from '../../recognize/runner';

const out = document.getElementById('out')!;
const log = (s: string) => {
  out.textContent += `${s}\n`;
};

/** Longest gap between animation frames while `work` runs: how long this page could not draw. */
async function maxFrameGap<T>(work: () => Promise<T>): Promise<{ result: T; maxGapMs: number }> {
  let maxGapMs = 0;
  let last = performance.now();
  let on = true;
  const frame = (t: number) => {
    maxGapMs = Math.max(maxGapMs, t - last);
    last = t;
    if (on) requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  try {
    const result = await work();
    // A page blocked for the whole run never gets a frame: count the time since the last one.
    return { result, maxGapMs: Math.max(maxGapMs, performance.now() - last) };
  } finally {
    on = false;
  }
}

async function run(ep: 'wasm' | 'webgpu' | 'worker'): Promise<void> {
  out.textContent = '';
  const threads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
  ort.env.wasm.wasmPaths = chrome.runtime.getURL('ort/');
  ort.env.wasm.numThreads = threads;
  const url = (f: string) => chrome.runtime.getURL(`models/${f}`);
  const meta = (await (await fetch(url(MODEL_FILES.btcMeta))).json()) as BtcMeta;
  let models: BenchModels;
  if (ep === 'worker') {
    const client = new ModelWorkerClient(new Worker(chrome.runtime.getURL('model-worker.js')));
    const opts = { wasmPaths: chrome.runtime.getURL('ort/'), numThreads: threads };
    await client.load('beat', url(MODEL_FILES.beat), 'wasm', opts);
    await client.load('chords', url(MODEL_FILES.chords), 'wasm', opts);
    models = { beat: client.runner('beat'), chords: client.runner('chords'), chordsMeta: meta.models.large };
  } else {
    const make = async (f: string, e: string) => ortRunner(await ort.InferenceSession.create(url(f), { executionProviders: [e] }), ort.Tensor);
    models = { beat: await make(MODEL_FILES.beat, ep), chords: await make(MODEL_FILES.chords, 'wasm'), chordsMeta: meta.models.large };
  }
  log(`onnxruntime-web ${ort.env.versions?.web ?? ''}; beat ${ep}, chords ${ep === 'worker' ? 'worker' : 'wasm'}; threads ${threads}; ${navigator.userAgent}`);
  const { result: lat, maxGapMs } = await maxFrameGap(() => measureLatency(models, 5));
  log(`page frame gap during latency runs: max ${maxGapMs.toFixed(0)} ms`);
  log(`latency: Beat This! 1500-frame chunk median ${lat.beatChunkMs.median.toFixed(1)} ms (p90 ${lat.beatChunkMs.p90.toFixed(1)}); BTC 108-frame window median ${lat.chordWindowMs.median.toFixed(1)} ms; CQT ${lat.cqtFramesPerSec.toFixed(0)} frames/s; mel ${lat.melFramesPerSec.toFixed(0)} frames/s`);
  const n = Number((document.getElementById('clips') as HTMLInputElement).value) || 6;
  const { summary } = await runBench(defaultSpecs().slice(0, n), models, (r, i) =>
    log(`${i + 1} ${r.id}: majmin ${((100 * r.wcsr.majmin.good) / (r.wcsr.majmin.total || 1)).toFixed(1)}% beatF ${r.beatF.f.toFixed(3)}`),
  );
  log(JSON.stringify(summary, null, 2));
}

document.getElementById('run-wasm')!.onclick = () => void run('wasm').catch((e) => log(String(e)));
document.getElementById('run-webgpu')!.onclick = () => void run('webgpu').catch((e) => log(String(e)));
document.getElementById('run-worker')!.onclick = () => void run('worker').catch((e) => log(String(e)));
