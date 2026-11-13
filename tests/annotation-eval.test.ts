import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Chart } from '../src/chart/types';
import { renderAnnotationReport } from '../src/eval/annotation-report';
import {
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

  it('excludes a song whose local offsets drift', () => {
    // Annotation runs 0.1% slow: about 0.19 s of drift over the song.
    const ann = est.map((b) => (b - 0.05) * 1.001);
    const a = alignAnnotation(alignInput(est, ann));
    expect(a.excluded?.code).toBe('drift');
    expect(a.driftSec!).toBeGreaterThan(0.1);
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
    const changes = grid(3, 180, 2).map((t) => t - 0.2);
    const a = alignAnnotation(alignInput(est, changes, { method: 'chord-boundaries', downbeatLandmarks: changes }));
    expect(a.strength).toBe('weak');
    expect(a.excluded).toBeNull();
    expect(a.offsetSec).toBeCloseTo(0.2, 2);
    expect(a.coarse.startOffsetSec).toBeCloseTo(est[0] - changes[0], 5);
  });

  it('needs estimate beats', () => {
    expect(alignAnnotation(alignInput([], est)).excluded?.code).toBe('no-estimate-beats');
  });

  it('derives downbeats from the first downbeat and the bar length', () => {
    expect(impliedDownbeats([0, 1, 2, 3, 4, 5, 6, 7, 8], 2, 3)).toEqual([2, 5, 8]);
    expect(impliedDownbeats([0, 1, 2], 1.5, 3)).toBeNull();
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
