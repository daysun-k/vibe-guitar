/**
 * Practice controls of the play view (VGT-9): the playback speeds offered to a beginner and an
 * A/B loop over lane bars. The loop is kept in chart time (the bar grid), never lyric lines.
 * Pure logic (no DOM, no chrome APIs) so it can be unit-tested.
 */
import type { LaneBar } from './lane';

/** The three speeds of the speed control (the user chose these; no slider). */
export const PRACTICE_RATES = [0.5, 0.75, 1] as const;
export type PracticeRate = (typeof PRACTICE_RATES)[number];

export function isPracticeRate(x: unknown): x is PracticeRate {
  return typeof x === 'number' && (PRACTICE_RATES as readonly number[]).includes(x);
}

/** The speed button matching a reported rate, or null when the site set some other rate. */
export function pressedRate(reported: number): PracticeRate | null {
  return PRACTICE_RATES.find((r) => Math.abs(r - reported) < 1e-3) ?? null;
}

/** "0.75×", "1.25×", "1×" */
export function rateLabel(rate: number): string {
  return `${Number(rate.toFixed(2))}×`;
}

/** A loop over whole bars of one recording's (or the demo's) chart. */
export interface PracticeLoop {
  /** Recording (or demo) the loop belongs to: "source:id". */
  key: string;
  /** Grid bar numbers (LaneBar.bar) of the first (A) and last (B) bar; fromBar <= toBar. */
  fromBar: number;
  toBar: number;
  /** Start of the A bar. */
  startSec: number;
  /** Where playback jumps back: the end of the B bar (a little before the end of the song). */
  endSec: number;
}

/** A loop that ends at the end of the song jumps this much earlier (an ended player stops reporting progress). */
const SONG_END_GUARD_SEC = 0.3;
/** A bar with this start is "the same bar" after a rebuild (chord fixes and level changes keep the grid). */
const SAME_BAR_SEC = 0.02;

function loopEnd(bar: LaneBar, startSec: number, durationSec: number | undefined): number {
  const songEnd = durationSec && durationSec > startSec + 1 ? durationSec - SONG_END_GUARD_SEC : Infinity;
  return Math.min(bar.endSec, songEnd);
}

/** A loop from bar index `a` to bar index `b` of `bars` (either order; equal = one bar). */
export function makeLoop(key: string, bars: readonly LaneBar[], a: number, b: number, durationSec?: number): PracticeLoop | null {
  const i = Math.min(a, b);
  const j = Math.max(a, b);
  if (!key || i < 0 || j >= bars.length) return null;
  const startSec = bars[i].startSec;
  const endSec = loopEnd(bars[j], startSec, durationSec);
  if (!(endSec > startSec)) return null;
  return { key, fromBar: bars[i].bar, toBar: bars[j].bar, startSec, endSec };
}

/** Indexes into `bars` of the loop's A and B bars, or null when either bar no longer exists. */
export function loopBarIndexes(loop: PracticeLoop, bars: readonly LaneBar[]): [number, number] | null {
  const i = bars.findIndex((b) => b.bar === loop.fromBar && Math.abs(b.startSec - loop.startSec) < SAME_BAR_SEC);
  const j = bars.findIndex((b) => b.bar === loop.toBar);
  return i >= 0 && j >= i ? [i, j] : null;
}

/**
 * The loop after the chart, its timing or the recording changed: kept (end re-read) while the
 * recording is the same and both bars still exist at the same place, otherwise null.
 */
export function resolveLoop(loop: PracticeLoop | null, key: string, bars: readonly LaneBar[], durationSec?: number): PracticeLoop | null {
  if (!loop || loop.key !== key) return null;
  const at = loopBarIndexes(loop, bars);
  return at ? makeLoop(key, bars, at[0], at[1], durationSec) : null;
}

/** Where a loop jump (or a play from the loop start) seeks: just inside the A bar, like a bar click. */
export function loopStartTarget(loop: Pick<PracticeLoop, 'startSec'>): number {
  return Math.max(0, loop.startSec) + 0.01;
}

/**
 * Where an explicit start (the play button, Space) begins and may count in: the loop's first bar
 * when a loop is on and the playhead is outside it, else the start of the bar under the playhead.
 */
export function explicitStartSec(loop: Pick<PracticeLoop, 'startSec' | 'endSec'> | null, positionSec: number, barStartSec: number | null): number {
  if (loop && !insideLoop(loop, positionSec)) return loopStartTarget(loop);
  return Math.max(0, barStartSec ?? positionSec);
}

/** A position this much before A still counts as inside the loop (a seek can land a little early). */
export const LOOP_EDGE_SEC = 0.35;
/** Past B by more than this is not a crossing of B but a move elsewhere (e.g. the site's own slider). */
export const LOOP_OVERSHOOT_SEC = 3;
/** A seek that does not show up in the reported position within this time is given up. */
export const LOOP_SETTLE_MS = 1500;

export function insideLoop(loop: Pick<PracticeLoop, 'startSec' | 'endSec'>, sec: number): boolean {
  return sec >= loop.startSec - LOOP_EDGE_SEC && sec < loop.endSec;
}

export interface LoopObservation {
  /** Player position (estimated from its latest report, without the sync offset). */
  positionSec: number;
  playing: boolean;
  isAd: boolean;
  /** Time of the observation in ms on a monotonic clock (the panel's panelClock), the same clock as seeked(). */
  nowMs: number;
}

/**
 * Decides loop jumps from the player's observed position. A content script's seek reply does not
 * prove the seek finished, so after every seek (a jump or the user's own) later observations are
 * ignored until the position shows up near the seek target, or LOOP_SETTLE_MS passes. That avoids
 * double jumps from reports taken before the seek. It jumps only when playback crossed the end of
 * B from inside the loop (up to LOOP_OVERSHOOT_SEC late), never while an ad plays or while paused,
 * and it never counts in (the count-in belongs to an explicit start).
 */
export class LoopJumper {
  private range: Pick<PracticeLoop, 'startSec' | 'endSec'> | null = null;
  private wasInside = false;
  private pending: { target: number; sinceMs: number } | null = null;

  /** A new loop (or none): forgets everything about the previous one. */
  set(range: Pick<PracticeLoop, 'startSec' | 'endSec'> | null): void {
    this.range = range ? { startSec: range.startSec, endSec: range.endSec } : null;
    this.wasInside = false;
    this.pending = null;
  }

  get active(): boolean {
    return this.range !== null;
  }

  /** The panel moved the playhead (bar click, slider, arrow keys, count-in, a loop jump). */
  seeked(targetSec: number, nowMs: number): void {
    this.pending = { target: targetSec, sinceMs: nowMs };
    this.wasInside = this.range ? insideLoop(this.range, targetSec) : false;
  }

  /** Seek target of a loop jump, or null. A returned jump is already recorded as pending. */
  observe(o: LoopObservation): number | null {
    const r = this.range;
    if (!r || o.isAd || !Number.isFinite(o.positionSec)) return null;
    const p = o.positionSec;
    if (this.pending) {
      const elapsedSec = Math.max(0, o.nowMs - this.pending.sinceMs) / 1000;
      // Reports lag: a landed seek reads as target + time since the seek (rate <= 1, plus slack).
      const landed = p >= this.pending.target - LOOP_EDGE_SEC && p <= this.pending.target + 0.5 + elapsedSec;
      if (!landed && elapsedSec * 1000 < LOOP_SETTLE_MS) return null;
      const { target } = this.pending;
      this.pending = null;
      if (landed) {
        // A report from just before a nearby seek can look landed too: trust the target, not this reading.
        this.wasInside = insideLoop(r, target);
        return null;
      }
      // Never showed up: judge from where playback is now.
    }
    if (insideLoop(r, p)) {
      this.wasInside = true;
      return null;
    }
    if (p < r.startSec - LOOP_EDGE_SEC || !this.wasInside) {
      this.wasInside = false;
      return null;
    }
    if (p - r.endSec > LOOP_OVERSHOOT_SEC) {
      this.wasInside = false;
      return null;
    }
    if (!o.playing) return null; // paused just after B: jump when playback resumes
    const target = loopStartTarget(r);
    this.seeked(target, o.nowMs);
    return target;
  }
}
