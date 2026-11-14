/**
 * Recognizer with the VGT-18 candidate options (offline replay, bench --config, baseline analysis).
 * Same stages as Recognizer.analyzeSegment (features → Beat This! → BTC → units → decode) with the
 * candidate decode path; the extension keeps using Recognizer. The key prior (C4) needs the whole
 * chart: pass 1 decodes without it, applyKeyPrior estimates the key from the pass-1 chart (as the
 * side panel does with respellChartForKey) and re-decodes each segment.
 */
import { CQT_FRAME_SEC, MODEL_SAMPLE_RATE } from '../audio/features';
import type { Chart } from '../chart/types';
import { estimateKey, timedChordsOf, type KeyEstimate } from '../music/key';
import { estimateBeatsPerBar, postprocessMinimal, predictBeatLogits, type BeatLogits } from './beats';
import {
  decodeCandidate,
  majminLabelFamily,
  MAJMIN_FAMILIES,
  sumClasses,
  type CandidateDecodeInput,
  type CandidateRecognizerOptions,
} from './candidate-decode';
import { buildVocabulary, predictChordProbsShifted, reduceProbs, type BtcModelMeta, type DecodeUnit } from './chords';
import { computeFeatures, unitsFromBeats, type SegmentAnalysis, type SegmentFeatures } from './recognizer';
import type { ModelRunner } from './runner';
import { segmentBeatLogits, type Segment } from './session';

export interface MajminModel {
  runner: ModelRunner;
  meta: BtcModelMeta;
}

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** recognizer.ts fixedUnits (module-private there; copied so the bundled recognizer.ts stays untouched). */
function fixedUnits(startSec: number, endSec: number, step = 0.5): DecodeUnit[] {
  const units: DecodeUnit[] = [];
  let i = 0;
  for (let t = startSec; t < endSec - 1e-6; t += step, i++) units.push({ startSec: t, endSec: Math.min(endSec, t + step), strength: i % 4 === 0 ? 0 : 2 });
  return units;
}

export class CandidateRecognizer {
  readonly symbols: string[];
  private readonly map: Int32Array;
  private readonly inputs = new WeakMap<SegmentAnalysis, CandidateDecodeInput>();

  /** `majmin` is required when opts.majmin is set; when given otherwise its probabilities are only kept (analyses). */
  constructor(
    private readonly beatRunner: ModelRunner,
    private readonly chordRunner: ModelRunner,
    readonly chordMeta: BtcModelMeta,
    readonly opts: CandidateRecognizerOptions = {},
    private readonly majmin?: MajminModel,
  ) {
    if (opts.majmin && !majmin) throw new Error('CandidateRecognizer: the majmin option needs the btc_majmin model');
    const v = buildVocabulary(chordMeta.labels, opts.vocabulary ?? 'simple');
    this.symbols = v.symbols;
    this.map = v.map;
  }

  /** Model class probabilities, averaged over the pitch-shifted runs (C6) with roots rotated back. */
  async modelProbs(runner: ModelRunner, meta: BtcModelMeta, cqt: Float32Array, frames: number): Promise<Float32Array> {
    return predictChordProbsShifted(runner, cqt, frames, meta, this.opts.pitchShift ?? []);
  }

  async analyzeSessionSegment(seg: Segment): Promise<SegmentAnalysis> {
    const features: SegmentFeatures = { mel: seg.mel.view(), melFrames: seg.melFrames, cqt: seg.cqt.view(), cqtFrames: seg.cqtFrames };
    return this.analyzeSegment(seg.audio.view(), seg.startSec, features, false, () => segmentBeatLogits(this.beatRunner, seg));
  }

  async analyzeSegment(audio: Float32Array, startSec: number, features?: SegmentFeatures, keepProbs = false, beatLogits?: () => Promise<BeatLogits>): Promise<SegmentAnalysis> {
    const t0 = now();
    const f = features ?? computeFeatures(audio);
    const t1 = now();
    const endSec = startSec + audio.length / MODEL_SAMPLE_RATE;
    let beats: number[] = [];
    let downbeats: number[] = [];
    if (!this.opts.noBeats && f.melFrames > 0) {
      const logits = beatLogits ? await beatLogits() : await predictBeatLogits(this.beatRunner, f.mel, f.melFrames);
      const r = postprocessMinimal(logits);
      beats = r.beats.map((b) => b + startSec);
      downbeats = r.downbeats.map((b) => b + startSec);
    }
    const t2 = now();
    const raw = await this.modelProbs(this.chordRunner, this.chordMeta, f.cqt, f.cqtFrames);
    const probs = reduceProbs(raw, f.cqtFrames, this.chordMeta.num_chords, this.map, this.symbols.length);
    let majminProbs: Float32Array | undefined;
    if (this.majmin) {
      const mm = await this.modelProbs(this.majmin.runner, this.majmin.meta, f.cqt, f.cqtFrames);
      const map = Int32Array.from(this.majmin.meta.labels, majminLabelFamily);
      majminProbs = sumClasses(mm, f.cqtFrames, this.majmin.meta.num_chords, map, MAJMIN_FAMILIES.length);
    }
    const t3 = now();
    const bpb = estimateBeatsPerBar(beats, downbeats);
    const units = beats.length >= 4 ? unitsFromBeats(startSec, endSec, beats, downbeats, bpb) : fixedUnits(startSec, endSec);
    const input: CandidateDecodeInput = { frames: f.cqtFrames, frameSec: CQT_FRAME_SEC, frameStartSec: startSec, units, symbols: this.symbols, probs, majminProbs, cqt: f.cqt };
    const decoded = decodeCandidate(input, this.opts, null);
    const t4 = now();
    const analysis: SegmentAnalysis = { startSec, endSec, beats, downbeats, units: decoded, probs: keepProbs ? probs : undefined, timingsMs: { features: t1 - t0, beats: t2 - t1, chords: t3 - t2, decode: t4 - t3 } };
    this.inputs.set(analysis, input);
    return analysis;
  }

  /** The decode input kept for an analysis this recognizer produced (probabilities, units, majmin probabilities). */
  decodeInput(a: SegmentAnalysis): CandidateDecodeInput {
    const x = this.inputs.get(a);
    if (!x) throw new Error('CandidateRecognizer: analysis was not produced by this recognizer');
    return x;
  }

  /**
   * C4 second pass: the global key of the pass-1 chart (estimateKey over its timed chords) and each
   * segment re-decoded with the key prior. Without keyPrior the analyses are returned unchanged.
   */
  applyKeyPrior(analyses: SegmentAnalysis[], pass1: Chart): { analyses: SegmentAnalysis[]; key: KeyEstimate | null } {
    if (!this.opts.keyPrior) return { analyses, key: null };
    const key = estimateKey(timedChordsOf(pass1));
    if (!key) return { analyses, key };
    return {
      key,
      analyses: analyses.map((a) => {
        const input = this.decodeInput(a);
        const b: SegmentAnalysis = { ...a, units: decodeCandidate(input, this.opts, key) };
        this.inputs.set(b, input);
        return b;
      }),
    };
  }
}
