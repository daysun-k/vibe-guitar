/**
 * Benchmark core shared by the Node script (scripts/bench.mjs) and the in-extension
 * bench page: speed (real-time factor, per-call latency) and accuracy on the synthetic
 * labeled set (WCSR majmin/root/sevenths, beat and downbeat F-measure), plus ablations.
 */
import { CQT, CQT_FRAME_SEC, MODEL_SAMPLE_RATE } from '../audio/features';
import { resample } from '../audio/resample';
import { estimateBeatsPerBar, estimateBpm } from '../recognize/beats';
import { buildAutoChart } from '../recognize/autochart';
import type { BtcModelMeta } from '../recognize/chords';
import { computeFeatures, Recognizer } from '../recognize/recognizer';
import type { ModelRunner } from '../recognize/runner';
import { beatFMeasure, chartIntervals, wcsr, type FMeasure, type LabeledInterval, type Reduction } from '../eval/metrics';
import { renderClip, type ClipSpec } from './synth';

export interface BenchModels {
  beat: ModelRunner;
  chords: ModelRunner;
  chordsMeta: BtcModelMeta;
  majmin?: ModelRunner;
  majminMeta?: BtcModelMeta;
}

interface Score {
  good: number;
  total: number;
}

export interface ClipResult {
  id: string;
  spec: ClipSpec;
  durationSec: number;
  timingsMs: { synth: number; resample: number; features: number; beats: number; chords: number; decode: number };
  beatF: FMeasure;
  downbeatF: FMeasure;
  bpm: { truth: number; est: number | null };
  meter: { truth: number; est: number };
  wcsr: Record<Reduction, Score>;
  ablations: { frameArgmaxMajmin: Score; noBeatSyncFixedUnitsMajmin: Score; btcMajminModelMajmin?: Score };
}

export interface BenchSummary {
  clips: number;
  audioSec: number;
  rtf: { resample: number; features: number; beats: number; chords: number; decode: number; total: number };
  wcsr: Record<Reduction, number>;
  ablations: { frameArgmaxMajmin: number; noBeatSyncFixedUnitsMajmin: number; btcMajminModelMajmin?: number };
  beatF: number;
  downbeatF: number;
  bpmWithin4pct: number;
  meterCorrect: number;
}

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

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

export async function benchClip(spec: ClipSpec, models: BenchModels, captureRate = 48000): Promise<ClipResult> {
  const t0 = now();
  const clip = renderClip(spec, captureRate);
  const t1 = now();
  const audio = resample(clip.audio, captureRate, MODEL_SAMPLE_RATE);
  const t2 = now();
  const rec = new Recognizer(models.beat, models.chords, models.chordsMeta);
  const features = computeFeatures(audio);
  const t3 = now();
  const seg = await rec.analyzeSegment(audio, 0, features, true);
  const recording = { source: 'youtube' as const, id: spec.id, title: spec.id, artist: 'synthetic' };
  const chart = buildAutoChart({ recording, segments: [seg], tool: 'bench', durationSec: clip.durationSec });
  const est = chartIntervals(chart.events, chart.coverage);
  const ref: LabeledInterval[] = clip.chords.map((c) => ({ ...c }));

  const noBeats = new Recognizer(models.beat, models.chords, models.chordsMeta, { noBeats: true });
  const segNoBeats = await noBeats.analyzeSegment(audio, 0, features);
  const chartNoBeats = buildAutoChart({ recording, segments: [segNoBeats], tool: 'bench' });

  let btcMajminModelMajmin: Score | undefined;
  if (models.majmin && models.majminMeta) {
    const mm = new Recognizer(models.beat, models.majmin, models.majminMeta, { vocabulary: 'full' });
    const segMm = await mm.analyzeSegment(audio, 0, features);
    const chartMm = buildAutoChart({ recording, segments: [segMm], tool: 'bench' });
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
      frameArgmaxMajmin: score(ref, frameIntervals(seg.probs!, features.cqtFrames, rec.symbols), 'majmin'),
      noBeatSyncFixedUnitsMajmin: score(ref, chartIntervals(chartNoBeats.events, chartNoBeats.coverage), 'majmin'),
      btcMajminModelMajmin,
    },
  };
}

const ratio = (s: Score[]): number => {
  const g = s.reduce((a, b) => a + b.good, 0);
  const t = s.reduce((a, b) => a + b.total, 0);
  return t > 0 ? g / t : NaN;
};

export function summarize(results: ClipResult[]): BenchSummary {
  const audioSec = results.reduce((s, r) => s + r.durationSec, 0);
  const sum = (k: keyof ClipResult['timingsMs']) => results.reduce((s, r) => s + r.timingsMs[k], 0) / 1000 / audioSec;
  const rtf = { resample: sum('resample'), features: sum('features'), beats: sum('beats'), chords: sum('chords'), decode: sum('decode'), total: 0 };
  rtf.total = rtf.resample + rtf.features + rtf.beats + rtf.chords + rtf.decode;
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const mm = results.map((r) => r.ablations.btcMajminModelMajmin).filter((x): x is Score => !!x);
  return {
    clips: results.length,
    audioSec,
    rtf,
    wcsr: { majmin: ratio(results.map((r) => r.wcsr.majmin)), root: ratio(results.map((r) => r.wcsr.root)), sevenths: ratio(results.map((r) => r.wcsr.sevenths)) },
    ablations: {
      frameArgmaxMajmin: ratio(results.map((r) => r.ablations.frameArgmaxMajmin)),
      noBeatSyncFixedUnitsMajmin: ratio(results.map((r) => r.ablations.noBeatSyncFixedUnitsMajmin)),
      btcMajminModelMajmin: mm.length ? ratio(mm) : undefined,
    },
    beatF: mean(results.map((r) => r.beatF.f)),
    downbeatF: mean(results.map((r) => r.downbeatF.f)),
    bpmWithin4pct: mean(results.map((r) => (r.bpm.est !== null && Math.abs(r.bpm.est / r.bpm.truth - 1) <= 0.04 ? 1 : 0))),
    meterCorrect: mean(results.map((r) => (r.meter.est === r.meter.truth ? 1 : 0))),
  };
}

export interface LatencyResult {
  /** One Beat This! call on a full 1500-frame (30 s) window. */
  beatChunkMs: { median: number; p90: number };
  /** One BTC call on a 108-frame (10 s) window: the live "인식 중" model step. */
  chordWindowMs: { median: number; p90: number };
  /** CQT frames per second of compute (live mode needs ~10.8 frames/s). */
  cqtFramesPerSec: number;
  melFramesPerSec: number;
}

function stats(xs: number[]): { median: number; p90: number } {
  const s = [...xs].sort((a, b) => a - b);
  return { median: s[Math.floor(s.length / 2)], p90: s[Math.min(s.length - 1, Math.floor(s.length * 0.9))] };
}

export async function measureLatency(models: BenchModels, reps = 10): Promise<LatencyResult> {
  const beatIn = new Float32Array(1500 * 128).map((_, i) => Math.sin(i * 0.01) + 1);
  const chordIn = new Float32Array(108 * CQT.nBins).map((_, i) => Math.sin(i * 0.013));
  await models.beat.run('spect', beatIn, [1, 1500, 128]); // warm-up
  await models.chords.run('feature', chordIn, [1, 108, CQT.nBins]);
  const b: number[] = [];
  const c: number[] = [];
  for (let i = 0; i < reps; i++) {
    let t = now();
    await models.beat.run('spect', beatIn, [1, 1500, 128]);
    b.push(now() - t);
    t = now();
    await models.chords.run('feature', chordIn, [1, 108, CQT.nBins]);
    c.push(now() - t);
  }
  const x = new Float32Array(MODEL_SAMPLE_RATE * 10).map((_, i) => Math.sin(i * 0.05) * 0.3);
  let t = now();
  const f = computeFeatures(x);
  const total = now() - t;
  // Split the joint cost by a separate mel-only pass.
  t = now();
  const { MelExtractor } = await import('../audio/features');
  new MelExtractor().all(x);
  const melMs = now() - t;
  const cqtMs = Math.max(1e-3, total - melMs);
  return { beatChunkMs: stats(b), chordWindowMs: stats(c), cqtFramesPerSec: (f.cqtFrames / cqtMs) * 1000, melFramesPerSec: (f.melFrames / melMs) * 1000 };
}

export async function runBench(specs: ClipSpec[], models: BenchModels, onProgress?: (r: ClipResult, i: number) => void): Promise<{ results: ClipResult[]; summary: BenchSummary }> {
  const results: ClipResult[] = [];
  for (let i = 0; i < specs.length; i++) {
    const r = await benchClip(specs[i], models);
    results.push(r);
    onProgress?.(r, i);
  }
  return { results, summary: summarize(results) };
}
