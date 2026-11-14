/**
 * Synthetic benchmark with VGT-18 candidate options (npm run bench -- --config <json>): the same clip
 * rendering, scoring and summary as benchClip, with the main analysis run by CandidateRecognizer
 * (plus the key-prior second pass) when the config sets candidate options, or by Recognizer with
 * the config's plain options otherwise. Ablations stay the default recognizer's. Node only; the
 * extension's bench page keeps src/bench/run.ts.
 */
import { CQT_FRAME_SEC, MODEL_SAMPLE_RATE } from '../audio/features';
import { resample } from '../audio/resample';
import { beatFMeasure, chartIntervals, wcsr, type LabeledInterval, type Reduction } from '../eval/metrics';
import { estimateBeatsPerBar, estimateBpm } from '../recognize/beats';
import { buildAutoChart } from '../recognize/autochart';
import { hasCandidateOptions, plainRecognizerOptions, type CandidateRecognizerOptions } from '../recognize/candidate-decode';
import { CandidateRecognizer } from '../recognize/candidate-recognizer';
import { computeFeatures, Recognizer, type SegmentAnalysis } from '../recognize/recognizer';
import { summarize, type BenchModels, type BenchSummary, type ClipResult } from './run';
import { renderClip, type ClipSpec } from './synth';

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

type Score = ClipResult['wcsr']['majmin'];

// score and frameIntervals of run.ts (module-private there; copied so the bundled bench page source stays untouched).
function score(ref: LabeledInterval[], est: LabeledInterval[], r: Reduction): Score {
  const w = wcsr(ref, est, r);
  return { good: Number.isNaN(w.score) ? 0 : w.score * w.evaluatedSec, total: w.evaluatedSec };
}

function frameIntervals(probs: Float32Array, frames: number, symbols: string[]): LabeledInterval[] {
  const n = symbols.length;
  const out: LabeledInterval[] = [];
  for (let f = 0; f < frames; f++) {
    let best = 0;
    for (let j = 1; j < n; j++) if (probs[f * n + j] > probs[f * n + best]) best = j;
    const s = Math.max(0, (f - 0.5) * CQT_FRAME_SEC);
    const sym = symbols[best];
    const last = out[out.length - 1];
    if (last && last.symbol === sym) last.endSec = (f + 0.5) * CQT_FRAME_SEC;
    else out.push({ startSec: s, endSec: (f + 0.5) * CQT_FRAME_SEC, symbol: sym });
  }
  return out;
}

export async function benchClipWithOptions(spec: ClipSpec, models: BenchModels, options: CandidateRecognizerOptions, captureRate = 48000): Promise<ClipResult> {
  const t0 = now();
  const clip = renderClip(spec, captureRate);
  const t1 = now();
  const audio = resample(clip.audio, captureRate, MODEL_SAMPLE_RATE);
  const t2 = now();
  const features = computeFeatures(audio);
  const t3 = now();
  const recording = { source: 'youtube' as const, id: spec.id, title: spec.id, artist: 'synthetic' };
  const build = (s: SegmentAnalysis) => buildAutoChart({ recording, segments: [s], tool: 'bench', durationSec: clip.durationSec });
  let seg: SegmentAnalysis;
  let symbols: string[];
  if (hasCandidateOptions(options)) {
    if (options.majmin && !(models.majmin && models.majminMeta)) throw new Error('bench: the majmin option needs models/btc_majmin.onnx');
    const majmin = options.majmin && models.majmin && models.majminMeta ? { runner: models.majmin, meta: models.majminMeta } : undefined;
    const rec = new CandidateRecognizer(models.beat, models.chords, models.chordsMeta, options, majmin);
    seg = await rec.analyzeSegment(audio, 0, features, true);
    if (options.keyPrior) seg = rec.applyKeyPrior([seg], build(seg)).analyses[0];
    symbols = rec.symbols;
  } else {
    const rec = new Recognizer(models.beat, models.chords, models.chordsMeta, plainRecognizerOptions(options));
    seg = await rec.analyzeSegment(audio, 0, features, true);
    symbols = rec.symbols;
  }
  const chart = build(seg);
  const est = chartIntervals(chart.events, chart.coverage);
  const ref: LabeledInterval[] = clip.chords.map((c) => ({ ...c }));

  const noBeats = new Recognizer(models.beat, models.chords, models.chordsMeta, { noBeats: true });
  const segNoBeats = await noBeats.analyzeSegment(audio, 0, features);
  const chartNoBeats = buildAutoChart({ recording, segments: [segNoBeats], tool: 'bench' });
  let btcMajminModelMajmin: Score | undefined;
  if (models.majmin && models.majminMeta) {
    const mm = new Recognizer(models.beat, models.majmin, models.majminMeta, { vocabulary: 'full' });
    const chartMm = buildAutoChart({ recording, segments: [await mm.analyzeSegment(audio, 0, features)], tool: 'bench' });
    btcMajminModelMajmin = score(ref, chartIntervals(chartMm.events, chartMm.coverage), 'majmin');
  }
  return {
    id: spec.id,
    spec,
    durationSec: clip.durationSec,
    timingsMs: { synth: t1 - t0, resample: t2 - t1, features: t3 - t2, beats: seg.timingsMs.beats, chords: seg.timingsMs.chords, decode: seg.timingsMs.decode },
    beatF: beatFMeasure(clip.beats, seg.beats),
    downbeatF: beatFMeasure(clip.downbeats, seg.downbeats),
    bpm: { truth: spec.bpm, est: estimateBpm(seg.beats) },
    meter: { truth: spec.beatsPerBar, est: estimateBeatsPerBar(seg.beats, seg.downbeats) },
    wcsr: { majmin: score(ref, est, 'majmin'), root: score(ref, est, 'root'), sevenths: score(ref, est, 'sevenths') },
    ablations: {
      frameArgmaxMajmin: score(ref, frameIntervals(seg.probs!, features.cqtFrames, symbols), 'majmin'),
      noBeatSyncFixedUnitsMajmin: score(ref, chartIntervals(chartNoBeats.events, chartNoBeats.coverage), 'majmin'),
      btcMajminModelMajmin,
    },
  };
}

export async function runBenchWithOptions(specs: ClipSpec[], models: BenchModels, options: CandidateRecognizerOptions, onProgress?: (r: ClipResult, i: number) => void): Promise<{ results: ClipResult[]; summary: BenchSummary }> {
  const results: ClipResult[] = [];
  for (let i = 0; i < specs.length; i++) {
    const r = await benchClipWithOptions(specs[i], models, options);
    results.push(r);
    onProgress?.(r, i);
  }
  return { results, summary: summarize(results) };
}
