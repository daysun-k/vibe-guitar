import { describe, expect, it } from 'vitest';
import { parseChord } from '../src/arrange/chord';
import { MEL, MODEL_SAMPLE_RATE } from '../src/audio/features';
import { validateChart } from '../src/chart/validate';
import { coverageRangeAt, normalizeCoverage } from '../src/chart/coverage';
import { buildAutoChart, fillBeatGaps } from '../src/recognize/autochart';
import { chunkStarts, estimateBeatsPerBar, estimateBpm, postprocessMinimal, predictBeatLogits } from '../src/recognize/beats';
import { btcLabelToSymbol, buildVocabulary, decodeUnits, type DecodeUnit } from '../src/recognize/chords';
import type { SegmentAnalysis } from '../src/recognize/recognizer';
import type { ModelRunner } from '../src/recognize/runner';
import { ListeningSession, MAX_SESSION_SEC, Segment, segmentBeatLogits } from '../src/recognize/session';

const LARGE_LABELS = (() => {
  const roots = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const q = ['min', 'maj', 'dim', 'aug', 'min6', 'maj6', 'min7', 'minmaj7', 'maj7', '7', 'dim7', 'hdim7', 'sus2', 'sus4'];
  return [...roots.flatMap((r) => q.map((x) => (x === 'maj' ? r : `${r}:${x}`))), 'X', 'N'];
})();

describe('beat postprocessing (Beat This! minimal)', () => {
  it('reproduces split_piece chunk starts', () => {
    expect(chunkStarts(100)).toEqual([-6]);
    expect(chunkStarts(3000)).toEqual([-6, 1482, 1506]);
  });

  it('picks logit peaks > 0, merges adjacent peaks and snaps downbeats to beats', () => {
    const beat = new Float32Array(200).fill(-5);
    const down = new Float32Array(200).fill(-5);
    for (const f of [25, 50, 75, 100, 125, 150]) beat[f] = 3;
    beat[51] = 3; // adjacent duplicate → averaged to 50.5
    down[26] = 2; // near beat 25
    down[124] = 2; // near beat 125
    const r = postprocessMinimal({ beat, downbeat: down });
    expect(r.beats).toEqual([0.5, 1.01, 1.5, 2, 2.5, 3]);
    expect(r.downbeats).toEqual([0.5, 2.5]);
  });

  it('estimates tempo and meter', () => {
    const beats = Array.from({ length: 13 }, (_, i) => i * 0.5);
    expect(estimateBpm(beats)).toBeCloseTo(120, 6);
    expect(estimateBeatsPerBar(beats, [0, 1.5, 3, 4.5])).toBe(3);
    expect(estimateBeatsPerBar(beats, [])).toBe(4);
  });
});

describe('BTC vocabulary', () => {
  it('maps every large-vocabulary label to a chord symbol the chart parser accepts', () => {
    for (const l of LARGE_LABELS) {
      const s = btcLabelToSymbol(l);
      if (l === 'X') expect(s).toBeNull();
      else if (l === 'N') expect(s).toBe('N');
      else expect(() => parseChord(s!)).not.toThrow();
    }
    expect(btcLabelToSymbol('A#:hdim7')).toBe('A#m7b5');
    expect(btcLabelToSymbol('C:minmaj7')).toBe('Cm(maj7)');
  });

  it('simple vocabulary folds rare qualities and drops X', () => {
    const v = buildVocabulary(LARGE_LABELS, 'simple');
    expect(v.symbols).toContain('C7');
    expect(v.symbols).toContain('Csus4');
    expect(v.symbols).not.toContain('C6');
    expect(v.symbols[v.map[LARGE_LABELS.indexOf('C:maj6')]]).toBe('C');
    expect(v.symbols[v.map[LARGE_LABELS.indexOf('D:minmaj7')]]).toBe('Dm');
    expect(v.map[LARGE_LABELS.indexOf('X')]).toBe(-1);
  });
});

describe('beat-synchronous Viterbi decoding', () => {
  it('suppresses a one-beat flicker but keeps a confident change on a bar start', () => {
    const symbols = ['C', 'G'];
    const unitsP = [0.9, 0.9, 0.45, 0.9, 0.1, 0.1, 0.1, 0.1]; // P(C) per beat; beat 2 flickers
    const frameSec = 0.1;
    const probs = new Float32Array(unitsP.length * 5 * 2);
    unitsP.forEach((p, u) => {
      for (let k = 0; k < 5; k++) {
        probs[(u * 5 + k) * 2] = p;
        probs[(u * 5 + k) * 2 + 1] = 1 - p;
      }
    });
    const units: DecodeUnit[] = unitsP.map((_, u) => ({ startSec: u * 0.5, endSec: (u + 1) * 0.5, strength: u % 4 === 0 ? 0 : 2 }));
    const out = decodeUnits(probs, unitsP.length * 5, 2, frameSec, 0, units, symbols);
    expect(out.map((u) => u.symbol)).toEqual(['C', 'C', 'C', 'C', 'G', 'G', 'G', 'G']);
    expect(out[4].confidence).toBeCloseTo(0.9, 5);
  });
});

/** Deterministic fake models: beat logit = first mel bin - 1; chord logits pick class by mean feature sign. */
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

describe('listening session', () => {
  const sec = (s: number) => new Float32Array(Math.round(s * MODEL_SAMPLE_RATE)).fill(0.01);

  it('appends contiguous audio to one segment and opens a new one after a seek', () => {
    const s = new ListeningSession('youtube:x', 60);
    s.append(sec(1), 11); // plays 10..11
    s.append(sec(1), 12.1); // within tolerance → same segment
    expect(s.segments).toHaveLength(1);
    s.append(sec(1), 41); // seek to 40
    expect(s.segments).toHaveLength(2);
    expect(s.segments[1].startSec).toBeCloseTo(40, 6);
    s.breakSegment();
    s.append(sec(1), 42);
    expect(s.segments).toHaveLength(3);
    expect(s.coverage().map((r) => [Math.round(r.fromSec), Math.round(r.toSec)])).toEqual([
      [10, 12],
      [40, 42],
    ]);
    expect(s.coveredFraction()).toBeCloseTo(4 / 60, 1);
  });

  it('stops storing audio at the memory cap', () => {
    const s = new ListeningSession('k', 3600);
    s.append(sec(MAX_SESSION_SEC - 1), MAX_SESSION_SEC - 1);
    s.append(sec(2), MAX_SESSION_SEC + 1);
    expect(s.full).toBe(true);
  });

  it('cached beat chunks give the same logits as one batch run', async () => {
    const seg = new Segment(0);
    const frames = 3400;
    const mel = new Float32Array(frames * MEL.nMels).map((_, i) => ((i * 7919) % 97) / 40);
    seg.mel.push(mel);
    seg.melFrames = frames;
    const batch = await predictBeatLogits(fakeBeatRunner, mel, frames);
    // Pretend the regular chunks were computed while listening.
    const s = new ListeningSession('k');
    (s as unknown as { current: Segment }).current = seg;
    s.segments.push(seg);
    expect(await s.precomputeBeatChunks(fakeBeatRunner, 5)).toBe(2);
    const cached = await segmentBeatLogits(fakeBeatRunner, seg);
    expect(Array.from(cached.beat)).toEqual(Array.from(batch.beat));
    expect(Array.from(cached.downbeat)).toEqual(Array.from(batch.downbeat));
  });
});

function fakeSegment(startSec: number, endSec: number, symbolAt: (t: number) => string): SegmentAnalysis {
  const beats: number[] = [];
  for (let t = Math.ceil(startSec * 2) / 2; t < endSec; t += 0.5) beats.push(t);
  const downbeats = beats.filter((_, i) => i % 4 === 0);
  const bounds = [startSec, ...beats.filter((b) => b > startSec), endSec];
  const units = bounds.slice(0, -1).map((b, i) => ({ startSec: b, endSec: bounds[i + 1], strength: 2 as const, symbol: symbolAt(b), confidence: 0.8 }));
  return { startSec, endSec, beats, downbeats, units, timingsMs: { features: 0, beats: 0, chords: 0, decode: 0 } };
}

describe('auto chart', () => {
  const rec = { source: 'youtube' as const, id: 'abcdefghijk', title: 't', artist: 'a' };

  it('builds a valid auto chart whose coverage is only the heard ranges', () => {
    const a = fakeSegment(0, 20, (t) => (Math.floor(t / 2) % 2 ? 'G' : 'C'));
    const b = fakeSegment(40, 50, () => 'Am7');
    const chart = buildAutoChart({ recording: rec, segments: [a, b], tool: 'test', durationSec: 60 });
    const v = validateChart(chart);
    expect(v.errors).toEqual([]);
    expect(v.warnings).toEqual([]);
    expect(chart.coverage).toEqual([
      { fromSec: 0, toSec: 20 },
      { fromSec: 40, toSec: 50 },
    ]);
    expect(chart.events.every((e) => e.source === 'auto' && e.confidence === 0.8)).toBe(true);
    expect(chart.events.map((e) => e.chord).slice(0, 3)).toEqual(['C', 'G', 'C']);
    const ranges = normalizeCoverage(chart.coverage);
    expect(chart.events.every((e) => coverageRangeAt(ranges, e.startSec))).toBe(true);
    expect(chart.events.find((e) => e.startSec === 40)?.chord).toBe('Am7');
    expect(chart.provenance.createdBy).toBe('recognizer');
    expect(chart.timing.bpm).toBeCloseTo(120, 0);
  });

  it('lets the longer segment win where segments overlap (user seeked back)', () => {
    const long = fakeSegment(0, 30, () => 'C');
    const replay = fakeSegment(10, 15, () => 'F');
    const chart = buildAutoChart({ recording: rec, segments: [replay, long], tool: 'test' });
    expect(chart.events.map((e) => e.chord)).toEqual(['C']);
    expect(chart.coverage).toEqual([{ fromSec: 0, toSec: 30 }]);
  });

  it('fills beat gaps across coverage holes with evenly spaced beats', () => {
    expect(fillBeatGaps([0, 0.5, 2.5, 3], 0.5)).toEqual([0, 0.5, 1, 1.5, 2, 2.5, 3]);
  });
});
