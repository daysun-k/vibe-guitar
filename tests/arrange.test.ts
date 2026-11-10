import { describe, expect, it } from 'vitest';
import { EXAMPLE_CHARTS } from '../src/chart';
import type { Timing } from '../src/chart/types';
import {
  DEFAULT_PROFILE,
  LEVEL_CONFIGS,
  arrangeChart,
  arrangeEvents,
  fretString,
  isStructuralSlash,
  isStructuralSus,
  parseChord,
  reduceForLevel,
  staticDifficulty,
  substitutionCandidates,
  suggestCapo,
  suggestStrumming,
  transitionCost,
  voicingsForChord,
  type ArrangeInputEvent,
  type Profile,
} from '../src/arrange';

const timing44: Timing = { bpm: 90, beatsPerBar: 4, firstDownbeatSec: 0 };
const bar = (60 / 90) * 4;

function seq(chords: string[], beatsEach = 4): ArrangeInputEvent[] {
  const d = (60 / 90) * beatsEach;
  return chords.map((c, i) => ({ startSec: i * d, endSec: (i + 1) * d, chord: c, confidence: 1 }));
}

const P = (over: Partial<Profile> = {}): Profile => ({ ...DEFAULT_PROFILE, ...over });

describe('context-aware reduction', () => {
  const ctx = (prev: string | null, next: string | null) => ({
    prev: prev ? parseChord(prev) : null,
    next: next ? parseChord(next) : null,
  });

  it('detects a structural slash bass (descending line) and a non-structural one', () => {
    expect(isStructuralSlash(parseChord('C/B'), ctx('C', 'Am'))).toBe(true);
    expect(isStructuralSlash(parseChord('F/C'), ctx('C', 'C'))).toBe(true); // pedal
    expect(isStructuralSlash(parseChord('D/F#'), ctx('Bb', 'Eb'))).toBe(false);
  });

  it('detects a sus resolution', () => {
    expect(isStructuralSus(parseChord('Dsus4'), ctx('G', 'D'))).toBe(true);
    expect(isStructuralSus(parseChord('Dsus4'), ctx('G', 'A'))).toBe(false);
  });

  it('beginner drops 7ths/extensions but keeps a structural slash bass', () => {
    const b = LEVEL_CONFIGS.beginner;
    expect(reduceForLevel(parseChord('Cmaj7'), b, ctx(null, null)).steps).toContain('drop 7th');
    const dm9 = reduceForLevel(parseChord('Dm9'), b, ctx(null, null));
    expect(dm9.changed).toBe(true);
    expect(dm9.chord.triad).toBe('min');
    expect(dm9.chord.seventh).toBe('none');
    expect(reduceForLevel(parseChord('C/B'), b, ctx('C', 'Am')).chord.bass).toBe(11);
    expect(reduceForLevel(parseChord('D/F#'), b, ctx('Bb', 'Eb')).chord.bass).toBeNull();
    expect(reduceForLevel(parseChord('Dsus4'), b, ctx('G', 'D')).chord.triad).toBe('sus4');
  });

  it('intermediate keeps the original chord', () => {
    const r = reduceForLevel(parseChord('Dm9'), LEVEL_CONFIGS.intermediate, ctx(null, null));
    expect(r.changed).toBe(false);
  });

  it('dropping a structural sus or slash is penalised more than a decorative one', () => {
    const sus = parseChord('Dsus4');
    const w = (c: ReturnType<typeof ctx>) => substitutionCandidates(sus, c, sus).find((s) => s.reason === 'drop-sus')!.weight;
    expect(w(ctx('G', 'D'))).toBeGreaterThan(w(ctx('G', 'A')));
  });

  it('offers the proposal substitutions', () => {
    const names = (s: string) => substitutionCandidates(parseChord(s), { prev: null, next: null }, parseChord(s)).map((x) => x.chord);
    const fmt = (c: ReturnType<typeof parseChord>) => `${c.rootName}|${c.triad}|${c.seventh}|${c.extension}`;
    expect(names('F').map(fmt)).toContain('F|maj|maj7|null');
    expect(names('Bm').map(fmt)).toContain('B|min|b7|null');
    expect(names('Cmaj7').map(fmt)).toContain('C|maj|none|null');
    expect(names('Dm9').map(fmt)).toContain('D|min|none|null');
  });
});

describe('cost model', () => {
  const v = (chord: string, frets: string) => voicingsForChord(parseChord(chord)).find((x) => fretString(x.frets) === frets)!;

  it('rates full barres harder than small shapes and open shapes easiest', () => {
    expect(staticDifficulty(v('F', '133211'))).toBeGreaterThan(staticDifficulty(v('F', 'xx3211')));
    expect(staticDifficulty(v('F', 'xx3211'))).toBeGreaterThan(staticDifficulty(v('Fmaj7', 'xx3210')));
    expect(staticDifficulty(v('Em', '022000'))).toBeLessThan(staticDifficulty(v('C', 'x32010')));
  });

  it('transition cost is zero for the same shape and smaller with anchor fingers', () => {
    const c = v('C', 'x32010');
    const am = v('Am', 'x02210'); // fingers 2 and 1 stay
    const g = v('G', '320003');
    expect(transitionCost(c, c)).toBe(0);
    expect(transitionCost(c, am)).toBeLessThan(transitionCost(c, g));
  });
});

describe('arrangement (DP)', () => {
  it('beginner: F becomes the small shape (voicing change, no substitution badge)', () => {
    const a = arrangeEvents(seq(['C', 'F', 'G', 'C']), timing44, { level: 'beginner', capo: 0 });
    const f = a.events[1];
    expect(fretString(f.voicing!.frets)).toBe('xx3211');
    expect(f.substitution).toBe(false);
    expect(f.transformations.some((t) => t.kind === 'voicing')).toBe(true);
  });

  it('beginner who only knows Fmaj7 gets F → Fmaj7 flagged as substitution', () => {
    const known = ['C', 'G', 'Fmaj7'].map((s) => voicingsForChord(parseChord(s)).find((v) => v.kind === 'open' || v.kind === 'small')!.id);
    const a = arrangeEvents(seq(['C', 'F', 'G', 'C']), timing44, { level: 'beginner', capo: 0, profile: P({ knownShapes: known }) });
    expect(a.events[1].sounding).toBe('Fmaj7');
    expect(fretString(a.events[1].voicing!.frets)).toBe('xx3210');
    expect(a.events[1].substitution).toBe(true);
  });

  it('intermediate player who can barre may keep the barre F', () => {
    const a = arrangeEvents(seq(['F', 'Bb', 'C', 'F']), timing44, { level: 'intermediate', capo: 0, profile: P({ canBarre: true }) });
    expect(a.events.every((e) => !e.substitution)).toBe(true);
    expect(a.unplayable).toEqual([]);
  });

  it('beginner keeps the easier Cmaj7 shape but simplifies Dm9 → Dm with a badge; intermediate keeps both', () => {
    const beg = arrangeEvents(seq(['Cmaj7', 'Dm9', 'G', 'C']), timing44, { level: 'beginner', capo: 0 });
    expect(beg.events[0].sounding).toBe('Cmaj7'); // x32000 is easier than C x32010
    expect(beg.events[0].substitution).toBe(false);
    expect(beg.events[1].sounding).toBe('Dm');
    expect(beg.events[1].substitution).toBe(true);
    const mid = arrangeEvents(seq(['Cmaj7', 'Dm9', 'G', 'C']), timing44, { level: 'intermediate', capo: 0, profile: P({ canBarre: true }) });
    expect(mid.events[0].sounding).toBe('Cmaj7');
    expect(mid.events[1].sounding).toBe('Dm9');
    expect(mid.events[1].substitution).toBe(false);
  });

  it('keeps a structural slash bass line at beginner level', () => {
    const a = arrangeEvents(seq(['C', 'C/B', 'Am', 'Am/G', 'F']), timing44, { level: 'beginner', capo: 0 });
    expect(a.events[1].sounding).toBe('C/B');
    expect(a.events[3].sounding).toBe('Am/G');
    expect(a.events[1].substitution).toBe(false);
  });

  it('keeps a sus that resolves', () => {
    const a = arrangeEvents(seq(['G', 'Dsus4', 'D', 'G']), timing44, { level: 'beginner', capo: 0 });
    expect(a.events[1].sounding).toBe('Dsus4');
  });

  it('merges chords shorter than the level minimum (beginner: 2 beats)', () => {
    const ev: ArrangeInputEvent[] = [
      { startSec: 0, endSec: bar, chord: 'C', confidence: 1 },
      { startSec: bar, endSec: bar + bar / 4, chord: 'G/B', confidence: 1 },
      { startSec: bar + bar / 4, endSec: 2 * bar, chord: 'Am', confidence: 1 },
    ];
    const beg = arrangeEvents(ev, timing44, { level: 'beginner', capo: 0 });
    expect(beg.events.map((e) => e.original)).toEqual(['C', 'Am']);
    expect(beg.events[0].mergedFrom).toEqual(['G/B']);
    const adv = arrangeEvents(ev, timing44, { level: 'advanced', capo: 0, profile: P({ canBarre: true }) });
    expect(adv.events).toHaveLength(3);
  });

  it('handles rests and marks low-confidence events as uncertain', () => {
    const a = arrangeEvents(
      [
        { startSec: 0, endSec: 2, chord: 'N', confidence: 1 },
        { startSec: 2, endSec: 5, chord: 'G', confidence: 0.3 },
      ],
      timing44,
      { level: 'novice', capo: 0 },
    );
    expect(a.events[0].rest).toBe(true);
    expect(a.events[1].uncertain).toBe(true);
  });

  it('chooses the whole sequence jointly (not per chord)', () => {
    const a = arrangeEvents(seq(['G', 'D', 'Em', 'C']), timing44, { level: 'novice', capo: 0 });
    expect(a.events.map((e) => fretString(e.voicing!.frets))).toEqual(['320003', 'xx0232', '022000', 'x32010']);
  });
});

describe('capo', () => {
  const ab = EXAMPLE_CHARTS[0];

  it('suggests capo 1 for Ab–Eb–Fm–Db and shows sounding vs shape', () => {
    const s = suggestCapo(ab, 'beginner');
    expect(s[0].capo).toBe(1);
    expect(s[0].shapes.slice(0, 4)).toEqual(['G', 'D', 'Em', 'C']);
    const a = arrangeChart(ab, { level: 'beginner', capo: 1 });
    expect(a.events[0].sounding).toBe('Ab');
    expect(a.events[0].shape).toBe('G');
    expect(a.events[2].sounding).toBe('Fm');
    expect(a.events[2].shape).toBe('Em');
  });

  it('capo never changes the sounding chord', () => {
    for (let capo = 0; capo <= 7; capo++) {
      const a = arrangeChart(ab, { level: 'intermediate', capo, profile: P({ canBarre: true }) });
      expect(a.events.map((e) => e.sounding)).toEqual(arrangeChart(ab, { level: 'intermediate', capo: 0, profile: P({ canBarre: true }) }).events.map((e) => e.sounding));
    }
  });
});

describe('strumming', () => {
  it('suggests patterns per level and meter, always labelled as suggestions', () => {
    const t44 = { beatsPerBar: 4, beatUnit: 4 as const };
    expect(suggestStrumming('beginner', t44).steps).toEqual(['D', 'D', 'D', 'D']);
    expect(suggestStrumming('novice', t44).steps.join('')).toBe('D-DUD-DU');
    expect(suggestStrumming('intermediate', t44).steps.join('')).toBe('D-DU-UDU');
    expect(suggestStrumming('advanced', t44).style).toBe('fingerstyle');
    expect(suggestStrumming('beginner', { beatsPerBar: 3 }).steps).toHaveLength(3);
    const six = suggestStrumming('novice', { beatsPerBar: 6, beatUnit: 8 });
    expect(six.meter).toBe('6/8');
    expect(six.steps).toHaveLength(6);
    expect(six.suggested).toBe(true);
    expect(suggestStrumming('intermediate', { beatsPerBar: 4, feel: 'shuffle' }).id).toContain('shuffle');
    expect(suggestStrumming('beginner', { beatsPerBar: 5 }).meterFallback).toBe(true);
  });

  it('every pattern fills exactly one bar', () => {
    for (const level of ['beginner', 'novice', 'intermediate', 'advanced'] as const) {
      for (const t of [{ beatsPerBar: 4 }, { beatsPerBar: 3 }, { beatsPerBar: 6, beatUnit: 8 as const }]) {
        const s = suggestStrumming(level, t);
        expect(s.steps.length).toBe(t.beatsPerBar * s.stepsPerBeat);
      }
    }
  });
});
