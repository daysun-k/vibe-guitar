/**
 * Beat This! inference helpers: chunking with borders (split_piece / aggregate_prediction
 * keep_first from CPJKU/beat_this inference.py), "minimal" peak-picking postprocessing,
 * and tempo / meter estimates for the chart timing.
 */
import { MEL } from '../audio/features';
import type { ModelRunner } from './runner';

export const BEAT_CHUNK = 1500;
export const BEAT_BORDER = 6;

export interface BeatLogits {
  beat: Float32Array;
  downbeat: Float32Array;
}

/** Start frames of the chunks for a piece of `frames` frames (beat_this split_piece). */
export function chunkStarts(frames: number, chunk = BEAT_CHUNK, border = BEAT_BORDER): number[] {
  const starts: number[] = [];
  for (let s = -border; s < frames - border; s += chunk - 2 * border) starts.push(s);
  if (frames > chunk - 2 * border && starts.length) starts[starts.length - 1] = frames - (chunk - border);
  return starts;
}

/** Runs the beat model over log-mel frames [frames * 128]. */
export async function predictBeatLogits(runner: ModelRunner, mel: Float32Array, frames: number): Promise<BeatLogits> {
  const nMels = MEL.nMels;
  const beat = new Float32Array(frames).fill(-1000);
  const downbeat = new Float32Array(frames).fill(-1000);
  const starts = chunkStarts(frames);
  const results: { start: number; beat: Float32Array; downbeat: Float32Array }[] = [];
  for (const start of starts) {
    const from = Math.max(start, 0);
    const to = Math.min(start + BEAT_CHUNK, frames);
    const left = Math.max(0, -start);
    const right = Math.max(0, Math.min(BEAT_BORDER, start + BEAT_CHUNK - frames));
    const len = left + (to - from) + right;
    const input = new Float32Array(len * nMels);
    input.set(mel.subarray(from * nMels, to * nMels), left * nMels);
    const out = await runner.run('spect', input, [1, len, nMels]);
    results.push({ start, beat: out.beat, downbeat: out.downbeat });
  }
  // keep_first: write later chunks first so earlier ones overwrite them.
  for (let i = results.length - 1; i >= 0; i--) {
    const r = results[i];
    const inner = r.beat.length - 2 * BEAT_BORDER;
    for (let j = 0; j < inner; j++) {
      const f = r.start + BEAT_BORDER + j;
      if (f < 0 || f >= frames) continue;
      beat[f] = r.beat[BEAT_BORDER + j];
      downbeat[f] = r.downbeat[BEAT_BORDER + j];
    }
  }
  return { beat, downbeat };
}

/** Local maxima within ±3 frames whose logit is > 0, then merge peaks 1 frame apart. */
function pickPeaks(logits: Float32Array): number[] {
  const n = logits.length;
  const peaks: number[] = [];
  for (let i = 0; i < n; i++) {
    const v = logits[i];
    if (!(v > 0)) continue;
    let isMax = true;
    for (let j = Math.max(0, i - 3); j <= Math.min(n - 1, i + 3); j++) {
      if (logits[j] > v) {
        isMax = false;
        break;
      }
    }
    if (isMax) peaks.push(i);
  }
  // deduplicate_peaks(width=1): average runs of peaks within 1 frame of each other.
  const out: number[] = [];
  let run: number[] = [];
  for (const p of peaks) {
    if (run.length && p - run[run.length - 1] > 1) {
      out.push(run.reduce((a, b) => a + b, 0) / run.length);
      run = [];
    }
    run.push(p);
  }
  if (run.length) out.push(run.reduce((a, b) => a + b, 0) / run.length);
  return out;
}

export interface BeatResult {
  /** Seconds from the start of the analysed audio. */
  beats: number[];
  downbeats: number[];
}

export function postprocessMinimal(logits: BeatLogits, fps: number = MEL.fps): BeatResult {
  const beats = pickPeaks(logits.beat).map((f) => f / fps);
  const rawDown = pickPeaks(logits.downbeat).map((f) => f / fps);
  // Every downbeat must be a beat: snap to the nearest beat, unique.
  const set = new Set<number>();
  for (const d of rawDown) {
    if (!beats.length) break;
    let best = beats[0];
    for (const b of beats) if (Math.abs(b - d) < Math.abs(best - d)) best = b;
    set.add(best);
  }
  return { beats, downbeats: [...set].sort((a, b) => a - b) };
}

function median(xs: number[]): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function estimateBpm(beats: number[]): number | null {
  const ibis: number[] = [];
  for (let i = 1; i < beats.length; i++) ibis.push(beats[i] - beats[i - 1]);
  const m = median(ibis);
  return Number.isFinite(m) && m > 0 ? 60 / m : null;
}

/** Most common number of beats between consecutive downbeats (2..7); default 4. */
export function estimateBeatsPerBar(beats: number[], downbeats: number[]): number {
  const counts = new Map<number, number>();
  for (let i = 1; i < downbeats.length; i++) {
    const n = beats.filter((b) => b >= downbeats[i - 1] - 1e-6 && b < downbeats[i] - 1e-6).length;
    if (n >= 2 && n <= 7) counts.set(n, (counts.get(n) ?? 0) + 1);
  }
  let best = 4;
  let bestCount = 0;
  for (const [n, c] of counts) {
    if (c > bestCount || (c === bestCount && n === 4)) {
      best = n;
      bestCount = c;
    }
  }
  return best;
}
