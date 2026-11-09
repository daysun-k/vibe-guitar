/** Guitar fretboard model: voicings, their sounded notes, and chord matching. */
import { chordPitchClasses, essentialPitchClasses, type Chord } from './chord';
import { mod12 } from './notes';

/** MIDI notes of open strings, index 0 = low E (6th string) … 5 = high e (1st string). */
export const STANDARD_TUNING = [40, 45, 50, 55, 59, 64] as const;
export const STRING_COUNT = 6;

/** null = muted string, 0 = open string, n = fret n (relative to the capo). */
export type Fret = number | null;
/** null = muted, 0 = open, 1..4 = index..pinky. */
export type Finger = 0 | 1 | 2 | 3 | 4 | null;

export type VoicingKind = 'open' | 'small' | 'barre' | 'movable';

export interface Voicing {
  id: string;
  /** Chord symbol this voicing is filed under. */
  chord: string;
  frets: Fret[];
  fingers: Finger[];
  kind: VoicingKind;
  origin: 'db' | 'template' | 'derived';
}

export interface Barre {
  finger: number;
  fret: number;
  /** string indices, from <= to */
  fromString: number;
  toString: number;
  /** covers 4 or more strings */
  full: boolean;
}

export function parseFrets(text: string): Fret[] {
  const t = text.trim();
  const parts = t.includes('-') || t.includes(',') ? t.split(/[-,]/) : t.split('');
  if (parts.length !== STRING_COUNT) throw new Error(`need 6 strings: ${text}`);
  return parts.map((p) => (p === 'x' || p === 'X' ? null : Number(p)));
}

export function parseFingers(text: string): Finger[] {
  const parts = text.trim().split('');
  if (parts.length !== STRING_COUNT) throw new Error(`need 6 fingers: ${text}`);
  return parts.map((p) => (p === 'x' || p === 'X' ? null : (Number(p) as Finger)));
}

export function fretString(frets: Fret[]): string {
  const wide = frets.some((f) => f !== null && f > 9);
  const parts = frets.map((f) => (f === null ? 'x' : String(f)));
  return wide ? parts.join('-') : parts.join('');
}

export function soundedMidi(v: Pick<Voicing, 'frets'>, capo = 0): number[] {
  const out: number[] = [];
  v.frets.forEach((f, s) => {
    if (f !== null) out.push(STANDARD_TUNING[s] + capo + f);
  });
  return out;
}

export function voicingPitchClasses(v: Pick<Voicing, 'frets'>, capo = 0): number[] {
  return [...new Set(soundedMidi(v, capo).map(mod12))].sort((a, b) => a - b);
}

export function voicingBassPc(v: Pick<Voicing, 'frets'>, capo = 0): number | null {
  const notes = soundedMidi(v, capo);
  return notes.length ? mod12(Math.min(...notes)) : null;
}

export function frettedFrets(v: Pick<Voicing, 'frets'>): number[] {
  return v.frets.filter((f): f is number => f !== null && f > 0);
}

/** Fret distance between lowest and highest fretted note (0 if <= 1 fretted note). */
export function fretSpan(v: Pick<Voicing, 'frets'>): number {
  const f = frettedFrets(v);
  return f.length ? Math.max(...f) - Math.min(...f) : 0;
}

export function lowestFret(v: Pick<Voicing, 'frets'>): number {
  const f = frettedFrets(v);
  return f.length ? Math.min(...f) : 0;
}

export function detectBarre(v: Pick<Voicing, 'frets' | 'fingers'>): Barre | null {
  let best: Barre | null = null;
  for (const finger of [1, 2, 3, 4]) {
    const strings = v.fingers.map((f, s) => (f === finger ? s : -1)).filter((s) => s >= 0);
    if (strings.length < 2) continue;
    const frets = new Set(strings.map((s) => v.frets[s]));
    if (frets.size !== 1) continue;
    const from = strings[0];
    const to = strings[strings.length - 1];
    const barre: Barre = { finger, fret: v.frets[from]!, fromString: from, toString: to, full: to - from + 1 >= 4 };
    if (!best || to - from > best.toString - best.fromString) best = barre;
  }
  return best;
}

export interface MatchResult {
  ok: boolean;
  reasons: string[];
}

/**
 * A voicing matches a chord when every sounded pitch class is a chord tone, every
 * essential tone (root, 3rd/sus, 7th, named extensions/alterations) is sounded, and
 * — for slash chords — the lowest sounded note is the slash bass. The 5th may be
 * omitted (except for power/dim/aug/altered chords); inversions are allowed for
 * plain chords (xx4432 is accepted as Bm).
 */
export function matchVoicing(v: Pick<Voicing, 'frets'>, chord: Chord, capo = 0): MatchResult {
  const reasons: string[] = [];
  const sounded = voicingPitchClasses(v, capo);
  const allowed = new Set(chordPitchClasses(chord));
  const required = essentialPitchClasses(chord);
  if (sounded.length < 2) reasons.push('fewer than 2 pitch classes');
  for (const pc of sounded) if (!allowed.has(pc)) reasons.push(`non-chord tone pc ${pc}`);
  for (const pc of required) if (!sounded.includes(pc)) reasons.push(`missing essential pc ${pc}`);
  if (chord.bass !== null && voicingBassPc(v, capo) !== chord.bass) reasons.push('slash bass is not the lowest note');
  return { ok: reasons.length === 0, reasons };
}

export function voicingMatchesChord(v: Pick<Voicing, 'frets'>, chord: Chord, capo = 0): boolean {
  return matchVoicing(v, chord, capo).ok;
}
