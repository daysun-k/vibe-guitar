/**
 * VGT-19 uncertainty measurement entry (bundled and run by scripts/uncertainty-analysis.mjs):
 *   --audio <captures dir> --maps <maps.json> --annotations <dir> --out <result.json>
 *   [--ids songId,…] [--songs <list.json>]… [--models <dir>] [--config <json>]
 *   [--signal S1..S5 --threshold <number> [--dev-result <DEV result.json>] [--charts-out <dir>]]
 * Without --signal: the DEV sweep (θ_f for every signal and f, every measured quantity, criterion steps
 * 1-4). With --signal/--threshold: the fixed setting (TEST check), T1-T4 and the similar/different
 * reading against --dev-result; --charts-out writes every replayed chart WITH `uncertain` as
 * <youtubeId>.json (input of `npm run uncertainty-sequence`). Replay uses the shipped recognizer only,
 * and R1 (the replayed chart equals the live chart of the capture, confidences exactly) is checked for
 * every song before anything is measured. Annotations are found exactly as baseline-analysis finds them.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Chart } from '../chart/types';
import { validateChart } from '../chart/validate';
import { parseBeats, parseLab, parseSongList } from '../eval/annotations';
import { lookupSongs, parseMaps, songListsToLoad } from '../eval/paired';
import { assembleAutoChart, buildAutoChart } from '../recognize/autochart';
import type { BtcMeta } from '../recognize/chords';
import { EXTENSION_RECOGNIZER_OPTIONS } from '../recognize/extension-options';
import { MODEL_FILES, ortRunner, type ModelRunner } from '../recognize/runner';
import { UNCERTAINTY_SIGNALS, type UncertaintySignal } from '../recognize/uncertainty';
import { compareParity } from './parity';
import { parseReplayConfig, replayShipped, modelHashMismatches, type ReplayConfig, type ReplayModels } from './replay';
import { readSegments, selectCaptures } from './store';
import {
  criterion,
  criterionText,
  devReferenceOf,
  EXISTING_RULE,
  measureSetting,
  NOMINAL_SHARES,
  oracleDiagnostic,
  pooledUnitValues,
  prepareSong,
  settingLine,
  testReading,
  thresholdFor,
  type PreparedSong,
  type SettingResult,
} from './uncertainty-analysis';

export const UNCERTAINTY_ANALYSIS_SCHEMA = 'vibe-guitar-uncertainty-analysis/1';
const USAGE =
  'usage: npm run uncertainty-analysis -- --audio <captures dir> --maps <maps.json> --annotations <dir> --out <result.json> [--ids songId,…] [--songs <list.json>]… [--models <dir>] [--config <json>] [--signal S1..S5 --threshold <number> [--dev-result <json>] [--charts-out <dir>]]';

export interface UncertaintyArgs {
  audio: string;
  maps: string;
  annotations: string;
  out: string;
  ids?: string[];
  songs: string[];
  models: string;
  config?: string;
  fixed?: { signal: UncertaintySignal; threshold: number };
  devResult?: string;
  chartsOut?: string;
}

export function parseArgs(argv: string[]): UncertaintyArgs {
  const out: Record<string, string> = { models: 'models' };
  const songs: string[] = [];
  const known = ['audio', 'maps', 'annotations', 'out', 'ids', 'models', 'songs', 'config', 'signal', 'threshold', 'dev-result', 'charts-out'];
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i].replace(/^--/, '');
    if (!argv[i].startsWith('--') || !known.includes(k) || argv[i + 1] === undefined) throw new Error(`bad argument ${argv[i]}\n${USAGE}`);
    if (k === 'songs') songs.push(argv[++i]);
    else out[k] = argv[++i];
  }
  for (const k of ['audio', 'maps', 'annotations', 'out']) if (!out[k]) throw new Error(`--${k} is required\n${USAGE}`);
  if ((out.signal === undefined) !== (out.threshold === undefined)) throw new Error(`--signal and --threshold go together\n${USAGE}`);
  let fixed: UncertaintyArgs['fixed'];
  if (out.signal !== undefined) {
    if (!UNCERTAINTY_SIGNALS.includes(out.signal as UncertaintySignal)) throw new Error(`--signal must be one of ${UNCERTAINTY_SIGNALS.join(', ')}`);
    const threshold = Number(out.threshold);
    if (out.threshold.trim() === '' || !Number.isFinite(threshold)) throw new Error('--threshold must be a finite number (full precision)');
    fixed = { signal: out.signal as UncertaintySignal, threshold };
  } else if (out['dev-result'] || out['charts-out']) throw new Error(`--dev-result and --charts-out need the fixed mode (--signal, --threshold)\n${USAGE}`);
  return {
    audio: out.audio,
    maps: out.maps,
    annotations: out.annotations,
    out: out.out,
    ids: out.ids ? out.ids.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
    songs,
    models: out.models,
    config: out.config,
    fixed,
    devResult: out['dev-result'],
    chartsOut: out['charts-out'],
  };
}

/** The shipped config only: { "recognizer": { "emission": "meanLog", "pitchShift": [-1, 1] } } (a label is allowed). */
export function shippedConfig(v: unknown): ReplayConfig {
  const config = parseReplayConfig(v ?? { recognizer: { ...EXTENSION_RECOGNIZER_OPTIONS, pitchShift: [...(EXTENSION_RECOGNIZER_OPTIONS.pitchShift ?? [])] } });
  const want = JSON.stringify({ emission: EXTENSION_RECOGNIZER_OPTIONS.emission, pitchShift: EXTENSION_RECOGNIZER_OPTIONS.pitchShift });
  const r = config.recognizer;
  const keys = Object.keys(r).sort().join(',');
  if (keys !== 'emission,pitchShift' || JSON.stringify({ emission: r.emission, pitchShift: r.pitchShift }) !== want)
    throw new Error(`uncertainty analysis: only the shipped config ${JSON.stringify({ recognizer: JSON.parse(want) })} is allowed, got ${JSON.stringify({ recognizer: r })}`);
  return config;
}

/** R1: the replayed chart reproduces the live chart (parity) and every event confidence exactly. */
export function r1Check(live: Chart, offline: Chart): { ok: boolean; diffs: string[] } {
  const p = compareParity(live, offline);
  const diffs = [...p.diffs];
  if (p.ok) live.events.forEach((e, i) => e.confidence !== offline.events[i].confidence && diffs.push(`event[${i}] confidence: live ${e.confidence} vs offline ${offline.events[i].confidence}`));
  return { ok: diffs.length === 0, diffs };
}

const repoRoot = (): string => process.cwd();

function listKey(file: string): string {
  const abs = path.resolve(repoRoot(), file);
  const rel = path.relative(repoRoot(), abs);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.split(path.sep).join('/') : abs;
}

function inside(base: string, ...rel: string[]): string | null {
  const b = path.resolve(base);
  const p = path.resolve(b, ...rel);
  return p === b || p.startsWith(b + path.sep) ? p : null;
}

function git(...a: string[]): string {
  try {
    return execFileSync('git', a, { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

const sha256File = (p: string): string => createHash('sha256').update(readFileSync(p)).digest('hex');
const readJson = (p: string): unknown => JSON.parse(readFileSync(p, 'utf8'));
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

export class R1Failure extends Error {}

/** Replays, checks R1 and measures the map songs (main loads the models with onnxruntime-node). */
export async function runUncertaintyAnalysis(args: UncertaintyArgs, models: ReplayModels, info: { runtime: string; models: Record<string, string> }, log: (s: string) => void = () => {}) {
  const config = shippedConfig(args.config ? readJson(args.config) : undefined);
  const mapsText = readFileSync(args.maps, 'utf8');
  const maps = parseMaps(JSON.parse(mapsText));
  for (const s of maps.songs) if (s.songList) s.songList = listKey(s.songList);
  if (args.ids) {
    const unknown = args.ids.filter((id) => !maps.songs.some((s) => s.id === id));
    if (unknown.length) throw new Error(`--ids not in the maps file: ${unknown.join(', ')}`);
    maps.songs = maps.songs.filter((s) => args.ids!.includes(s.id));
  }
  const { files, fallback } = songListsToLoad(maps, args.songs.map((f) => listKey(path.resolve(f))));
  const lists = files.map((file) => ({ file, list: parseSongList(readJson(path.resolve(repoRoot(), file))) }));
  const entries = lookupSongs(lists, maps, fallback);
  const readAnnotation = (folder: string, rel: string): string | null => {
    const p = inside(args.annotations, folder, rel);
    return p && existsSync(p) ? readFileSync(p, 'utf8') : null;
  };
  // Only the map songs' capture folders are read (other songs' charts stay unread).
  const audioDir = path.resolve(args.audio);
  if (!existsSync(audioDir)) throw new Error(`--audio ${audioDir} does not exist`);
  const present = new Set(readdirSync(audioDir).filter((k) => statSync(path.join(audioDir, k)).isDirectory()));
  const { captures } = selectCaptures(audioDir, [...new Set(maps.songs.map((s) => s.youtubeId).filter((id) => present.has(id)))]);
  const missing = maps.songs.filter((m) => !captures.some((c) => c.key === m.youtubeId)).map((m) => m.id);
  // The criterion needs every DEV song; a TEST check with a missing song is reported as incomplete.
  if (missing.length && !args.fixed) throw new Error(`DEV sweep: no capture for ${missing.join(', ')} (the user decides before anything is measured)`);
  const tool = `vibe-guitar uncertainty analysis (${info.runtime})`;

  // Replay every song and check R1 before anything is measured.
  const replayed: { m: (typeof maps.songs)[number]; c: (typeof captures)[number]; r: Awaited<ReturnType<typeof replayShipped>>; chart: Chart; placed: ReturnType<typeof assembleAutoChart>['placed'] }[] = [];
  const r1: { id: string; youtubeId: string; captureId: string; ok: boolean; diffs: string[]; modelMismatches: string[] }[] = [];
  for (const m of maps.songs) {
    const c = captures.find((x) => x.key === m.youtubeId);
    if (!c) continue;
    const r = await replayShipped(c.meta, readSegments(c), models, config.recognizer, tool);
    const { chart, placed } = assembleAutoChart(r.input());
    const check = r1Check(c.meta.chart, chart);
    const mismatches = modelHashMismatches(c.meta.models ?? {}, info.models).map((x) => x.file);
    // Model files differing from the capture's build are recorded and warned about (as replay does); R1 itself is the chart check.
    r1.push({ id: m.id, youtubeId: m.youtubeId, captureId: c.captureId, ok: check.ok, diffs: check.diffs.slice(0, 20), modelMismatches: mismatches });
    log(`${m.id}: R1 ${check.ok ? 'ok' : 'FAILED'} (${r.ms.feed + r.ms.analyze} ms)${mismatches.length ? ` WARNING model files differ from the capture's build: ${mismatches.join(', ')}` : ''}`);
    replayed.push({ m, c, r, chart, placed });
  }
  const failed = r1.filter((x) => !x.ok);
  if (failed.length)
    throw new R1Failure(`R1 failed for ${failed.length} song(s); nothing measured:\n${failed.map((f) => `  ${f.id} (${f.youtubeId}): ${f.diffs.slice(0, 5).join('; ')}`).join('\n')}`);

  const songs: PreparedSong[] = replayed.map(({ m, c, r, chart, placed }) => {
    const entry = entries.get(m.id)!;
    const folder = entry.list.datasets[entry.song.dataset].folder;
    const lab = readAnnotation(folder, entry.song.chords);
    if (lab === null) throw new Error(`${m.id}: annotation file not found: ${folder}/${entry.song.chords}`);
    let annBeats: number[] | null = null;
    if (entry.song.beats) {
      const t = readAnnotation(folder, entry.song.beats);
      if (t === null) throw new Error(`${m.id}: beat file not found: ${folder}/${entry.song.beats}`);
      annBeats = parseBeats(t).map((b) => b.sec);
    }
    return prepareSong({ id: m.id, youtubeId: c.key, map: m, segs: parseLab(lab), annBeats, chart, placed, build: (opts) => buildAutoChart(r.input(opts)) });
  });

  const settings: SettingResult[] = [];
  const thresholds: Record<string, { f: number; threshold: number; share: number }[]> = {};
  let fixedCharts: Chart[] | null = null;
  if (!args.fixed) {
    for (const signal of UNCERTAINTY_SIGNALS) {
      const { values, totalSec } = pooledUnitValues(songs, signal);
      thresholds[signal] = NOMINAL_SHARES.map((f) => ({ f, ...thresholdFor(values, totalSec, f) }));
      for (const t of thresholds[signal]) {
        settings.push(measureSetting(songs, signal, t.f, t.threshold).result);
        log(settingLine(settings[settings.length - 1]));
      }
    }
  } else {
    const m = measureSetting(songs, args.fixed.signal, null, args.fixed.threshold);
    settings.push(m.result);
    fixedCharts = m.charts;
    log(settingLine(m.result));
  }
  const existingRule = measureSetting(songs, EXISTING_RULE.signal, null, EXISTING_RULE.threshold).result;
  const result = {
    schema: UNCERTAINTY_ANALYSIS_SCHEMA,
    generatedAt: new Date().toISOString(),
    mode: args.fixed ? ('fixed' as const) : ('sweep' as const),
    config,
    git: { commit: git('rev-parse', 'HEAD'), dirty: git('status', '--porcelain', '--untracked-files=no') !== '' },
    runtime: info.runtime,
    models: info.models,
    inputs: {
      audio: path.resolve(args.audio),
      maps: path.resolve(args.maps),
      mapsSha256: createHash('sha256').update(mapsText).digest('hex'),
      annotations: path.resolve(args.annotations),
      songLists: files,
      devResult: args.devResult ? path.resolve(args.devResult) : null,
      devResultSha256: args.devResult ? sha256File(args.devResult) : null,
    },
    captures: replayed.map(({ m, c }) => ({ id: m.id, youtubeId: c.key, captureId: c.captureId, build: c.meta.build, capturedAt: c.meta.capturedAt })),
    missing,
    complete: missing.length === 0,
    r1,
    /** Context only: majmin song mean of the replayed (= live) charts. */
    majminSongMean: mean(songs.map((s) => s.majmin)),
    songs: songs.map((s) => ({ id: s.input.id, youtubeId: s.input.youtubeId, majmin: s.majmin, evaluatedSec: s.anatomy.evaluatedSec, errorSec: s.errSec, omittedSegments: s.omitted.length, units: s.units.length })),
    thresholds: args.fixed ? null : thresholds,
    settings,
    existingRule,
    oracle: oracleDiagnostic(songs),
    criterion: args.fixed ? null : criterion(settings),
    test: args.fixed ? testReading(settings[0], args.devResult ? devReferenceOf(readJson(args.devResult)) : null) : null,
  };
  if (args.chartsOut && fixedCharts) {
    const dir = path.resolve(args.chartsOut);
    mkdirSync(dir, { recursive: true });
    fixedCharts.forEach((chart, i) => {
      const v = validateChart(chart);
      if (!v.ok) throw new Error(`${songs[i].input.id}: produced chart fails validateChart: ${v.errors.join('; ')}`);
      writeFileSync(path.join(dir, `${songs[i].input.youtubeId}.json`), `${JSON.stringify(chart, null, 2)}\n`);
    });
  }
  return result;
}

export function resultText(r: Awaited<ReturnType<typeof runUncertaintyAnalysis>>): string {
  const lines = [
    `uncertainty analysis (${r.mode}): ${r.songs.length} songs${r.complete ? '' : `, INCOMPLETE (no capture: ${r.missing.join(', ')})`}; R1 ok for all; git ${r.git.commit}${r.git.dirty ? ' (dirty)' : ''}; maps sha256 ${r.inputs.mapsSha256.slice(0, 12)}`,
    `config ${JSON.stringify(r.config.recognizer)}; majmin song mean ${r.majminSongMean === null ? 'n/a' : (100 * r.majminSongMean).toFixed(2)}% (context)`,
    ...r.settings.map(settingLine),
    `existing rule (S1 < 0.5): ${settingLine(r.existingRule)}`,
    `oracle fixes: ${Object.entries(r.oracle).map(([k, s]) => `${k} ${s.value === null ? 'n/a' : `${(100 * s.value).toFixed(1)}%`}`).join(', ')}`,
  ];
  if (r.criterion) lines.push(criterionText(r.criterion));
  if (r.test) lines.push(`TEST reading: ${r.test.reading} (${r.test.detail})`, ...r.test.alarms.map((a) => `${a.id} ${a.raised ? 'RAISED' : 'ok'}: ${a.detail}`));
  return lines.join('\n');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const modelsDir = path.resolve(args.models);
  const ort = await import('onnxruntime-node');
  const runtime = `onnxruntime-node ${ort.env.versions?.node ?? ''} (cpu)`;
  const make = async (file: string): Promise<ModelRunner> => ortRunner(await ort.InferenceSession.create(path.join(modelsDir, file), { executionProviders: ['cpu'] }), ort.Tensor);
  const meta = JSON.parse(readFileSync(path.join(modelsDir, MODEL_FILES.btcMeta), 'utf8')) as BtcMeta;
  const models: ReplayModels = { beat: await make(MODEL_FILES.beat), chords: await make(MODEL_FILES.chords), chordMeta: meta.models.large };
  const modelSha = Object.fromEntries([MODEL_FILES.beat, MODEL_FILES.chords, MODEL_FILES.btcMeta].map((f) => [f, sha256File(path.join(modelsDir, f))]));
  const result = await runUncertaintyAnalysis(args, models, { runtime, models: modelSha }, (s) => console.error(s));
  writeFileSync(path.resolve(args.out), `${JSON.stringify(result, (_, v) => (typeof v === 'number' && !Number.isFinite(v) ? null : v), 2)}\n`);
  console.log(resultText(result));
  console.log(`wrote ${path.resolve(args.out)}`);
}

if (process.argv[1] && /uncertainty-analysis-node\.mjs$/.test(process.argv[1])) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(e instanceof R1Failure ? 3 : 1);
  });
}
