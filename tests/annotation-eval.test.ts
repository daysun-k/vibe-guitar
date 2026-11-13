import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Chart } from '../src/chart/types';
import { renderAnnotationReport } from '../src/eval/annotation-report';
import {
  RATE_FIT_MAX,
  SONG_LIST_SCHEMA,
  alignAnnotation,
  annotationChart,
  chordChangeLandmarks,
  degreeSemitones,
  evaluateSongs,
  harteToSymbol,
  impliedDownbeats,
  parseBeats,
  parseLab,
  parseSongList,
  parseUploads,
  scoreSong,
  withoutBass,
  type AlignInput,
  type AnnotationSegment,
  type EvalIo,
  type SongList,
} from '../src/eval/annotations';
import { chordChangeOffset, reduceSymbol } from '../src/eval/metrics';

const sym = (label: string) => {
  const m = harteToSymbol(label);
  return m.kind === 'chord' ? m.symbol : m.kind;
};

describe('Harte label mapping', () => {
  it.each([
    ['C:maj', 'C'],
    ['C', 'C'],
    ['A:min', 'Am'],
    ['Db:maj', 'C#'],
    ['Cb:min', 'Bm'],
    ['E#:7', 'F7'],
    ['G:7', 'G7'],
    ['F:maj7', 'Fmaj7'],
    ['E:min7', 'Em7'],
    ['B:hdim7', 'Bm7b5'],
    ['C:dim7', 'Cdim7'],
    ['C:dim', 'Cdim'],
    ['C:aug', 'Caug'],
    ['C:minmaj7', 'Cm(maj7)'],
    ['C:maj6', 'C6'],
    ['C:min6', 'Cm6'],
    ['C:maj6(9)', 'C69'],
    ['C:9', 'C9'],
    ['C:min9', 'Cm9'],
    ['C:maj(9)', 'C(add9)'],
    ['C:sus4', 'Csus4'],
    ['C:sus2', 'Csus2'],
    ['C:sus4(b7)', 'C7sus4'],
    ['C:sus4(b7,9)', 'C9sus4'],
    ['C:7(#9)', 'C7(#9)'],
    ['C:7(b9,b13)', 'C7(b9,b13)'],
    ['Bb:maj6(7,#11)', 'A#maj13(#11)'],
    ['C:maj/3', 'C/E'],
    ['C/5', 'C/G'],
    ['C:min/b3', 'Cm/D#'],
    ['C:maj/bb6', 'C/G'],
    ['C:(b3,b7)/b7', 'Cm7/A#'],
    ['C:5', 'C5'],
    ['C:1/1', 'C5'],
    ['C:(1)', 'C5'],
    ['C:min(*b3)', 'C5'],
    ['C:(1,5,b7)', 'C5'],
    ['N', 'N'],
    ['X', 'X'],
  ])('%s → %s', (label, expected) => {
    expect(sym(label)).toBe(expected);
  });

  it('rejects labels that are not Harte syntax', () => {
    expect(harteToSymbol('H:maj').kind).toBe('unmapped');
    expect(harteToSymbol('C:weird').kind).toBe('unmapped');
    expect(harteToSymbol('C:maj(x)').kind).toBe('unmapped');
  });

  it('computes degree semitones', () => {
    expect(degreeSemitones('b3')).toBe(3);
    expect(degreeSemitones('#11')).toBe(18);
    expect(degreeSemitones('bb7')).toBe(9);
    expect(degreeSemitones('13')).toBe(21);
    expect(degreeSemitones('q')).toBeNull();
  });

  it('reduces mapped labels the way the comparison code expects (inversions and extensions)', () => {
    const r = (label: string, red: 'majmin' | 'root' | 'sevenths') => reduceSymbol(sym(label), red);
    // Enharmonic roots agree.
    expect(r('Db:min', 'majmin')).toBe(r('C#:min', 'majmin'));
    // Inversions count as root position.
    expect(r('C:maj/3', 'majmin')).toBe(r('C:maj', 'majmin'));
    expect(r('C:min7/b7', 'sevenths')).toBe(r('C:min7', 'sevenths'));
    // Extensions: majmin keeps the triad, sevenths keeps the seventh.
    expect(r('C:9', 'majmin')).toBe(r('C:maj', 'majmin'));
    expect(r('C:9', 'sevenths')).toBe(r('C:7', 'sevenths'));
    expect(r('Bb:maj6(7,#11)', 'sevenths')).toBe(r('Bb:maj7', 'sevenths'));
    // Outside a reduction → excluded (null).
    expect(r('C:sus4', 'majmin')).toBeNull();
    expect(r('C:maj6', 'sevenths')).toBeNull();
    expect(r('C:5', 'majmin')).toBeNull();
    expect(r('C:5', 'root')).not.toBeNull();
    expect(reduceSymbol('X', 'root')).toBeNull();
    expect(reduceSymbol('N', 'majmin')).toBe('N');
  });

  it('strips a slash bass', () => {
    expect(withoutBass('C/E')).toBe('C');
    expect(withoutBass('Cm7/A#')).toBe('Cm7');
    expect(withoutBass('N')).toBe('N');
  });
});

describe('annotation files', () => {
  it('parses lab files and skips segments that end before they start', () => {
    const segs = parseLab('0.0\t1.5\tN\n1.5 3.0 C:maj\n\n3.0\t2.0\tG:maj\n3.0 4.5 A:min\n');
    expect(segs.map((s) => s.label)).toEqual(['N', 'C:maj', 'A:min']);
    expect(() => parseLab('a b C')).toThrow();
  });

  it('parses beat files with metric positions', () => {
    expect(parseBeats('1.405  1\n1.892  2\nNew Point\n2.368\t3\n')).toEqual([
      { sec: 1.405, position: 1 },
      { sec: 1.892, position: 2 },
      { sec: 2.368, position: 3 },
    ]);
  });

  it('takes chord changes (not N, not repeats) as landmarks', () => {
    const segs: AnnotationSegment[] = [
      { startSec: 0, endSec: 1, label: 'N' },
      { startSec: 1, endSec: 2, label: 'C:maj' },
      { startSec: 2, endSec: 3, label: 'C:maj' },
      { startSec: 3, endSec: 4, label: 'G:maj' },
      { startSec: 4, endSec: 5, label: 'N' },
      { startSec: 5, endSec: 6, label: 'G:maj' },
    ];
    expect(chordChangeLandmarks(segs)).toEqual([1, 3, 5]);
  });
});

/** Beats every `period` s from `start` to `end`, with a deterministic ±jitter. */
function grid(start: number, end: number, period: number, jitter = 0): number[] {
  const out: number[] = [];
  for (let t = start, k = 0; t < end; t += period, k++) out.push(t + jitter * Math.sin(k * 1.7));
  return out;
}

function alignInput(est: number[], ann: number[], extra: Partial<AlignInput> = {}): AlignInput {
  return {
    method: 'beats',
    landmarks: ann,
    downbeatLandmarks: ann.filter((_, k) => k % 4 === 0),
    annotationDurationSec: 200,
    chordSpan: { fromSec: ann[0], toSec: ann[ann.length - 1] },
    estimateBeats: est,
    estimateFirstDownbeatSec: est[0],
    estimateBeatsPerBar: 4,
    mediaDurationSec: 200,
    ...extra,
  };
}

describe('alignment', () => {
  const est = grid(1, 190, 0.5, 0.01);

  it('finds a small offset from beats and checks start, middle and end', () => {
    const ann = est.map((b) => b - 0.13);
    const a = alignAnnotation(alignInput(est, ann));
    expect(a.excluded).toBeNull();
    expect(a.offsetSec).toBeCloseTo(0.13, 2);
    expect(a.strength).toBe('strong');
    expect(a.segments.map((s) => s.part)).toEqual(['start', 'middle', 'end']);
    expect(a.driftSec!).toBeLessThan(0.02);
    expect(a.matchedFraction).toBeGreaterThan(0.95);
  });

  const slow = grid(1, 190, 0.8, 0.01);

  it('uses bar phase when no candidate is near 0', () => {
    // 75 bpm, true offset 0.5 s; the other candidates are -0.3, 1.3, -1.1 …
    const ann = slow.map((b) => b - 0.5);
    const a = alignAnnotation(alignInput(slow, ann));
    expect(a.offsetSec).toBeCloseTo(0.5, 2);
    expect(a.ambiguous).toBe(false);
    expect(a.candidates.length).toBeGreaterThan(1);
    expect(a.warnings.join(' ')).toMatch(/bar phase/);
  });

  it('marks the offset ambiguous when no candidate is near 0 and bar phase is unavailable', () => {
    const ann = slow.map((b) => b - 0.5);
    const a = alignAnnotation(alignInput(slow, ann, { estimateFirstDownbeatSec: null }));
    expect(a.ambiguous).toBe(true);
    expect(a.offsetSec).toBeCloseTo(-0.3, 2);
    expect(a.warnings.join(' ')).toMatch(/nearest 0/);
  });

  it('keeps a candidate near 0 and only warns when bar phase disagrees', () => {
    // True offset 0.38 s at 120 bpm: -0.12 is within 0.2 s, so it is kept (same-master prior).
    const ann = est.map((b) => b - 0.38);
    const a = alignAnnotation(alignInput(est, ann));
    expect(a.offsetSec).toBeCloseTo(-0.12, 2);
    expect(a.ambiguous).toBe(false);
    expect(a.warnings.join(' ')).toMatch(/bar phase prefers offset 0\.38/);
  });

  it('fits a linear 0.1% speed difference instead of excluding it as drift (VGT-7)', () => {
    // Was 'excludes a song whose local offsets drift': a constant speed difference inside
    // RATE_FIT_MAX is now modelled as a rate, so the same input is kept. Non-linear section
    // offsets are still excluded (see the VGT-7 tests below).
    const ann = est.map((b) => (b - 0.05) * 1.001);
    const a = alignAnnotation(alignInput(est, ann));
    expect(a.excluded).toBeNull();
    expect(a.rate).toBeCloseTo(1 / 1.001, 4);
    expect(a.offsetSec).toBeCloseTo(0.05, 2);
    expect(a.driftSec!).toBeLessThan(0.03);
  });

  it('excludes a song whose upload length differs by more than 2 s', () => {
    const a = alignAnnotation(alignInput(est, est, { mediaDurationSec: 203 }));
    expect(a.excluded?.code).toBe('duration-mismatch');
    expect(a.durationDiffSec).toBeCloseTo(3);
  });

  it('excludes a song whose landmarks do not fall on estimated beats', () => {
    const ann = grid(1.25, 190, 0.731);
    const a = alignAnnotation(alignInput(est, ann, { estimateFirstDownbeatSec: null }));
    expect(a.excluded?.code).toBe('landmarks-disagree');
  });

  it('marks chord-boundary alignment as weak and reports the coarse check', () => {
    // True offset 0.15 s, clear of the nearZeroSec boundary (0.2 s): exactly at the boundary the
    // candidate 0.2 and its whole-bar alias -1.8 are now an ambiguous pair (VGT-7).
    const changes = grid(3, 180, 2).map((t) => t - 0.15);
    const a = alignAnnotation(alignInput(est, changes, { method: 'chord-boundaries', downbeatLandmarks: changes }));
    expect(a.strength).toBe('weak');
    expect(a.excluded).toBeNull();
    expect(a.offsetSec).toBeCloseTo(0.15, 2);
    expect(a.coarse.startOffsetSec).toBeCloseTo(est[0] - changes[0], 5);
  });

  it('needs estimate beats', () => {
    expect(alignAnnotation(alignInput([], est)).excluded?.code).toBe('no-estimate-beats');
  });

  it('excludes an upload 1% off speed as drift instead of re-snapping landmarks (connector review on PR #25)', () => {
    // Beats every 0.5 s; chord changes every 2 s on a recording 1% slower: about 2 s apart by the
    // end, with an upload length difference (2 s) that the duration check alone lets through.
    const beats = Array.from({ length: 398 }, (_, k) => 1 + 0.5 * k);
    const changes = Array.from({ length: 100 }, (_, k) => (1 + 2 * k) * 1.01);
    const a = alignAnnotation(alignInput(beats, changes, { method: 'chord-boundaries', downbeatLandmarks: changes, annotationDurationSec: 202, mediaDurationSec: 200, estimateFirstDownbeatSec: null }));
    expect(a.driftSec!).toBeGreaterThan(1);
    expect(a.excluded?.code).toBe('drift');
    expect(a.excluded?.reason).toContain('time scale');
  });

  it('keeps a clean song whose chord boundaries wobble for a few changes (review s14-r2 R2)', () => {
    const beats = Array.from({ length: 398 }, (_, k) => 1 + 0.5 * k);
    const jitter = [0.07, 0.14, 0.21, -0.21, -0.14, -0.07];
    const changes = Array.from({ length: 100 }, (_, k) => 1 + 2 * k + (k >= 40 && k <= 45 ? jitter[k - 40] : 0));
    const a = alignAnnotation(alignInput(beats, changes, { method: 'chord-boundaries', downbeatLandmarks: changes, estimateFirstDownbeatSec: null }));
    expect(a.excluded).toBeNull();
    expect(a.driftSec!).toBeLessThan(0.1);
  });

  it('does not fit a time scale to sparse noisy boundaries when the lengths agree (review s14-r3 R3)', () => {
    const beats = Array.from({ length: 398 }, (_, k) => 1 + 0.5 * k);
    const jitter = [-0.07, 0.15, 0.17, 0.01, -0.04, 0.16, 0.11, 0.1, 0.15, -0.1, 0.17, -0.18, -0.09, 0.04, 0.18, 0.14, -0.01, -0.12, 0.18, 0.2, 0.07, -0.05, -0.07, 0.17];
    const changes = jitter.map((j, k) => 1 + 8 * k + j);
    const a = alignAnnotation(alignInput(beats, changes, { method: 'chord-boundaries', downbeatLandmarks: changes, estimateFirstDownbeatSec: null }));
    expect(a.excluded).toBeNull();
    expect(a.driftSec!).toBeLessThan(0.1);
    expect(a.rate).toBe(1);
  });

  it('does not fit the length-ratio scale to sparse noisy boundaries (review s14-r4 R3)', () => {
    const beats = Array.from({ length: 398 }, (_, k) => 1 + 0.5 * k);
    const jitter = [0.19, 0.15, -0.18, -0.03, 0.08, 0.03, -0.14, -0.07, -0.19, -0.14, -0.07, 0.08, 0.14, 0.13, -0.06, -0.06, -0.12, 0.19, -0.14, 0.08, 0.16, -0.2, 0.03, -0.06];
    const changes = jitter.map((j, k) => 1 + 8 * k + j);
    const a = alignAnnotation(alignInput(beats, changes, { method: 'chord-boundaries', downbeatLandmarks: changes, annotationDurationSec: 200, mediaDurationSec: 201.5, estimateFirstDownbeatSec: null }));
    expect(a.excluded).toBeNull();
    expect(a.driftSec!).toBeLessThan(0.1);
    expect(a.rate).toBe(1);
  });

  it('keeps a same-speed upload whose length differs by a longer intro or outro', () => {
    const beats = Array.from({ length: 398 }, (_, k) => 1 + 0.5 * k);
    const changes = Array.from({ length: 100 }, (_, k) => 1 + 2 * k);
    const a = alignAnnotation(alignInput(beats, changes, { method: 'chord-boundaries', downbeatLandmarks: changes, annotationDurationSec: 200, mediaDurationSec: 201.5, estimateFirstDownbeatSec: null }));
    expect(a.excluded).toBeNull();
  });

  it('derives downbeats from the first downbeat and the bar length', () => {
    expect(impliedDownbeats([0, 1, 2, 3, 4, 5, 6, 7, 8], 2, 3)).toEqual([2, 5, 8]);
    expect(impliedDownbeats([0, 1, 2], 1.5, 3)).toBeNull();
  });
});

/** Deterministic PRNG (mulberry32) for the fixed-seed chance-match cases. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('alignment: bounded rate and offset choice (VGT-7)', () => {
  const est = grid(1, 190, 0.5, 0.01);
  const slow = grid(1, 190, 0.8, 0.01);

  it('recovers a linear speed difference in both directions, with the lead-in chosen by bar phase and a misleading length ratio', () => {
    for (const rate of [1.0008, 0.9992, 1.0018]) {
      // media = 0.5 + rate × annotation time; no candidate is near 0, so bar phase picks 0.5 s.
      // The upload is 1.5 s longer (a longer outro): the length ratio suggests 0.75%, which is wrong.
      const ann = slow.map((b) => (b - 0.5) / rate);
      const a = alignAnnotation(alignInput(slow, ann, { mediaDurationSec: 201.5 }));
      expect(a.excluded, `rate ${rate}`).toBeNull();
      expect(a.rate).toBeCloseTo(rate, 4);
      expect(a.offsetSec).toBeCloseTo(0.5, 2);
      expect(a.rateFit?.accepted).toBe(true);
      expect(a.driftSec!).toBeLessThan(0.03);
    }
  });

  it('does not keep speed differences beyond RATE_FIT_MAX when the lengths agree', () => {
    for (const rate of [1.005, 0.995, 1.01, 0.99]) {
      const ann = est.map((b) => (b - 0.05) / rate);
      const a = alignAnnotation(alignInput(est, ann));
      expect(a.excluded, `rate ${rate}`).not.toBeNull();
      expect(Math.abs(a.rate - 1)).toBeLessThanOrEqual(RATE_FIT_MAX + 1e-12);
    }
  });

  it('still excludes a non-linear section offset (middle third 150 ms late)', () => {
    const ann = est.map((b) => b - 0.05 - (b > 66 && b < 128 ? 0.15 : 0));
    const a = alignAnnotation(alignInput(est, ann));
    expect(['landmarks-disagree', 'drift']).toContain(a.excluded?.code);
    expect(a.rate).toBe(1);
  });

  it('keeps every beat phase as a candidate when drift and tempo wander make raw hit counts trend', () => {
    // Tempo wanders around 0.52 s per beat; the upload runs 0.07% fast and starts 0.14 s later.
    const ann: number[] = [];
    for (let t = 0.3; t < 280; t += 0.52 + 0.012 * Math.sin((2 * Math.PI * t) / 97)) ann.push(t);
    const media = ann.map((t, k) => 0.14 + 1.0007 * t + 0.008 * Math.sin(k * 1.3));
    const a = alignAnnotation(alignInput(media, ann, { annotationDurationSec: 285, mediaDurationSec: 285 }));
    expect(a.excluded).toBeNull();
    expect(a.offsetSec).toBeCloseTo(0.14, 1);
    expect(a.rate).toBeCloseTo(1.0007, 4);
  });

  it('fits no rate to chance matches (fixed seeds): doubled beats, clustered landmarks, missing beats, random landmarks', () => {
    let runs = 0;
    let fitted = 0;
    for (let seed = 1; seed <= 12; seed++) {
      const rand = rng(seed);
      const real = grid(1, 200, 0.64);
      const doubled = grid(1, 200, 0.32, 0.008);
      const bars = real.filter((_, k) => k % 4 === 0).map((t) => t - 0.1 + (rand() - 0.5) * 0.08);
      const clustered = bars.filter((t) => t < 85);
      const missing = doubled.filter(() => rand() > 0.15);
      const random = Array.from({ length: 80 }, () => 1 + rand() * 198).sort((x, y) => x - y);
      const cases: [number[], number[]][] = [
        [doubled, bars],
        [doubled, clustered],
        [missing, bars],
        [doubled, random],
      ];
      for (const [beats, lm] of cases) {
        const a = alignAnnotation(alignInput(beats, lm, { method: 'chord-boundaries', downbeatLandmarks: lm, estimateFirstDownbeatSec: null }));
        runs++;
        if (a.rate !== 1) fitted++;
      }
    }
    expect(runs).toBe(48);
    expect(fitted).toBe(0);
  });

  it('applies the near-0 rule only when the nearest other candidate is more than 2 × nearZeroSec away', () => {
    // Bars of 8 estimate beats; chord changes on every bar. True offset 0.53 s (below) / 0.57 s (above).
    const below = grid(1, 190, 0.38, 0.005);
    const changesBelow = grid(1, 185, 8 * 0.38).map((t) => t - 0.53);
    const a = alignAnnotation(alignInput(below, changesBelow, { method: 'chord-boundaries', downbeatLandmarks: changesBelow, estimateBeatsPerBar: 8 }));
    expect(a.excluded).toBeNull();
    expect(a.offsetSec).toBeCloseTo(0.53, 2);
    expect(a.warnings.join(' ')).toMatch(/bar phase decides/);

    const above = grid(1, 190, 0.42, 0.005);
    const changesAbove = grid(1, 185, 8 * 0.42).map((t) => t - 0.57);
    const b = alignAnnotation(alignInput(above, changesAbove, { method: 'chord-boundaries', downbeatLandmarks: changesAbove, estimateBeatsPerBar: 8 }));
    expect(b.offsetSec).toBeCloseTo(0.15, 2);
    expect(b.warnings.join(' ')).toMatch(/kept the one near 0/);
  });

  it('lets bar phase override a near-0 candidate on doubled estimate beats', () => {
    // Estimate beats every 0.32 s (double tempo) put a candidate within 0.2 s of 0 whatever the
    // offset (here 0.01 s). True offset 0.33 s; its whole-bar alias -2.23 s is outside the search.
    const fast = grid(1, 190, 0.32, 0.005);
    const changes = grid(1, 185, 2.56).map((t) => t - 0.33);
    const a = alignAnnotation(alignInput(fast, changes, { method: 'chord-boundaries', downbeatLandmarks: changes, estimateBeatsPerBar: 8 }));
    expect(a.excluded).toBeNull();
    expect(a.offsetSec).toBeCloseTo(0.33, 2);
    expect(a.candidates.some((c) => Math.abs(c.offsetSec) <= 0.2)).toBe(true);
  });

  it('excludes as ambiguous when candidates are close and bar phase is unavailable', () => {
    const fast = grid(1, 190, 0.32, 0.005);
    const changes = grid(1, 185, 2.56).map((t) => t - 0.53);
    const a = alignAnnotation(alignInput(fast, changes, { method: 'chord-boundaries', downbeatLandmarks: changes, estimateFirstDownbeatSec: null }));
    expect(a.ambiguous).toBe(true);
    expect(a.excluded?.code).toBe('ambiguous');
  });

  it('excludes as ambiguous when bar phase leaves whole-bar aliases and no candidate stands apart near 0', () => {
    // 120 bpm, bars of 2 s, true offset 0.75 s: 0.75 and -1.25 both put changes on implied downbeats.
    const changes = grid(3, 180, 2).map((t) => t - 0.75);
    const a = alignAnnotation(alignInput(est, changes, { method: 'chord-boundaries', downbeatLandmarks: changes }));
    expect(a.ambiguous).toBe(true);
    expect(a.excluded?.code).toBe('ambiguous');
    expect(a.candidates.length).toBeGreaterThan(1);
  });
});

const SEGS: AnnotationSegment[] = [
  { startSec: 0, endSec: 2, label: 'N' },
  { startSec: 2, endSec: 6, label: 'C:maj' },
  { startSec: 6, endSec: 10, label: 'A:min7/b7' },
  { startSec: 10, endSec: 14, label: 'F:sus4' },
  { startSec: 14, endSec: 18, label: 'G:7' },
  { startSec: 18, endSec: 20, label: 'X' },
  { startSec: 20, endSec: 24, label: 'C:maj' },
  { startSec: 24, endSec: 26, label: 'N' },
];

function autoChart(events: [number, string][], beats: number[], cover: [number, number] = [0, 26.5]): Chart {
  return {
    schemaVersion: 1,
    recording: { source: 'youtube', id: 'abcdefghijk', title: 't', artist: 'a' },
    timing: { bpm: 120, beatsPerBar: 4, firstDownbeatSec: beats[0] ?? 0, beatTimes: beats },
    events: events.map(([startSec, chord]) => ({ startSec, chord, confidence: 0.9, source: 'auto' })),
    coverage: [{ fromSec: cover[0], toSec: cover[1] }],
    provenance: { createdBy: 'recognizer', createdAt: '2026-11-13T00:00:00.000Z' },
  };
}

describe('scoring', () => {
  const off = 0.3;
  const auto = autoChart(
    [
      [0, 'N'],
      [2 + off + 0.05, 'C'],
      [6 + off + 0.05, 'Am7'],
      [10 + off + 0.05, 'F'],
      [14 + off + 0.05, 'G7'],
      [18 + off + 0.05, 'G7'],
      [20 + off + 0.05, 'C'],
      [24 + off + 0.05, 'N'],
    ],
    grid(0.3, 26, 0.5),
  );

  it('builds the reference chart in media time over the chord span', () => {
    const ref = annotationChart(SEGS, off, null, 30);
    expect(ref.coverage).toEqual([{ fromSec: 2.3, toSec: 24.3 }]);
    expect(ref.events.find((e) => e.startSec === 6.3)?.chord).toBe('Am7/G');
  });

  it('maps segments, coverage and beats through the rate, clips at 0 s, and defaults to rate 1 (VGT-7)', () => {
    const m = (t: number) => -2.5 + 1.001 * t;
    const ref = annotationChart(SEGS, -2.5, [1, 2, 3], 30, false, 1.001);
    // The first chord starts at 2 s: m(2) < 0, so coverage and that chord start at 0 s.
    expect(ref.coverage[0].fromSec).toBe(0);
    expect(ref.coverage[0].toSec).toBeCloseTo(m(24), 9);
    expect(ref.events[0]).toMatchObject({ startSec: 0, chord: 'C' });
    expect(ref.events.find((e) => e.chord === 'Am7/G')!.startSec).toBeCloseTo(m(6), 9);
    expect(ref.events.at(-1)!.startSec).toBeCloseTo(m(26), 9);
    expect(ref.timing.beatTimes).toEqual([1, 2, 3].map(m));
    expect(annotationChart(SEGS, off, [1, 2], 30)).toEqual(annotationChart(SEGS, off, [1, 2], 30, false, 1));
    expect(scoreSong(SEGS, null, auto, off, 30)).toEqual(scoreSong(SEGS, null, auto, off, 30, 1, 1));
    // Unknown (X) seconds are media seconds under the map.
    expect(scoreSong(SEGS, null, auto, off, 30, 1, 1.001).unknownSec).toBeCloseTo(2 * 1.001, 9);
  });

  it('scores with compareCharts and reports evaluated and excluded seconds', () => {
    const s = scoreSong(SEGS, null, auto, off, 30);
    expect(s.comparison.overlapSec).toBeCloseTo(22);
    // majmin: the sus4 (4 s) and X (2 s) are excluded; 0.05 s late at each of 4 evaluated changes.
    expect(s.excludedSec.majmin).toBeCloseTo(6);
    expect(s.comparison.majmin.evaluatedSec).toBeCloseTo(16);
    expect(s.comparison.majmin.score).toBeCloseTo((16 - 0.2) / 16, 5);
    // root: only X is excluded; Fsus4 → F root matches the F estimate.
    expect(s.excludedSec.root).toBeCloseTo(2);
    expect(s.unknownSec).toBeCloseTo(2);
    expect(s.notCoveredSec).toBeCloseTo(0);
  });

  it('lists every chord-change residual, consistent with chordChangeOffset', () => {
    const s = scoreSong(SEGS, null, auto, off, 30);
    const matched = s.changes.filter((c) => c.offsetMs !== null);
    expect(matched.every((c) => Math.abs(c.offsetMs! - 50) < 1e-6)).toBe(true);
    const repo = chordChangeOffset(annotationChart(SEGS, off, null, 30, true), auto, 1);
    expect(matched.map((c) => c.offsetMs)).toEqual(repo.offsetsMs);
    expect(s.changeMedianMs).toBeCloseTo(50);
  });

  it('counts annotated time the auto chart did not capture', () => {
    const partial = { ...auto, coverage: [{ fromSec: 0, toSec: 12.3 }] };
    const s = scoreSong(SEGS, null, partial, off, 30);
    expect(s.notCoveredSec).toBeCloseTo(12);
  });

  it('keeps the chord sounding at 0 s when a negative offset moves it earlier (review s14-r1 R1)', () => {
    // C 0-10 s, G 10-20 s, offset -0.1 s; the auto chart is wrong (F) until 9.9 s, then right.
    const segs = parseLab('0 10 C:maj\n10 20 G:maj\n');
    const wrongThenRight = autoChart([[0, 'F'], [9.9, 'G']], [], [0, 19.9]);
    const s = scoreSong(segs, null, wrongThenRight, -0.1, null);
    for (const k of ['majmin', 'root', 'sevenths'] as const) {
      expect(s.comparison[k].evaluatedSec).toBeCloseTo(19.9, 5);
      expect(s.comparison[k].score).toBeCloseTo(10 / 19.9, 5);
      expect(s.excludedSec[k]).toBeCloseTo(0, 5);
    }
  });
});

// ---------------------------------------------------------------- evaluateSongs and the report

function list(): SongList {
  const base = {
    release: 'r',
    annotationDurationSec: 200,
    complexity: 'simple' as const,
    search: ['q'],
    uploadHint: 'h',
  };
  return parseSongList({
    schema: SONG_LIST_SCHEMA,
    declaredAt: '2026-11-13',
    purpose: 'test',
    datasets: {
      iso: { name: 'Iso', page: 'p', downloads: [], folder: 'iso', licence: 'none', licenceQuote: 'q', attribution: 'a', btcTraining: 'likely' },
      bb: { name: 'BB', page: 'p', downloads: [], folder: 'bb', licence: 'CC0', licenceQuote: 'q', attribution: 'a', btcTraining: 'no' },
    },
    songs: [
      { ...base, id: 'pilot', role: 'pilot', artist: 'P', title: 'Pilot <b>', dataset: 'iso', chords: 'song.lab', beats: 'song.txt', btcTraining: 'likely' },
      { ...base, id: 'a', role: 'eval', artist: 'A', title: 'Song A', dataset: 'iso', chords: 'song.lab', beats: 'song.txt', btcTraining: 'likely' },
      { ...base, id: 'b', role: 'eval', artist: 'B', title: 'Song B', dataset: 'bb', chords: 'song.lab', beats: null, btcTraining: 'not-known' },
      { ...base, id: 'c', role: 'eval', artist: 'C', title: 'Song C', dataset: 'bb', chords: 'song.lab', beats: null, btcTraining: 'not-known' },
      { ...base, id: 'd', role: 'eval', artist: 'D', title: 'Song D', dataset: 'bb', chords: 'song.lab', beats: null, btcTraining: 'not-known' },
    ],
  });
}

/** A 200 s song: 2 s per chord over C Am F G, beats every 0.5 s from 2 s. */
function fixture() {
  const chords = ['C:maj', 'A:min', 'F:maj', 'G:maj'];
  const auto = ['C', 'Am', 'F', 'G'];
  let lab = '0 2 N\n';
  const events: [number, string][] = [[0, 'N']];
  for (let k = 0; k < 97; k++) {
    lab += `${2 + 2 * k} ${4 + 2 * k} ${chords[k % 4]}\n`;
    events.push([2 + 2 * k + 0.1 + 0.04, auto[k % 4]]);
  }
  lab += '196 200 N\n';
  const annBeats = grid(2, 196, 0.5);
  const beatsTxt = annBeats.map((b, k) => `${b.toFixed(3)}\t${(k % 4) + 1}`).join('\n');
  const chart = autoChart(events, annBeats.map((b) => b + 0.1), [0, 200]);
  return { lab, beatsTxt, chart };
}

function memoryIo(files: Record<string, string>, charts: Record<string, unknown>): EvalIo {
  return { readAnnotation: (f, r) => files[`${f}/${r}`] ?? null, readChart: (id) => charts[id] ?? null };
}

describe('evaluateSongs', () => {
  const { lab, beatsTxt, chart } = fixture();
  const io = memoryIo(
    { 'iso/song.lab': lab, 'iso/song.txt': beatsTxt, 'bb/song.lab': lab },
    { aaaaaaaaaaa: chart, bbbbbbbbbbb: chart, ccccccccccc: { chart }, ppppppppppp: chart },
  );
  const uploads = parseUploads({
    pilot: { youtubeId: 'ppppppppppp', durationSec: 200 },
    a: { youtubeId: 'aaaaaaaaaaa', durationSec: 200.5 },
    b: { youtubeId: 'bbbbbbbbbbb', durationSec: 200 },
    c: { youtubeId: 'ccccccccccc', durationSec: 207 },
  });
  const res = evaluateSongs(list(), uploads, io, { sha256: 'f'.repeat(64), now: new Date('2026-11-14T00:00:00Z') });
  const by = (id: string) => res.songs.find((s) => s.id === id)!;

  it('aligns from landmarks only: changing the predicted chord labels leaves every alignment identical (VGT-7)', () => {
    const relabel = (c: Chart): Chart => ({ ...c, events: c.events.map((e) => ({ ...e, chord: e.chord === 'N' ? 'N' : 'E' })) });
    const other = relabel(chart);
    const io2 = memoryIo(
      { 'iso/song.lab': lab, 'iso/song.txt': beatsTxt, 'bb/song.lab': lab },
      { aaaaaaaaaaa: other, bbbbbbbbbbb: other, ccccccccccc: { chart: other }, ppppppppppp: other },
    );
    const res2 = evaluateSongs(list(), uploads, io2, { sha256: 'f'.repeat(64), now: new Date('2026-11-14T00:00:00Z') });
    for (const s of res.songs) expect(res2.songs.find((x) => x.id === s.id)!.alignment).toEqual(s.alignment);
    expect(res2.songs.find((x) => x.id === 'a')!.score!.comparison.majmin.score).toBeLessThan(by('a').score!.comparison.majmin.score);
  });

  it('scores songs with frozen offsets, excludes and reports missing songs', () => {
    expect(by('a').status).toBe('scored');
    expect(by('a').alignment!.method).toBe('beats');
    expect(by('a').alignment!.offsetSec).toBeCloseTo(0.1, 2);
    expect(by('a').score!.comparison.majmin.score).toBeCloseTo((194 - 97 * 0.04) / 194, 3);
    expect(by('b').status).toBe('scored');
    expect(by('b').alignment!.strength).toBe('weak');
    expect(by('c').status).toBe('excluded');
    expect(by('c').alignment!.excluded!.code).toBe('duration-mismatch');
    expect(by('c').score).toBeUndefined();
    expect(by('d').status).toBe('missing');
  });

  it('keeps pilots out of the totals and splits training overlap from held-out songs', () => {
    expect(res.totals.all.songs).toBe(2);
    expect(res.totals.trainingOverlap.songs).toBe(1);
    expect(res.totals.heldOut.songs).toBe(1);
    expect(res.totals.all.changes.medianMs).toBeCloseTo(40, 0);
    expect(res.songList.sha256).toBe('f'.repeat(64));
  });

  it('reports a missing annotation and a non-auto chart as errors', () => {
    const r = evaluateSongs(list(), uploads, memoryIo({}, {}));
    expect(r.songs.every((s) => s.status === 'error')).toBe(true);
    const manual = { ...chart, provenance: { createdBy: 'manual', createdAt: 'x' } };
    const r2 = evaluateSongs(list(), uploads, memoryIo({ 'iso/song.lab': lab, 'iso/song.txt': beatsTxt }, { aaaaaaaaaaa: manual }));
    expect(r2.songs.find((s) => s.id === 'a')!.reason).toMatch(/not an auto chart/);
  });

  it('validates the song list and uploads', () => {
    expect(() => parseSongList({ schema: 'x' })).toThrow();
    expect(() => parseUploads({ a: { youtubeId: '../etc' } })).toThrow();
    expect(() => parseUploads({ a: { youtubeId: 'abcdefghijk', durationSec: -1 } })).toThrow();
    expect(parseUploads({ $comment: 'x', a: { youtubeId: 'abcdefghijk' } })).toEqual({ a: { youtubeId: 'abcdefghijk' } });
  });

  it('renders a self-contained Korean report without scripts', () => {
    const html = renderAnnotationReport(res);
    expect(html).toContain('<html lang="ko">');
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toContain('Pilot <b>');
    expect(html).toContain('Pilot &lt;b&gt;');
    expect(html).toContain('학습에 없는 곡');
    expect(html).toContain('채점하지 않은 곡');
    expect(html).toContain('<details>');
  });
});

describe('eval-annotations script', () => {
  it('writes JSON and HTML from folders', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'vgt-ann-'));
    try {
      const { lab, beatsTxt, chart } = fixture();
      mkdirSync(path.join(dir, 'ann', 'iso'), { recursive: true });
      mkdirSync(path.join(dir, 'ann', 'bb'), { recursive: true });
      mkdirSync(path.join(dir, 'charts'));
      writeFileSync(path.join(dir, 'ann', 'iso', 'song.lab'), lab);
      writeFileSync(path.join(dir, 'ann', 'iso', 'song.txt'), beatsTxt);
      writeFileSync(path.join(dir, 'ann', 'bb', 'song.lab'), lab);
      writeFileSync(path.join(dir, 'songs.json'), JSON.stringify(list()));
      writeFileSync(path.join(dir, 'charts', 'uploads.json'), JSON.stringify({ a: { youtubeId: 'aaaaaaaaaaa', durationSec: 200 } }));
      writeFileSync(path.join(dir, 'charts', 'aaaaaaaaaaa.json'), JSON.stringify(chart));
      const run = spawnSync(
        process.execPath,
        ['scripts/eval-annotations.mjs', '--annotations', path.join(dir, 'ann'), '--charts', path.join(dir, 'charts'), '--songs', path.join(dir, 'songs.json')],
        { encoding: 'utf8' },
      );
      expect(run.status, run.stderr).toBe(0);
      const out = JSON.parse(readFileSync(path.join(dir, 'charts', 'annotation-eval.json'), 'utf8'));
      expect(out.songs.find((s: { id: string }) => s.id === 'a').status).toBe('scored');
      expect(out.songList.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(readFileSync(path.join(dir, 'charts', 'annotation-eval.html'), 'utf8')).toContain('공개 정답 코드');
      const bad = spawnSync(process.execPath, ['scripts/eval-annotations.mjs', '--charts', dir], { encoding: 'utf8' });
      expect(bad.status).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ships a valid predeclared song list whose files are named consistently', () => {
    const l = parseSongList(JSON.parse(readFileSync('docs/annotation-eval-songs.json', 'utf8')));
    const evalSongs = l.songs.filter((s) => s.role === 'eval');
    expect(evalSongs).toHaveLength(20);
    expect(l.songs.filter((s) => s.role === 'pilot')).toHaveLength(2);
    expect(new Set(evalSongs.map((s) => s.artist)).size).toBeGreaterThanOrEqual(5);
    for (const s of l.songs) {
      expect(s.annotationDurationSec).toBeGreaterThan(100);
      expect(s.search.length).toBeGreaterThan(0);
      if (s.beats) expect(s.beats.replace(/^beat\//, '').replace(/\.txt$/, '')).toBe(s.chords.replace(/^chordlab\//, '').replace(/\.lab$/, ''));
    }
  });
});
