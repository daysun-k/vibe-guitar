/**
 * Regression tests for the independent review of phase 0 slice 2 (listening mode):
 * each case reproduces the reviewer's counterexample.
 */
import { describe, expect, it } from 'vitest';
import { mergeAutoCharts } from '../src/chart/merge';
import { chartStorageKey, type Chart, type ChordEvent, type CoverageRange, type Recording } from '../src/chart/types';
import { MODEL_SAMPLE_RATE } from '../src/audio/features';
import { ChartStore, autoChartKey, type StorageArea } from '../src/extension/storage';
import { anchorFromPlayerState, AudioPlacer, type PlayerAnchor } from '../src/recognize/placement';
import { analyzeClosedSegments, ListeningSession, type Segment } from '../src/recognize/session';

const rec: Recording = { source: 'youtube', id: 'abcdefghijk', title: 'T', artist: 'A' };
const MAIN = chartStorageKey('youtube', rec.id);
const AUTO = autoChartKey('youtube', rec.id);

function chart(createdBy: Chart['provenance']['createdBy'], events: [number, string][], coverage: [number, number][], beatTimes?: number[]): Chart {
  const c: Chart = {
    schemaVersion: 1,
    recording: { ...rec },
    timing: { bpm: 120, beatsPerBar: 4, beatUnit: 4, firstDownbeatSec: beatTimes?.[0] ?? 0 },
    events: events.map(([startSec, chord]): ChordEvent => ({ startSec, chord, confidence: 1, source: createdBy === 'recognizer' ? 'auto' : 'manual' })),
    coverage: coverage.map(([fromSec, toSec]): CoverageRange => ({ fromSec, toSec })),
    provenance: { createdBy, createdAt: '2026-11-09T00:00:00Z' },
  };
  if (beatTimes) c.timing.beatTimes = beatTimes;
  return c;
}

/** In-memory storage whose reads and writes yield to the event loop, with a hook after reading a given key. */
class MockArea implements StorageArea {
  data: Record<string, unknown> = {};
  afterGet: { key: string; fn: () => void } | null = null;
  async get(keys: string[] | null): Promise<Record<string, unknown>> {
    await new Promise((r) => setTimeout(r, 0));
    const out: Record<string, unknown> = {};
    for (const k of keys ?? Object.keys(this.data)) if (k in this.data) out[k] = structuredClone(this.data[k]);
    const hook = this.afterGet;
    if (hook && keys?.includes(hook.key)) {
      this.afterGet = null;
      hook.fn();
    }
    return out;
  }
  async set(items: Record<string, unknown>): Promise<void> {
    await new Promise((r) => setTimeout(r, 0));
    Object.assign(this.data, structuredClone(items));
  }
}

describe('finding 1: chart writes are serialized', () => {
  it('a manual save made while an auto save is in flight is not overwritten', async () => {
    const area = new MockArea();
    const store = new ChartStore(area);
    const auto = chart('recognizer', [[0, 'C']], [[0, 10]]);
    const manual = chart('manual', [[0, 'Am']], [[0, 10]]);
    // Reviewer's interleaving: the editor saves right after the auto save read the stored state.
    let manualSave: Promise<void> | null = null;
    area.afterGet = {
      key: MAIN,
      fn: () => {
        manualSave = store.saveManual(manual);
      },
    };
    const savedAs = await store.saveAuto(auto);
    await manualSave;
    expect(manualSave).not.toBeNull();
    expect((area.data[MAIN] as Chart).provenance.createdBy).toBe('manual');
    expect((area.data[MAIN] as Chart).events[0].chord).toBe('Am');
    expect((area.data[AUTO] as Chart).events[0].chord).toBe('C');
    expect(savedAs).toBe('main'); // stored first, then replaced by the later manual save
  });

  it('an auto save queued behind a manual save stays pending', async () => {
    const area = new MockArea();
    const store = new ChartStore(area);
    const manual = chart('manual', [[0, 'Am']], [[0, 10]]);
    const auto = chart('recognizer', [[0, 'C']], [[0, 10]]);
    const [, savedAs] = await Promise.all([store.saveManual(manual), store.saveAuto(auto)]);
    expect(savedAs).toBe('pending');
    expect((area.data[MAIN] as Chart).provenance.createdBy).toBe('manual');
  });

  it('adopting backs up the manual chart, and a failed write does not block later ones', async () => {
    const area = new MockArea();
    const store = new ChartStore(area);
    await store.saveManual(chart('manual', [[0, 'Am']], [[0, 10]]));
    expect(() => store.saveManual({ ...chart('manual', [[0, 'Am']], [[0, 10]]), schemaVersion: 2 as 1 })).toThrow();
    await store.saveAuto(chart('recognizer', [[0, 'C']], [[0, 10]]));
    await store.adoptAuto('youtube', rec.id);
    expect((area.data[MAIN] as Chart).provenance.createdBy).toBe('recognizer');
    expect((area.data[`chartbackup:youtube:${rec.id}`] as Chart).events[0].chord).toBe('Am');
  });
});

describe('finding 4: a short re-analysis never shrinks the auto chart', () => {
  const long = chart(
    'recognizer',
    [
      [0, 'C'],
      [40, 'G'],
      [80, 'Am'],
    ],
    [[0, 100]],
    [0, 0.5, 1, 99.5],
  );
  const short = chart('recognizer', [[50, 'F']], [[50, 55]], [50, 50.5, 51]);

  it('merges coverage and keeps the earlier chords outside the new range', () => {
    const m = mergeAutoCharts(long, short);
    expect(m.coverage).toEqual([{ fromSec: 0, toSec: 100 }]);
    expect(m.events.map((e) => [e.startSec, e.chord])).toEqual([
      [0, 'C'],
      [40, 'G'],
      [50, 'F'],
      [55, 'G'], // the chord that was sounding at 55 s in the earlier chart
      [80, 'Am'],
    ]);
    expect(m.timing.beatTimes).toEqual([0, 0.5, 1, 50, 50.5, 51, 99.5]);
  });

  it('stores the merged chart in both the main and the auto key', async () => {
    const area = new MockArea();
    const store = new ChartStore(area);
    expect(await store.saveAuto(long)).toBe('main');
    expect(await store.saveAuto(short)).toBe('main');
    for (const key of [MAIN, AUTO]) {
      const c = area.data[key] as Chart;
      expect(c.coverage).toEqual([{ fromSec: 0, toSec: 100 }]);
      expect(c.events.map((e) => e.chord)).toEqual(['C', 'G', 'F', 'G', 'Am']);
    }
  });

  it('a new chart covering everything replaces the old one', () => {
    const full = chart('recognizer', [[0, 'D']], [[0, 120]]);
    expect(mergeAutoCharts(long, full)).toBe(full);
  });
});

describe('finding 2: audio is placed by sample time, not arrival time', () => {
  const RATE = 48000;
  const BLOCK = 4800; // 100 ms
  const LAT = 0.05;
  const anchor = (ctxTime: number, position: number, extra: Partial<PlayerAnchor> = {}): PlayerAnchor => ({
    ctxTime,
    key: 'A',
    position,
    paused: false,
    rate: 1,
    isAd: false,
    ...extra,
  });
  /** Pushes blocks ending at 0.1, 0.2, … `untilSec` (AudioContext time), all at once. */
  const pushBlocks = (p: AudioPlacer, fromSec: number, untilSec: number) => {
    for (let end = Math.round((fromSec + 0.1) * RATE); end <= Math.round(untilSec * RATE); end += BLOCK) {
      p.pushBlock(new Float32Array(BLOCK).fill(0.01), RATE, end);
    }
  };
  const ranges = (s: ListeningSession) => s.coverage().map((r) => [r.fromSec, r.toSec]);

  it('10 × 100 ms blocks delivered 1 s late keep 1 s of coverage (reviewer counterexample)', () => {
    const s = new ListeningSession('A', 200);
    const p = new AudioPlacer(LAT);
    p.addAnchor(anchor(0, 10));
    pushBlocks(p, 0, 1);
    p.drain(2, (k) => (k === 'A' ? s : null)); // every block arrives at ctx 2 s
    expect(s.segments).toHaveLength(1);
    const [[from, to]] = ranges(s);
    expect(to - from).toBeGreaterThan(0.99);
    expect(s.storedSec).toBeCloseTo(to - from, 6);
    expect(to).toBeCloseTo(11 - LAT, 2);
  });

  it('holds a block until a report covering its time arrives, then places it by sample time', () => {
    const s = new ListeningSession('A', 200);
    const p = new AudioPlacer(LAT);
    p.addAnchor(anchor(0, 10));
    pushBlocks(p, 0.4, 0.5);
    p.drain(0.6, () => s); // younger than HOLD_SEC and no later report yet
    expect(p.pendingBlocks).toBe(1);
    // The pause at ctx 0.45 is reported late (with a later report at 0.7); the block
    // ending at 0.5 is placed as soon as a report covers its time, and is not stored.
    p.addAnchor(anchor(0.45, 10.45, { paused: true }));
    p.addAnchor(anchor(0.7, 10.45, { paused: true }));
    p.drain(0.75, () => s);
    expect(p.pendingBlocks).toBe(0);
    expect(s.storedSec).toBe(0);
    expect(p.idleReason).toBe('일시정지');
  });

  it('pause and resume boundaries apply at the right block', () => {
    const s = new ListeningSession('A', 200);
    const p = new AudioPlacer(LAT);
    p.addAnchor(anchor(0, 10));
    p.addAnchor(anchor(0.5, 10.5, { paused: true }));
    p.addAnchor(anchor(1.0, 10.5));
    pushBlocks(p, 0, 1.5);
    p.drain(3, () => s);
    expect(s.segments).toHaveLength(2);
    const [[a0, a1], [b0, b1]] = ranges(s);
    expect(a1 - a0).toBeGreaterThan(0.39);
    expect(a1).toBeCloseTo(10.4 - LAT, 2);
    expect(b0).toBeCloseTo(10.5 - LAT, 2);
    expect(b1).toBeCloseTo(11 - LAT, 2);
  });

  it('a seek splits the timeline at the right block', () => {
    const s = new ListeningSession('A', 200);
    const p = new AudioPlacer(LAT);
    p.addAnchor(anchor(0, 10));
    p.addAnchor(anchor(0.45, 60));
    pushBlocks(p, 0, 1);
    p.drain(3, () => s);
    const r = ranges(s);
    expect(r).toHaveLength(2);
    expect(r[0][1]).toBeCloseTo(10.4 - LAT, 2);
    // The block spanning the seek (ctx 0.4..0.5) is dropped; the next one starts at 60.05 s.
    expect(r[1][0]).toBeCloseTo(60.05 - LAT, 2);
    expect(r[1][1]).toBeCloseTo(60.55 - LAT, 2);
  });

  it('a track change sends each block to its own recording', () => {
    const a = new ListeningSession('A', 200);
    const b = new ListeningSession('B', 200);
    const p = new AudioPlacer(LAT);
    p.addAnchor(anchor(0, 100));
    p.addAnchor(anchor(0.5, 0, { key: 'B' }));
    pushBlocks(p, 0, 1);
    p.drain(3, (k) => (k === 'A' ? a : k === 'B' ? b : null));
    expect(a.storedSec).toBeGreaterThan(0.39);
    expect(a.storedSec).toBeLessThan(0.41);
    expect(b.storedSec).toBeGreaterThan(0.49);
    expect(ranges(b)[0][0]).toBeCloseTo(0, 2);
  });

  it('a late player report keeps its own time', () => {
    const report = { currentTime: 30, paused: false, playbackRate: 1, isAd: false, sampledAt: 1_000 };
    const a = anchorFromPlayerState(report, 'A', { ctxTime: 5, epochMs: 1_400 });
    expect(a.ctxTime).toBeCloseTo(4.6, 9);
    expect(a.position).toBe(30);
  });
});

describe('finding 3: analysis during playback only caches closed segments', () => {
  const sec = (s: number) => new Float32Array(Math.round(s * MODEL_SAMPLE_RATE)).fill(0.01);

  it('audio appended during the analysis awaits is analysed later, not cached half-grown', async () => {
    const s = new ListeningSession('A', 200);
    s.append(sec(20), 20); // heard 0..20 s
    const cache = new WeakMap<Segment, { start: number; end: number }>();
    let first = true;
    const analyze = async (seg: Segment) => {
      if (first) {
        first = false;
        // Playback goes on while the model runs: a new segment opens at 20 s and grows.
        s.append(sec(2), 22);
        await new Promise((r) => setTimeout(r, 0));
      }
      return { start: seg.startSec, end: seg.endSec };
    };
    const a1 = await analyzeClosedSegments(s, cache, analyze);
    expect(a1.map((x) => [x.start, x.end])).toEqual([[0, 20]]);
    s.append(sec(2), 24); // the open segment grows to 24 s
    const a2 = await analyzeClosedSegments(s, cache, analyze);
    expect(a2.map((x) => [x.start, Math.round(x.end * 1000) / 1000])).toEqual([
      [0, 20],
      [20, 24],
    ]);
    expect(s.segments.every((seg) => seg.closed)).toBe(true);
  });
});
