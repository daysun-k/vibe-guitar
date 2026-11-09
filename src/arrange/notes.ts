/** Pitch classes, note names and spelling. Pitch class 0 = C. */

export const LETTERS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'] as const;
export type Letter = (typeof LETTERS)[number];

const LETTER_PC: Record<Letter, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

export function mod12(n: number): number {
  return ((n % 12) + 12) % 12;
}

export interface NoteName {
  letter: Letter;
  /** -2..2 (bb, b, natural, #, ##) */
  accidental: number;
  pc: number;
  name: string;
}

const NOTE_RE = /^([A-G])(##|bb|#|b|♯|♭|x)?$/;

export function parseNoteName(text: string): NoteName | null {
  const m = NOTE_RE.exec(text.trim());
  if (!m) return null;
  const letter = m[1] as Letter;
  const acc = m[2] ?? '';
  const accidental =
    acc === '#' || acc === '♯' ? 1 : acc === '##' || acc === 'x' ? 2 : acc === 'b' || acc === '♭' ? -1 : acc === 'bb' ? -2 : 0;
  return makeNote(letter, accidental);
}

function accidentalText(accidental: number): string {
  switch (accidental) {
    case -2:
      return 'bb';
    case -1:
      return 'b';
    case 1:
      return '#';
    case 2:
      return '##';
    default:
      return '';
  }
}

function makeNote(letter: Letter, accidental: number): NoteName {
  return {
    letter,
    accidental,
    pc: mod12(LETTER_PC[letter] + accidental),
    name: letter + accidentalText(accidental),
  };
}

/** Spell `pc` using the given letter (accidental chosen to reach pc; may be ## / bb). */
export function spellWithLetter(letter: Letter, pc: number): NoteName {
  let diff = mod12(pc - LETTER_PC[letter]);
  if (diff > 6) diff -= 12;
  return makeNote(letter, diff);
}

/** Default guitar-friendly root spelling for a chord root. */
const MAJOR_ROOTS = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const MINOR_ROOTS = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'G#', 'A', 'Bb', 'B'];
const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const FLAT_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];

export type SpellingPreference = 'sharp' | 'flat' | 'guitar-major' | 'guitar-minor';

export function spellPitchClass(pc: number, preference: SpellingPreference = 'guitar-major'): string {
  const p = mod12(pc);
  switch (preference) {
    case 'sharp':
      return SHARP_NAMES[p];
    case 'flat':
      return FLAT_NAMES[p];
    case 'guitar-minor':
      return MINOR_ROOTS[p];
    default:
      return MAJOR_ROOTS[p];
  }
}

/** Transpose a spelled note, keeping flat/sharp flavour of the original where possible. */
export function transposeNoteName(name: string, semitones: number): string {
  const note = parseNoteName(name);
  if (!note) throw new Error(`not a note name: ${name}`);
  const pc = mod12(note.pc + semitones);
  if (semitones % 12 === 0) return note.name;
  return note.accidental < 0 ? FLAT_NAMES[pc] : note.accidental > 0 ? SHARP_NAMES[pc] : MAJOR_ROOTS[pc];
}

export function letterIndex(letter: Letter): number {
  return LETTERS.indexOf(letter);
}
