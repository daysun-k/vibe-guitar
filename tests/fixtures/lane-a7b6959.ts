/**
 * Frozen reference: barsBetween and buildLane exactly as on main at a7b6959 (before VGT-19's lane
 * changes), used by tests/lane-equivalence.test.ts. Do not edit; only the import paths differ.
 */
import type { Arrangement, ArrangedEvent } from '../../src/arrange/arrange';
import { beatIndexAt, beatTimeAt } from '../../src/chart/timing';
import type { Timing } from '../../src/chart/types';
import { findEventIndex } from '../../src/extension/playview';
import type { BigBeat } from '../../src/music/meter';

export interface RefSegment {
  event: number;
  startSec: number;
  endSec: number;
  weight: number;
}

export interface RefBar {
  bar: number;
  startSec: number;
  endSec: number;
  segments: RefSegment[];
  repeat: boolean;
}

/** Bars covering [fromSec, toSec). */
export function barsBetween(t: Timing, fromSec: number, toSec: number): { bar: number; startSec: number; endSec: number }[] {
  const bpb = t.beatsPerBar;
  const first = Math.floor(beatIndexAt(t, Math.max(0, fromSec) + 1e-6) / bpb);
  const last = Math.floor(beatIndexAt(t, Math.max(fromSec, toSec - 0.05)) / bpb);
  const out: { bar: number; startSec: number; endSec: number }[] = [];
  for (let b = first; b <= last && out.length < 2000; b++) out.push({ bar: b, startSec: beatTimeAt(t, b * bpb), endSec: beatTimeAt(t, (b + 1) * bpb) });
  return out;
}

const isActive = (e: ArrangedEvent | undefined, t: number) => !!e && t >= e.startSec && t < e.endSec;

/**
 * Bars with their chord segments. `keyOf` names an event's displayed shape, used to mark
 * a bar that repeats the previous one. A changed event (`changed`) is never drawn as a repeat
 * of a different event, so its change marker stays visible.
 */
export function buildLane(a: Arrangement, t: Timing, big: BigBeat, toSec: number, keyOf: (i: number) => string, changed: (i: number) => boolean = () => false): RefBar[] {
  const from = a.events.length ? Math.min(0, a.events[0].startSec) : 0;
  const bars = barsBetween(t, from, toSec);
  let prevKey: string | null = null;
  let prevEvent = -1;
  return bars.map((b) => {
    // Split at every event start and end inside the bar (ends mark coverage gaps), so time
    // without analysis is drawn empty. Rests and gaps are both "no chord" (-1); equal
    // neighbours merge.
    const chordAt = (sec: number): number => {
      const i = findEventIndex(a.events, sec);
      return isActive(a.events[i], sec) && !a.events[i].rest ? i : -1;
    };
    const cuts = [b.startSec];
    for (const e of a.events) {
      for (const x of [e.startSec, e.endSec]) if (x > b.startSec + 0.1 && x < b.endSec - 0.1) cuts.push(x);
    }
    cuts.sort((x, y) => x - y);
    const parts: { id: number; st: number }[] = [];
    for (const c of cuts) {
      const id = chordAt(c + 0.01);
      if (!parts.length || parts[parts.length - 1].id !== id) parts.push({ id, st: c });
    }
    const segments: RefSegment[] = parts.map((p, n) => {
      const en = n + 1 < parts.length ? parts[n + 1].st : b.endSec;
      const w = (beatIndexAt(t, en) - beatIndexAt(t, p.st)) / big.beatsPerBig;
      return { event: p.id, startSec: p.st, endSec: en, weight: Math.max(1, Math.round(w)) };
    });
    const keys = segments.map((s) => (s.event < 0 ? '-' : keyOf(s.event)));
    const ev = segments[0]?.event ?? -1;
    const repeat = segments.length === 1 && keys[0] !== '-' && keys[0] === prevKey && (!changed(ev) || ev === prevEvent);
    prevKey = keys[keys.length - 1];
    prevEvent = segments[segments.length - 1]?.event ?? -1;
    return { ...b, segments, repeat };
  });
}
