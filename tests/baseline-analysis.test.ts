import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CQT } from '../src/audio/features';
import { parseLab, scoreSong, SONG_LIST_SCHEMA } from '../src/eval/annotations';
import type { BtcModelMeta } from '../src/recognize/chords';
import type { ModelRunner } from '../src/recognize/runner';
import { anatomyOf, ANATOMY_KEYS } from '../src/replay/analysis';
import { parseArgs, runAnalysis } from '../src/replay/analysis-node';
import { replayCapture, type ReplayModels } from '../src/replay/replay';
import { readSegments, selectCaptures } from '../src/replay/store';
import { testAudio, writeCaptureFolder } from './replay-helpers';

const B = CQT.nBins;
const ROOTS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const labels = [...ROOTS.flatMap((r) => [`${r}:min`, r, `${r}:7`, `${r}:min7`, `${r}:sus4`]), 'N', 'X'];
const chordMeta: BtcModelMeta = { file: 'fake', mean: -3, std: 2, timestep: 108, num_chords: labels.length, labels };
const mmLabels = [...ROOTS.flatMap((r) => [r, `${r}:min`]), 'N'];
const mmMeta: BtcModelMeta = { file: 'fake-mm', mean: -3, std: 2, timestep: 108, num_chords: 25, labels: mmLabels };

const logitsRunner = (C: number, f: (x: number, c: number, t: number) => number): ModelRunner => ({
  async run(_n, data, dims) {
    const T = dims[1];
    const logits = new Float32Array(T * C);
    for (let t = 0; t < T; t++) for (let c = 0; c < C; c++) logits[t * C + c] = f(data[t * B + ((c * 7) % B)], c, t);
    return { logits };
  },
});
const beatRunner: ModelRunner = {
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
};
const models: ReplayModels = {
  beat: beatRunner,
  chords: logitsRunner(labels.length, (x, c, t) => 3 * Math.sin(x * 1.9 + c * 0.7 + t * 0.03)),
  chordMeta,
  majmin: { runner: logitsRunner(25, (x, c, t) => 3 * Math.cos(x * 1.3 + c * 0.9 + t * 0.02)), meta: mmMeta },
};

const LAB = ['0.0 3.0 C:maj', '3.0 5.5 A:min', '5.5 7.0 G:7', '7.0 8.0 N', '8.0 12.0 F:maj', '12.0 16.0 D:min7', '16.0 18.0 X', '18.0 22.0 E:maj'].join('\n');

function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'vg-analysis-'));
  const audio = path.join(dir, 'audio');
  writeCaptureFolder(audio, 'abcdefghijk', [
    { startSec: 0.5, samples: testAudio(9, 1) },
    { startSec: 11.75, samples: testAudio(8, 2) },
  ], 30);
  writeCaptureFolder(audio, 'zzzzzzzzzzz', [{ startSec: 0, samples: testAudio(2, 4) }], 10); // not a map song: never read
  const ann = path.join(dir, 'ann');
  mkdirSync(path.join(ann, 'ds'), { recursive: true });
  writeFileSync(path.join(ann, 'ds', 'song.lab'), LAB);
  const songList = path.join(dir, 'songs.json');
  writeFileSync(
    songList,
    JSON.stringify({
      schema: SONG_LIST_SCHEMA,
      declaredAt: 'x',
      purpose: 'test',
      datasets: { ds: { name: 'DS', page: 'p', downloads: [], folder: 'ds', licence: 'none', licenceQuote: 'q', attribution: 'a', btcTraining: 'not-known' } },
      songs: [{ id: 'song-a', role: 'eval', artist: 'a', title: 't', release: 'r', dataset: 'ds', chords: 'song.lab', beats: null, annotationDurationSec: 22, btcTraining: 'not-known', complexity: 'simple', search: [], uploadHint: '' }],
    }),
  );
  const maps = path.join(dir, 'maps.json');
  writeFileSync(maps, JSON.stringify({ schema: 'vibe-guitar-recognition-dev-maps/1', songs: [{ id: 'song-a', songList, dataset: 'ds', youtubeId: 'abcdefghijk', offsetSec: 0.25, rate: 1, mediaDurationSec: 30, btcTraining: 'not-known', groups: [] }] }));
  return { dir, audio, ann, maps };
}

const info = { runtime: 'fake', models: {} };

describe('baseline analysis', () => {
  it('classifies errors by root interval and quality', () => {
    expect(anatomyOf('0:maj', 'C7')).toBe('exact');
    expect(anatomyOf('0:maj', 'G')).toBe('fifthRoot');
    expect(anatomyOf('0:maj', 'Fm')).toBe('fifthRoot');
    expect(anatomyOf('0:maj', 'Cm7')).toBe('parallel');
    expect(anatomyOf('0:maj', 'Csus4')).toBe('other');
    expect(anatomyOf('0:maj', 'Am')).toBe('relative');
    expect(anatomyOf('9:min', 'C')).toBe('relative');
    expect(anatomyOf('0:maj', 'A')).toBe('other');
    expect(anatomyOf('0:maj', 'B')).toBe('semitoneRoot');
    expect(anatomyOf('0:maj', 'N')).toBe('falseN');
    expect(anatomyOf('N', 'C')).toBe('chordForRefN');
    expect(anatomyOf('N', 'N')).toBe('exact');
  });

  it('runs end to end on a synthetic capture folder under the frozen map', async () => {
    const f = fixture();
    const args = parseArgs(['--audio', f.audio, '--maps', f.maps, '--annotations', f.ann, '--out', path.join(f.dir, 'out.json')]);
    const r = await runAnalysis(args, models, info);
    expect(r.songs).toHaveLength(1);
    const s = r.songs[0];
    // The official majmin score is the evaluator's scoreSong on the replayed chart.
    const [cap] = selectCaptures(f.audio, ['abcdefghijk']).captures;
    const chart = (await replayCapture(cap.meta, readSegments(cap), models, {}, 't')).chart;
    const official = scoreSong(parseLab(LAB), null, chart, 0.25, 30, 1, 1).comparison.majmin;
    expect(s.majmin).toBeCloseTo(official.score, 12);
    expect(s.evaluatedSec).toBeCloseTo(official.evaluatedSec, 9);
    expect(ANATOMY_KEYS.reduce((a, k) => a + s.anatomy[k], 0)).toBeCloseTo(1, 9);
    expect(s.anatomy.exact).toBeCloseTo(s.majmin, 9);
    expect(s.topK.top1).toBeLessThanOrEqual(s.topK.top2);
    expect(s.topK.top2).toBeLessThanOrEqual(s.topK.top3);
    // Half-beat units refine beat units: their majority ceiling cannot be lower.
    expect(s.ceilings.halfBeat).toBeGreaterThanOrEqual(s.ceilings.beat - 1e-9);
    expect(s.ceilings.frame).toBeGreaterThan(0.9);
    expect(s.ceilings.beat).toBeLessThanOrEqual(1);
    expect(s.majminModel.oracle).toBeGreaterThanOrEqual(Math.max(s.majminModel.largeArgmax, s.majminModel.majminArgmax) - 1e-9);
    expect(s.majminModel.disagreeUnits).toBeGreaterThan(0);
    expect(r.songMean).toMatchObject({ majmin: s.majmin, ceilings: s.ceilings });
  });

  it('runs with a candidate config and refuses ids outside the maps file', async () => {
    const f = fixture();
    const config = path.join(f.dir, 'c.json');
    writeFileSync(config, JSON.stringify({ label: 'C1', recognizer: { decode: { familyFirst: { penaltyScale: 1 } } } }));
    const base = ['--audio', f.audio, '--maps', f.maps, '--annotations', f.ann, '--out', path.join(f.dir, 'o.json')];
    const r = await runAnalysis(parseArgs([...base, '--config', config, '--ids', 'song-a']), models, info);
    expect(r.config.recognizer).toEqual({ decode: { familyFirst: { penaltyScale: 1 } } });
    expect(r.songs[0].id).toBe('song-a');
    await expect(runAnalysis(parseArgs([...base, '--ids', 'song-a,zzzzzzzzzzz']), models, info)).rejects.toThrow(/not in the maps file: zzzzzzzzzzz/);
    await expect(runAnalysis(parseArgs(base), { ...models, majmin: undefined }, info)).rejects.toThrow(/btc_majmin model is required/);
    expect(() => parseArgs(['--audio', 'a'])).toThrow(/--maps is required/);
  });
});

describe('replayCapture with candidate options', () => {
  const meta = { recordingKey: 'youtube:abcdefghijk', recording: { source: 'youtube' as const, id: 'abcdefghijk', title: 't', artist: 'a' }, durationSec: 30 };
  const segments = () => [
    { startSec: 0.5, samples: testAudio(9, 1) },
    { startSec: 11.75, samples: testAudio(8, 2) },
  ];
  const strip = (c: { provenance: object }) => ({ ...c, provenance: { ...c.provenance, createdAt: '' } });

  it('the candidate path with default options (keep) builds the live chart', async () => {
    const live = await replayCapture(meta, segments(), models, {}, 't');
    const kept = await replayCapture(meta, segments(), models, {}, 't', true);
    expect(strip(kept.chart)).toEqual(strip(live.chart));
    expect(kept.kept!.analyses).toHaveLength(2);
    expect(live.kept).toBeUndefined();
    // C2 only (no candidate option) stays on the plain Recognizer and differs from the default.
    const c2 = await replayCapture(meta, segments(), models, { decode: { changePenalty: [0, 0, 0] } }, 't');
    expect(c2.chart.events.length).toBeGreaterThan(live.chart.events.length);
  });

  it('the key prior runs a second pass with the key of the pass-1 chart', async () => {
    const r = await replayCapture(meta, segments(), models, { keyPrior: { bonus: 1, margin: 0.15 } }, 't');
    expect(r.key).not.toBeUndefined();
    expect(r.key?.mode === 'major' || r.key?.mode === 'minor').toBe(true);
    const plain = await replayCapture(meta, segments(), models, {}, 't');
    expect(plain.key).toBeUndefined();
  });
});
