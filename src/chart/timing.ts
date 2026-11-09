/** Beat grid helpers. Beat index 0 is the first downbeat; indices are fractional. */
import type { Timing } from './types';

export function beatSeconds(t: Timing): number {
  return 60 / t.bpm;
}

export function barSeconds(t: Timing): number {
  return beatSeconds(t) * t.beatsPerBar;
}

function explicitBeats(t: Timing): number[] | null {
  return t.beatTimes && t.beatTimes.length >= 2 ? t.beatTimes : null;
}

/** Playback time of (fractional) beat index k. */
export function beatTimeAt(t: Timing, k: number): number {
  const beats = explicitBeats(t);
  const d = beatSeconds(t);
  if (!beats) return t.firstDownbeatSec + k * d;
  const last = beats.length - 1;
  if (k <= 0) return beats[0] + k * d;
  if (k >= last) return beats[last] + (k - last) * d;
  const i = Math.floor(k);
  return beats[i] + (k - i) * (beats[i + 1] - beats[i]);
}

/** Fractional beat index at playback time `sec` (inverse of beatTimeAt). */
export function beatIndexAt(t: Timing, sec: number): number {
  const beats = explicitBeats(t);
  const d = beatSeconds(t);
  if (!beats) return (sec - t.firstDownbeatSec) / d;
  const last = beats.length - 1;
  if (sec <= beats[0]) return (sec - beats[0]) / d;
  if (sec >= beats[last]) return last + (sec - beats[last]) / d;
  let lo = 0;
  let hi = last;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (beats[mid] <= sec) lo = mid;
    else hi = mid;
  }
  return lo + (sec - beats[lo]) / (beats[hi] - beats[lo]);
}

export interface BarPosition {
  /** 0-based bar number (negative before the first downbeat). */
  bar: number;
  /** 0-based beat inside the bar. */
  beatInBar: number;
  /** 0..1 progress inside the current beat. */
  beatFraction: number;
  beatIndex: number;
}

export function barPosition(t: Timing, sec: number): BarPosition {
  const beatIndex = beatIndexAt(t, sec);
  const whole = Math.floor(beatIndex);
  const bar = Math.floor(whole / t.beatsPerBar);
  return {
    bar,
    beatInBar: whole - bar * t.beatsPerBar,
    beatFraction: beatIndex - whole,
    beatIndex,
  };
}

/** Duration in beats between two playback times. */
export function beatsBetween(t: Timing, fromSec: number, toSec: number): number {
  return beatIndexAt(t, toSec) - beatIndexAt(t, fromSec);
}

/** Snap a time to the nearest grid line of `subdivision` steps per beat. */
export function quantizeTime(t: Timing, sec: number, subdivision = 1): number {
  const k = beatIndexAt(t, sec);
  return beatTimeAt(t, Math.round(k * subdivision) / subdivision);
}

/** Time of the downbeat at or before `sec`. */
export function previousDownbeat(t: Timing, sec: number): number {
  const { bar } = barPosition(t, sec);
  return beatTimeAt(t, bar * t.beatsPerBar);
}
