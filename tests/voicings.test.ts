import { describe, expect, it } from 'vitest';
import { parseChord } from '../src/arrange/chord';
import { detectBarre, fretSpan, matchVoicing, parseFrets, voicingPitchClasses } from '../src/arrange/guitar';
import { allVoicings, voicingsForChord } from '../src/arrange/voicings';

const shape = (frets: string) => ({ frets: parseFrets(frets) });
const matches = (frets: string, chord: string) => matchVoicing(shape(frets), parseChord(chord)).ok;

describe('voicing pitch classes', () => {
  it('computes notes from frets', () => {
    // xx4432 = F# B D F# → Bm
    expect(voicingPitchClasses(shape('xx4432'))).toEqual([2, 6, 11]);
    expect(voicingPitchClasses(shape('x20202'))).toEqual([2, 6, 9, 11]);
    expect(voicingPitchClasses(shape('xx3210'))).toEqual([0, 4, 5, 9]);
  });

  it('matches the proposal examples', () => {
    expect(matches('xx4432', 'Bm')).toBe(true);
    expect(matches('x20202', 'Bm7')).toBe(true);
    expect(matches('xx3210', 'Fmaj7')).toBe(true);
    expect(matches('xx3211', 'F')).toBe(true);
    expect(matches('133211', 'F')).toBe(true);
  });

  it('rejects wrong names', () => {
    expect(matches('xx3210', 'F')).toBe(false); // E is not in F major
    expect(matches('x20202', 'Bm')).toBe(false); // A is not in Bm
    expect(matches('xx4432', 'B')).toBe(false);
    expect(matches('x32010', 'C/G')).toBe(false); // bass is C, not G
    expect(matches('xx0232', 'Dsus4')).toBe(false);
  });
});

describe('voicing database', () => {
  const all = allVoicings();

  it('is reasonably large and has unique ids', () => {
    expect(all.length).toBeGreaterThan(150);
    expect(new Set(all.map((v) => v.id)).size).toBe(all.length);
  });

  it('every voicing sounds exactly its chord name', () => {
    const bad = all
      .map((v) => ({ v, r: matchVoicing(v, parseChord(v.chord)) }))
      .filter((x) => !x.r.ok)
      .map((x) => `${x.v.chord} ${x.v.frets.map((f) => f ?? 'x').join('')}: ${x.r.reasons.join(', ')}`);
    expect(bad).toEqual([]);
  });

  it('every voicing has a finger for each fretted string and none for open/muted', () => {
    for (const v of all) {
      v.frets.forEach((f, s) => {
        const g = v.fingers[s];
        if (f === null) expect(g, v.id).toBeNull();
        else if (f === 0) expect(g, v.id).toBe(0);
        else expect(g, v.id).toBeGreaterThanOrEqual(1);
      });
    }
  });

  it('fingers never sit on two different frets', () => {
    for (const v of all) {
      const fretByFinger = new Map<number, number>();
      v.frets.forEach((f, s) => {
        const g = v.fingers[s];
        if (!g || f === null) return;
        const prev = fretByFinger.get(g);
        if (prev !== undefined) expect(prev, v.id).toBe(f);
        fretByFinger.set(g, f);
      });
    }
  });

  it('marks barre shapes and keeps spans playable', () => {
    const f = voicingsForChord(parseChord('F'));
    const barre = f.find((v) => v.kind === 'barre')!;
    expect(barre.frets).toEqual(parseFrets('133211'));
    expect(detectBarre(barre)?.full).toBe(true);
    const small = f.find((v) => v.kind === 'small')!;
    expect(small.frets).toEqual(parseFrets('xx3211'));
    expect(detectBarre(small)?.full).toBe(false);
    for (const v of all) expect(fretSpan(v), v.id).toBeLessThanOrEqual(4);
  });

  it('finds voicings for enharmonic spellings and movable shapes', () => {
    expect(voicingsForChord(parseChord('A#m7')).length).toBeGreaterThan(0);
    expect(voicingsForChord(parseChord('Bbm7')).length).toBeGreaterThan(0);
    expect(voicingsForChord(parseChord('Dm9')).some((v) => v.frets.join() === parseFrets('x5355x').join())).toBe(true);
    expect(voicingsForChord(parseChord('Ebm7b5')).length).toBeGreaterThan(0);
  });

  it('derives slash-bass voicings and validates them', () => {
    const gb = voicingsForChord(parseChord('G/B'));
    expect(gb.length).toBeGreaterThan(0);
    const em_d = voicingsForChord(parseChord('Em/D'));
    expect(em_d.length).toBeGreaterThan(0);
    for (const v of [...gb, ...em_d, ...voicingsForChord(parseChord('F/C')), ...voicingsForChord(parseChord('Am/F#'))]) {
      expect(matchVoicing(v, parseChord(v.chord)).ok, `${v.chord} ${v.frets.join(',')}`).toBe(true);
    }
  });
});
