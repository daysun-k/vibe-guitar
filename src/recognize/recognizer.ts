/**
 * Full recognition pipeline for one contiguous stretch of audio (a "segment"):
 * features → Beat This! → BTC → beat-synchronous decoding. Runtime-neutral: give it
 * ModelRunners from onnxruntime-web or onnxruntime-node.
 */
import { CQT, CQT_FRAME_SEC, CqtExtractor, MEL, MelExtractor, MODEL_SAMPLE_RATE } from '../audio/features';
import { estimateBeatsPerBar, postprocessMinimal, predictBeatLogits, type BeatLogits } from './beats';
import {
  buildVocabulary,
  decodeUnits,
  DEFAULT_DECODE,
  predictChordProbs,
  predictChordProbsShifted,
  reduceProbs,
  topOfLastFrames,
  type BtcModelMeta,
  type DecodedUnit,
  type DecodeOptions,
  type DecodeUnit,
  type Vocabulary,
} from './chords';
import type { ModelRunner } from './runner';
import { segmentBeatLogits, type Segment } from './session';

export interface SegmentFeatures {
  mel: Float32Array;
  melFrames: number;
  cqt: Float32Array;
  cqtFrames: number;
}

export interface SegmentAnalysis {
  /** Playback time of the first sample. */
  startSec: number;
  endSec: number;
  /** Absolute playback times. */
  beats: number[];
  downbeats: number[];
  units: DecodedUnit[];
  /** Frame-wise reduced chord probabilities (only with keepProbs). */
  probs?: Float32Array;
  timingsMs: { features: number; beats: number; chords: number; decode: number };
}

export interface RecognizerOptions {
  vocabulary?: Vocabulary;
  decode?: DecodeOptions;
  /** Unit emission for decoding (VGT-18 E): the mean of frame log-probabilities instead of log of the mean. */
  emission?: 'meanLog';
  /** Semitone shifts of the log-CQT averaged with the unshifted BTC run (VGT-18 C6); not used by live(). */
  pitchShift?: number[];
  /** Skip the beat model (benchmark ablation): decode on fixed 0.5 s units. */
  noBeats?: boolean;
}

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export function computeFeatures(audio: Float32Array): SegmentFeatures {
  const mel = new MelExtractor().all(audio);
  const cqt = new CqtExtractor().all(audio);
  return { mel, melFrames: mel.length / MEL.nMels, cqt, cqtFrames: cqt.length / CQT.nBins };
}

/** Decode units for a segment: one per beat, plus the stretch before the first beat. */
export function unitsFromBeats(startSec: number, endSec: number, beats: number[], downbeats: number[], beatsPerBar: number): DecodeUnit[] {
  const inside = beats.filter((b) => b > startSec + 0.05 && b < endSec - 0.05);
  const bounds = [startSec, ...inside, endSec];
  const isDown = new Set(downbeats.map((d) => Math.round(d * 1000)));
  const units: DecodeUnit[] = [];
  let sinceDown = -1;
  for (let i = 0; i < bounds.length - 1; i++) {
    const t = bounds[i];
    let strength: 0 | 1 | 2 = 2;
    if (i > 0) {
      if (isDown.has(Math.round(t * 1000))) {
        sinceDown = 0;
        strength = 0;
      } else if (sinceDown >= 0) {
        sinceDown++;
        if (beatsPerBar % 2 === 0 && sinceDown === beatsPerBar / 2) strength = 1;
      }
    }
    units.push({ startSec: t, endSec: bounds[i + 1], strength });
  }
  return units;
}

function fixedUnits(startSec: number, endSec: number, step = 0.5): DecodeUnit[] {
  const units: DecodeUnit[] = [];
  let i = 0;
  for (let t = startSec; t < endSec - 1e-6; t += step, i++) units.push({ startSec: t, endSec: Math.min(endSec, t + step), strength: i % 4 === 0 ? 0 : 2 });
  return units;
}

export class Recognizer {
  readonly symbols: string[];
  private readonly map: Int32Array;

  constructor(
    private readonly beatRunner: ModelRunner,
    private readonly chordRunner: ModelRunner,
    readonly chordMeta: BtcModelMeta,
    private readonly opts: RecognizerOptions = {},
  ) {
    const v = buildVocabulary(chordMeta.labels, opts.vocabulary ?? 'simple');
    this.symbols = v.symbols;
    this.map = v.map;
  }

  private decodeOptions(): DecodeOptions {
    const d = this.opts.decode ?? DEFAULT_DECODE;
    return this.opts.emission ? { ...d, emission: this.opts.emission } : d;
  }

  /** Reduced class probabilities [frames * symbols.length] for log-CQT frames (pitch-shift averaged when set). */
  async chordProbs(cqt: Float32Array, frames: number): Promise<Float32Array> {
    const shifts = this.opts.pitchShift ?? [];
    const raw = shifts.length ? await predictChordProbsShifted(this.chordRunner, cqt, frames, this.chordMeta, shifts) : await predictChordProbs(this.chordRunner, cqt, frames, this.chordMeta);
    return reduceProbs(raw, frames, this.chordMeta.num_chords, this.map, this.symbols.length);
  }

  /** Current chord from the most recent CQT frames (listening mode, not for play-along). */
  async live(cqtTail: Float32Array, frames: number): Promise<{ symbol: string; confidence: number } | null> {
    const T = this.chordMeta.timestep;
    const n = Math.min(frames, T);
    const tail = cqtTail.subarray((frames - n) * CQT.nBins, frames * CQT.nBins);
    const raw = await predictChordProbs(this.chordRunner, tail, n, this.chordMeta, false);
    const probs = reduceProbs(raw, n, this.chordMeta.num_chords, this.map, this.symbols.length);
    return topOfLastFrames(probs, n, this.symbols.length, this.symbols, 3);
  }

  /** Analyses a listening-session segment, reusing its incremental features and cached beat chunks. */
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
    const probs = await this.chordProbs(f.cqt, f.cqtFrames);
    const t3 = now();
    const bpb = estimateBeatsPerBar(beats, downbeats);
    const units = beats.length >= 4 ? unitsFromBeats(startSec, endSec, beats, downbeats, bpb) : fixedUnits(startSec, endSec);
    const decoded = decodeUnits(probs, f.cqtFrames, this.symbols.length, CQT_FRAME_SEC, startSec, units, this.symbols, this.decodeOptions());
    const t4 = now();
    return { startSec, endSec, beats, downbeats, units: decoded, probs: keepProbs ? probs : undefined, timingsMs: { features: t1 - t0, beats: t2 - t1, chords: t3 - t2, decode: t4 - t3 } };
  }
}
