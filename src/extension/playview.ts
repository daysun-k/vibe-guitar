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
  /** Index of the current event; negative (and unique per gap) when no chord is active. */
  currentIndex: number;
  next: ArrangedEvent | null;
  /** Beats until the next chord change (fractional), null if no next chord. */
  beatsUntilNext: number | null;
  /** Whole beats left in the countdown (ceil), shown when inside the look-ahead window. */
  countdown: number | null;
  inLookAhead: boolean;
  bar: number;
  beatInBar: number;
  /** 1..beatsPerBar while counting in to the first chord (or after a rest / gap); else null. */
  countIn: number | null;
  /** When the current chord is the last one before a coverage gap: the time the coverage ends. */
  endOfCoverage: number | null;
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

const EPS = 1e-9;

/**
 * Current/next chord at `position`. Coverage is applied through the arranged events,
 * whose end times come from normalizeCoverage (chartToInputEvents), so lookups here
 * use the same merged ranges. Events are half-open [startSec, endSec): outside every
 * event (before the first, in a coverage gap, after the end) there is no current chord.
 * While a chord is active and the coverage ends before the next event, there is no
 * "next" chord (the next change is unknown), so the look-ahead does not jump the gap.
 */
export function computePlayView(a: Arrangement, timing: Timing, position: number, lookAheadBars = 1): PlayView {
  const idx = findEventIndex(a.events, position);
  const candidate = idx >= 0 ? a.events[idx] : null;
  const current = candidate && position < candidate.endSec - EPS ? candidate : null;
  const following = a.events[idx + 1] ?? null;
  const gapAhead = current !== null && following !== null && current.endSec < following.startSec - 1e-6;
  const next = gapAhead ? null : following;
  const beatsUntilNext = next ? beatIndexAt(timing, next.startSec) - beatIndexAt(timing, position) : null;
  const window = lookAheadBars * timing.beatsPerBar;
  const inLookAhead = beatsUntilNext !== null && beatsUntilNext <= window + EPS;
  const pos = barPosition(timing, position);
  let countIn: number | null = null;
  if ((current === null || current.rest) && next && !next.rest && beatsUntilNext !== null && beatsUntilNext <= timing.beatsPerBar && beatsUntilNext > 0) {
    countIn = Math.max(1, timing.beatsPerBar - Math.ceil(beatsUntilNext - EPS) + 1);
  }
  return {
    position,
    current,
    currentIndex: current ? idx : -1 - Math.max(0, idx + 1),
    next,
    beatsUntilNext,
    countdown: inLookAhead && beatsUntilNext !== null ? Math.max(0, Math.ceil(beatsUntilNext - EPS)) : null,
    inLookAhead,
    bar: pos.bar,
    beatInBar: pos.beatInBar,
    countIn,
    endOfCoverage: gapAhead ? current!.endSec : null,
  };
}
