import { describe, expect, it } from 'vitest';
import type { Chart } from '../src/chart/types';
import { evaluateSongs, parseSongList, SONG_LIST_SCHEMA, type SongList } from '../src/eval/annotations';
import { bootstrapMeanCi } from '../src/eval/song-mean';
import { aggregate, matchChanges, PAIRED_MAPS_SCHEMA, pairedEvaluate, parseGroups, parseMaps, type PairedIo, type PairedMaps } from '../src/eval/paired';

function autoChart(events: [number, string][], beats: number[], cover: [number, number][] = [[0, 200]]): Chart {
  return {
    schemaVersion: 1,
    recording: { source: 'youtube', id: 'abcdefghijk', title: 't', artist: 'a' },
    timing: { bpm: 120, beatsPerBar: 4, beatUnit: 4, firstDownbeatSec: beats[0] ?? 0, beatTimes: beats },
    events: events.map(([startSec, chord]) => ({ startSec, chord, confidence: 0.9, source: 'auto' })),
    coverage: cover.map(([fromSec, toSec]) => ({ fromSec, toSec })),
    provenance: { createdBy: 'recognizer', createdAt: '2026-11-14T00:00:00.000Z' },
  };
}

const grid = (a: number, b: number, p: number) => Array.from({ length: Math.floor((b - a) / p) + 1 }, (_, k) => a + k * p);

/** A 200 s song: 2 s per chord over C Am F G, beats every 0.5 s; the chart is 0.14 s late with beats 0.1 s late. */
function fixture(lateBy = 0.14, wrongEvery = 0) {
  const chords = ['C:maj', 'A:min', 'F:maj', 'G:maj'];
  const auto = ['C', 'Am', 'F', 'G'];
  let lab = '0 2 N\n';
  const events: [number, string][] = [[0, 'N']];
  for (let k = 0; k < 97; k++) {
    lab += `${2 + 2 * k} ${4 + 2 * k} ${chords[k % 4]}\n`;
    events.push([2 + 2 * k + lateBy, wrongEvery && k % wrongEvery === 0 ? 'E' : auto[k % 4]]);
  }
  lab += '196 200 N\n';
  const annBeats = grid(2, 196, 0.5);
  const beatsTxt = annBeats.map((b, k) => `${b.toFixed(3)}\t${(k % 4) + 1}`).join('\n');
  return { lab, beatsTxt, chart: autoChart(events, annBeats.map((b) => b + 0.1)) };
}

function list(): SongList {
  const base = { release: 'r', annotationDurationSec: 200, complexity: 'simple' as const, search: ['q'], uploadHint: 'h', artist: 'A', title: 'T' };
  return parseSongList({
    schema: SONG_LIST_SCHEMA,
    declaredAt: '2026-11-14',
    purpose: 'test',
    datasets: { iso: { name: 'Iso', page: 'p', downloads: [], folder: 'iso', licence: 'none', licenceQuote: 'q', attribution: 'a', btcTraining: 'likely' } },
    songs: [
      { ...base, id: 'a', role: 'eval', dataset: 'iso', chords: 'a.lab', beats: 'a.txt', btcTraining: 'likely' },
      { ...base, id: 'b', role: 'eval', dataset: 'iso', chords: 'b.lab', beats: null, btcTraining: 'not-known' },
      { ...base, id: 'c', role: 'eval', dataset: 'iso', chords: 'c.lab', beats: null, btcTraining: 'not-known' },
    ],
  });
}

const fx = fixture();
const files: Record<string, string> = { 'iso/a.lab': fx.lab, 'iso/a.txt': fx.beatsTxt, 'iso/b.lab': fx.lab, 'iso/c.lab': fx.lab };
const ids = { a: 'aaaaaaaaaaa', b: 'bbbbbbbbbbb', c: 'ccccccccccc' } as const;

function maps(offsets: Record<string, number> = { a: 0.14, b: 0.14, c: 0.14 }): PairedMaps {
  return parseMaps({
    schema: PAIRED_MAPS_SCHEMA,
    songs: (['a', 'b', 'c'] as const).map((id) => ({ id, dataset: 'iso', youtubeId: ids[id], offsetSec: offsets[id], rate: 1, mediaDurationSec: 200, btcTraining: id === 'a' ? 'likely' : 'not-known', groups: id === 'c' ? ['g'] : [] })),
  });
}

function io(baseline: Record<string, Chart>, candidate: Record<string, Chart>): PairedIo {
  return { readAnnotation: (f, r) => files[`${f}/${r}`] ?? null, readBaseline: (y) => baseline[y] ?? null, readCandidate: (y) => candidate[y] ?? null };
}

const charts = (c: Chart) => Object.fromEntries(Object.values(ids).map((y) => [y, c]));

describe('paired frozen-map scorer', () => {
  it('the same chart in both arms gives zero deltas', () => {
    const r = pairedEvaluate(maps(), [list()], io(charts(fx.chart), charts(fx.chart)), { subset: { field: 'btcTraining', value: 'not-known' } });
    expect(r.songs).toHaveLength(3);
    for (const s of r.songs) expect(s.delta).toEqual({ majmin: 0, root: 0, sevenths: 0 });
    expect(r.all.meanDelta.majmin).toBe(0);
    expect([r.all.majminDeltaCi.lower, r.all.majminDeltaCi.upper]).toEqual([0, 0]);
    expect(r.all.leaveOneOut).toMatchObject({ min: 0, max: 0 });
    expect(r.subset?.aggregate.songs).toBe(2);
    expect(r.groups.g).toEqual({ n: 1, meanDelta: { majmin: 0, root: 0, sevenths: 0 } });
    expect(r.songs[0].baseline.boundaries).toMatchObject({ predicted: 96, annotated: 96, matched: 96, f: 1 });
  });

  it('scores a worse candidate with a paired delta and boundary diagnostics', () => {
    const worse = fixture(0.14, 4).chart;
    const r = pairedEvaluate(maps(), [list()], io(charts(fx.chart), { ...charts(fx.chart), [ids.b]: worse }));
    const b = r.songs.find((s) => s.id === 'b')!;
    expect(b.delta.majmin).toBeLessThan(0);
    expect(r.all.largestLoss?.id).toBe('b');
    expect(r.all.leaveOneOut?.max).toBe(0); // leaving b out removes the only loss
    expect(b.candidate.boundaries.annotated).toBe(b.baseline.boundaries.annotated);
  });

  it('throws when evaluated seconds or coverage differ between the arms', () => {
    // Without coverage the evaluator falls back to the event span, so the evaluated seconds differ.
    const noCov = (end: number) => autoChart([[0, 'N'], [2, 'C'], [end, 'G']], [], []);
    expect(() => pairedEvaluate(maps(), [list()], io(charts(noCov(100)), charts(noCov(150))))).toThrow(/evaluated majmin seconds differ/);
    const shorter = autoChart(fx.chart.events.map((e) => [e.startSec, e.chord]), fx.chart.timing.beatTimes!, [[0, 150]]);
    expect(() => pairedEvaluate(maps(), [list()], io(charts(fx.chart), charts(shorter)))).toThrow(/coverage differ/);
  });

  it('accepts only map songs: groups with unknown ids and songs missing from the lists are errors', () => {
    expect(() => parseGroups({ g: ['a', 'zzz'] }, maps())).toThrow(/not in the maps file: zzz/);
    const m = maps();
    const extra = parseMaps({ ...m, songs: [...m.songs, { ...m.songs[0], id: 'nope' }] });
    expect(() => pairedEvaluate(extra, [list()], io(charts(fx.chart), charts(fx.chart)))).toThrow(/nope is in no song list/);
    expect(() => parseMaps({ ...m, songs: [m.songs[0], m.songs[0]] })).toThrow(/duplicate/);
  });

  it('the bootstrap interval is deterministic for a fixed seed', () => {
    const r = pairedEvaluate(maps(), [list()], io(charts(fx.chart), { [ids.a]: fixture(0.14, 3).chart, [ids.b]: fixture(0.14, 5).chart, [ids.c]: fx.chart }));
    const again = aggregate(r.songs);
    expect(again.majminDeltaCi).toEqual(r.all.majminDeltaCi);
    expect(again.majminDeltaCi).toMatchObject({ resamples: 10000, seed: 7007, prng: 'mulberry32' });
    expect(r.all.majminDeltaCi.lower).toBeLessThan(r.all.majminDeltaCi.upper);
    // The paired interval is the evaluator's bootstrap (song-mean.ts) over the per-song deltas.
    const ci = bootstrapMeanCi(r.songs.map((s) => s.delta.majmin), 10000, 7007);
    expect([r.all.majminDeltaCi.lower, r.all.majminDeltaCi.upper]).toEqual([ci.lower, ci.upper]);
  });

  it('equals evaluateSongs for a chart whose alignment equals the map', () => {
    const l = list();
    const uploads = { a: { youtubeId: ids.a, durationSec: 200 }, b: { youtubeId: ids.b, durationSec: 200 }, c: { youtubeId: ids.c, durationSec: 200 } };
    const charts3: Record<string, Chart> = { [ids.a]: fx.chart, [ids.b]: fixture(0.2, 6).chart, [ids.c]: fixture(0.1, 0).chart };
    const ev = evaluateSongs(l, uploads, { readAnnotation: (f, r) => files[`${f}/${r}`] ?? null, readChart: (y) => charts3[y] ?? null });
    const scored = ev.songs.filter((s) => s.status === 'scored');
    expect(scored.length).toBe(3);
    const frozen = parseMaps({
      schema: PAIRED_MAPS_SCHEMA,
      songs: scored.map((s) => ({ id: s.id, dataset: s.dataset, youtubeId: s.youtubeId, offsetSec: s.alignment!.offsetSec, rate: s.alignment!.rate, mediaDurationSec: s.mediaDurationSec, btcTraining: s.btcTraining, groups: [] })),
    });
    const r = pairedEvaluate(frozen, [l], io(charts3, charts3));
    for (const s of scored) {
      const p = r.songs.find((x) => x.id === s.id)!;
      const c = s.score!.comparison;
      expect([p.baseline.majmin, p.baseline.root, p.baseline.sevenths]).toEqual([c.majmin.score, c.root.score, c.sevenths.score]);
      expect(p.baseline.evaluatedSec.majmin).toBe(c.majmin.evaluatedSec);
    }
  });

  it('matches chord changes one-to-one within the window', () => {
    expect(matchChanges([1, 2, 3], [1.2, 1.3, 3.26])).toBe(1); // 1.2↔1; 1.3 has no partner left; 3.26 is outside ±250 ms
    expect(matchChanges([1, 1.1], [1.05])).toBe(1);
    expect(matchChanges([1, 2], [0.8, 1.9])).toBe(2);
  });
});
