/**
 * VGT-19 review r3: on charts without uncertain stretches the lane must be drawn exactly as on main
 * before VGT-19 (a7b6959, frozen in tests/fixtures/lane-a7b6959.ts). Seeded random charts cover
 * coverage gaps, rests, very short events, event and coverage bounds within 0.1 s of bar edges,
 * 3/4 and 4/4, varied tempi and explicit beat grids.
 */
import { describe, expect, it } from 'vitest';
import type { Chart, ChordEvent, CoverageRange } from '../src/chart/types';
import { validateChart } from '../src/chart/validate';
import type { Level } from '../src/arrange/levels';
import { buildPlayModel } from '../src/play/model';
import { buildLane as mainBuildLane } from './fixtures/lane-a7b6959';

const SEED = 0x5eed19;
export const CHARTS = 400;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const r3 = (x: number) => Math.round(x * 1000) / 1000;
const CHORDS = ['C', 'G', 'Am', 'F', 'Em', 'D7', 'Bm', 'N', 'Fmaj7', 'E', 'C#m', 'Bb', 'N'];
const LEVELS: Level[] = ['beginner', 'novice', 'intermediate', 'advanced'];

function randomChart(rnd: () => number): { chart: Chart; level: Level; capo: 'auto' | number; allowRootChange: boolean } {
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];
  const bpb = rnd() < 0.5 ? 3 : 4;
  const bpm = Math.round(60 + rnd() * 120);
  const beat = 60 / bpm;
  const bar = bpb * beat;
  const first = r3(rnd() * 1.5);
  const bars = 6 + Math.floor(rnd() * 14);
  const total = first + bars * bar;
  // a time near a bar edge: within 0.1 s on either side (sometimes exactly on it)
  const nearEdge = (after: number) => {
    const k = Math.ceil((after - first) / bar + 1e-9);
    return first + k * bar + (rnd() < 0.2 ? 0 : (rnd() - 0.5) * 0.2);
  };

  const events: ChordEvent[] = [];
  let t = r3(rnd() * Math.min(2, bar));
  while (t < total) {
    events.push({ startSec: t, chord: pick(CHORDS), confidence: r3(0.3 + rnd() * 0.7), source: 'auto' });
    const u = rnd();
    let next = u < 0.3 ? t + 0.02 + rnd() * 0.28 : u < 0.6 ? nearEdge(t + 0.05) : t + 0.3 + rnd() * 2.7;
    next = r3(next);
    t = next > t ? next : r3(t + 0.01);
  }

  const n = 1 + Math.floor(rnd() * 3);
  const marks: number[] = [];
  for (let i = 0; i < n * 2; i++) marks.push(r3(rnd() < 0.5 ? nearEdge(rnd() * total) : rnd() * total));
  marks.sort((x, y) => x - y);
  const coverage: CoverageRange[] = [];
  for (let i = 0; i + 1 < marks.length; i += 2) {
    const fromSec = Math.max(0, marks[i]);
    const toSec = Math.min(r3(total), marks[i + 1]);
    if (toSec - fromSec > 0.01 && (!coverage.length || fromSec > coverage[coverage.length - 1].toSec)) coverage.push({ fromSec, toSec });
  }
  if (!coverage.length) coverage.push({ fromSec: 0, toSec: r3(total) });

  const timing: Chart['timing'] = { bpm, beatsPerBar: bpb, beatUnit: 4, firstDownbeatSec: first };
  if (rnd() < 0.3) {
    const beatTimes: number[] = [];
    for (let i = 0; i <= bars * bpb; i++) beatTimes.push(r3(first + i * beat + (rnd() - 0.5) * beat * 0.1));
    timing.beatTimes = beatTimes;
  }
  const chart: Chart = {
    schemaVersion: 1,
    recording: { source: 'youtube', id: 'laneequiv01', title: 'T', artist: 'A' },
    timing,
    events,
    coverage,
    provenance: { createdBy: 'recognizer', createdAt: '2026-11-14T00:00:00.000Z' },
  };
  return { chart, level: pick(LEVELS), capo: rnd() < 0.5 ? 'auto' : Math.floor(rnd() * 4), allowRootChange: rnd() < 0.3 };
}

describe('lane equals main (a7b6959) on charts without uncertain stretches', () => {
  it(`${CHARTS} seeded random charts draw the same bars and segments`, () => {
    const rnd = mulberry32(SEED);
    let nearEdgeCuts = 0;
    for (let n = 0; n < CHARTS; n++) {
      const { chart, level, capo, allowRootChange } = randomChart(rnd);
      const v = validateChart(chart);
      expect(v.errors, `chart ${n}`).toEqual([]);
      const m = buildPlayModel(chart, { level, capo, allowRootChange }, null);
      let coverEnd = 0;
      for (const r of m.chart.coverage) coverEnd = Math.max(coverEnd, r.toSec);
      for (const e of m.arrangement.events) coverEnd = Math.max(coverEnd, e.endSec);
      const ref = mainBuildLane(m.arrangement, m.timing, m.big, Math.min(m.durationSec, coverEnd + 0.01), (i) => m.stripKeys[i] || m.labels[i].name, (i) => !!m.arrangement.events[i]?.change);
      const got = m.bars.map((b) => ({ ...b, segments: b.segments.map(({ flag, ...s }) => (expect(flag).toBe(-1), s)) }));
      expect(got, `chart ${n} (seed ${SEED})`).toEqual(ref);
      for (const b of m.bars) for (const e of m.arrangement.events) if ([e.startSec, e.endSec].some((x) => Math.abs(x - b.startSec) < 0.1 || Math.abs(x - b.endSec) < 0.1)) nearEdgeCuts++;
    }
    // the generator really exercises bounds near bar edges
    expect(nearEdgeCuts).toBeGreaterThan(CHARTS);
  });
});
