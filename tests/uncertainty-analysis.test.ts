/**
 * VGT-19 measurement (docs/uncertainty-protocol.md): error classes on hand-made reference/chart pairs,
 * θ_f with ties, the pair bootstrap, the criterion (including the dead end) and the TEST reading, and
 * the CLI path end to end on a synthetic capture with fake models.
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CQT } from '../src/audio/features';
import { validateChart } from '../src/chart';
import type { Chart } from '../src/chart/types';
import { SONG_LIST_SCHEMA } from '../src/eval/annotations';
import type { BtcModelMeta } from '../src/recognize/chords';
import { EXTENSION_RECOGNIZER_OPTIONS } from '../src/recognize/extension-options';
import type { ModelRunner } from '../src/recognize/runner';
import { replayCapture, type ReplayModels } from '../src/replay/replay';
import { readSegments, selectCaptures } from '../src/replay/store';
import {
  criterion,
  omittedSegments,
  pairBootstrap,
  share,
  songAnatomy,
  testReading,
  thresholdFor,
  type Piece,
  type SettingResult,
} from '../src/replay/uncertainty-analysis';
import { parseArgs, R1Failure, runUncertaintyAnalysis, shippedConfig } from '../src/replay/uncertainty-analysis-node';
import type { UncertaintySignal } from '../src/recognize/uncertainty';
import { testAudio, writeCaptureFolder } from './replay-helpers';

const chartOf = (events: [number, string][], coverage: [number, number][]): Chart => ({
  schemaVersion: 1,
  recording: { source: 'youtube', id: 'abcdefghijk', title: 't', artist: 'a' },
  timing: { bpm: 120, beatsPerBar: 4, beatUnit: 4, firstDownbeatSec: 0 },
  events: events.map(([startSec, chord]) => ({ startSec, chord, confidence: 1, source: 'auto' })),
  coverage: coverage.map(([fromSec, toSec]) => ({ fromSec, toSec })),
  provenance: { createdBy: 'recognizer', createdAt: 'x' },
});

/** Error seconds per class (pieces merged), and the pieces. */
function classes(ref: Chart, est: Chart): { by: Record<string, number>; pieces: Piece[] } {
  const a = songAnatomy(ref, est);
  const by: Record<string, number> = {};
  for (const p of a.pieces) if (p.cls) by[p.cls] = Math.round(((by[p.cls] ?? 0) + p.dur) * 1e9) / 1e9;
  return { by, pieces: a.pieces };
}

describe('error classes', () => {
  it('boundary: the chart changes late, the new label is shown inside R', () => {
    const r = classes(chartOf([[0, 'C'], [4, 'G']], [[0, 8]]), chartOf([[0, 'C'], [5, 'G']], [[0, 8]]));
    expect(r.by).toEqual({ boundary: 1 });
    expect(omittedSegments(r.pieces)).toEqual([]);
  });

  it('missed change: the chart holds the neighbour label over all of R; R is omitted', () => {
    const r = classes(chartOf([[0, 'C'], [4, 'G'], [6, 'C']], [[0, 10]]), chartOf([[0, 'C7']], [[0, 10]]));
    expect(r.by).toEqual({ missedChange: 2 });
    expect(omittedSegments(r.pieces)).toEqual([1]);
  });

  it('N and different chord', () => {
    const r = classes(chartOf([[0, 'C'], [4, 'N'], [6, 'D']], [[0, 8]]), chartOf([[0, 'Am'], [4, 'C'], [6, 'N']], [[0, 8]]));
    expect(r.by).toEqual({ differentChord: 4, N: 4 });
  });

  it('unevaluated reference labels are barriers, not neighbours', () => {
    const est = chartOf([[0, 'C'], [6, 'G']], [[0, 8]]);
    expect(classes(chartOf([[0, 'C'], [5, 'G']], [[0, 8]]), est).by).toEqual({ boundary: 1 });
    // With an unevaluated chord between, the C at 5-6 s is no hold-over; the 4-5 s stretch is not evaluated.
    const r = classes(chartOf([[0, 'C'], [4, 'Csus4'], [5, 'G']], [[0, 8]]), est);
    expect(r.by).toEqual({ differentChord: 1 });
    expect(r.pieces.reduce((a, p) => a + p.dur, 0)).toBeCloseTo(7, 9);
  });

  it('chart runs split at coverage gaps; overlaps need positive duration', () => {
    const ref = chartOf([[0, 'C'], [4, 'G']], [[0, 8]]);
    const gap = classes(ref, chartOf([[0, 'C'], [5, 'C'], [6, 'G']], [[0, 4.5], [5, 8]]));
    expect(gap.by).toEqual({ boundary: 0.5, differentChord: 1 });
    // A C run that only touches the C segment at 4 s does not overlap it.
    const touch = classes(ref, chartOf([[0, 'Am'], [4, 'C'], [5, 'G']], [[0, 8]]));
    expect(touch.by).toEqual({ differentChord: 5 });
  });
});

describe('θ_f', () => {
  const values = [
    { v: 0.1, t: 1 },
    { v: 0.2, t: 1 },
    { v: 0.2, t: 1 },
    { v: 0.3, t: 2 },
    { v: 0.05, t: 0 },
  ];
  it('flags the largest share at or below f with equal values together', () => {
    expect(thresholdFor(values, 10, 0.1)).toEqual({ threshold: 0.2, share: 0.1 });
    expect(thresholdFor(values, 10, 0.25)).toEqual({ threshold: 0.2, share: 0.1 });
    expect(thresholdFor(values, 10, 0.3)).toEqual({ threshold: 0.3, share: 0.3 });
    expect(thresholdFor(values, 10, 0.05)).toEqual({ threshold: 0.1, share: 0 });
    expect(thresholdFor(values, 10, 0.6)).toEqual({ threshold: Infinity, share: 0.5 });
  });
});

describe('pair bootstrap', () => {
  it('resamples (numerator, denominator) pairs, reproducibly', () => {
    const s = share([
      [1, 2],
      [3, 4],
    ]);
    expect(s.value).toBeCloseTo(4 / 6, 12);
    expect(s.songMean).toBeCloseTo(0.625, 12);
    expect(s.ci!.validDraws).toBe(10_000);
    expect(s.ci!.lower).toBeLessThanOrEqual(s.value!);
    expect(s.ci!.upper).toBeGreaterThanOrEqual(s.value!);
    expect(pairBootstrap([[1, 2], [3, 4]])).toEqual(s.ci);
  });

  it('drops zero-denominator draws and reports the valid count; no support is not assessable', () => {
    const ci = pairBootstrap([
      [1, 2],
      [0, 0],
    ])!;
    expect(ci.validDraws).toBeGreaterThan(6_000);
    expect(ci.validDraws).toBeLessThan(9_000);
    expect(ci.lower).toBe(0.5);
    const none = share([[0, 0]]);
    expect(none.value).toBeNull();
    expect(none.ci).toBeNull();
    expect(none.songMean).toBeNull();
  });
});

const sh = (value: number | null) => ({ value, num: 0, den: 0, songMean: value, songs: 1, ci: null });
function setting(signal: UncertaintySignal, f: number, x: { share: number; all: number | null; mc?: number | null; fix?: number; alt?: number; shown?: number }): SettingResult {
  const by = (v: number | null) => ({ all: sh(v), differentChord: sh(null), missedChange: sh(null), boundary: sh(null), N: sh(null) });
  const capture = by(x.all);
  capture.missedChange = sh(x.mc ?? null);
  const fixes = by(x.fix ?? 0.5);
  return {
    signal,
    f,
    threshold: f,
    flaggedShare: sh(x.share),
    capture,
    precision: sh(0.5),
    secondChoice: { altRight: sh(x.alt ?? 0.5), shownRight: sh(x.shown ?? 0.2), fixes },
    blindReplacement: sh(0),
    spread: { flaggedShareBySong: null, spansPerMin: null, spanDurationSec: null, chordChangesPerMin: null },
    omittedSegments: { segments: 0, withFlaggedTime: 0 },
  } as SettingResult;
}
const grid = (cap: Partial<Record<UncertaintySignal, Partial<Record<number, number>> & { mc?: number }>>, extra: Partial<Parameters<typeof setting>[2]> = {}) =>
  (['S1', 'S2', 'S3', 'S4', 'S5'] as UncertaintySignal[]).flatMap((s) => [0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.4].map((f) => setting(s, f, { share: f - 0.01, all: cap[s]?.[f] ?? 0.3, mc: cap[s]?.mc ?? 0.4, ...extra })));

describe('criterion', () => {
  it('dead end: no eligible signal raises A1 and stops', () => {
    const c = criterion(grid({}));
    expect(c.eligible).toEqual([]);
    expect(c.signal).toBeNull();
    expect(c.alarms).toEqual([expect.objectContaining({ id: 'A1', raised: true })]);
    expect(c.stop).toBe(true);
  });

  it('picks within 1.0 pp of the best by missed-change capture, then simplicity order; operating point is the smallest f reaching 50%', () => {
    const c = criterion(grid({ S2: { 0.2: 0.62, mc: 0.3 }, S4: { 0.1: 0.45, 0.15: 0.52, 0.2: 0.615, mc: 0.5 }, S5: { 0.2: 0.625, mc: 0.1 } }));
    expect(c.eligible).toEqual(['S2', 'S4', 'S5']);
    expect(c.nearBest).toEqual(['S2', 'S4', 'S5']);
    expect(c.signal).toBe('S4');
    expect(c.operatingPoint!.f).toBe(0.15);
    expect(c.operatingPoint!.capture).toBe(0.52);
    const far = criterion(grid({ S2: { 0.2: 0.62, mc: 0.3 }, S5: { 0.2: 0.7, mc: 0.1 } }));
    expect(far.nearBest).toEqual(['S5']);
    const tie = criterion(grid({ S2: { 0.2: 0.62, mc: 0.5 }, S4: { 0.2: 0.62, mc: 0.5 } }));
    expect(tie.signal).toBe('S2');
    expect(tie.operatingPoint!.f).toBe(0.2);
  });

  it('alarms A2-A4 at the operating point', () => {
    const ok = criterion(grid({ S3: { 0.1: 0.55, 0.2: 0.6, mc: 0.5 } }));
    expect(ok.alarms.map((a) => [a.id, a.raised])).toEqual([
      ['A1', false],
      ['A2', false],
      ['A3', false],
      ['A4', false],
    ]);
    expect(ok.stop).toBe(false);
    const bad = criterion(grid({ S3: { 0.1: 0.55, 0.2: 0.6, mc: 0.1 } }, { fix: 0.2, alt: 0.3, shown: 0.3 }));
    expect(bad.alarms.filter((a) => a.raised).map((a) => a.id)).toEqual(['A2', 'A3', 'A4']);
    expect(bad.stop).toBe(true);
  });

  it('TEST reading against DEV and T1', () => {
    const dev = { signal: 'S3' as const, threshold: 0.3, capture: 0.6, share: 0.15 };
    expect(testReading(setting('S3', 0, { share: 0.18, all: 0.55, mc: 0.4 }), dev).reading).toBe('similar');
    const t = testReading(setting('S3', 0, { share: 0.18, all: 0.45, mc: 0.4 }), dev);
    expect(t.reading).toBe('different');
    expect(t.alarms.find((a) => a.id === 'T1')!.raised).toBe(true);
    expect(testReading(setting('S3', 0, { share: 0.21, all: 0.55, mc: 0.4 }), dev).reading).toBe('different');
    expect(testReading(setting('S3', 0, { share: 0.18, all: 0.55 }), null).reading).toBe('not assessable');
  });
});

// ---------------------------------------------------------------- CLI path, synthetic capture

const B = CQT.nBins;
const ROOTS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const labels = [...ROOTS.flatMap((r) => [`${r}:min`, r, `${r}:7`, `${r}:min7`, `${r}:sus4`]), 'N', 'X'];
const chordMeta: BtcModelMeta = { file: 'fake', mean: -3, std: 2, timestep: 108, num_chords: labels.length, labels };
const models: ReplayModels = {
  beat: {
    async run(_n, _d, dims) {
      const T = dims[1];
      const beat = new Float32Array(T).fill(-5);
      const downbeat = new Float32Array(T).fill(-5);
      for (let t = 25; t < T; t += 25) {
        beat[t] = 5;
        if (t % 100 === 0) downbeat[t] = 5;
      }
      return { beat, downbeat };
    },
  } as ModelRunner,
  chords: {
    async run(_n, data, dims) {
      const T = dims[1];
      const C = labels.length;
      const logits = new Float32Array(T * C);
      for (let t = 0; t < T; t++) for (let c = 0; c < C; c++) logits[t * C + c] = 3 * Math.sin(data[t * B + ((c * 7) % B)] * 1.9 + c * 0.7 + t * 0.03);
      return { logits };
    },
  } as ModelRunner,
  chordMeta,
};
const LAB = ['0.0 3.0 C:maj', '3.0 5.5 A:min', '5.5 7.0 G:7', '7.0 8.0 N', '8.0 12.0 F:maj', '12.0 16.0 D:min7', '16.0 18.0 X', '18.0 22.0 E:maj'].join('\n');

/** A capture folder whose meta.json holds the live chart (the shipped path's replay) unless `live` is false. */
async function fixture(live = true) {
  const dir = mkdtempSync(path.join(tmpdir(), 'vg-uncertainty-'));
  const audio = path.join(dir, 'audio');
  const songs = [
    { id: 'song-a', yt: 'abcdefghijk', segs: [{ startSec: 0.5, samples: testAudio(9, 1) }, { startSec: 11.75, samples: testAudio(8, 2) }] },
    { id: 'song-b', yt: 'bbbbbbbbbbb', segs: [{ startSec: 0, samples: testAudio(12, 3) }] },
  ];
  for (const s of songs) {
    const capDir = writeCaptureFolder(audio, s.yt, s.segs, 30);
    if (!live) continue;
    const [cap] = selectCaptures(audio, [s.yt]).captures;
    const chart = (await replayCapture(cap.meta, readSegments(cap), models, { ...EXTENSION_RECOGNIZER_OPTIONS, pitchShift: [-1, 1] }, 'live')).chart;
    const metaPath = path.join(capDir, 'meta.json');
    writeFileSync(metaPath, JSON.stringify({ ...JSON.parse(readFileSync(metaPath, 'utf8')), chart }));
  }
  const ann = path.join(dir, 'ann');
  mkdirSync(path.join(ann, 'ds'), { recursive: true });
  writeFileSync(path.join(ann, 'ds', 'song.lab'), LAB);
  const songList = path.join(dir, 'songs.json');
  const entry = (id: string) => ({ id, role: 'eval', artist: 'a', title: id, release: 'r', dataset: 'ds', chords: 'song.lab', beats: null, annotationDurationSec: 22, btcTraining: 'not-known', complexity: 'simple', search: [], uploads: [] });
  writeFileSync(
    songList,
    JSON.stringify({
      schema: SONG_LIST_SCHEMA,
      declaredAt: 'x',
      purpose: 'test',
      datasets: { ds: { name: 'DS', page: 'p', downloads: [], folder: 'ds', licence: 'none', licenceQuote: 'q', attribution: 'a', btcTraining: 'not-known' } },
      songs: songs.map((s) => entry(s.id)),
    }),
  );
  const maps = path.join(dir, 'maps.json');
  writeFileSync(
    maps,
    JSON.stringify({
      schema: 'vibe-guitar-recognition-dev-maps/1',
      songs: songs.map((s) => ({ id: s.id, songList, dataset: 'ds', youtubeId: s.yt, offsetSec: 0.25, rate: 1, mediaDurationSec: 30, btcTraining: 'not-known', groups: [] })),
    }),
  );
  return { dir, audio, ann, maps };
}
const info = { runtime: 'fake', models: {} };
const toJson = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === 'number' && !Number.isFinite(x) ? null : x));

describe('uncertainty-analysis CLI path', () => {
  it('accepts only the shipped config', () => {
    expect(shippedConfig(undefined).recognizer).toEqual({ emission: 'meanLog', pitchShift: [-1, 1] });
    expect(shippedConfig({ label: 'x', recognizer: { emission: 'meanLog', pitchShift: [-1, 1] } }).label).toBe('x');
    expect(() => shippedConfig({ recognizer: {} })).toThrow(/only the shipped config/);
    expect(() => shippedConfig({ recognizer: { emission: 'meanLog', pitchShift: [1, -1] } })).toThrow(/only the shipped config/);
    expect(() => parseArgs(['--audio', 'a', '--maps', 'm', '--annotations', 'n', '--out', 'o', '--signal', 'S2'])).toThrow(/go together/);
    expect(() => parseArgs(['--audio', 'a', '--maps', 'm', '--annotations', 'n', '--out', 'o', '--charts-out', 'c'])).toThrow(/fixed mode/);
    expect(parseArgs(['--audio', 'a', '--maps', 'm', '--annotations', 'n', '--out', 'o', '--signal', 'S4', '--threshold', '0.123456789012345']).fixed).toEqual({ signal: 'S4', threshold: 0.123456789012345 });
  });

  it('stops before measuring when R1 fails', async () => {
    const f = await fixture(false);
    const args = parseArgs(['--audio', f.audio, '--maps', f.maps, '--annotations', f.ann, '--out', path.join(f.dir, 'out.json')]);
    await expect(runUncertaintyAnalysis(args, models, info)).rejects.toThrow(R1Failure);
  });

  it('sweeps DEV, then reproduces one setting in fixed mode with charts, the TEST reading and K-pop-ready charts', async () => {
    const f = await fixture();
    const sweep = await runUncertaintyAnalysis(parseArgs(['--audio', f.audio, '--maps', f.maps, '--annotations', f.ann, '--out', 'x']), models, info);
    expect(sweep.r1.every((r) => r.ok)).toBe(true);
    expect(sweep.settings).toHaveLength(35);
    for (const s of sweep.settings) expect(s.flaggedShare.value!).toBeLessThanOrEqual(s.f! + 1e-12);
    expect(Object.values(sweep.thresholds!).map((t) => t.length)).toEqual([7, 7, 7, 7, 7]);
    expect(sweep.settings.some((s) => s.flaggedShare.value! > 0 && s.capture.all.value !== null)).toBe(true);
    expect(sweep.songs.every((s) => s.errorSec.all > 0)).toBe(true);
    expect(sweep.criterion).not.toBeNull();
    expect(sweep.existingRule.signal).toBe('S1');
    expect(sweep.songs.map((s) => s.id)).toEqual(['song-a', 'song-b']);
    const devFile = path.join(f.dir, 'dev.json');
    writeFileSync(devFile, toJson({ ...sweep, criterion: { ...sweep.criterion, signal: 'S2', operatingPoint: { f: 0.2, threshold: 0.5, share: 0.2, capture: 0.5 } } }));

    const theta = sweep.thresholds!.S2.find((t) => t.f === 0.2)!;
    const chartsOut = path.join(f.dir, 'charts');
    const fixed = await runUncertaintyAnalysis(
      parseArgs(['--audio', f.audio, '--maps', f.maps, '--annotations', f.ann, '--out', 'x', '--signal', 'S2', '--threshold', String(theta.threshold), '--dev-result', devFile, '--charts-out', chartsOut]),
      models,
      info,
    );
    const same = sweep.settings.find((s) => s.signal === 'S2' && s.f === 0.2)!;
    expect(fixed.settings[0].flaggedShare.value).toBeCloseTo(same.flaggedShare.value!, 12);
    expect(fixed.settings[0].flaggedShare.value).toBeCloseTo(theta.share, 9);
    expect(fixed.settings[0].capture.all.value).toEqual(same.capture.all.value);
    expect(fixed.test!.dev).toEqual({ signal: 'S2', threshold: 0.5, capture: 0.5, share: 0.2 });
    expect(['similar', 'different', 'not assessable']).toContain(fixed.test!.reading);
    const files = readdirSync(chartsOut).sort();
    expect(files).toEqual(['abcdefghijk.json', 'bbbbbbbbbbb.json']);
    for (const file of files) {
      const chart = JSON.parse(readFileSync(path.join(chartsOut, file), 'utf8')) as Chart;
      expect(validateChart(chart).ok).toBe(true);
      expect(Array.isArray(chart.uncertain)).toBe(true);
    }
  }, 60_000);
});
