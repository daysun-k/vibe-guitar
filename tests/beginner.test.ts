import { describe, expect, it } from 'vitest';
import type { Chart, Timing } from '../src/chart/types';
import {
  LEVELS,
  LEVEL_CONFIGS,
  DEFAULT_PROFILE,
  arrangeChart,
  arrangeEvents,
  detectBarre,
  fretString,
  lowestFret,
  parseChord,
  suggestCapo,
  voicingCost,
  voicingsForChord,
  type ArrangeInputEvent,
  type Arrangement,
} from '../src/arrange';
import { beatsBetween } from '../src/chart/timing';

const timing44: Timing = { bpm: 90, beatsPerBar: 4, firstDownbeatSec: 0 };

function seq(chords: string[], beatsEach = 4): ArrangeInputEvent[] {
  const d = (60 / 90) * beatsEach;
  return chords.map((c, i) => ({ startSec: i * d, endSec: (i + 1) * d, chord: c, confidence: 1 }));
}

const beginner = (chords: string[]) => arrangeEvents(seq(chords), timing44, { level: 'beginner', capo: 0 });

describe('beginner keeps an original 7th when its shape is easier', () => {
  it('Fmaj7, Am7 and Cmaj7 stay as written: no badge, no "drop 7th" history', () => {
    const a = beginner(['Cmaj7', 'Fmaj7', 'G', 'Am7']);
    for (const [i, name, frets] of [[0, 'Cmaj7', 'x32000'], [1, 'Fmaj7', 'xx3210'], [3, 'Am7', 'x02010']] as const) {
      const e = a.events[i];
      expect(e.sounding).toBe(name);
      expect(fretString(e.voicing!.frets)).toBe(frets);
      expect(e.substitution).toBe(false);
      expect(e.transformations.filter((t) => t.kind === 'substitution')).toEqual([]);
    }
  });

  it('a kept 7th sounds the same pitch classes as the original chord', () => {
    const a = beginner(['C', 'A7', 'Dm', 'G7']);
    for (const e of a.events) {
      expect(parseChord(e.sounding!).root).toBe(parseChord(e.original).root);
      if (!e.substitution) expect(e.sounding).toBe(e.original);
    }
    expect(a.events[1].sounding).toBe('A7'); // x02020 is easier than A x02220
  });

  it('still drops the 7th when the triad is easier, and says so', () => {
    const a = beginner(['C', 'Em7', 'Am', 'G']);
    const em = a.events[1];
    expect(em.sounding).toBe('Em'); // 022000 (2 fingers) beats Em7 022030 (3 fingers)
    expect(em.substitution).toBe(true);
    expect(em.transformations.some((t) => t.kind === 'substitution' && t.reason === 'level-simplify' && t.detail === 'drop 7th')).toBe(true);
  });

  it('Dm7 has a partial barre, so beginner plays Dm while novice keeps Dm7', () => {
    expect(detectBarre(voicingsForChord(parseChord('Dm7')).find((v) => fretString(v.frets) === 'xx0211')!)?.full).toBe(false);
    expect(beginner(['C', 'Dm7', 'G', 'C']).events[1].sounding).toBe('Dm');
    expect(arrangeEvents(seq(['C', 'Dm7', 'G', 'C']), timing44, { level: 'novice', capo: 0 }).events[1].sounding).toBe('Dm7');
  });
});

describe('dominant 7ths never come back as major 7ths', () => {
  it('at every level and capo, X7 sounds as X7 or X, never Xmaj7', () => {
    const dominants = ['C7', 'D7', 'E7', 'F7', 'G7', 'A7', 'B7', 'Bb7', 'Eb7', 'F#7'];
    for (const level of LEVELS) {
      for (let capo = 0; capo <= 3; capo++) {
        const a = arrangeEvents(seq(['C', ...dominants, 'C']), timing44, { level, capo });
        for (const e of a.events.slice(1, -1)) {
          expect(e.sounding, `${level} capo ${capo} ${e.original}`).not.toMatch(/maj7/);
          expect(parseChord(e.sounding!).root).toBe(parseChord(e.original).root);
        }
      }
    }
  });
});

describe('beginner-only shape penalties', () => {
  const v = (chord: string, frets: string) => voicingsForChord(parseChord(chord)).find((x) => fretString(x.frets) === frets)!;
  const extra = (level: (typeof LEVELS)[number], chord: string, frets: string): number => {
    const voicing = v(chord, frets);
    const plain = { ...LEVEL_CONFIGS[level], partialBarreCost: 0, highPositionCost: 0 };
    return voicingCost(voicing, parseChord(chord).root, LEVEL_CONFIGS[level], DEFAULT_PROFILE) - voicingCost(voicing, parseChord(chord).root, plain, DEFAULT_PROFILE);
  };

  it('adds cost for a partial barre and for high positions at beginner only', () => {
    expect(extra('beginner', 'F#m', 'xx4222')).toBeCloseTo(LEVEL_CONFIGS.beginner.partialBarreCost);
    expect(extra('beginner', 'Em', '022000')).toBe(0);
    const high = voicingsForChord(parseChord('A')).find((x) => lowestFret(x) >= 5)!;
    expect(extra('beginner', 'A', fretString(high.frets))).toBeGreaterThanOrEqual(LEVEL_CONFIGS.beginner.highPositionCost);
    for (const level of ['novice', 'intermediate', 'advanced'] as const) {
      expect(extra(level, 'F#m', 'xx4222')).toBe(0);
      expect(extra(level, 'A', fretString(high.frets))).toBe(0);
    }
  });

  it('a partial barre alone does not turn a faithful F into a flagged Fmaj7', () => {
    const f = beginner(['C', 'F', 'G', 'C']).events[1];
    expect(f.sounding).toBe('F');
    expect(f.substitution).toBe(false);
  });
});

describe('voicing ids stay stable for saved "known shapes"', () => {
  it('keeps the ids that main 9ed8cea gave existing shapes', () => {
    const id = (c: string, f: string) => voicingsForChord(parseChord(c)).find((x) => fretString(x.frets) === f)!.id;
    expect(id('C', 'x32010')).toBe('db:C:x32010:0');
    expect(id('F', 'xx3211')).toBe('db:F:xx3211:30');
    expect(id('G', '320003')).toBe('db:G:320003:35');
    expect(id('Gm', 'xx5333')).toBe('db:Gm:xx5333:42');
    expect(id('B7', 'x21202')).toBe('db:B7:x21202:55');
    expect(id('C#m', 'xx6654')).toBe('db:C#m:xx6654:60');
  });
});

describe('new open shapes', () => {
  it('F#m7 2x2220 and F#7 xx4320 are listed and need no barre', () => {
    for (const [chord, frets] of [['F#m7', '2x2220'], ['F#7', 'xx4320']] as const) {
      const shape = voicingsForChord(parseChord(chord)).find((x) => fretString(x.frets) === frets);
      expect(shape, chord).toBeDefined();
      expect(detectBarre(shape!)).toBeNull();
    }
  });
});

/**
 * A made-up Eb-major ballad (not a real song): maj7 and m7 colours, secondary dominants and a
 * borrowed iv (Abm), one chord per bar at 70 bpm, played three times.
 */
function balladChart(): Chart {
  const loop = ['Ebmaj7', 'Cm7', 'Fm7', 'Bb7', 'Abmaj7', 'Gm7', 'Cm7', 'C7', 'Fm7', 'Abm', 'Eb', 'Bb7'];
  const chords = [...loop, ...loop, ...loop];
  const timing: Timing = { bpm: 70, beatsPerBar: 4, beatUnit: 4, firstDownbeatSec: 0, feel: 'straight' };
  const barSec = (60 / 70) * 4;
  return {
    schemaVersion: 1,
    recording: { source: 'youtube', id: 'SYNTHETIC-EB-BALLAD', title: 'synthetic Eb ballad', artist: 'test' },
    timing,
    events: chords.map((chord, i) => ({ startSec: i * barSec, chord, confidence: 1, source: 'manual' })),
    coverage: [{ fromSec: 0, toSec: chords.length * barSec }],
    provenance: { createdBy: 'manual', createdAt: '2026-11-10T00:00:00Z', tool: 'test fixture', note: 'synthetic', example: true },
  } as Chart;
}

function barreBeats(a: Arrangement, timing: Timing): number {
  let beats = 0;
  for (const e of a.events) {
    if (e.rest || !e.voicing) continue;
    if (detectBarre(e.voicing) || lowestFret(e.voicing) >= 5) beats += beatsBetween(timing, e.startSec, e.endSec);
  }
  return Math.round(beats);
}

describe('synthetic Eb-major ballad at beginner', () => {
  const chart = balladChart();
  const capo = suggestCapo(chart, 'beginner')[0].capo;
  const a = arrangeChart(chart, { level: 'beginner', capo });

  it('spends fewer beats on barre or high-position shapes than before (main 9ed8cea: 24 of 144 beats at capo 1)', () => {
    expect(barreBeats(a, chart.timing)).toBeLessThan(BASELINE_BARRE_BEATS);
  });

  it('never changes a chord root and never invents a major 7th', () => {
    for (const e of a.events) {
      expect(parseChord(e.sounding!).root).toBe(parseChord(e.original).root);
      if (parseChord(e.original).seventh === 'b7') expect(e.sounding).not.toMatch(/maj7/);
    }
  });
});

/** Measured on main 9ed8cea with the same fixture before this change. */
const BASELINE_BARRE_BEATS = 24;
