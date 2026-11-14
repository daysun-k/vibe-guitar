/**
 * Fixing one wrong chord of a chart in place (play view "코드 고치기"). Only the chord of
 * that event changes: its time, every other event and the heard coverage stay as they were.
 */
import { formatChord, isNoChord, parseChord, qualitySuffix, sameChord, transposeChord } from '../arrange/chord';
import { spellPitchClass } from '../arrange/notes';
import { coverageRangeAt, normalizeCoverage } from '../chart/coverage';
import { NO_CHORD, type Chart, type ChordEvent, type UncertainSpan } from '../chart/types';
import { validateChart } from '../chart/validate';
import { respellChord, type KeyEstimate } from '../music/key';

/** Identifies the event to fix by what the panel saw, so a changed chart is detected. */
export interface EventRef {
  startSec: number;
  chord: string;
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
 * auto analysis is stored as pending instead of replacing it.
 */
export function correctChordEvent(chart: Chart, ref: EventRef, chord: string, now: Date = new Date()): Chart {
  const i = findEvent(chart, ref);
  if (i < 0) throw new CorrectionConflict('코드표가 그 사이에 바뀌었어요. 다시 골라 주세요.');
  const next = storedChord(chord);
  const events = chart.events.map((e, k) => (k === i ? { ...e, chord: next, confidence: 1, source: 'manual' as const } : e));
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
 * the event is still an auto event and still has the span's chord (any spelling). A manual fix
 * of the event, or a chord change, therefore hides the span.
 */
export function uncertainSpanEvent(chart: Chart, span: UncertainSpan): number {
  let i = -1;
  for (let k = 0; k < chart.events.length; k++) {
    if (chart.events[k].startSec <= span.fromSec + 1e-6) i = k;
    else break;
  }
  if (i < 0) return -1;
  const e = chart.events[i];
  if (e.source !== 'auto' || isNoChord(e.chord) || !sameChordSymbol(e.chord, span.chord)) return -1;
  return span.toSec <= eventEndSec(chart, i) + 1e-6 ? i : -1;
}

const sameSpan = (a: UncertainSpan, b: UncertainSpan): boolean =>
  a.fromSec === b.fromSec && a.toSec === b.toSec && sameChordSymbol(a.chord, b.chord) && sameChordSymbol(a.alt, b.alt);

/**
 * "2순위로 바꾸기": a copy of the chart where the span's stretch of the event plays the span's
 * second choice. The event is split at the span bounds: the head before the span and the tail
 * after it keep the auto chord with its confidence; the span part becomes a manual event
 * (confidence 1) with `span.alt`. Empty heads/tails are not created. The span is removed from
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
  if (uncertainSpanEvent(chart, stored) !== i) throw conflict();
  const e = chart.events[i];
  const end = eventEndSec(chart, i);
  const parts: ChordEvent[] = [];
  if (stored.fromSec - e.startSec > EDGE_SEC) parts.push(e);
  parts.push({ startSec: parts.length ? stored.fromSec : e.startSec, chord: storedChord(stored.alt), confidence: 1, source: 'manual' });
  if (end - stored.toSec > EDGE_SEC) parts.push({ ...e, startSec: stored.toSec });
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
