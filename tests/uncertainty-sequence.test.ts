/**
 * VGT-19 K-pop reference check (docs/uncertainty-protocol.md): token flagging by duration, mismatch
 * shares for flagged vs unflagged chart tokens (wildcard-absorbed tokens left out) and the net change
 * when every flagged span takes its second choice. Synthetic references and charts only.
 */
import { describe, expect, it } from 'vitest';
import type { Chart } from '../src/chart/types';
import { parseSongList, SONG_LIST_SCHEMA } from '../src/eval/annotations';
import { parseMaps } from '../src/eval/paired';
import { timedChartTokens, uncertainSequenceEvaluate } from '../src/eval/uncertainty-sequence';

const chartOf = (events: [number, string][], coverage: [number, number][], uncertain: [number, number, string, string][]): Chart => ({
  schemaVersion: 1,
  recording: { source: 'youtube', id: 'abcdefghijk', title: 't', artist: 'a' },
  timing: { bpm: 120, beatsPerBar: 4, beatUnit: 4, firstDownbeatSec: 0 },
  events: events.map(([startSec, chord]) => ({ startSec, chord, confidence: 0.5, source: 'auto' })),
  coverage: coverage.map(([fromSec, toSec]) => ({ fromSec, toSec })),
  provenance: { createdBy: 'recognizer', createdAt: 'x' },
  uncertain: uncertain.map(([fromSec, toSec, chord, alt]) => ({ fromSec, toSec, chord, alt })),
});

describe('timed chart tokens', () => {
  it('sum chord intervals without N or coverage gaps; flagged at half the duration', () => {
    const chart = chartOf(
      [
        [0, 'C'],
        [2, 'N'],
        [3, 'C7'],
        [4, 'G'],
        [8, 'G'],
      ],
      [
        [0, 6],
        [8, 9],
      ],
      [
        [0, 1, 'C', 'Am'],
        [3, 3.5, 'C7', 'Am'],
        [4, 5, 'G', 'Em'],
      ],
    );
    expect(timedChartTokens(chart)).toEqual([
      { token: '0:maj', durSec: 3, flaggedSec: 1.5, flagged: true },
      { token: '7:maj', durSec: 3, flaggedSec: 1, flagged: false },
    ]);
  });
});

const LAB = ['0 1 C:maj', '1 2 A:min', '2 3 F:maj', '3 4 G:maj', '4 5 X', '5 6 C:maj'].join('\n');
const songsJson = parseSongList({
  schema: SONG_LIST_SCHEMA,
  declaredAt: 'x',
  purpose: 'test',
  datasets: { ds: { name: 'DS', page: 'p', downloads: [], folder: 'ds', licence: 'none', licenceQuote: 'q', attribution: 'a', btcTraining: 'not-known' } },
  songs: ['k1', 'k2'].map((id) => ({ id, role: 'eval', artist: 'a', title: id, release: 'r', dataset: 'ds', chords: 'song.lab', beats: null, annotationDurationSec: 6, btcTraining: 'not-known', complexity: 'simple', search: [], uploads: [] })),
});
const maps = parseMaps({
  schema: 'vibe-guitar-recognition-dev-maps/1',
  songs: [
    { id: 'k1', songList: 'songs.json', dataset: 'ds', youtubeId: 'k1k1k1k1k1k', offsetSec: 0, rate: 1, mediaDurationSec: null, btcTraining: 'not-known', groups: [] },
    { id: 'k2', songList: 'songs.json', dataset: 'ds', youtubeId: 'k2k2k2k2k2k', offsetSec: 0, rate: 1, mediaDurationSec: null, btcTraining: 'not-known', groups: [] },
  ],
});

describe('uncertainty sequence check', () => {
  const chart = chartOf(
    [
      [0, 'C'],
      [2, 'Em'],
      [4, 'F'],
      [6, 'G'],
      [8, 'D'],
      [10, 'C'],
    ],
    [[0, 12]],
    [
      [2, 4, 'Em', 'Am'],
      [6, 6.5, 'G', 'Gm'],
      [8, 10, 'D', 'Dm'],
    ],
  );
  const io = (charts: Record<string, unknown>) => ({
    readAnnotation: () => LAB,
    readAnnotationSevenths: () => LAB,
    readChart: (id: string) => charts[id] ?? null,
  });

  it('counts mismatches of flagged vs unflagged tokens and the net change of second choices', () => {
    const r = uncertainSequenceEvaluate(maps, [{ file: 'songs.json', list: songsJson }], io({ k1k1k1k1k1k: chart }), { now: new Date(0) });
    expect(r.missing).toEqual(['k2']);
    expect(r.complete).toBe(false);
    const s = r.songs[0];
    // Reference C Am F G * C; chart C Em F G D C: Em (flagged) is substituted, D is absorbed by the wildcard.
    expect(s.flagged).toEqual({ tokens: 1, mismatched: 1 });
    expect(s.unflagged).toEqual({ tokens: 4, mismatched: 0 });
    expect(s.wildcardAbsorbed).toBe(1);
    expect(s.before).toMatchObject({ matches: 4, substitutions: 1, deletions: 0, insertions: 0, recall: 0.8, precision: 0.8 });
    // Second choices: C Am F Gm G Dm C → Gm is inserted, Dm is absorbed.
    expect(s.after).toMatchObject({ matches: 5, substitutions: 0, deletions: 0, insertions: 1, recall: 1 });
    expect(r.mismatch.flagged.value).toBe(1);
    expect(r.mismatch.unflagged.value).toBe(0);
    expect(r.recovery.songMean.recall.change).toBeCloseTo(0.2, 12);
    expect(r.recovery.totals.insertions).toEqual({ before: 0, after: 1 });
  });

  it('refuses charts without uncertain spans', () => {
    const { uncertain: _u, ...plain } = chart;
    expect(() => uncertainSequenceEvaluate(maps, [{ file: 'songs.json', list: songsJson }], io({ k1k1k1k1k1k: plain, k2k2k2k2k2k: chart }))).toThrow(/no uncertain spans/);
  });
});
