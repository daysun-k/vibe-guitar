/**
 * Uncertain stretches on the play view (VGT-19): which stored spans show, and the second choice
 * named the way the screen names chords (capo shape names, the level's simplification). The side
 * panel only draws these marks.
 */
import { arrangeEvents, type Arrangement } from '../arrange/arrange';
import { isNoChord } from '../arrange/chord';
import type { Level, Profile } from '../arrange/levels';
import type { Chart, Timing, UncertainSpan } from '../chart/types';
import { LANE_JOIN_GAP_SEC, laneJoins, sameChordSymbol, uncertainSpanEvent, type EventRef } from '../editor/correct';
import { prettyChord, respellChord, shapeName, type KeyEstimate } from '../music/key';

export interface VisibleSpan {
  /** The span as stored (used to find it again when replacing). */
  span: UncertainSpan;
  /** The stored event it applies to, as an EventRef for the replacement write. */
  ref: EventRef;
}

/**
 * Spans that show: the toggle is on, the span lies inside one event, and that event is still an
 * auto event with the span's chord. Everything else (a manually fixed event, a chart without
 * spans, the toggle off) shows nothing.
 */
export function visibleSpans(chart: Chart, on: boolean): VisibleSpan[] {
  if (!on || !chart.uncertain?.length) return [];
  const out: VisibleSpan[] = [];
  for (const span of chart.uncertain) {
    const i = uncertainSpanEvent(chart, span);
    if (i < 0) continue;
    const e = chart.events[i];
    out.push({ span, ref: { startSec: e.startSec, chord: e.chord } });
  }
  return out;
}

export interface AltNameOptions {
  level: Level;
  capo: number;
  profile?: Profile;
  allowRootChange?: boolean;
}

/**
 * The second choice named like the shown chords of that screen: spelled for the key, arranged at
 * the level (입문 drops 7ths) and named as a capo shape. `sounding` is the concert name (shown only
 * where the screen already shows concert names).
 */
export function altNames(alt: string, key: KeyEstimate | null, timing: Timing, span: Pick<UncertainSpan, 'fromSec' | 'toSec'>, o: AltNameOptions): { name: string; sounding: string } {
  if (isNoChord(alt)) return { name: 'N.C.', sounding: 'N.C.' };
  const spelled = respellChord(alt, key);
  const a = arrangeEvents([{ startSec: span.fromSec, endSec: span.toSec, chord: spelled, confidence: 1 }], timing, o).events[0];
  if (!a || a.rest || !a.shape) return { name: shapeName(spelled, o.capo), sounding: prettyChord(spelled) };
  const name = o.capo ? a.shape : (a.sounding ?? a.shape);
  return { name: prettyChord(name), sounding: prettyChord(a.sounding ?? name) };
}

export interface UncertainMark extends VisibleSpan {
  fromSec: number;
  toSec: number;
  /** Shown name of the second choice ("Am" with a capo shape name). */
  alt: string;
  /** Concert name of the second choice (equal to `alt` without a capo). */
  altSounding: string;
  /** Replace tier: the panel offers the one-tap replacement (else the second choice is only shown). */
  replace: boolean;
  /** The stretch was heard as no chord (its lane segment is empty; the second choice is a chord). */
  noChord: boolean;
}

/**
 * Marks of the play model: visible spans whose stretch is drawn as the span's chord (a short chord
 * merged into the previous one by the arrangement is not marked) and whose second choice reads
 * differently from the shown chord after the level's simplification. A no-chord span is marked where
 * the arrangement draws its stretch as a rest (the lane's empty segment).
 */
export function uncertainMarks(chart: Chart, arrangement: Arrangement, key: KeyEstimate | null, timing: Timing, labelAt: (sec: number) => string | null, on: boolean, o: AltNameOptions): UncertainMark[] {
  const out: UncertainMark[] = [];
  for (const v of visibleSpans(chart, on)) {
    const mid = (v.span.fromSec + v.span.toSec) / 2;
    const ev = arrangement.events.find((e) => mid >= e.startSec && mid < e.endSec);
    if (!ev) continue;
    if (isNoChord(v.span.chord) ? !ev.rest : ev.rest || !sameChordSymbol(ev.original, v.span.chord)) continue;
    const names = altNames(v.span.alt, key, timing, v.span, o);
    if (names.name === labelAt(mid)) continue;
    out.push({ ...v, fromSec: v.span.fromSec, toSec: v.span.toSec, alt: names.name, altSounding: names.sounding, replace: v.span.replace === true, noChord: isNoChord(v.span.chord) });
  }
  return out;
}

export { LANE_JOIN_GAP_SEC };

/** A stretch the lane draws: one mark, or marks joined over small gaps. */
export interface LaneStretch {
  fromSec: number;
  toSec: number;
  noChord: boolean;
  /** Indices into the marks of its parts, in time order (the first one names the stretch). */
  parts: number[];
}

/**
 * Lane drawing only (VGT-19 Amendment 2): marks of the same stored chord event naming the same chord
 * whose gap is at most LANE_JOIN_GAP_SEC are drawn as one stretch covering the gap; joining runs left
 * to right, so a chain of small gaps becomes one stretch. The marks themselves are unchanged (코드
 * 고치기 still reads the part under the playhead).
 */
export function laneStretches(marks: readonly Pick<UncertainMark, 'fromSec' | 'toSec' | 'ref' | 'span' | 'noChord'>[]): LaneStretch[] {
  const order = marks.map((_, i) => i).sort((a, b) => marks[a].fromSec - marks[b].fromSec);
  const out: LaneStretch[] = [];
  let cur: LaneStretch | null = null;
  for (const i of order) {
    const m = marks[i];
    const head: (typeof marks)[number] | undefined = cur ? marks[cur.parts[0]] : undefined;
    if (cur && head && laneJoins({ eventStartSec: head.ref.startSec, chord: head.span.chord }, cur.toSec, { eventStartSec: m.ref.startSec, chord: m.span.chord, fromSec: m.fromSec })) {
      cur.toSec = Math.max(cur.toSec, m.toSec);
      cur.parts.push(i);
    } else {
      cur = { fromSec: m.fromSec, toSec: m.toSec, noChord: m.noChord, parts: [i] };
      out.push(cur);
    }
  }
  return out;
}

/** True when `t` lies in a joined gap: inside a drawn lane stretch but under none of its marks. */
export function inJoinedGap(marks: readonly Pick<UncertainMark, 'fromSec' | 'toSec' | 'ref' | 'span' | 'noChord'>[], t: number): boolean {
  return laneStretches(marks).some((s) => s.parts.length > 1 && t >= s.fromSec && t < s.toSec && !s.parts.some((i) => t >= marks[i].fromSec && t < marks[i].toSec));
}

/** Index of the mark under `t` (inside [fromSec, toSec)), -1 when none. */
export function markAt(marks: readonly Pick<UncertainMark, 'fromSec' | 'toSec'>[], t: number): number {
  return marks.findIndex((m) => t >= m.fromSec && t < m.toSec);
}

// Final sound of how a chord name is read aloud: letters A–G (에이 … 지) end in a vowel, "m" (엠),
// ♭/♯ (플랫/샵) and 0, 3, 6 (영, 삼, 육) end in a consonant other than ㄹ.
const EU_RO_LAST = /(?:m|M|♭|♯|b|#|[036])$/;

/** "Am" → "Am으로", "G" → "G로", "C7" → "C7로": the particle a chord name takes before 바꾸기. */
export function withRo(name: string): string {
  return `${name}${EU_RO_LAST.test(name) ? '으로' : '로'}`;
}
