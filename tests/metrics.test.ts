import { describe, expect, it } from 'vitest';
import type { Chart } from '../src/chart/types';
import { beatFMeasure, compareCharts, reduceSymbol, wcsr } from '../src/eval/metrics';

describe('chord reductions', () => {
  it('reduces like mir_eval majmin / root / sevenths', () => {
    expect(reduceSymbol('C7', 'majmin')).toBe('0:maj');
    expect(reduceSymbol('Am7', 'majmin')).toBe('9:min');
    expect(reduceSymbol('Bb', 'majmin')).toBe(reduceSymbol('A#', 'majmin'));
    expect(reduceSymbol('Csus4', 'majmin')).toBeNull();
    expect(reduceSymbol('Csus4', 'root')).toBe('0');
    expect(reduceSymbol('Cmaj7', 'sevenths')).toBe('0:maj7');
    expect(reduceSymbol('C6', 'sevenths')).toBeNull();
    expect(reduceSymbol('N', 'majmin')).toBe('N');
  });
});

describe('WCSR', () => {
  it('weights agreement by duration and excludes chords outside the reduction', () => {
    const ref = [
      { startSec: 0, endSec: 4, symbol: 'C' },
      { startSec: 4, endSec: 6, symbol: 'Gsus4' },
      { startSec: 6, endSec: 10, symbol: 'Am' },
    ];
    const est = [
      { startSec: 0, endSec: 3, symbol: 'C7' },
      { startSec: 3, endSec: 10, symbol: 'Am' },
    ];
    const r = wcsr(ref, est, 'majmin');
    expect(r.evaluatedSec).toBe(8);
    expect(r.score).toBeCloseTo(7 / 8, 9);
  });
});

describe('beat F-measure', () => {
  it('matches within ±70 ms one-to-one', () => {
    const f = beatFMeasure([1, 2, 3, 4], [1.05, 2.1, 3.0, 3.01, 5]);
    expect(f.precision).toBeCloseTo(2 / 5, 9);
    expect(f.recall).toBeCloseTo(2 / 4, 9);
  });

  it('uses a maximum matching, not greedy nearest (review finding 5)', () => {
    // Greedy nearest gives 1 → 1.04 and leaves 1.1 unmatched (F = 0.5); both can match.
    const f = beatFMeasure([1, 1.1], [0.94, 1.04], 0.07);
    expect(f.f).toBeCloseTo(1, 9);
    expect(f.precision).toBeCloseTo(1, 9);
    expect(f.recall).toBeCloseTo(1, 9);
    // Order of the inputs does not matter.
    expect(beatFMeasure([1.1, 1], [1.04, 0.94], 0.07).f).toBeCloseTo(1, 9);
  });
});

describe('compareCharts (user chart vs auto chart)', () => {
  const base = (events: [number, string][], coverage: [number, number][], beatTimes?: number[]): Chart => ({
    schemaVersion: 1,
    recording: { source: 'youtube', id: 'x', title: '', artist: '' },
    timing: { bpm: 120, beatsPerBar: 4, firstDownbeatSec: 0, ...(beatTimes ? { beatTimes } : {}) },
    events: events.map(([startSec, chord]) => ({ startSec, chord, confidence: 1, source: 'manual' as const })),
    coverage: coverage.map(([fromSec, toSec]) => ({ fromSec, toSec })),
    provenance: { createdBy: 'manual', createdAt: '2026-11-09T00:00:00Z' },
  });

  it('scores only the time both charts cover', () => {
    const manual = base([[0, 'C'], [4, 'G'], [8, 'Am']], [[0, 12]], [0, 0.5, 1, 1.5]);
    const auto = base([[2, 'C'], [5, 'G'], [8, 'F']], [[2, 10]], [0.02, 0.5, 1.2, 1.5]);
    const c = compareCharts(manual, auto);
    expect(c.overlapSec).toBe(8);
    // 2..4 C ok, 4..5 G vs C wrong, 5..8 ok, 8..10 Am vs F wrong → 5/8
    expect(c.majmin.score).toBeCloseTo(5 / 8, 9);
    expect(c.beatF).toBeUndefined(); // reference beats lie outside the overlap
  });
});
