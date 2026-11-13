import { describe, expect, it } from 'vitest';
import type { Chart } from '../src/chart/types';
import { RecordingCache } from '../src/extension/dump/audio-dump';
import type { ModelRunner } from '../src/recognize/runner';
import { analyzeClosedSegments, ListeningSession, segmentBeatLogits, type Segment } from '../src/recognize/session';
import { compareParity } from '../src/replay/parity';
import { feedSession, parseReplayConfig } from '../src/replay/replay';
import { liveLikeSession } from './replay-helpers';

const fakeBeatRunner: ModelRunner = {
  async run(_name, data, dims) {
    const T = dims[1];
    const beat = new Float32Array(T);
    const downbeat = new Float32Array(T);
    for (let t = 0; t < T; t++) {
      beat[t] = data[t * dims[2]] - 1 + Math.sin(t) * 0.01;
      downbeat[t] = data[t * dims[2] + 1] - 1;
    }
    return { beat, downbeat };
  },
};

describe('offline replay feeding', () => {
  it('rebuilds the analysed segments exactly: start, audio, features and beat logits', async () => {
    const live = liveLikeSession();
    const rec = new RecordingCache<number>(new WeakMap());
    await analyzeClosedSegments(live, rec, async () => 0);
    const snapshot = rec.seen;
    expect(snapshot).toHaveLength(2);

    const replay = new ListeningSession(live.key, live.durationSec);
    const fed = await feedSession(replay, snapshot.map((s) => ({ startSec: s.startSec, samples: s.audio.view().slice() })), fakeBeatRunner);
    const rec2 = new RecordingCache<number>(new WeakMap());
    await analyzeClosedSegments(replay, rec2, async () => 0);
    expect(rec2.seen).toEqual(fed);
    for (let i = 0; i < snapshot.length; i++) {
      const a = snapshot[i];
      const b = rec2.seen[i];
      expect(b.startSec).toBe(a.startSec); // exact, not close
      expect(b.audio.view()).toEqual(a.audio.view());
      expect([b.melFrames, b.cqtFrames]).toEqual([a.melFrames, a.cqtFrames]);
      expect(b.mel.view()).toEqual(a.mel.view());
      expect(b.cqt.view()).toEqual(a.cqt.view());
      expect(await segmentBeatLogits(fakeBeatRunner, b)).toEqual(await segmentBeatLogits(fakeBeatRunner, a));
    }
  });

  it('keeps one session segment per stored segment', async () => {
    const s = new ListeningSession('youtube:x', 60);
    const segs = await feedSession(s, [
      { startSec: 0, samples: new Float32Array(30000).fill(0.01) },
      { startSec: 1.5, samples: new Float32Array(30000).fill(0.02) }, // starts right where a continuation would: still a new segment
    ], null);
    expect(s.segments).toHaveLength(2);
    expect(segs.map((g: Segment) => g.startSec)).toEqual([0, 1.5]);
  });
});

describe('replay config', () => {
  it('accepts the recognizer options and rejects unknown fields', () => {
    expect(parseReplayConfig(undefined)).toEqual({ recognizer: {} });
    expect(parseReplayConfig({ label: 'cp', recognizer: { vocabulary: 'majmin', decode: { changePenalty: [1, 2, 3] } } })).toEqual({ label: 'cp', recognizer: { vocabulary: 'majmin', decode: { changePenalty: [1, 2, 3] } } });
    expect(() => parseReplayConfig({ recognizer: { vocab: 'full' } })).toThrow(/unknown field recognizer.vocab/);
    expect(() => parseReplayConfig({ recognizer: { decode: { changePenalty: [1, 2] } } })).toThrow(/three finite numbers/);
    expect(() => parseReplayConfig({ recognizer: { decode: { changePenalty: [1, 2, 3], extra: 1 } } })).toThrow(/unknown field/);
    expect(() => parseReplayConfig({ recognizer: { vocabulary: 'huge' } })).toThrow(/vocabulary/);
    expect(() => parseReplayConfig({ recogniser: {} })).toThrow(/unknown field recogniser/);
  });
});

function chart(events: [number, string, number][], beats: number[], extra: Partial<Chart> = {}): Chart {
  return {
    schemaVersion: 1,
    recording: { source: 'youtube', id: 'abcdefghijk', title: 't', artist: 'a' },
    timing: { bpm: 120, beatsPerBar: 4, beatUnit: 4, firstDownbeatSec: beats[0], beatTimes: beats },
    events: events.map(([startSec, chord, confidence]) => ({ startSec, chord, confidence, source: 'auto' })),
    coverage: [{ fromSec: 0, toSec: 30 }],
    provenance: { createdBy: 'recognizer', createdAt: '2026-11-14T00:00:00.000Z', tool: 'live' },
    ...extra,
  };
}

describe('replay parity', () => {
  const live = chart(
    [
      [0.5, 'C', 0.8],
      [2.5, 'Am', 0.7],
      [4.5, 'F', 0.9],
    ],
    [0.5, 1.0, 1.5, 2.0],
  );

  it('identical charts pass; provenance and confidence differences do not fail', () => {
    const offline = chart(
      [
        [0.5, 'C', 0.81],
        [2.5, 'Am', 0.7],
        [4.5, 'F', 0.9],
      ],
      [0.5, 1.0, 1.5, 2.0],
      { provenance: { createdBy: 'recognizer', createdAt: '2030-01-01T00:00:00.000Z', tool: 'replay' } },
    );
    const r = compareParity(live, offline);
    expect(r.ok).toBe(true);
    expect(r.maxConfidenceDiff).toBeCloseTo(0.01, 9);
    // Sub-millisecond differences vanish after rounding to 1 ms.
    expect(compareParity(live, chart([[0.5001, 'C', 0.8], [2.5, 'Am', 0.7], [4.5, 'F', 0.9]], [0.5, 1.0, 1.5, 2.0002])).ok).toBe(true);
  });

  it('one millisecond off fails', () => {
    const r = compareParity(live, chart([[0.5, 'C', 0.8], [2.501, 'Am', 0.7], [4.5, 'F', 0.9]], [0.5, 1.0, 1.5, 2.0]));
    expect(r.ok).toBe(false);
    expect(r.diffs[0]).toMatch(/event\[1\]: live Am@2.500 vs offline Am@2.501/);
    const b = compareParity(live, chart([[0.5, 'C', 0.8], [2.5, 'Am', 0.7], [4.5, 'F', 0.9]], [0.5, 1.001, 1.5, 2.0]));
    expect(b.diffs).toEqual(['beatTimes[1]: live 1.000 vs offline 1.001']);
  });

  it('a changed chord, an extra event, other coverage or meter fail', () => {
    expect(compareParity(live, chart([[0.5, 'C', 0.8], [2.5, 'A', 0.7], [4.5, 'F', 0.9]], [0.5, 1.0, 1.5, 2.0])).diffs).toEqual(['event[1]: live Am@2.500 vs offline A@2.500']);
    expect(compareParity(live, chart([[0.5, 'C', 0.8], [2.5, 'Am', 0.7], [4.5, 'F', 0.9], [6, 'G', 1]], [0.5, 1.0, 1.5, 2.0])).ok).toBe(false);
    expect(compareParity(live, { ...live, coverage: [{ fromSec: 0, toSec: 29.999 }] }).diffs[0]).toMatch(/^coverage/);
    expect(compareParity(live, { ...live, timing: { ...live.timing, beatsPerBar: 3 } }).diffs).toEqual(['beatsPerBar: live 4 vs offline 3']);
  });
});
