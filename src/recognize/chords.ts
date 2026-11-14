/**
 * BTC chord model helpers: block inference over normalised log-CQT frames, mapping
 * of the 170-class vocabulary to chart chord symbols, a reduced "guitar" vocabulary
 * (major / minor / 7 / maj7 / m7 / sus, plus dim / aug / m7b5), and beat-synchronous
 * Viterbi smoothing.
 */
import { CQT } from '../audio/features';
import { NO_CHORD } from '../chart/types';
import type { ModelRunner } from './runner';

export interface BtcModelMeta {
  file: string;
  mean: number;
  std: number;
  timestep: number;
  num_chords: number;
  labels: string[];
}

export interface BtcMeta {
  models: { majmin: BtcModelMeta; large: BtcModelMeta };
}

/** BTC label ("C#:min7", "N", "X") → chart chord symbol ("C#m7", "N"); null for "X". */
export function btcLabelToSymbol(label: string): string | null {
  if (label === 'N') return NO_CHORD;
  if (label === 'X') return null;
  const [root, quality = 'maj'] = label.split(':');
  const suffix: Record<string, string> = {
    maj: '',
    min: 'm',
    dim: 'dim',
    aug: 'aug',
    min6: 'm6',
    maj6: '6',
    min7: 'm7',
    minmaj7: 'm(maj7)',
    maj7: 'maj7',
    '7': '7',
    dim7: 'dim7',
    hdim7: 'm7b5',
    sus2: 'sus2',
    sus4: 'sus4',
  };
  const s = suffix[quality];
  return s === undefined ? null : `${root}${s}`;
}

/** Quality merges for the default guitar vocabulary (rare qualities fold into close common ones). */
const SIMPLE_QUALITY: Record<string, string> = {
  min6: 'min',
  maj6: 'maj',
  minmaj7: 'min',
  dim7: 'dim',
};

export type Vocabulary = 'full' | 'simple' | 'majmin';

/** Maps each model class to an output class index; returns the output labels (chart symbols). */
export function buildVocabulary(labels: string[], vocab: Vocabulary): { symbols: string[]; map: Int32Array } {
  const symbols: string[] = [];
  const index = new Map<string, number>();
  const map = new Int32Array(labels.length).fill(-1);
  labels.forEach((label, i) => {
    let l = label;
    if (l !== 'N' && l !== 'X') {
      const [root, q = 'maj'] = l.split(':');
      let quality = q;
      if (vocab === 'simple') quality = SIMPLE_QUALITY[q] ?? q;
      if (vocab === 'majmin') {
        if (['min', 'min6', 'min7', 'minmaj7'].includes(q)) quality = 'min';
        else if (['maj', 'maj6', 'maj7', '7', 'aug'].includes(q)) quality = 'maj';
        else quality = q === 'dim' || q === 'dim7' || q === 'hdim7' ? 'min' : 'maj';
      }
      l = quality === 'maj' ? root : `${root}:${quality}`;
    }
    const sym = btcLabelToSymbol(l);
    if (sym === null) return; // "X" (unknown chord) is dropped and renormalised away
    let j = index.get(sym);
    if (j === undefined) {
      j = symbols.length;
      symbols.push(sym);
      index.set(sym, j);
    }
    map[i] = j;
  });
  return { symbols, map };
}

function softmaxInto(logits: Float32Array, offset: number, n: number, out: Float32Array, outOffset: number): void {
  let max = -Infinity;
  for (let i = 0; i < n; i++) max = Math.max(max, logits[offset + i]);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const e = Math.exp(logits[offset + i] - max);
    out[outOffset + i] = e;
    sum += e;
  }
  for (let i = 0; i < n; i++) out[outOffset + i] /= sum;
}

/**
 * Frame-wise class probabilities [frames * num_chords] from log-CQT frames [frames * 144].
 * Windows of `timestep` frames with 50 % overlap; overlapping predictions are averaged
 * with triangular weights (the original BTC test script uses non-overlapping blocks).
 */
export async function predictChordProbs(runner: ModelRunner, logCqt: Float32Array, frames: number, meta: BtcModelMeta, overlap = true): Promise<Float32Array> {
  const T = meta.timestep;
  const C = meta.num_chords;
  const B = CQT.nBins;
  const hop = overlap ? T / 2 : T;
  const probs = new Float32Array(frames * C);
  const weights = new Float32Array(frames);
  const window = new Float32Array(T * B);
  const p = new Float32Array(T * C);
  const lastStart = Math.max(0, frames - T);
  const starts: number[] = [];
  for (let s = 0; s < frames; s += hop) {
    starts.push(Math.min(s, overlap ? lastStart : s));
    if (s + T >= frames) break;
  }
  for (const start of [...new Set(starts)]) {
    window.fill(0); // zero = the training mean after normalisation (BTC pads the same way)
    const n = Math.min(T, frames - start);
    for (let t = 0; t < n; t++) {
      for (let k = 0; k < B; k++) window[t * B + k] = (logCqt[(start + t) * B + k] - meta.mean) / meta.std;
    }
    const out = await runner.run('feature', window, [1, T, B]);
    for (let t = 0; t < n; t++) softmaxInto(out.logits, t * C, C, p, t * C);
    for (let t = 0; t < n; t++) {
      const w = overlap ? 1 - Math.abs((t + 0.5) / T - 0.5) * 1.9 : 1;
      const f = start + t;
      weights[f] += w;
      for (let c = 0; c < C; c++) probs[f * C + c] += w * p[t * C + c];
    }
  }
  for (let f = 0; f < frames; f++) {
    const w = weights[f] || 1;
    for (let c = 0; c < C; c++) probs[f * C + c] /= w;
  }
  return probs;
}

// ---------------------------------------------------------------- Pitch-shift averaging (VGT-18 C6)

const PITCH_CLASS: Record<string, number> = { C: 0, 'C#': 1, D: 2, 'D#': 3, E: 4, F: 5, 'F#': 6, G: 7, 'G#': 8, A: 9, 'A#': 10, B: 11 };

/** Bins per semitone of the log-CQT (24 bins per octave). */
export const BINS_PER_SEMITONE = CQT.binsPerOctave / 12;

/**
 * Log-CQT frames shifted up by `semitones` (2 bins each), repeating the edge bin (never circular):
 * out[k] = in[clamp(k − 2·semitones)]. Shifting before or after normalisation is the same (affine per bin).
 */
export function shiftCqt(cqt: Float32Array, frames: number, semitones: number, nBins = CQT.nBins): Float32Array {
  const d = Math.round(semitones * BINS_PER_SEMITONE);
  const out = new Float32Array(frames * nBins);
  for (let f = 0; f < frames; f++) {
    const o = f * nBins;
    for (let k = 0; k < nBins; k++) out[o + k] = cqt[o + Math.min(nBins - 1, Math.max(0, k - d))];
  }
  return out;
}

/**
 * For model labels ("C#:min7", "C", "N", "X"): index of the label with the root moved by `delta`
 * semitones and the same quality; N and X map to themselves.
 */
export function rootRotation(labels: string[], delta: number): Int32Array {
  const index = new Map<string, number>();
  const parsed = labels.map((l, i) => {
    if (l === 'N' || l === 'X') return null;
    const [root, q = 'maj'] = l.split(':');
    if (PITCH_CLASS[root] === undefined) throw new Error(`pitch shift: unexpected label ${l}`);
    index.set(`${PITCH_CLASS[root]}|${q}`, i);
    return { pc: PITCH_CLASS[root], q };
  });
  return Int32Array.from(parsed, (p, i) => {
    if (!p) return i;
    const j = index.get(`${(((p.pc + delta) % 12) + 12) % 12}|${p.q}`);
    if (j === undefined) throw new Error(`pitch shift: no rotated label for ${labels[i]}`);
    return j;
  });
}

/**
 * Frame-wise class probabilities averaged (equal weights) over the unshifted run and one run per
 * semitone shift of the log-CQT, each shifted run's chord roots rotated back (N and X kept).
 */
export async function predictChordProbsShifted(runner: ModelRunner, logCqt: Float32Array, frames: number, meta: BtcModelMeta, shifts: number[]): Promise<Float32Array> {
  const base = await predictChordProbs(runner, logCqt, frames, meta);
  if (!shifts.length) return base;
  const C = meta.num_chords;
  const sum = Float32Array.from(base);
  for (const s of shifts) {
    const p = await predictChordProbs(runner, shiftCqt(logCqt, frames, s), frames, meta);
    // The shifted run hears every chord s semitones higher: its root r is the original r − s.
    const rot = rootRotation(meta.labels, -s);
    for (let f = 0; f < frames; f++) for (let c = 0; c < C; c++) sum[f * C + rot[c]] += p[f * C + c];
  }
  for (let i = 0; i < sum.length; i++) sum[i] /= shifts.length + 1;
  return sum;
}

/** Collapses class probabilities onto the output vocabulary and renormalises (drops "X"). */
export function reduceProbs(probs: Float32Array, frames: number, numClasses: number, map: Int32Array, numOut: number): Float32Array {
  const out = new Float32Array(frames * numOut);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let c = 0; c < numClasses; c++) {
      const j = map[c];
      if (j < 0) continue;
      out[f * numOut + j] += probs[f * numClasses + c];
      sum += probs[f * numClasses + c];
    }
    if (sum > 0) for (let j = 0; j < numOut; j++) out[f * numOut + j] /= sum;
  }
  return out;
}

export interface DecodeUnit {
  startSec: number;
  endSec: number;
  /** Change penalty multiplier class: 0 = bar start, 1 = half bar, 2 = other beat. */
  strength: 0 | 1 | 2;
}

export interface DecodedUnit extends DecodeUnit {
  symbol: string;
  /** Mean probability of the chosen symbol over the unit. */
  confidence: number;
}

export interface DecodeOptions {
  /** Log-probability penalty for a chord change at a bar start, half bar and other beats. */
  changePenalty: [number, number, number];
  /** Unit emission: log of the mean frame probability (default) or the mean of frame log-probabilities. */
  emission?: 'meanLog';
}

export const DEFAULT_DECODE: DecodeOptions = { changePenalty: [2, 4, 6] };

/**
 * Beat-synchronous Viterbi: averages frame probabilities inside each unit (usually a
 * beat), then finds the label sequence maximising sum(log p) − change penalties. With
 * emission 'meanLog' a unit's log p is the mean of its frame log-probabilities.
 * `frameStartSec` is the time of frame 0 (frame f is centred at frameStartSec + f*frameSec).
 */
export function decodeUnits(probs: Float32Array, frames: number, numOut: number, frameSec: number, frameStartSec: number, units: DecodeUnit[], symbols: string[], opts: DecodeOptions = DEFAULT_DECODE): DecodedUnit[] {
  const U = units.length;
  if (!U) return [];
  const avg = new Float32Array(U * numOut);
  const meanLog = opts.emission === 'meanLog' ? new Float64Array(U * numOut) : null;
  for (let u = 0; u < U; u++) {
    const { startSec, endSec } = units[u];
    let f0 = Math.round((startSec - frameStartSec) / frameSec);
    let f1 = Math.round((endSec - frameStartSec) / frameSec);
    f0 = Math.max(0, Math.min(frames - 1, f0));
    f1 = Math.max(f0 + 1, Math.min(frames, f1));
    for (let f = f0; f < f1; f++) for (let j = 0; j < numOut; j++) avg[u * numOut + j] += probs[f * numOut + j];
    for (let j = 0; j < numOut; j++) avg[u * numOut + j] /= f1 - f0;
    if (meanLog) {
      for (let f = f0; f < f1; f++) for (let j = 0; j < numOut; j++) meanLog[u * numOut + j] += Math.log(probs[f * numOut + j] + 1e-9);
      for (let j = 0; j < numOut; j++) meanLog[u * numOut + j] /= f1 - f0;
    }
  }
  const logp = meanLog ? (u: number, j: number) => meanLog[u * numOut + j] : (u: number, j: number) => Math.log(avg[u * numOut + j] + 1e-9);
  let score = new Float64Array(numOut);
  const back = new Int32Array(U * numOut);
  for (let j = 0; j < numOut; j++) score[j] = logp(0, j);
  for (let u = 1; u < U; u++) {
    const pen = opts.changePenalty[units[u].strength];
    let best = 0;
    for (let j = 1; j < numOut; j++) if (score[j] > score[best]) best = j;
    const next = new Float64Array(numOut);
    for (let j = 0; j < numOut; j++) {
      const stay = score[j];
      const move = score[best] - pen;
      if (stay >= move || best === j) {
        next[j] = stay + logp(u, j);
        back[u * numOut + j] = j;
      } else {
        next[j] = move + logp(u, j);
        back[u * numOut + j] = best;
      }
    }
    score = next;
  }
  let j = 0;
  for (let k = 1; k < numOut; k++) if (score[k] > score[j]) j = k;
  const path = new Int32Array(U);
  for (let u = U - 1; u >= 0; u--) {
    path[u] = j;
    j = back[u * numOut + j];
  }
  return units.map((unit, u) => ({ ...unit, symbol: symbols[path[u]], confidence: avg[u * numOut + path[u]] }));
}

/** Top symbol of the mean probability over the last `n` frames (live "인식 중" display). */
export function topOfLastFrames(probs: Float32Array, frames: number, numOut: number, symbols: string[], n = 3): { symbol: string; confidence: number } | null {
  if (!frames) return null;
  const from = Math.max(0, frames - n);
  let best = 0;
  let bestP = -1;
  for (let j = 0; j < numOut; j++) {
    let s = 0;
    for (let f = from; f < frames; f++) s += probs[f * numOut + j];
    s /= frames - from;
    if (s > bestP) {
      bestP = s;
      best = j;
    }
  }
  return { symbol: symbols[best], confidence: bestP };
}
