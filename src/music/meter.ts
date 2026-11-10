/**
 * Meter helpers for the play view: compound-meter "big beats" and bar-phase correction.
 *
 * Big beat: the pulse a player counts. In 6/8 or 12/8 (and in a 6-beat bar tracked at a
 * fast eighth-note tempo) that is the dotted quarter, three tracker beats. Countdown,
 * look-ahead and count-in all count big beats.
 *
 * Bar phase: a beat tracker can put the downbeat on the wrong beat of the bar. Chord
 * changes mostly land on bar starts, so we pick the phase (0..beatsPerBar-1) that puts the
 * most changes on a bar start and shift the grid when the evidence is clear.
 */
import { beatIndexAt, beatSeconds, beatTimeAt } from '../chart/timing';
import type { Timing } from '../chart/types';

export interface BigBeat {
  /** Tracker beats per big beat (3 in compound meter, else 1). */
  beatsPerBig: number;
  bigPerBar: number;
  compound: boolean;
  /** Display meter, e.g. "6/8", "4/4". */
  label: string;
}

/** Compound when the bar has 6, 9 or 12 beats counted in eighths (beatUnit 8, or a fast tracker tempo). */
export function bigBeatInfo(t: Timing): BigBeat {
  const bpb = t.beatsPerBar;
  const compound = bpb >= 6 && bpb % 3 === 0 && (t.beatUnit === 8 || t.bpm >= 120);
  if (compound) return { beatsPerBig: 3, bigPerBar: bpb / 3, compound, label: `${bpb}/8` };
  return { beatsPerBig: 1, bigPerBar: bpb, compound: false, label: `${bpb}/${t.beatUnit ?? 4}` };
}

/** Fractional big-beat index at `sec` (0 = first downbeat). */
export function bigBeatIndexAt(t: Timing, big: BigBeat, sec: number): number {
  return beatIndexAt(t, sec) / big.beatsPerBig;
}

export function bigBeatTimeAt(t: Timing, big: BigBeat, k: number): number {
  return beatTimeAt(t, k * big.beatsPerBig);
}

/** Typical big-beat length in seconds (median of the explicit beat grid when present). */
export function bigBeatSeconds(t: Timing, big: BigBeat): number {
  const b = t.beatTimes;
  if (b && b.length >= 3) {
    const d = b
      .slice(1)
      .map((x, i) => x - b[i])
      .sort((x, y) => x - y);
    return d[d.length >> 1] * big.beatsPerBig;
  }
  return beatSeconds(t) * big.beatsPerBig;
}

/** Whole big beats left until `targetSec` (at least 1 while the target is ahead). */
export function bigBeatsUntil(t: Timing, big: BigBeat, nowSec: number, targetSec: number): number {
  const d = (beatIndexAt(t, targetSec) - beatIndexAt(t, nowSec)) / big.beatsPerBig;
  return d <= 1e-6 ? 0 : Math.max(1, Math.ceil(d - 1e-6));
}

export interface PhaseEstimate {
  /** Beat index (mod beatsPerBar) that should be the downbeat; 0 = current grid. */
  phase: number;
  /** Changes that land on a beat with this phase as bar start. */
  hits: number;
  /** Same count for the current grid (phase 0). */
  currentHits: number;
  /** Chord changes that sit on a beat at all (within ±0.3 beat). */
  onBeat: number;
  votes: number[];
}

/** Count, per beat position in the bar, the chord changes that start there. */
export function estimateBarPhase(t: Timing, changeTimes: number[]): PhaseEstimate {
  const bpb = t.beatsPerBar;
  const votes = new Array<number>(bpb).fill(0);
  let onBeat = 0;
  for (const sec of changeTimes) {
    const k = beatIndexAt(t, sec);
    const r = Math.round(k);
    if (Math.abs(k - r) > 0.3) continue;
    onBeat++;
    votes[((r % bpb) + bpb) % bpb]++;
  }
  let phase = 0;
  for (let p = 1; p < bpb; p++) if (votes[p] > votes[phase]) phase = p;
  return { phase, hits: votes[phase], currentHits: votes[0], onBeat, votes };
}

/** Shift is applied only when it clearly wins: 3+ more changes and 1.5× the current grid. */
export function phaseIsClear(e: PhaseEstimate): boolean {
  return e.phase !== 0 && e.hits - e.currentHits >= 3 && e.hits >= 1.5 * e.currentHits;
}

/**
 * Timing whose bar starts fall on beat `phase` of the old grid. Explicit beat times are kept
 * and synthetic beats are prepended, so every original beat time survives.
 */
export function shiftBarPhase(t: Timing, phase: number): Timing {
  const bpb = t.beatsPerBar;
  const p = ((phase % bpb) + bpb) % bpb;
  if (p === 0) return t;
  const beats = t.beatTimes && t.beatTimes.length >= 2 ? t.beatTimes : null;
  if (!beats) return { ...t, firstDownbeatSec: t.firstDownbeatSec + p * beatSeconds(t) };
  const pad = bpb - p;
  const step = beats[1] - beats[0] > 0 ? beats[1] - beats[0] : beatSeconds(t);
  const pre = Array.from({ length: pad }, (_, i) => beats[0] - (pad - i) * step);
  const beatTimes = [...pre.map((x) => Math.round(x * 1000) / 1000), ...beats];
  return { ...t, beatTimes, firstDownbeatSec: beatTimes[0] };
}

export interface AlignedTiming {
  timing: Timing;
  estimate: PhaseEstimate;
  shifted: boolean;
}

/** Bar grid with the downbeat phase that puts the most chord changes on bar starts. */
export function alignBarPhase(t: Timing, changeTimes: number[]): AlignedTiming {
  const estimate = estimateBarPhase(t, changeTimes);
  if (!phaseIsClear(estimate)) return { timing: t, estimate, shifted: false };
  return { timing: shiftBarPhase(t, estimate.phase), estimate, shifted: true };
}
