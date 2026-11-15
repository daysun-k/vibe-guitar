/**
 * VGT-22: a segment's start is the median of its per-block start estimates (not the first
 * block's alone) and is not clamped at 0 s; coverage and the auto chart clip at 0 s.
 */
import { describe, expect, it } from 'vitest';
import { MODEL_SAMPLE_RATE } from '../src/audio/features';
import { validateChart } from '../src/chart/validate';
import { buildAutoChart } from '../src/recognize/autochart';
import type { SegmentAnalysis } from '../src/recognize/recognizer';
import { ListeningSession, Segment } from '../src/recognize/session';

const BLOCK = 1882; // about one 4096-frame capture block at 22.05 kHz
const block = () => new Float32Array(BLOCK);
const blockSec = BLOCK / MODEL_SAMPLE_RATE;

/** Appends `n` blocks of a segment that truly starts at `trueStart`; `ahead(i)` = how far block i's report runs ahead. */
function feed(s: ListeningSession, trueStart: number, n: number, ahead: (i: number) => number): void {
  for (let i = 0; i < n; i++) s.append(block(), trueStart + (i + 1) * blockSec + ahead(i));
}

describe('Segment start (VGT-22)', () => {
  it('uses the median of the per-block estimates, keeps the first one, and stays one segment', () => {
    const s = new ListeningSession('k');
    // A startup delay of 60 ms: the first three reports run ahead, the rest are right.
    feed(s, 20, 40, (i) => (i < 3 ? 0.06 - i * 0.01 : 0));
    expect(s.segments).toHaveLength(1);
    const seg = s.segments[0];
    expect(seg.firstStartSec).toBeCloseTo(20.06, 9);
    expect(seg.startSec).toBeCloseTo(20, 9);
    expect(seg.startEstimates).toHaveLength(40);
    expect([...seg.startEstimates]).toEqual([...seg.startEstimates].sort((a, b) => a - b));
    expect(seg.endSec).toBeCloseTo(20 + 40 * blockSec, 9);
  });

  it('negative control: an offset shared by every report moves the start with it', () => {
    const s = new ListeningSession('k');
    feed(s, 20, 40, () => 0.05);
    expect(s.segments[0].startSec).toBeCloseTo(20.05, 9);
    expect(s.segments[0].firstStartSec).toBeCloseTo(20.05, 9);
  });

  it('a new segment after a seek gets its own estimates', () => {
    const s = new ListeningSession('k');
    feed(s, 10, 10, () => 0);
    feed(s, 40, 10, (i) => (i === 0 ? 0.08 : 0));
    expect(s.segments.map((g) => +g.startSec.toFixed(6))).toEqual([10, 40]);
    expect(s.segments[1].firstStartSec).toBeCloseTo(40.08, 9);
  });

  it('is not clamped at 0 s; coverage and the covered fraction clip there', () => {
    const s = new ListeningSession('k', 10);
    feed(s, -0.04, 50, () => 0);
    const seg = s.segments[0];
    expect(seg.startSec).toBeCloseTo(-0.04, 9);
    const end = -0.04 + 50 * blockSec;
    expect(s.coverage()).toEqual([{ fromSec: 0, toSec: seg.endSec }]);
    expect(s.coveredFraction()).toBeCloseTo(end / 10, 9);
  });

  it('pinStart fixes the start (replay of a stored segment)', () => {
    const seg = new Segment(1.23);
    expect(seg.startSec).toBe(1.23); // no estimate yet: the first start
    seg.addStartEstimate(1.3);
    expect(seg.startSec).toBe(1.3);
    seg.pinStart(-0.012);
    seg.addStartEstimate(2);
    expect(seg.startSec).toBe(-0.012);
  });
});

describe('auto chart with a segment that starts before 0 s', () => {
  const rec = { source: 'youtube' as const, id: 'abcdefghijk', title: 't', artist: 'a' };
  const seg = (startSec: number, endSec: number, symbol: string): SegmentAnalysis => {
    const beats: number[] = [];
    for (let t = Math.ceil(startSec * 2) / 2; t < endSec; t += 0.5) beats.push(t);
    const bounds = [startSec, ...beats.filter((b) => b > startSec), endSec];
    const units = bounds.slice(0, -1).map((b, i) => ({ startSec: b, endSec: bounds[i + 1], strength: 2 as const, symbol, confidence: 0.8 }));
    return { startSec, endSec, beats, downbeats: beats.filter((_, i) => i % 4 === 0), units, timingsMs: { features: 0, beats: 0, chords: 0, decode: 0 } };
  };

  it('clips coverage, events and beats at 0 s and stays valid', () => {
    const early = seg(-0.06, 12, 'C');
    early.beats.unshift(-0.04); // a beat heard before 0 s
    const chart = buildAutoChart({ recording: rec, segments: [early], tool: 'test', durationSec: 20 });
    expect(validateChart(chart).errors).toEqual([]);
    expect(chart.coverage).toEqual([{ fromSec: 0, toSec: 12 }]);
    expect(chart.events[0]).toMatchObject({ startSec: 0, chord: 'C' });
    expect(chart.events.every((e) => e.startSec >= 0)).toBe(true);
  });

  it('a later, longer segment that starts before 0 s does not take a range below 0 s from ownership', () => {
    const replay = seg(-0.03, 4, 'F');
    const long = seg(5, 30, 'C');
    const chart = buildAutoChart({ recording: rec, segments: [long, replay], tool: 'test', durationSec: 30 });
    expect(validateChart(chart).errors).toEqual([]);
    expect(chart.coverage).toEqual([
      { fromSec: 0, toSec: 4 },
      { fromSec: 5, toSec: 30 },
    ]);
    expect(chart.events.map((e) => [e.startSec, e.chord])).toEqual([
      [0, 'F'],
      [5, 'C'],
    ]);
  });
});
