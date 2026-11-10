/**
 * Key estimation from a chord chart and key-aware spelling of chord roots.
 *
 * A recognizer names roots with sharps ("G#", "D#"); in A-flat major a guitarist reads
 * A♭, Fm, D♭, E♭. We score all 24 keys by how well the duration-weighted chords fit the
 * key's diatonic triads (plus a tonic bonus that separates relative major/minor) and then
 * spell every root and slash bass with that key's letters.
 */
import { formatChord, isNoChord, parseChord, type Chord } from '../arrange/chord';
import { LETTERS, letterIndex, mod12, parseNoteName, spellPitchClass, spellWithLetter } from '../arrange/notes';
import type { Chart } from '../chart/types';

export type Mode = 'major' | 'minor';

export interface KeyEstimate {
  tonic: number;
  mode: Mode;
  /** ASCII tonic spelling, e.g. "Ab", "F#". */
  tonicName: string;
  /** Spelling used for roots outside the scale. */
  accidentals: 'flat' | 'sharp' | 'natural';
  /** Pitch class → ASCII note name for the 7 scale degrees. */
  scale: Map<number, string>;
  score: number;
  /** (best − runner-up) / total weight, 0..1. Low values mean the key is a guess. */
  margin: number;
}

export interface TimedChord {
  chord: string;
  durationSec: number;
}

const MAJOR_STEPS = [0, 2, 4, 5, 7, 9, 11];
const MINOR_STEPS = [0, 2, 3, 5, 7, 8, 10];
/** Diatonic triad quality per degree (minor allows the major V of harmonic minor too). */
const MAJOR_TRIADS: Chord['triad'][] = ['maj', 'min', 'min', 'maj', 'maj', 'min', 'dim'];
const MINOR_TRIADS: Chord['triad'][] = ['min', 'dim', 'maj', 'min', 'min', 'maj', 'maj'];

/** Conventional tonic names (fewest accidentals; guitar-friendly for the 6-accidental keys). */
const MAJOR_TONIC = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const MINOR_TONIC = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'G#', 'A', 'Bb', 'B'];

function triadFamily(c: Chord): 'maj' | 'min' | 'dim' | 'other' {
  if (c.triad === 'maj' || c.triad === 'aug' || c.triad === 'sus2' || c.triad === 'sus4' || c.triad === '5') return 'maj';
  if (c.triad === 'min') return 'min';
  if (c.triad === 'dim') return 'dim';
  return 'other';
}

function buildScale(tonicName: string, mode: Mode): Map<number, string> {
  const tonic = parseNoteName(tonicName)!;
  const base = letterIndex(tonic.letter);
  const steps = mode === 'major' ? MAJOR_STEPS : MINOR_STEPS;
  const out = new Map<number, string>();
  steps.forEach((st, i) => {
    const pc = mod12(tonic.pc + st);
    out.set(pc, spellWithLetter(LETTERS[(base + i) % 7], pc).name);
  });
  return out;
}

function accidentalsOf(scale: Map<number, string>): KeyEstimate['accidentals'] {
  const names = [...scale.values()];
  if (names.some((n) => n.includes('b'))) return 'flat';
  if (names.some((n) => n.includes('#'))) return 'sharp';
  return 'natural';
}

function scoreKey(chords: { c: Chord; w: number }[], tonic: number, mode: Mode, first: Chord | null, last: Chord | null): number {
  const steps = mode === 'major' ? MAJOR_STEPS : MINOR_STEPS;
  const triads = mode === 'major' ? MAJOR_TRIADS : MINOR_TRIADS;
  const tonicTriad = mode === 'major' ? 'maj' : 'min';
  let s = 0;
  for (const { c, w } of chords) {
    const deg = steps.indexOf(mod12(c.root - tonic));
    const fam = triadFamily(c);
    if (deg < 0) {
      s -= 0.6 * w;
      continue;
    }
    const fits = triads[deg] === fam || (mode === 'minor' && deg === 4 && fam === 'maj');
    s += (fits ? 1 : 0.35) * w;
    if (deg === 0 && fam === tonicTriad) s += 0.6 * w; // tonic chord
    if (deg === 4 && fam === 'maj') s += 0.15 * w; // dominant
  }
  const total = chords.reduce((a, x) => a + x.w, 0) || 1;
  const isTonic = (c: Chord | null) => c !== null && c.root === tonic && triadFamily(c) === tonicTriad;
  if (isTonic(first)) s += 0.08 * total;
  if (isTonic(last)) s += 0.08 * total;
  return s;
}

function safeParse(sym: string): Chord | null {
  if (isNoChord(sym)) return null;
  try {
    return parseChord(sym);
  } catch {
    return null;
  }
}

/** Most likely key of the chords, or null when there are no parseable chords. */
export function estimateKey(input: TimedChord[]): KeyEstimate | null {
  const chords = input
    .map((x) => ({ c: safeParse(x.chord), w: Math.max(0, x.durationSec) }))
    .filter((x): x is { c: Chord; w: number } => x.c !== null && x.w > 0);
  if (!chords.length) return null;
  const first = chords[0].c;
  const last = chords[chords.length - 1].c;
  const scored: { tonic: number; mode: Mode; score: number }[] = [];
  for (let tonic = 0; tonic < 12; tonic++) {
    for (const mode of ['major', 'minor'] as const) scored.push({ tonic, mode, score: scoreKey(chords, tonic, mode, first, last) });
  }
  scored.sort((a, b) => b.score - a.score || (a.mode === 'major' ? -1 : 1));
  const best = scored[0];
  const total = chords.reduce((a, x) => a + x.w, 0);
  const tonicName = (best.mode === 'major' ? MAJOR_TONIC : MINOR_TONIC)[best.tonic];
  const scale = buildScale(tonicName, best.mode);
  return {
    tonic: best.tonic,
    mode: best.mode,
    tonicName,
    accidentals: accidentalsOf(scale),
    scale,
    score: best.score,
    margin: total > 0 ? Math.max(0, (best.score - scored[1].score) / total) : 0,
  };
}

/** ASCII spelling of a pitch class in the key (scale letters first, then the key's accidental). */
export function spellPitchInKey(pc: number, key: KeyEstimate | null, minorChord = false): string {
  const p = mod12(pc);
  if (!key) return spellPitchClass(p, minorChord ? 'guitar-minor' : 'guitar-major');
  const inScale = key.scale.get(p);
  if (inScale) return inScale;
  if (key.accidentals === 'flat') return spellPitchClass(p, 'flat');
  if (key.accidentals === 'sharp') return spellPitchClass(p, 'sharp');
  return spellPitchClass(p, minorChord ? 'guitar-minor' : 'guitar-major');
}

/** Re-spell the root and slash bass of a chord symbol for the key; unparseable symbols pass through. */
export function respellChord(symbol: string, key: KeyEstimate | null): string {
  const c = safeParse(symbol);
  if (!c || !key) return symbol;
  const minor = c.triad === 'min' || c.triad === 'dim';
  return formatChord({
    ...c,
    rootName: spellPitchInKey(c.root, key, minor),
    bassName: c.bass === null ? null : spellPitchInKey(c.bass, key),
  });
}

/** Duration of each chart event (until the next event or the end of its coverage range). */
export function timedChordsOf(chart: Chart): TimedChord[] {
  const ends = chart.coverage.map((r) => r.toSec);
  return chart.events.map((e, i) => {
    const next = chart.events[i + 1]?.startSec;
    const coverEnd = ends.find((t) => t > e.startSec) ?? e.startSec + 2;
    const end = next !== undefined ? Math.min(next, coverEnd) : coverEnd;
    return { chord: e.chord, durationSec: Math.max(0, end - e.startSec) };
  });
}

/** A copy of the chart with every chord spelled for its estimated key (the stored chart is untouched). */
export function respellChartForKey(chart: Chart): { chart: Chart; key: KeyEstimate | null } {
  const key = estimateKey(timedChordsOf(chart));
  if (!key) return { chart, key };
  return { chart: { ...chart, events: chart.events.map((e) => ({ ...e, chord: respellChord(e.chord, key) })) }, key };
}

/** Display form of a symbol: root/bass accidentals as ♭/♯ ("Ab/Eb" → "A♭/E♭"); quality text is left alone. */
export function prettyChord(symbol: string): string {
  return symbol
    .replace(/^([A-G])b/, '$1♭')
    .replace(/^([A-G])#/, '$1♯')
    .replace(/\/([A-G])b$/, '/$1♭')
    .replace(/\/([A-G])#$/, '/$1♯');
}

export function keyLabel(k: KeyEstimate): string {
  return `${prettyChord(k.tonicName)}${k.mode === 'minor' ? 'm' : ''}`;
}
