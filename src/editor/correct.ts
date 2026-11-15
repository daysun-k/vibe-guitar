/**
 * Fixing one wrong chord of a chart in place (play view "코드 고치기"). Only the chord of
 * that event changes: its time, every other event and the heard coverage stay as they were.
 */
import { formatChord, isNoChord, parseChord, qualitySuffix, sameChord, transposeChord } from '../arrange/chord';
import { spellPitchClass } from '../arrange/notes';
import { coverageRangeAt, normalizeCoverage } from '../chart/coverage';
import { NO_CHORD, type AutoOrigin, type Chart, type ChordEvent, type UncertainSpan } from '../chart/types';
import { validateChart } from '../chart/validate';
import { respellChord, type KeyEstimate } from '../music/key';

/** Identifies the event to fix by what the panel saw, so a changed chart is detected. */
export interface EventRef {
  startSec: number;
  chord: string;
}

/** The "?" stretch of an event that 코드 고치기 fixes at a "?" stop (seconds, [fromSec, toSec)). */
export interface FixStretch {
  fromSec: number;
  toSec: number;
}

/** The chart changed since the panel showed it (the event is gone or has another chord). */
export class CorrectionConflict extends Error {}

/** Index of the event at ref.startSec with ref's chord in any spelling (the panel shows key-respelled names); -1 if none. */
export function findEvent(chart: Chart, ref: EventRef): number {
  return chart.events.findIndex((e) => e.startSec === ref.startSec && sameChordSymbol(e.chord, ref.chord));
}

/** Same chord regardless of spelling ("G#m" = "Abm"); no-chord symbols match each other. */
export function sameChordSymbol(a: string, b: string): boolean {
  if (a === b) return true;
  if (isNoChord(a) || isNoChord(b)) return isNoChord(a) && isNoChord(b);
  try {
    return sameChord(parseChord(a), parseChord(b));
  } catch {
    return false;
  }
}

/** Normalized stored form of a picked chord: "N" for no chord, else a parseable symbol. */
function storedChord(symbol: string): string {
  if (isNoChord(symbol)) return NO_CHORD;
  parseChord(symbol); // throws ChordParseError
  return symbol.trim();
}

/**
 * A copy of the chart with one event's chord replaced. The event becomes a manual event
 * (confidence 1); the chart becomes 'edited' (a hand-made chart stays 'manual'), so a later
 * auto analysis is stored as pending instead of replacing it. A fixed auto event remembers its
 * chord in `auto`; fixing it again keeps that first one.
 */
export function correctChordEvent(chart: Chart, ref: EventRef, chord: string, now: Date = new Date()): Chart {
  const i = findEvent(chart, ref);
  if (i < 0) throw new CorrectionConflict('코드표가 그 사이에 바뀌었어요. 다시 골라 주세요.');
  const next = storedChord(chord);
  const fixed = (e: ChordEvent): ChordEvent => {
    const { auto: kept, ...rest } = e;
    const auto: AutoOrigin | undefined = e.source === 'auto' ? { chord: e.chord, confidence: e.confidence } : kept;
    return { ...rest, chord: next, confidence: 1, source: 'manual', ...(auto ? { auto } : {}) };
  };
  const events = chart.events.map((e, k) => (k === i ? fixed(e) : e));
  const out: Chart = {
    ...chart,
    events,
    provenance: { ...chart.provenance, createdBy: chart.provenance.createdBy === 'manual' ? 'manual' : 'edited', updatedAt: now.toISOString() },
  };
  const v = validateChart(out);
  if (!v.ok) throw new Error(`corrected chart is invalid: ${v.errors.join('; ')}`);
  return out;
}

const EDGE_SEC = 1e-3;

/**
 * End of event i as the play view sees it: the next event's start, cut at the end of the heard
 * range the event starts in. Infinity for the last event of a chart without coverage; -Infinity
 * when the event starts outside every heard range (it is never drawn).
 */
export function eventEndSec(chart: Chart, i: number): number {
  const next = chart.events[i + 1]?.startSec ?? Infinity;
  if (!chart.coverage.length) return next;
  const range = coverageRangeAt(normalizeCoverage(chart.coverage), chart.events[i].startSec);
  return range ? Math.min(next, range.toSec) : -Infinity;
}

/**
 * Index of the event an uncertain span applies to, or -1: the span lies inside that one event,
 * the event is still an auto event and still has the span's chord (any spelling; a no-chord span
 * applies to an auto no-chord event). A manual fix of the event, or a chord change, therefore hides
 * the span.
 */
export function uncertainSpanEvent(chart: Chart, span: UncertainSpan): number {
  let i = -1;
  for (let k = 0; k < chart.events.length; k++) {
    if (chart.events[k].startSec <= span.fromSec + 1e-6) i = k;
    else break;
  }
  if (i < 0) return -1;
  const e = chart.events[i];
  if (e.source !== 'auto' || !sameChordSymbol(e.chord, span.chord)) return -1;
  return span.toSec <= eventEndSec(chart, i) + 1e-6 ? i : -1;
}

const sameSpan = (a: UncertainSpan, b: UncertainSpan): boolean =>
  a.fromSec === b.fromSec && a.toSec === b.toSec && sameChordSymbol(a.chord, b.chord) && sameChordSymbol(a.alt, b.alt) && a.replace === b.replace;

/**
 * "2순위로 바꾸기": a copy of the chart where the span's stretch of the event plays the span's
 * second choice. The event is split at the span bounds: the head before the span and the tail
 * after it keep the auto chord (or no chord) with its confidence; the span part becomes a manual event
 * (confidence 1) with `span.alt` that remembers the auto chord, the span and which fragments the
 * split made in `auto` (so restoreAutoChord can undo exactly this split). Empty heads/tails are not created. The span is removed from
 * `uncertain`; the chart becomes 'edited' (a hand-made chart stays 'manual') like
 * correctChordEvent. A CorrectionConflict when the event or the span changed meanwhile.
 */
export function acceptUncertainAlt(chart: Chart, ref: EventRef, span: UncertainSpan, now: Date = new Date()): Chart {
  const conflict = () => new CorrectionConflict('코드표가 그 사이에 바뀌었어요. 다시 골라 주세요.');
  const i = findEvent(chart, ref);
  if (i < 0) throw conflict();
  const si = (chart.uncertain ?? []).findIndex((s) => sameSpan(s, span));
  if (si < 0) throw conflict();
  const stored = chart.uncertain![si];
  // Only the replace tier offers the replacement (Amendment 1); a later analysis may have moved the
  // stretch out of it while the panel still showed the button (review vgt19-flags-ui-r4 F4).
  if (stored.replace !== true) throw conflict();
  if (uncertainSpanEvent(chart, stored) !== i) throw conflict();
  const e = chart.events[i];
  const end = eventEndSec(chart, i);
  const head = stored.fromSec - e.startSec > EDGE_SEC;
  const tail = end - stored.toSec > EDGE_SEC;
  const parts: ChordEvent[] = [];
  if (head) parts.push(e);
  const split = { startSec: e.startSec, head, tail };
  parts.push({ startSec: head ? stored.fromSec : e.startSec, chord: storedChord(stored.alt), confidence: 1, source: 'manual', auto: { chord: e.chord, confidence: e.confidence, span: { ...stored }, split } });
  if (tail) parts.push({ ...e, startSec: stored.toSec });
  const events = [...chart.events.slice(0, i), ...parts, ...chart.events.slice(i + 1)];
  const uncertain = chart.uncertain!.filter((_, k) => k !== si);
  const out: Chart = {
    ...chart,
    events,
    uncertain,
    provenance: { ...chart.provenance, createdBy: chart.provenance.createdBy === 'manual' ? 'manual' : 'edited', updatedAt: now.toISOString() },
  };
  const v = validateChart(out);
  if (!v.ok) throw new Error(`chart with the second choice is invalid: ${v.errors.join('; ')}`);
  return out;
}

/**
 * 코드 고치기 at a "?" stop: a copy of the chart where only the stretch [fromSec, toSec) of the auto event
 * `ref` plays `chord`. The event is split at the stretch bounds like acceptUncertainAlt: the head before
 * and the tail after keep the auto chord with its confidence; the stretch becomes a manual event
 * (confidence 1) remembering the auto chord and the split (`auto.split` with the stretch's own bounds, no
 * span: no span is consumed), so restoreAutoChord merges the fragments back exactly. The uncertain spans
 * inside the stretch stay stored (hidden while the stretch is manual, shown again once restored). Empty
 * heads/tails are not created. A CorrectionConflict when the event changed meanwhile, is no longer an
 * auto event, or no longer has stored uncertain spans starting and ending at the stretch bounds.
 */
export function correctChordStretch(chart: Chart, ref: EventRef, stretch: FixStretch, chord: string, now: Date = new Date()): Chart {
  const conflict = () => new CorrectionConflict('코드표가 그 사이에 바뀌었어요. 다시 골라 주세요.');
  const i = findEvent(chart, ref);
  if (i < 0) throw conflict();
  const e = chart.events[i];
  const end = eventEndSec(chart, i);
  if (e.source !== 'auto' || !(stretch.fromSec >= e.startSec - EDGE_SEC && stretch.toSec <= end + EDGE_SEC && stretch.toSec > stretch.fromSec)) throw conflict();
  // The stretch the panel showed is still drawn from this event's stored spans.
  const spans = (chart.uncertain ?? []).filter((s) => uncertainSpanEvent(chart, s) === i);
  if (!spans.some((s) => s.fromSec === stretch.fromSec) || !spans.some((s) => s.toSec === stretch.toSec)) throw conflict();
  const head = stretch.fromSec - e.startSec > EDGE_SEC;
  const tail = end - stretch.toSec > EDGE_SEC;
  const parts: ChordEvent[] = [];
  if (head) parts.push(e);
  const split = { startSec: e.startSec, head, tail, fromSec: stretch.fromSec, toSec: stretch.toSec };
  parts.push({ startSec: head ? stretch.fromSec : e.startSec, chord: storedChord(chord), confidence: 1, source: 'manual', auto: { chord: e.chord, confidence: e.confidence, split } });
  if (tail) parts.push({ ...e, startSec: stretch.toSec });
  const out: Chart = {
    ...chart,
    events: [...chart.events.slice(0, i), ...parts, ...chart.events.slice(i + 1)],
    provenance: { ...chart.provenance, createdBy: chart.provenance.createdBy === 'manual' ? 'manual' : 'edited', updatedAt: now.toISOString() },
  };
  const v = validateChart(out);
  if (!v.ok) throw new Error(`corrected chart is invalid: ${v.errors.join('; ')}`);
  return out;
}

/**
 * The auto chord of `auto` (the recording's stored auto chart) sounding at `sec`: its last event
 * starting at or before `sec`, while `sec` lies inside that event's heard range. Null when none.
 * Used for "처음 들은 코드" of events fixed before ChordEvent.auto existed.
 */
export function autoChordAt(auto: Chart, sec: number): AutoOrigin | null {
  let k = -1;
  for (let j = 0; j < auto.events.length; j++) {
    if (auto.events[j].startSec <= sec + 1e-6) k = j;
    else break;
  }
  if (k < 0 || !(sec < eventEndSec(auto, k))) return null;
  const e = auto.events[k];
  return { chord: e.chord, confidence: e.confidence };
}

/**
 * The first recognized chord to offer for a shown event ("처음 들은 코드: X"), or null: a manual event's
 * own `auto`, else (an event fixed before `auto` existed) `fallback`, the stored auto chart's chord
 * there, when it differs from the event's chord. Auto events have nothing to restore.
 */
export function firstHeard(e: ChordEvent, fallback: AutoOrigin | null): AutoOrigin | null {
  if (e.source !== 'manual') return null;
  if (e.auto) return e.auto;
  if (!fallback || sameChordSymbol(fallback.chord, e.chord)) return null;
  return { chord: fallback.chord, confidence: fallback.confidence };
}

/**
 * "처음 코드로 되돌리기": a copy of the chart where a manual event plays its first recognized chord
 * again as an auto event (its `auto`, else `fallback` from the stored auto chart). An event made by
 * 2순위로 바꾸기 (or by 코드 고치기 at a "?" stretch, correctChordStretch) is merged back with the fragments
 * that split recorded making (`auto.split`) while each is still exactly that fragment, so the original
 * event comes back exactly, and a consumed span returns to `uncertain` (unless a span stored since
 * overlaps it; a "?" stretch fix consumed none). An auto neighbour the split
 * did not make is never merged, even with the same chord and confidence; when a recorded fragment
 * changed (or the record is incomplete) only the chord comes back: no merge, no span. The chart becomes 'edited' like correctChordEvent. A CorrectionConflict
 * when the event changed meanwhile or there is nothing to restore.
 */
export function restoreAutoChord(chart: Chart, ref: EventRef, fallback: AutoOrigin | null = null, now: Date = new Date()): Chart {
  const i = findEvent(chart, ref);
  if (i < 0) throw new CorrectionConflict('코드표가 그 사이에 바뀌었어요. 다시 골라 주세요.');
  const e = chart.events[i];
  const origin = firstHeard(e, fallback);
  if (!origin) throw new CorrectionConflict('처음 들은 코드를 찾지 못했어요.');
  let restored: ChordEvent = { startSec: e.startSec, chord: origin.chord, confidence: origin.confidence, source: 'auto' };
  let from = i;
  let to = i + 1;
  const span = e.auto?.span;
  const split = e.auto?.split;
  // The split stretch: the consumed span's bounds, or (코드 고치기 at a "?" stop) the split's own.
  const bounds = span ?? (split?.fromSec !== undefined && split.toSec !== undefined ? { fromSec: split.fromSec, toSec: split.toSec } : undefined);
  let uncertain = chart.uncertain;
  // A fragment the split made, still exactly as made: auto, the original chord and confidence, at `startSec`.
  const fragment = (x: ChordEvent | undefined, startSec: number): x is ChordEvent =>
    !!x && x.source === 'auto' && x.auto === undefined && x.chord === origin.chord && x.confidence === origin.confidence && x.startSec === startSec;
  const prev = chart.events[i - 1];
  const next = chart.events[i + 1];
  const intact =
    !!bounds &&
    !!split &&
    e.startSec === (split.head ? bounds.fromSec : split.startSec) &&
    (!split.head || fragment(prev, split.startSec)) &&
    (!split.tail || fragment(next, bounds.toSec));
  if (bounds && split && intact) {
    if (split.head) {
      from = i - 1;
      restored = prev!;
    }
    if (split.tail) to = i + 2;
  }
  if (span && split && intact) {
    const list = chart.uncertain ?? [];
    const at = list.findIndex((s) => s.fromSec >= span.fromSec);
    const k = at < 0 ? list.length : at;
    const fits = (k === 0 || list[k - 1].toSec <= span.fromSec) && (k === list.length || list[k].fromSec >= span.toSec);
    if (fits) uncertain = [...list.slice(0, k), { ...span }, ...list.slice(k)];
  }
  const events = [...chart.events.slice(0, from), restored, ...chart.events.slice(to)];
  const out: Chart = {
    ...chart,
    events,
    provenance: { ...chart.provenance, createdBy: chart.provenance.createdBy === 'manual' ? 'manual' : 'edited', updatedAt: now.toISOString() },
  };
  if (uncertain !== undefined) out.uncertain = uncertain;
  const v = validateChart(out);
  if (!v.ok) throw new Error(`chart with the first chord is invalid: ${v.errors.join('; ')}`);
  return out;
}

/**
 * Stored (sounding) chord for a chord picked on the play side. With a capo the picker shows
 * shape names, so the pick is moved up by the capo; the root and bass are then spelled for
 * the song's key (shape G with capo 1 in A♭ major is stored as "Ab", not "G#").
 */
export function pickToConcert(pick: string, capo: number, key: KeyEstimate | null): string {
  if (isNoChord(pick)) return NO_CHORD;
  return respellChord(formatChord(transposeChord(parseChord(pick), capo)), key);
}

/** Chord kinds offered by the picker, as suffixes after the root. */
export const PICK_QUALITIES: readonly string[] = ['', 'm', '7', 'm7', 'maj7', 'sus2', 'sus4', 'dim'];

const minorKind = (quality: string): boolean => (quality.startsWith('m') && !quality.startsWith('maj')) || quality.startsWith('dim');

/** Root of a picker choice, spelled like capo shapes (G♯ for G♯m, A♭ for A♭). */
export function pickRoot(rootPc: number, quality: string): string {
  return spellPitchClass(rootPc, minorKind(quality) ? 'guitar-minor' : 'guitar-major');
}

/** Slash bass of a picker choice, spelled like capo shape basses (C♯, E♭, F♯, A♭, B♭). */
export function pickBass(pc: number): string {
  return spellPitchClass(pc, 'guitar-major');
}

/**
 * ASCII shape name of a picker choice ("G#m", "Ab7", "Am/B"). A bass equal to the root is
 * not written as a slash (C with bass C is "C").
 */
export function pickName(rootPc: number, quality: string, bassPc: number | null = null): string {
  const bass = bassPc === null || (bassPc - rootPc) % 12 === 0 ? '' : `/${pickBass(bassPc)}`;
  return pickRoot(rootPc, quality) + quality + bass;
}

/**
 * Picker state for a shown (shape) chord: its root pitch class, its kind and its slash bass
 * pitch class (null without one). A kind the picker does not offer (e.g. "7sus4") is
 * returned as is so the picker can keep it selectable. Null for no chord.
 */
export function splitPick(shape: string): { rootPc: number; quality: string; bassPc: number | null } | null {
  if (isNoChord(shape) || shape === 'N.C.') return null;
  try {
    const c = parseChord(shape.replaceAll('♭', 'b').replaceAll('♯', '#'));
    return { rootPc: c.root, quality: qualitySuffix(c), bassPc: c.bass };
  } catch {
    return null;
  }
}
