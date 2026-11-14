import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Chart } from '../src/chart/types';
import { parseLab, parseSongList, SONG_LIST_SCHEMA, type SongList } from '../src/eval/annotations';
import { PAIRED_MAPS_SCHEMA, parseGroups, parseMaps, songListsToLoad, type PairedMaps } from '../src/eval/paired';
import * as seq from '../src/eval/sequence';
import { alignSequences, anatomy, chartTokens, classifySubstitution, referenceTokens, scoreTokens, sequenceEvaluate, sequenceGap, viewToken, WILDCARD, type SequenceIo } from '../src/eval/sequence';
import { bootstrapMeanCi } from '../src/eval/song-mean';
// @ts-expect-error plain .mjs without types
import { parseArgs, run } from '../scripts/sequence-eval.mjs';

const W = WILDCARD;

function chart(events: [number, string][], cover: [number, number][] = [[0, 1000]]): Chart {
  return {
    schemaVersion: 1,
    recording: { source: 'youtube', id: 'abcdefghijk', title: 't', artist: 'a' },
    timing: { bpm: 120, beatsPerBar: 4, beatUnit: 4, firstDownbeatSec: 0 },
    events: events.map(([startSec, chord]) => ({ startSec, chord, confidence: 0.9, source: 'auto' })),
    coverage: cover.map(([fromSec, toSec]) => ({ fromSec, toSec })),
    provenance: { createdBy: 'recognizer', createdAt: '2026-11-14T00:00:00.000Z' },
  };
}

/** LAB text with dummy one-second segments, as the K-pop references are written. */
const lab = (labels: string[]) => labels.map((l, i) => `${i} ${i + 1} ${l}`).join('\n');
/** Chart with one chord per second. */
const seqChart = (symbols: string[], cover: [number, number][] = [[0, 1000]]) => chart(symbols.map((s, i) => [i, s] as [number, string]), cover);
const mm = (labels: string[]) => referenceTokens(parseLab(lab(labels)), 'majmin');
const est = (symbols: string[]) => chartTokens(seqChart(symbols), 'majmin');

describe('sequence tokens', () => {
  it('reference: N dropped, X and unmapped become wildcards, consecutive equal tokens (wildcards too) collapse', () => {
    expect(mm(['N', 'C:maj', 'C:maj', 'N', 'C:maj/3', 'A:min', 'X', 'X', 'G:maj', 'N'])).toEqual(['0:maj', '9:min', W, '7:maj']);
    expect(mm(['C:maj', 'C:bogus', 'D:min'])).toEqual(['0:maj', W, '2:min']);
  });

  it('a chord outside majmin keeps its own symbol (the boundary metric reduction)', () => {
    expect(mm(['C:maj', 'B:dim', 'C:maj7'])).toEqual(['0:maj', 'other:Bdim', '0:maj']);
    expect(viewToken('Bdim', 'majmin')).toBe('other:Bdim');
  });

  it('chart: only events inside coverage, N dropped, duplicates collapsed', () => {
    const c = chart([[0, 'G'], [5, 'C'], [6, 'N'], [7, 'C'], [8, 'Am'], [20, 'F']], [[4, 10]]);
    expect(chartTokens(c, 'majmin')).toEqual(['0:maj', '9:min']);
  });

  it('root and sevenths views', () => {
    const ref = parseLab(lab(['C:maj7', 'C:7', 'A:min7', 'A:min', 'D:hdim7', 'X']));
    expect(referenceTokens(ref, 'majmin')).toEqual(['0:maj', '9:min', 'other:Dm7b5', W]);
    expect(referenceTokens(ref, 'root')).toEqual(['0', '9', '2', W]);
    expect(referenceTokens(ref, 'sevenths')).toEqual(['0:maj7', '0:7', '9:min7', '9:min', 'other:Dm7b5', W]);
    const c = seqChart(['Cmaj7', 'C7', 'Am7', 'Am', 'Dm7b5']);
    expect(chartTokens(c, 'root')).toEqual(['0', '9', '2']);
    expect(chartTokens(c, 'sevenths')).toEqual(['0:maj7', '0:7', '9:min7', '9:min', 'other:Dm7b5']);
  });
});

describe('sequence alignment and counts', () => {
  it('identical sequences score 1', () => {
    const r = ['C:maj', 'G:maj', 'A:min', 'F:maj'];
    const { score } = scoreTokens(mm(r), est(['C', 'G', 'Am', 'F']));
    expect(score).toMatchObject({ matches: 4, substitutions: 0, deletions: 0, insertions: 0, editDistance: 0, recall: 1, precision: 1, f: 1 });
  });

  it('one substitution', () => {
    const { score } = scoreTokens(mm(['C:maj', 'G:maj', 'A:min', 'F:maj']), est(['C', 'G', 'Em', 'F']));
    expect(score).toMatchObject({ matches: 3, substitutions: 1, deletions: 0, insertions: 0, editDistance: 1, recall: 0.75, precision: 0.75, f: 0.75 });
  });

  it('an insertion and a deletion', () => {
    const { score, ops } = scoreTokens(mm(['C:maj', 'G:maj', 'A:min', 'F:maj']), est(['C', 'Am', 'F', 'Dm']));
    expect(score).toMatchObject({ matches: 3, substitutions: 0, deletions: 1, insertions: 1, editDistance: 2, refTokens: 4, chartCounted: 4, recall: 0.75, precision: 0.75 });
    expect(ops.map((o) => o.op)).toEqual(['match', 'del', 'match', 'match', 'ins']);
  });

  it('F is 2·matches/(reference + chart tokens): unequal lengths', () => {
    const { score } = scoreTokens(mm(['C:maj', 'G:maj']), est(['C', 'G', 'Am', 'F']));
    expect(score).toMatchObject({ matches: 2, insertions: 2, recall: 1, precision: 0.5 });
    expect(score.f).toBeCloseTo((2 * 1 * 0.5) / 1.5, 12);
  });

  it('a wildcard absorbs any chart tokens and is excluded from both denominators', () => {
    const ref = mm(['C:maj', 'X', 'F:maj']);
    const { score, ops } = scoreTokens(ref, est(['C', 'D', 'E', 'F']));
    expect(score).toMatchObject({ refTokens: 2, refWildcards: 1, chartTokens: 4, chartCounted: 2, absorbed: 2, matches: 2, editDistance: 0, recall: 1, precision: 1, f: 1 });
    expect(ops.filter((o) => o.op === 'wild')).toHaveLength(2);
    const empty = scoreTokens(ref, est(['C', 'F']));
    expect(empty.score).toMatchObject({ absorbed: 0, chartCounted: 2, recall: 1, precision: 1 });
    expect(empty.ops).toContainEqual({ op: 'wild', ref: 1, est: null });
    // A wildcard does not hide a wrong chord next to it: Dm is still a substitution of C.
    expect(scoreTokens(ref, est(['Dm', 'E', 'F'])).score).toMatchObject({ matches: 1, recall: 0.5 });
  });

  it('the tie-break is fixed: diagonal before deletion before insertion on the backward trace', () => {
    // [C G Am F] vs [C E G F]: two substitutions and one deletion + one insertion both cost 2.
    const a = alignSequences(mm(['C:maj', 'G:maj', 'A:min', 'F:maj']), est(['C', 'E', 'G', 'F']));
    expect(a.cost).toBe(2);
    expect(a.ops.map((o) => o.op)).toEqual(['match', 'sub', 'sub', 'match']);
    expect(alignSequences(['a', 'b'], ['b', 'a']).ops.map((o) => o.op)).toEqual(['sub', 'sub']);
    expect(alignSequences([], ['x']).ops).toEqual([{ op: 'ins', ref: null, est: 0 }]);
    expect(alignSequences(['x'], []).ops).toEqual([{ op: 'del', ref: 0, est: null }]);
    // [C G * F] vs [C Em F]: G→Em substitution and G deleted + Em absorbed both cost 1; the wildcard
    // closes first, so Em is counted (precision 2/3), not hidden.
    const w = scoreTokens(mm(['C:maj', 'G:maj', 'X', 'F:maj']), est(['C', 'Em', 'F']));
    expect(w.ops.map((o) => o.op)).toEqual(['match', 'sub', 'wild', 'match']);
    expect(w.score).toMatchObject({ editDistance: 1, absorbed: 0, chartCounted: 3, matches: 2 });
  });

  it('the map window cuts the reference to the chart coverage', () => {
    const segs = parseLab('0 10 C:maj\n10 20 G:maj\n20 30 A:min\n30 40 F:maj\n');
    // media = 5 + t: C 5-15, G 15-25, Am 25-35, F 35-45; chart covers 17-30.
    expect(referenceTokens(segs, 'majmin', { offsetSec: 5, rate: 1, mediaDurationSec: null, coverage: [{ fromSec: 17, toSec: 30 }] })).toEqual(['7:maj', '9:min']);
    // rate 2: C 0-20, G 20-40, Am 40-60, F 60-80; media ends at 60, so F is cut although coverage runs on.
    expect(referenceTokens(segs, 'majmin', { offsetSec: 0, rate: 2, mediaDurationSec: 60, coverage: [{ fromSec: 30, toSec: 100 }] })).toEqual(['7:maj', '9:min']);
    // Two coverage ranges keep both parts; a segment only touching a range edge is not kept.
    expect(referenceTokens(segs, 'majmin', { offsetSec: 0, rate: 1, mediaDurationSec: null, coverage: [{ fromSec: 0, toSec: 10 }, { fromSec: 30, toSec: 35 }] })).toEqual(['0:maj', '5:maj']);
  });
});

describe('error anatomy', () => {
  it('classes substitutions by root relation', () => {
    expect(classifySubstitution('0:maj', '7:maj')).toBe('fifth');
    expect(classifySubstitution('0:maj', '5:min')).toBe('fifth');
    expect(classifySubstitution('0:maj', '0:min')).toBe('parallel');
    expect(classifySubstitution('0:maj', '9:min')).toBe('relative');
    expect(classifySubstitution('9:min', '0:maj')).toBe('relative');
    expect(classifySubstitution('0:min', '3:min')).toBe('other');
    expect(classifySubstitution('0:maj', '1:maj')).toBe('semitone');
    expect(classifySubstitution('0:maj', 'other:Bdim')).toBe('semitone');
    expect(classifySubstitution('0:maj', 'other:Cdim')).toBe('other');
    expect(classifySubstitution('0:maj', '2:maj')).toBe('other');
  });

  it('counts and shares over one alignment', () => {
    const ref = mm(['C:maj', 'D:min', 'G:maj', 'A:min', 'C:maj', 'F:maj', 'G:maj', 'E:maj', 'A:maj', 'D:maj', 'C:maj']);
    const e = est(['C', 'C', 'G', 'Am', 'B', 'C', 'Fm', 'G', 'Eb', 'A', 'G', 'C']);
    const { score, ops } = scoreTokens(ref, e);
    const a = anatomy(ref, e, ops, score);
    // Chart collapses to C G Am B C Fm G Eb A G C (unique optimum, cost 5): Dm deleted, B inserted,
    // F→Fm parallel, E→Eb semitone, D→G fifth.
    expect(score.editDistance).toBe(5);
    expect(a.counts).toEqual({ fifth: 1, parallel: 1, relative: 0, semitone: 1, other: 0, deletion: 1, insertion: 1 });
    expect(a.shares.parallel).toBeCloseTo(1 / 11, 12);
    expect(a.shares.deletion).toBeCloseTo(1 / 11, 12);
    expect(a.shares.insertion).toBeCloseTo(1 / 11, 12);
    const rel = scoreTokens(mm(['C:maj', 'G:maj']), est(['Am', 'G']));
    expect(anatomy(mm(['C:maj', 'G:maj']), est(['Am', 'G']), rel.ops, rel.score).counts.relative).toBe(1);
    expect(score.matches + score.substitutions + score.deletions).toBe(score.refTokens);
    expect(score.matches + score.substitutions + score.insertions).toBe(score.chartCounted);
  });
});

// ---------------------------------------------------------------- Evaluate, gap, CLI

const ids = { a: 'aaaaaaaaaaa', b: 'bbbbbbbbbbb', c: 'ccccccccccc', d: 'ddddddddddd' } as const;
type Id = keyof typeof ids;

function list(): SongList {
  const base = { release: 'r', annotationDurationSec: 10, complexity: 'simple' as const, search: ['q'], uploadHint: 'h', artist: 'A', title: 'T', role: 'eval', dataset: 'k', beats: null, btcTraining: 'not-known' };
  return parseSongList({
    schema: SONG_LIST_SCHEMA,
    declaredAt: '2026-11-14',
    purpose: 'test',
    datasets: { k: { name: 'K', page: 'p', downloads: [], folder: 'k', licence: 'none', licenceQuote: 'q', attribution: 'a', btcTraining: 'not-known' } },
    songs: (Object.keys(ids) as Id[]).map((id) => ({ ...base, id, chords: `${id}.lab` })),
  });
}

function maps(): PairedMaps {
  return parseMaps({
    schema: PAIRED_MAPS_SCHEMA,
    songs: (Object.keys(ids) as Id[]).map((id) => ({ id, dataset: 'k', youtubeId: ids[id], offsetSec: 0, rate: 1, mediaDurationSec: null, btcTraining: 'not-known', groups: [id === 'a' || id === 'b' ? 'artist:x' : 'artist:y'] })),
  });
}

const refLabels = ['C:maj', 'G:maj', 'A:min', 'F:maj'];
const refFiles: Record<string, string> = Object.fromEntries((Object.keys(ids) as Id[]).map((id) => [`k/${id}.lab`, lab(refLabels)]));
const ref7Files: Record<string, string> = Object.fromEntries((Object.keys(ids) as Id[]).map((id) => [`k/${id}.lab`, lab(['C:maj7', 'G:7', 'A:min7', 'X'])]));
const songCharts: Record<string, Chart> = {
  [ids.a]: seqChart(['C', 'G', 'Am', 'F']),
  [ids.b]: seqChart(['C', 'G', 'Em', 'F']),
  [ids.c]: seqChart(['C', 'Am', 'F', 'Dm']),
  [ids.d]: seqChart(['Cmaj7', 'G7', 'Am7', 'F'], [[0, 2.5]]),
};

const io = (ref7 = ref7Files): SequenceIo => ({ readAnnotation: (f, r) => refFiles[`${f}/${r}`] ?? null, readAnnotationSevenths: (f, r) => ref7[`${f}/${r}`] ?? null, readChart: (y) => songCharts[y] ?? null });
const named = () => [{ file: 'list.json', list: list() }];
const now = new Date('2026-11-14T00:00:00Z');

describe('sequenceEvaluate', () => {
  const r = sequenceEvaluate(maps(), named(), io(), { now, groups: { pair: ['a', 'c'] } });

  it('scores every song, cuts the reference to coverage by default, and records the window', () => {
    expect(r.referenceWindow).toBe('chart-coverage');
    expect(r.songs.map((s) => s.views.majmin.f)).toEqual([1, 0.75, 0.75, 1]);
    // d covers 0-2.5 s: reference C G Am (F at 3-4 s is outside), chart C G Am.
    expect(r.songs[3].views.majmin).toMatchObject({ refTokens: 3, chartTokens: 3, matches: 3 });
    expect(r.songs[3].views.sevenths).toMatchObject({ refTokens: 3, matches: 3 });
    // Sevenths reference from the second root: X is a wildcard; a's chart has plain triads.
    expect(r.songs[0].views.sevenths).toMatchObject({ refTokens: 3, refWildcards: 1, matches: 0 });
    expect(r.songs[0].wildcardShare).toBe(0);
    const whole = sequenceEvaluate(maps(), named(), io(), { now, wholeChart: true });
    expect(whole.referenceWindow).toBe('none');
    expect(whole.inputs.wholeChart).toBe(true);
    expect(whole.songs[3].views.majmin).toMatchObject({ refTokens: 4, matches: 3, deletions: 1 });
  });

  it('song means, seeded bootstrap, groups and leave-one-group-out', () => {
    const fs = r.songs.map((s) => s.views.majmin.f);
    expect(r.all.means.majmin.f).toBeCloseTo(0.875, 12);
    expect(r.all.ci.majmin.f).toEqual(bootstrapMeanCi(fs, 10_000, 7007));
    expect(r.all.bootstrap).toMatchObject({ resamples: 10_000, seed: 7007, prng: 'mulberry32', level: 0.95 });
    expect(Object.keys(r.groups)).toEqual(['artist:x', 'artist:y', 'pair']);
    expect(r.groups['artist:x']).toMatchObject({ n: 2, ids: ['a', 'b'] });
    expect(r.groups['artist:x'].means.majmin.f).toBeCloseTo(0.875, 12);
    expect(r.leaveOneGroupOut['artist:x'].means.majmin.f).toBeCloseTo(0.875, 12);
    expect(r.leaveOneGroupOut.pair.means.majmin.f).toBeCloseTo(0.875, 12);
    expect(r.all.anatomyShareMeans.deletion).toBeCloseTo(0.25 / 4, 12);
  });

  it('is deterministic', () => {
    expect(sequenceEvaluate(maps(), named(), io(), { now, groups: { pair: ['a', 'c'] } })).toEqual(r);
  });

  it('fails closed on a missing chart, a non-recognizer chart or a reference with no tokens', () => {
    const missing: SequenceIo = { ...io(), readChart: (y) => (y === ids.b ? null : songCharts[y]) };
    expect(() => sequenceEvaluate(maps(), named(), missing)).toThrow(/b bbbbbbbbbbb\.json: no chart/);
    const manual: SequenceIo = { ...io(), readChart: (y) => ({ ...songCharts[y], provenance: { createdBy: 'manual', createdAt: 'x' } }) };
    expect(() => sequenceEvaluate(maps(), named(), manual)).toThrow(/not an auto chart/);
    const nRef: SequenceIo = { ...io(), readAnnotation: () => lab(['N', 'X']) };
    expect(() => sequenceEvaluate(maps(), named(), nRef)).toThrow(/no majmin reference tokens/);
  });

  it('gap: A minus B with an independent seeded bootstrap and each group left out', () => {
    const g0 = sequenceGap(r, r, { now });
    expect(g0.gap).toBe(0);
    expect(g0.ci).toMatchObject({ seedA: 7007, seedB: 7008, resamples: 10_000 });
    // B with every song at the same F: the B side is constant, so the interval is A's own bootstrap shifted.
    const flat = { ...r, songs: r.songs.map((s) => ({ ...s, views: { ...s.views, majmin: { ...s.views.majmin, f: 0.5 } } })) };
    const g = sequenceGap(r, flat, { now });
    const own = bootstrapMeanCi(r.songs.map((s) => s.views.majmin.f), 10_000, 7007);
    expect(g.gap).toBeCloseTo(0.375, 12);
    expect(g.ci.lower).toBeCloseTo(own.lower - 0.5, 12);
    expect(g.ci.upper).toBeCloseTo(own.upper - 0.5, 12);
    expect(g.leaveOneGroupOut.a['artist:y'].gap).toBeCloseTo(0.375, 12);
    expect(g.leaveOneGroupOut.b['artist:x']).toEqual({ n: 2, gap: 0.375 });
    expect(sequenceGap(r, flat, { now })).toEqual(g);
  });
});

describe('sequence-eval CLI', () => {
  it('parses the evaluate and gap forms', () => {
    expect(parseArgs(['--maps', 'm.json', '--annotations', 'ann', '--charts', 'c', '--songs', 'l1.json', '--songs', 'l2.json', '--out', 'o.json', '--whole-chart', '--annotations-sevenths', 'a7', '--groups', 'g.json'])).toEqual({
      songs: ['l1.json', 'l2.json'],
      wholeChart: true,
      maps: 'm.json',
      annotations: 'ann',
      annotationsSevenths: 'a7',
      charts: 'c',
      groups: 'g.json',
      out: 'o.json',
    });
    expect(parseArgs(['--gap', 'a.json', 'b.json', '--out', 'g.json'])).toEqual({ songs: [], wholeChart: false, gap: ['a.json', 'b.json'], out: 'g.json' });
    expect(parseArgs(['--help'])).toEqual({ help: true });
  });

  it('rejects missing, unknown and mixed arguments', () => {
    expect(() => parseArgs(['--maps', 'm.json', '--annotations', 'a', '--charts', 'c'])).toThrow(/--out is required/);
    expect(() => parseArgs(['--maps', 'm.json', '--annotations', 'a', '--out', 'o'])).toThrow(/--charts is required/);
    expect(() => parseArgs(['--bogus', 'x'])).toThrow(/unknown argument: --bogus/);
    expect(() => parseArgs(['--maps'])).toThrow(/--maps needs a value/);
    expect(() => parseArgs(['--gap', 'a.json'])).toThrow(/--gap needs two result files/);
    expect(() => parseArgs(['--gap', 'a.json', 'b.json', '--maps', 'm.json'])).toThrow(/--gap takes only/);
  });

  it('runs from files: song list, both annotation roots and the chart folder', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'seq-eval-'));
    const w = (rel: string, text: string) => {
      const p = path.join(dir, rel);
      writeFileSync(p, text);
      return p;
    };
    for (const d of ['mm/k', 's7/k', 'charts']) mkdirSync(path.join(dir, d), { recursive: true });
    const listFile = w('list.json', JSON.stringify(list()));
    const m = maps();
    const mapsFile = w('maps.json', JSON.stringify({ ...m, songs: m.songs.map((s) => ({ ...s, songList: listFile })) }));
    for (const id of Object.keys(ids) as Id[]) {
      w(`mm/k/${id}.lab`, refFiles[`k/${id}.lab`]);
      w(`s7/k/${id}.lab`, ref7Files[`k/${id}.lab`]);
      w(`charts/${ids[id]}.json`, JSON.stringify({ chart: songCharts[ids[id]] }));
    }
    const mod = { ...seq, parseMaps, parseGroups, songListsToLoad, parseSongList };
    const args = parseArgs(['--maps', mapsFile, '--annotations', path.join(dir, 'mm'), '--annotations-sevenths', path.join(dir, 's7'), '--charts', path.join(dir, 'charts'), '--out', path.join(dir, 'o.json')]);
    const res = await run(args, mod);
    expect(res.songs.map((s: { views: { majmin: { f: number } } }) => s.views.majmin.f)).toEqual([1, 0.75, 0.75, 1]);
    expect(res.songs[0].views.sevenths.refWildcards).toBe(1);
    expect(res.inputs.annotationsSevenths).toBe(path.join(dir, 's7'));
    expect(res.inputs.mapsSha256).toMatch(/^[0-9a-f]{64}$/);
  });
});
