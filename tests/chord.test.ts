import { describe, expect, it } from 'vitest';
import {
  chordPitchClasses,
  chordToneNames,
  formatChord,
  isNoChord,
  parseChord,
  transposeChord,
} from '../src/arrange/chord';
import { spellPitchClass, transposeNoteName } from '../src/arrange/notes';

const pcs = (s: string) => chordPitchClasses(parseChord(s));

describe('parseChord', () => {
  it('parses root, quality, extension and slash bass', () => {
    const c = parseChord('Ebmaj9/G');
    expect(c.rootName).toBe('Eb');
    expect(c.root).toBe(3);
    expect(c.triad).toBe('maj');
    expect(c.seventh).toBe('maj7');
    expect(c.extension).toBe(9);
    expect(c.bass).toBe(7);
    expect(c.bassName).toBe('G');
  });

  it.each([
    ['C', [0, 4, 7]],
    ['Cm', [0, 3, 7]],
    ['C-', [0, 3, 7]],
    ['Cdim', [0, 3, 6]],
    ['Caug', [0, 4, 8]],
    ['C+', [0, 4, 8]],
    ['Csus', [0, 5, 7]],
    ['Csus2', [0, 2, 7]],
    ['C5', [0, 7]],
    ['C7', [0, 4, 7, 10]],
    ['Cmaj7', [0, 4, 7, 11]],
    ['CM7', [0, 4, 7, 11]],
    ['CΔ7', [0, 4, 7, 11]],
    ['Cm7', [0, 3, 7, 10]],
    ['CmM7', [0, 3, 7, 11]],
    ['Cm7b5', [0, 3, 6, 10]],
    ['Cø', [0, 3, 6, 10]],
    ['Cdim7', [0, 3, 6, 9]],
    ['C6', [0, 4, 7, 9]],
    ['Cm6', [0, 3, 7, 9]],
    ['C6/9', [0, 2, 4, 7, 9]],
    ['C9', [0, 2, 4, 7, 10]],
    ['Cm9', [0, 2, 3, 7, 10]],
    ['Cmaj9', [0, 2, 4, 7, 11]],
    ['C11', [0, 2, 4, 5, 7, 10]],
    ['C13', [0, 2, 4, 7, 9, 10]],
    ['Cadd9', [0, 2, 4, 7]],
    ['C7sus4', [0, 5, 7, 10]],
    ['C7b9', [0, 1, 4, 7, 10]],
    ['C7(#9)', [0, 3, 4, 7, 10]],
    ['C7#5', [0, 4, 8, 10]],
  ])('%s has the right pitch classes', (sym, expected) => {
    expect(pcs(sym)).toEqual(expected);
  });

  it('normalises equivalent spellings', () => {
    expect(parseChord('Cm7b5').triad).toBe('dim');
    expect(parseChord('C7#5').triad).toBe('aug');
    expect(parseChord('Am/A').bass).toBeNull();
  });

  it('round-trips through formatChord', () => {
    for (const s of ['C', 'Am', 'F#m7', 'Bbmaj7', 'Dm9', 'G7sus4', 'Ebdim7', 'Bm7b5', 'C/B', 'Am/G', 'D/F#', 'Caug', 'E5', 'Cadd9', 'C6/9', 'A7b9']) {
      const once = formatChord(parseChord(s));
      expect(formatChord(parseChord(once))).toBe(once);
      expect(chordPitchClasses(parseChord(once))).toEqual(chordPitchClasses(parseChord(s)));
    }
  });

  it('rejects garbage', () => {
    expect(() => parseChord('H7')).toThrow();
    expect(() => parseChord('Cfoo')).toThrow();
    expect(() => parseChord('C/Q')).toThrow();
  });

  it('recognises no-chord markers', () => {
    expect(isNoChord('N')).toBe(true);
    expect(isNoChord('N.C.')).toBe(true);
    expect(isNoChord('Am')).toBe(false);
  });
});

describe('spelling', () => {
  it('spells chord tones with correct letters', () => {
    expect(chordToneNames(parseChord('Ab'))).toEqual(['Ab', 'C', 'Eb']);
    expect(chordToneNames(parseChord('F#m'))).toEqual(['F#', 'A', 'C#']);
    expect(chordToneNames(parseChord('Bm'))).toEqual(['B', 'D', 'F#']);
    expect(chordToneNames(parseChord('Cdim7'))).toEqual(['C', 'Eb', 'Gb', 'Bbb']);
    expect(chordToneNames(parseChord('Db7'))).toEqual(['Db', 'F', 'Ab', 'Cb']);
    expect(chordToneNames(parseChord('C/B'))).toEqual(['B', 'C', 'E', 'G']);
  });

  it('spells pitch classes for guitar roots', () => {
    expect(spellPitchClass(8)).toBe('Ab');
    expect(spellPitchClass(8, 'guitar-minor')).toBe('G#');
    expect(spellPitchClass(10, 'sharp')).toBe('A#');
    expect(transposeNoteName('Bb', 2)).toBe('C');
    expect(transposeNoteName('Eb', 1)).toBe('E');
  });

  it('transposes chords (capo shape names)', () => {
    expect(formatChord(transposeChord(parseChord('Ab'), -1))).toBe('G');
    expect(formatChord(transposeChord(parseChord('Fm'), -1))).toBe('Em');
    expect(formatChord(transposeChord(parseChord('Db/F'), -1))).toBe('C/E');
    expect(formatChord(transposeChord(parseChord('Bbm7'), -1))).toBe('Am7');
  });
});
