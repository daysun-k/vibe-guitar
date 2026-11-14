import { describe, expect, it } from 'vitest';
import type { Chart } from '../src/chart/types';
import { harteToSymbol, parseLab, scoreSong } from '../src/eval/annotations';
import { boundaryStats, BOUNDARY_WINDOW_SEC, unknownRanges } from '../src/eval/paired';
// @ts-expect-error plain .mjs without types
import { parseArgs } from '../scripts/paired-eval.mjs';

function chart(events: [number, string][], cover: [number, number][]): Chart {
  return {
    schemaVersion: 1,
    recording: { source: 'youtube', id: 'abcdefghijk', title: 't', artist: 'a' },
    timing: { bpm: 120, beatsPerBar: 4, beatUnit: 4, firstDownbeatSec: 0 },
    events: events.map(([startSec, chord]) => ({ startSec, chord, confidence: 0.9, source: 'auto' })),
    coverage: cover.map(([fromSec, toSec]) => ({ fromSec, toSec })),
    provenance: { createdBy: 'recognizer', createdAt: '2026-11-14T00:00:00.000Z' },
  };
}

const W = BOUNDARY_WINDOW_SEC;

describe('boundary metrics with --mask-unknown-boundaries', () => {
  // PR #40 review F1: reference C (0-4), X (4-7), C (7-10); chart C (0-5), G (5-6), C (6-10).
  const cxc = parseLab('0 4 C:maj\n4 7 X\n7 10 C:maj\n');
  const cgc = chart([[0, 'C'], [5, 'G'], [6, 'C']], [[0, 10]]);

  it('C/X/C: WCSR is 1 over 7 s; unmasked boundaries count the X entry/exit and the changes inside X', () => {
    const wcsr = scoreSong(cxc, null, cgc, 0, 10, 1, 1).comparison.majmin;
    expect(wcsr.evaluatedSec).toBeCloseTo(7, 9);
    expect(wcsr.score).toBeCloseTo(1, 9);
    expect(boundaryStats(cxc, cgc, 0, 10, 1)).toEqual({ predicted: 2, annotated: 2, matched: 0, precision: 0, recall: 0, f: 0 });
    expect(boundaryStats(cxc, cgc, 0, 10, 1, W, false)).toEqual(boundaryStats(cxc, cgc, 0, 10, 1));
  });

  it('C/X/C masked: nothing left to count, so precision, recall and F are NaN (empty sets)', () => {
    const b = boundaryStats(cxc, cgc, 0, 10, 1, W, true);
    expect(b).toMatchObject({ predicted: 0, annotated: 0, matched: 0 });
    expect([b.precision, b.recall, b.f].every(Number.isNaN)).toBe(true);
  });

  it('an unmapped label is masked like X', () => {
    const odd = parseLab('0 4 C:maj\n4 7 ???\n7 10 C:maj\n');
    expect(harteToSymbol('???').kind).toBe('unmapped');
    expect(boundaryStats(odd, cgc, 0, 10, 1)).toMatchObject({ predicted: 2, annotated: 2, matched: 0 });
    expect(boundaryStats(odd, cgc, 0, 10, 1, W, true)).toMatchObject({ predicted: 0, annotated: 0, matched: 0 });
  });

  it('real changes outside X still count; the X entry/exit and a chart change inside X do not', () => {
    const segs = parseLab('0 4 C:maj\n4 8 G:maj\n8 11 X\n11 15 C:maj\n');
    const c = chart([[0, 'C'], [4.1, 'G'], [9, 'C']], [[0, 15]]);
    expect(boundaryStats(segs, c, 0, 15, 1)).toMatchObject({ annotated: 3, predicted: 2, matched: 1 });
    expect(boundaryStats(segs, c, 0, 15, 1, W, true)).toEqual({ predicted: 1, annotated: 1, matched: 1, precision: 1, recall: 1, f: 1 });
  });

  it('masks in media time through the frozen offset and rate, widened by the window', () => {
    const segs = parseLab('0 4 C:maj\n4 7 X\n7 10 N\n10 12 X\n');
    expect(unknownRanges(segs, 1, 2, W)).toEqual([
      { fromSec: 9 - W, toSec: 15 + W },
      { fromSec: 21 - W, toSec: 25 + W },
    ]);
    // The same C/X/C song placed at offset 1 s and rate 2: the mask follows the mapped X region.
    const mapped = chart([[0, 'N'], [1, 'C'], [11, 'G'], [13, 'C']], [[0, 30]]);
    expect(boundaryStats(cxc, mapped, 1, 30, 2, W, true)).toMatchObject({ predicted: 0, annotated: 0 });
  });
});

describe('paired-eval CLI', () => {
  const req = ['--maps', 'm.json', '--annotations', 'a', '--baseline', 'b', '--candidate', 'c'];
  it('--mask-unknown-boundaries is an opt-in flag without a value', () => {
    expect(parseArgs(req).maskUnknownBoundaries).toBe(false);
    expect(parseArgs([...req, '--mask-unknown-boundaries']).maskUnknownBoundaries).toBe(true);
    expect(parseArgs(['--mask-unknown-boundaries', ...req, '--out', 'r.json'])).toMatchObject({ maskUnknownBoundaries: true, out: 'r.json', maps: 'm.json' });
  });
});
