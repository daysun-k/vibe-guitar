/**
 * Pure model of the play view's bar-grid lane: bars, chord segments per bar, sections,
 * and the chord-shape strip.
 */
import type { Arrangement, ArrangedEvent } from '../arrange/arrange';
import { formatChord, isNoChord, parseChord } from '../arrange/chord';
import { beatIndexAt, beatTimeAt } from '../chart/timing';
import type { Timing } from '../chart/types';
import type { LyricLine } from '../lyrics/types';
import { findEventIndex } from '../extension/playview';
import type { BigBeat } from '../music/meter';

export interface LaneSegment {
  /** Index into arrangement.events, or -1 when no chord is active. */
  event: number;
  startSec: number;
  endSec: number;
  /** Width in big beats (≥ 1). */
  weight: number;
}

export interface LaneBar {
  /** Bar number in the timing grid (0 = first downbeat; may be negative for a pickup). */
  bar: number;
  startSec: number;
  endSec: number;
  segments: LaneSegment[];
  /** One segment, same shape as the end of the previous bar (drawn as a repeat sign). */
  repeat: boolean;
}

export interface LaneSection {
  name: string;
  /** Index into the bars array. */
  firstBar: number;
  startSec: number;
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
export function buildLane(a: Arrangement, t: Timing, big: BigBeat, toSec: number, keyOf: (i: number) => string, changed: (i: number) => boolean = () => false): LaneBar[] {
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
    const segments: LaneSegment[] = parts.map((p, n) => {
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

const normText = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

function barAtOrAfter(bars: { startSec: number }[], sec: number): number {
  const i = bars.findIndex((b) => b.startSec >= sec - 0.2);
  return i < 0 ? bars.length : i;
}

function nearestBar(bars: { startSec: number }[], sec: number): number {
  let best = 0;
  bars.forEach((b, i) => {
    if (Math.abs(b.startSec - sec) < Math.abs(bars[best].startSec - sec)) best = i;
  });
  return best;
}

/**
 * Section labels. With lyrics: lines are grouped into blocks that split at instrumental
 * gaps and where the lyric switches between repeated lines (sung more than once in the
 * song → "후렴") and lines sung once (numbered verses, "1절", "2절"); gaps become
 * 인트로 / 간주 / 아웃트로. Without lyrics: groups of 8 bars.
 */
export function buildSections(bars: { startSec: number; endSec: number }[], lines: LyricLine[] | null): LaneSection[] {
  if (!bars.length) return [];
  const barLen = bars[0].endSec - bars[0].startSec;
  if (!lines || !lines.length) {
    const out: LaneSection[] = [];
    for (let i = 0; i < bars.length; i += 8) out.push({ name: `${i + 1}–${Math.min(bars.length, i + 8)}마디`, firstBar: i, startSec: bars[i].startSec });
    return out;
  }
  const gap = Math.max(2.5, barLen * 1.5);
  const texts = lines.map((l) => normText(l.text));
  const counts = new Map<string, number>();
  for (const t of texts) counts.set(t, (counts.get(t) ?? 0) + 1);
  const rep = texts.map((t) => (counts.get(t) ?? 0) >= 2);
  // A single line that disagrees with both neighbours follows them (avoids one-line sections).
  const smooth = rep.map((r, i) => (i > 0 && i + 1 < rep.length && rep[i - 1] === rep[i + 1] && r !== rep[i - 1] ? rep[i - 1] : r));
  const blocks: LyricLine[][] = [];
  const isChorus: boolean[] = [];
  lines.forEach((l, i) => {
    const cur = blocks[blocks.length - 1];
    if (cur && l.startSec - cur[cur.length - 1].endSec <= gap && smooth[i] === isChorus[isChorus.length - 1]) cur.push(l);
    else {
      blocks.push([l]);
      isChorus.push(smooth[i]);
    }
  });
  // A short run of once-sung lines straight after a chorus (no gap) is the chorus's tail, not a verse.
  for (let i = blocks.length - 1; i > 0; i--) {
    const prev = blocks[i - 1];
    if (!isChorus[i] && isChorus[i - 1] && blocks[i].length < 4 && blocks[i][0].startSec - prev[prev.length - 1].endSec <= gap) {
      prev.push(...blocks[i]);
      blocks.splice(i, 1);
      isChorus.splice(i, 1);
    }
  }
  const raw: LaneSection[] = [];
  let verse = 0;
  blocks.forEach((b, i) => {
    const firstBar = nearestBar(bars, b[0].startSec);
    const prevEnd = i > 0 ? blocks[i - 1][blocks[i - 1].length - 1].endSec : null;
    if (i === 0 && firstBar > 0) raw.push({ name: '인트로', firstBar: 0, startSec: bars[0].startSec });
    if (prevEnd !== null) {
      const g = barAtOrAfter(bars, prevEnd);
      if (firstBar - g >= 2) raw.push({ name: '간주', firstBar: g, startSec: bars[g].startSec });
    }
    raw.push({ name: isChorus[i] ? '후렴' : `${++verse}절`, firstBar, startSec: bars[firstBar].startSec });
  });
  const lastEnd = blocks[blocks.length - 1].at(-1)!.endSec;
  const out = barAtOrAfter(bars, lastEnd);
  if (bars.length - out >= 2) raw.push({ name: '아웃트로', firstBar: out, startSec: bars[out].startSec });
  // Keep sections strictly increasing; a later label on the same bar replaces the earlier one.
  const res: LaneSection[] = [];
  for (const s of raw) {
    while (res.length && res[res.length - 1].firstBar >= s.firstBar) res.pop();
    res.push(s);
  }
  if (res[0].firstBar > 0) res.unshift({ name: '인트로', firstBar: 0, startSec: bars[0].startSec });
  return res;
}

// ---------- names ----------

/** Shape name with 7th/6th/extensions removed ("Em7" → "Em", "Cmaj7" → "C"). */
export function simpleShape(name: string): string {
  if (isNoChord(name)) return name;
  try {
    const c = parseChord(name);
    return formatChord({ ...c, seventh: 'none', extension: null, adds: [], alterations: c.alterations.filter((x) => x === 'b5' || x === '#5'), bass: null, bassName: null });
  } catch {
    return name;
  }
}

/** True when the level reduction dropped a 7th from the original (shown as a tiny superscript 7). */
export function droppedSeventh(e: ArrangedEvent): boolean {
  if (e.rest || !e.transformations.some((x) => x.kind === 'substitution' && x.reason === 'level-simplify')) return false;
  try {
    const o = parseChord(e.original);
    const s = parseChord(e.sounding ?? '');
    return (o.seventh === 'b7' || o.seventh === 'maj7') && s.seventh === 'none';
  } catch {
    return false;
  }
}

export interface StripItem {
  key: string;
  shape: string;
  sounding: string;
  event: ArrangedEvent;
}

/**
 * Shapes in order of first appearance; `keys[i]` is the strip key of event i ('' for rests).
 * The key includes the event's change (original → sounding), so an original Fmaj7 and an
 * F played as Fmaj7 on the same fingering are separate items and each keeps its own marker.
 */
export function stripItems(a: Arrangement): { items: StripItem[]; keys: string[] } {
  const items: StripItem[] = [];
  const seen = new Set<string>();
  const keys = a.events.map((e) => {
    if (e.rest || !e.shape) return '';
    const key = `${e.shape}|${e.voicing?.id ?? ''}|${e.change ? `${e.change.original}>${e.change.sounding}` : ''}`;
    if (!seen.has(key)) {
      seen.add(key);
      items.push({ key, shape: e.shape, sounding: e.sounding ?? e.shape, event: e });
    }
    return key;
  });
  return { items, keys };
}
