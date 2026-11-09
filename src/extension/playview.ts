/** Pure play-along state: playback clock interpolation and current/next chord with countdown. */
import type { Arrangement, ArrangedEvent } from '../arrange/arrange';
import { beatIndexAt, barPosition } from '../chart/timing';
import type { Timing } from '../chart/types';

export interface PlayerSnapshot {
  currentTime: number;
  paused: boolean;
  playbackRate: number;
  /** Date.now() in the content script when currentTime was sampled. */
  sampledAt: number;
}

/** Estimated playback position now, extrapolated from the last snapshot. */
export function estimatePosition(s: PlayerSnapshot, nowMs: number, offsetMs = 0): number {
  const elapsed = s.paused ? 0 : Math.max(0, Math.min(2000, nowMs - s.sampledAt)) / 1000;
  return s.currentTime + elapsed * s.playbackRate + offsetMs / 1000;
}

export interface PlayView {
  position: number;
  current: ArrangedEvent | null;
  currentIndex: number;
  next: ArrangedEvent | null;
  /** Beats until the next chord change (fractional), null if no next chord. */
  beatsUntilNext: number | null;
  /** Whole beats left in the countdown (ceil), shown when inside the look-ahead window. */
  countdown: number | null;
  inLookAhead: boolean;
  bar: number;
  beatInBar: number;
  /** 1..beatsPerBar while counting in to the first chord (or after a rest); else null. */
  countIn: number | null;
}

export function findEventIndex(events: { startSec: number }[], t: number): number {
  let lo = 0;
  let hi = events.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (events[mid].startSec <= t) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

export function computePlayView(a: Arrangement, timing: Timing, position: number, lookAheadBars = 1): PlayView {
  const idx = findEventIndex(a.events, position);
  const current = idx >= 0 ? a.events[idx] : null;
  const next = a.events[idx + 1] ?? null;
  const beatsUntilNext = next ? beatIndexAt(timing, next.startSec) - beatIndexAt(timing, position) : null;
  const window = lookAheadBars * timing.beatsPerBar;
  const inLookAhead = beatsUntilNext !== null && beatsUntilNext <= window + 1e-9;
  const pos = barPosition(timing, position);
  let countIn: number | null = null;
  if ((current === null || current.rest) && next && !next.rest && beatsUntilNext !== null && beatsUntilNext <= timing.beatsPerBar && beatsUntilNext > 0) {
    countIn = Math.max(1, timing.beatsPerBar - Math.ceil(beatsUntilNext - 1e-9) + 1);
  }
  return {
    position,
    current,
    currentIndex: idx,
    next,
    beatsUntilNext,
    countdown: inLookAhead && beatsUntilNext !== null ? Math.max(0, Math.ceil(beatsUntilNext - 1e-9)) : null,
    inLookAhead,
    bar: pos.bar,
    beatInBar: pos.beatInBar,
    countIn,
  };
}
