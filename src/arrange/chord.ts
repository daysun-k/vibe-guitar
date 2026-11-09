/**
 * Chord symbol parser, formatter, pitch-class and spelling helpers.
 *
 * A chord is: root + triad quality + optional seventh/sixth + optional extension
 * (9/11/13) + added tones + alterations + optional slash bass.
 */
import { LETTERS, letterIndex, mod12, parseNoteName, spellPitchClass, spellWithLetter } from './notes';

export type Triad = 'maj' | 'min' | 'dim' | 'aug' | 'sus2' | 'sus4' | '5';
export type Seventh = 'none' | 'b7' | 'maj7' | 'dim7' | '6';
export type Extension = 9 | 11 | 13;
export type AddTone = 9 | 11 | 13;
export type Alteration = 'b5' | '#5' | 'b9' | '#9' | '#11' | 'b13';

export interface Chord {
  root: number;
  rootName: string;
  triad: Triad;
  seventh: Seventh;
  extension: Extension | null;
  adds: AddTone[];
  alterations: Alteration[];
  bass: number | null;
  bassName: string | null;
}

export class ChordParseError extends Error {
  constructor(
    readonly symbol: string,
    reason: string,
  ) {
    super(`cannot parse chord "${symbol}": ${reason}`);
    this.name = 'ChordParseError';
  }
}

const NO_CHORD_SYMBOLS = new Set(['N', 'NC', 'N.C.', 'N.C', '-', 'x']);

export function isNoChord(symbol: string): boolean {
  return NO_CHORD_SYMBOLS.has(symbol.trim());
}

const ROOT_RE = /^([A-G])(#|b|♯|♭)?/;
const ALTERATIONS: readonly Alteration[] = ['b5', '#5', 'b9', '#9', '#11', 'b13'];

export function parseChord(input: string): Chord {
  const symbol = input.trim();
  const rootMatch = ROOT_RE.exec(symbol);
  if (!rootMatch) throw new ChordParseError(input, 'missing root note');
  const root = parseNoteName(rootMatch[0])!;
  let rest = symbol.slice(rootMatch[0].length);

  let bass: number | null = null;
  let bassName: string | null = null;
  const slash = rest.lastIndexOf('/');
  if (slash >= 0) {
    const bassNote = parseNoteName(rest.slice(slash + 1));
    if (bassNote) {
      bass = bassNote.pc;
      bassName = bassNote.name;
      rest = rest.slice(0, slash);
    } else if (!/^\d/.test(rest.slice(slash + 1))) {
      throw new ChordParseError(input, `bad slash bass "${rest.slice(slash + 1)}"`);
    }
  }

  const q = parseQuality(rest, input);
  const chord: Chord = { root: root.pc, rootName: root.name, ...q, bass, bassName };
  if (bass === chord.root) {
    chord.bass = null;
    chord.bassName = null;
  }
  return chord;
}

interface Quality {
  triad: Triad;
  seventh: Seventh;
  extension: Extension | null;
  adds: AddTone[];
  alterations: Alteration[];
}

function parseQuality(raw: string, input: string): Quality {
  const s = raw.replace(/[\s()]/g, '').replace(/♯/g, '#').replace(/♭/g, 'b').replace(/,/g, '');
  let i = 0;
  const eat = (re: RegExp): RegExpExecArray | null => {
    const m = re.exec(s.slice(i));
    if (m) i += m[0].length;
    return m;
  };

  let triad: Triad = 'maj';
  let seventh: Seventh = 'none';
  let extension: Extension | null = null;
  const adds: AddTone[] = [];
  const alterations: Alteration[] = [];
  let majFlag = false;
  let halfDim = false;

  if (eat(/^(maj|Maj|MAJ|Ma|M|Δ|△)/)) majFlag = true;
  else if (eat(/^(min|mi|m|-)/)) {
    triad = 'min';
    if (eat(/^(maj|Maj|Ma|M|Δ|△)/)) majFlag = true;
  } else if (eat(/^(dim|°|o)/)) triad = 'dim';
  else if (eat(/^(ø|Ø)/)) {
    triad = 'dim';
    halfDim = true;
    seventh = 'b7';
    eat(/^7/);
  } else if (eat(/^(aug|\+)(?!\d)/)) triad = 'aug';

  const num = halfDim ? null : eat(/^(6\/9|69|13|11|9|7|6|5)/);
  if (num) {
    const n = num[0];
    if (n === '5') {
      if (triad !== 'maj' || majFlag) throw new ChordParseError(input, 'power chord with quality');
      triad = '5';
    } else if (n === '6') seventh = '6';
    else if (n === '69' || n === '6/9') {
      seventh = '6';
      adds.push(9);
    } else {
      seventh = majFlag ? 'maj7' : triad === 'dim' ? 'dim7' : 'b7';
      if (n !== '7') extension = Number(n) as Extension;
      if (triad === 'dim' && n !== '7') throw new ChordParseError(input, 'extended diminished chord');
    }
  } else if (majFlag && triad === 'min') {
    throw new ChordParseError(input, 'minor-major without 7');
  }

  while (i < s.length) {
    let m: RegExpExecArray | null;
    if (eat(/^sus2/)) setSus('sus2');
    else if (eat(/^sus4?/)) setSus('sus4');
    else if ((m = eat(/^add(2|4|9|11|13)/))) {
      const v = Number(m[1]);
      adds.push((v === 2 ? 9 : v === 4 ? 11 : v) as AddTone);
    } else if ((m = eat(/^(b|#|\+|-)(5|9|11|13)/))) {
      const sign = m[1] === '+' ? '#' : m[1] === '-' ? 'b' : m[1];
      const alt = `${sign}${m[2]}` as Alteration;
      if (!ALTERATIONS.includes(alt)) throw new ChordParseError(input, `unsupported alteration ${alt}`);
      if (!alterations.includes(alt)) alterations.push(alt);
    } else if ((m = eat(/^(2|4)$/))) {
      setSus(m[1] === '2' ? 'sus2' : 'sus4');
    } else {
      throw new ChordParseError(input, `unexpected "${s.slice(i)}"`);
    }
  }

  function setSus(kind: 'sus2' | 'sus4'): void {
    if (triad !== 'maj') throw new ChordParseError(input, 'sus on non-major triad');
    triad = kind;
  }

  // Normalise spellings that are really a different triad.
  if (triad === 'min' && alterations.includes('b5')) {
    triad = 'dim';
    alterations.splice(alterations.indexOf('b5'), 1);
  }
  if (triad === 'maj' && alterations.includes('#5')) {
    triad = 'aug';
    alterations.splice(alterations.indexOf('#5'), 1);
  }
  if (extension === 9 && (alterations.includes('b9') || alterations.includes('#9'))) extension = null;
  adds.sort((a, b) => a - b);
  alterations.sort((a, b) => ALTERATIONS.indexOf(a) - ALTERATIONS.indexOf(b));
  return { triad, seventh, extension, adds, alterations };
}

/** Interval (semitones above root) tagged with its scale degree (1..7) for spelling. */
export interface Interval {
  semitones: number;
  degree: number;
  /** Essential tones must be present in any voicing of the chord. */
  essential: boolean;
}

export function chordIntervals(c: Chord): Interval[] {
  const out: Interval[] = [{ semitones: 0, degree: 1, essential: true }];
  const add = (semitones: number, degree: number, essential: boolean): void => {
    const existing = out.find((x) => mod12(x.semitones) === mod12(semitones));
    if (existing) {
      existing.essential ||= essential;
      return;
    }
    out.push({ semitones, degree, essential });
  };
  const has = (a: Alteration): boolean => c.alterations.includes(a);
  const eleventhChord = c.extension === 11;

  switch (c.triad) {
    case 'maj':
      add(4, 3, !eleventhChord);
      break;
    case 'min':
      add(3, 3, !eleventhChord);
      break;
    case 'dim':
      add(3, 3, true);
      break;
    case 'aug':
      add(4, 3, true);
      break;
    case 'sus2':
      add(2, 2, true);
      break;
    case 'sus4':
      add(5, 4, true);
      break;
    case '5':
      break;
  }
  // fifth
  if (has('b5')) add(6, 5, true);
  else if (has('#5')) add(8, 5, true);
  else if (c.triad === 'dim') add(6, 5, true);
  else if (c.triad === 'aug') add(8, 5, true);
  else add(7, 5, c.triad === '5');

  switch (c.seventh) {
    case 'b7':
      add(10, 7, true);
      break;
    case 'maj7':
      add(11, 7, true);
      break;
    case 'dim7':
      add(9, 7, true);
      break;
    case '6':
      add(9, 6, true);
      break;
  }
  if (c.extension !== null) {
    const top = c.extension;
    if (!has('b9') && !has('#9')) add(2, 2, top === 9);
    if (top === 11) add(5, 4, true);
    if (top === 13) {
      if (!has('b13')) add(9, 6, true);
    }
  }
  for (const a of c.adds) {
    if (a === 9) add(2, 2, true);
    if (a === 11) add(5, 4, true);
    if (a === 13) add(9, 6, true);
  }
  if (has('b9')) add(1, 2, true);
  if (has('#9')) add(3, 2, true);
  if (has('#11')) add(6, 4, true);
  if (has('b13')) add(8, 6, true);
  return out;
}

/** All pitch classes of the chord (including slash bass). */
export function chordPitchClasses(c: Chord): number[] {
  const set = new Set(chordIntervals(c).map((i) => mod12(c.root + i.semitones)));
  if (c.bass !== null) set.add(c.bass);
  return [...set].sort((a, b) => a - b);
}

export function essentialPitchClasses(c: Chord): number[] {
  const set = new Set(
    chordIntervals(c)
      .filter((i) => i.essential)
      .map((i) => mod12(c.root + i.semitones)),
  );
  if (c.bass !== null) set.add(c.bass);
  return [...set].sort((a, b) => a - b);
}

/** Correctly spelled chord tones, e.g. Ab major → Ab C Eb; Cdim7 → C Eb Gb Bbb. */
export function chordToneNames(c: Chord): string[] {
  const rootNote = parseNoteName(c.rootName)!;
  const base = letterIndex(rootNote.letter);
  const names = chordIntervals(c)
    .slice()
    .sort((a, b) => mod12(a.semitones) - mod12(b.semitones))
    .map((i) => spellWithLetter(LETTERS[(base + i.degree - 1) % 7], mod12(c.root + i.semitones)).name);
  if (c.bassName && !names.includes(c.bassName)) names.unshift(c.bassName);
  return names;
}

export function qualitySuffix(c: Chord): string {
  const { triad, seventh, extension } = c;
  let s = '';
  const top = extension ?? (seventh === 'b7' || seventh === 'maj7' || seventh === 'dim7' ? 7 : null);
  if (triad === 'dim' && seventh === 'b7') s = extension ? `m${extension}b5` : 'm7b5';
  else if (triad === 'dim' && seventh === 'dim7') s = 'dim7';
  else if (triad === 'dim') s = 'dim';
  else if (triad === '5') s = '5';
  else {
    const m = triad === 'min' ? 'm' : '';
    if (seventh === '6') s = `${m}6${c.adds.includes(9) ? '/9' : ''}`;
    else if (seventh === 'maj7') s = triad === 'min' ? `m(maj${top})` : `maj${top}`;
    else if (seventh === 'b7') s = `${m}${top}`;
    else s = m;
    if (triad === 'aug') s = seventh === 'none' ? 'aug' : `aug${s}`;
    if (triad === 'sus2' || triad === 'sus4') s += triad;
  }
  for (const a of c.adds) {
    if (a === 9 && seventh === '6') continue;
    s += `add${a}`;
  }
  for (const alt of c.alterations) s += alt;
  return s;
}

export function formatChord(c: Chord): string {
  return `${c.rootName}${qualitySuffix(c)}${c.bassName ? `/${c.bassName}` : ''}`;
}

/** Key ignoring root/bass: used to match transposable shapes. */
export function qualityKey(c: Chord): string {
  return [c.triad, c.seventh, c.extension ?? '', c.adds.join('.'), c.alterations.join('.')].join('|');
}

/** Full identity key: root pitch class + quality + bass pitch class. */
export function chordKey(c: Chord): string {
  return `${c.root}|${qualityKey(c)}|${c.bass ?? ''}`;
}

export function sameChord(a: Chord, b: Chord): boolean {
  return chordKey(a) === chordKey(b);
}

function rootPreference(c: Chord): 'guitar-major' | 'guitar-minor' {
  return c.triad === 'min' || c.triad === 'dim' ? 'guitar-minor' : 'guitar-major';
}

/** Transpose; spelled with guitar-friendly root names (used for capo shapes). */
export function transposeChord(c: Chord, semitones: number): Chord {
  if (mod12(semitones) === 0) return { ...c, adds: [...c.adds], alterations: [...c.alterations] };
  const root = mod12(c.root + semitones);
  const bass = c.bass === null ? null : mod12(c.bass + semitones);
  return {
    ...c,
    adds: [...c.adds],
    alterations: [...c.alterations],
    root,
    rootName: spellPitchClass(root, rootPreference(c)),
    bass,
    bassName: bass === null ? null : spellPitchClass(bass, 'guitar-major'),
  };
}

export function withChanges(c: Chord, changes: Partial<Chord>): Chord {
  return { ...c, adds: [...c.adds], alterations: [...c.alterations], ...changes };
}
