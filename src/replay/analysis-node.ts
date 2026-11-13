/**
 * Baseline analysis entry (bundled and run by scripts/baseline-analysis.mjs):
 *   --audio <captures dir> --maps <maps.json> --annotations <dir> --out <result.json>
 *   [--config <json>] [--ids songId,…] [--songs <list.json>]… [--models <dir>]
 * Only the songs of the maps file are replayed and analysed (--ids must name map songs); each song's
 * annotation is found and read exactly as paired-eval does (maps songList, else --songs, else the
 * two DEV lists), under its frozen offsetSec / rate. Writes the JSON result and prints a short text.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildAutoChart } from '../recognize/autochart';
import type { BtcMeta } from '../recognize/chords';
import { MODEL_FILES, ortRunner, type ModelRunner } from '../recognize/runner';
import { parseBeats, parseLab, parseSongList } from '../eval/annotations';
import { lookupSongs, parseMaps, songListsToLoad } from '../eval/paired';
import { analysisText, analyzeSong, songMeans, type SongAnalysis } from './analysis';
import { parseReplayConfig, replayCapture, type ReplayModels } from './replay';
import { readSegments, selectCaptures } from './store';

export const ANALYSIS_SCHEMA = 'vibe-guitar-baseline-analysis/1';
const USAGE =
  'usage: node scripts/baseline-analysis.mjs --audio <captures dir> --maps <maps.json> --annotations <dir> --out <result.json> [--config <json>] [--ids songId,…] [--songs <list.json>]… [--models <dir>]';

export function parseArgs(argv: string[]): { audio: string; maps: string; annotations: string; out: string; config?: string; ids?: string[]; songs: string[]; models: string } {
  const out: Record<string, string> = { models: 'models' };
  const songs: string[] = [];
  const known = ['audio', 'maps', 'annotations', 'out', 'config', 'ids', 'models', 'songs'];
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i].replace(/^--/, '');
    if (!argv[i].startsWith('--') || !known.includes(k) || argv[i + 1] === undefined) throw new Error(`bad argument ${argv[i]}\n${USAGE}`);
    if (k === 'songs') songs.push(argv[++i]);
    else out[k] = argv[++i];
  }
  for (const k of ['audio', 'maps', 'annotations', 'out']) if (!out[k]) throw new Error(`--${k} is required\n${USAGE}`);
  return {
    audio: out.audio,
    maps: out.maps,
    annotations: out.annotations,
    out: out.out,
    config: out.config,
    ids: out.ids ? out.ids.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
    songs,
    models: out.models,
  };
}

/** Repository root: this bundle runs from <root>/bench-out/. */
const repoRoot = (): string => process.cwd();

/** Key a song list is named by (as paired-eval listKey): repository-relative inside the repository. */
function listKey(file: string): string {
  const abs = path.resolve(repoRoot(), file);
  const rel = path.relative(repoRoot(), abs);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.split(path.sep).join('/') : abs;
}

/** Resolves rel inside base; null when it would leave base (as in eval-annotations / paired-eval). */
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

export type AnalysisArgs = ReturnType<typeof parseArgs>;

/** Replays and analyses the map songs with the given models (main loads them with onnxruntime-node). */
export async function runAnalysis(args: AnalysisArgs, models: ReplayModels, info: { runtime: string; models: Record<string, string> }) {
  if (!models.majmin) throw new Error('baseline analysis: the btc_majmin model is required');
  const config = parseReplayConfig(args.config ? readJson(args.config) : undefined);
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
  // Captures are read only for the map songs (folder = youtubeId).
  const { captures } = selectCaptures(path.resolve(args.audio), maps.songs.map((s) => s.youtubeId));
  const tool = `vibe-guitar baseline analysis (${info.runtime})${config.label ? `: ${config.label}` : ''}`;

  const songs: SongAnalysis[] = [];
  for (const m of maps.songs) {
    const c = captures.find((x) => x.key === m.youtubeId)!;
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
    const r = await replayCapture(c.meta, readSegments(c), models, config.recognizer, tool, true);
    const kept = r.kept!;
    const durationSec = c.meta.durationSec;
    songs.push(
      analyzeSong({
        map: m,
        segs: parseLab(lab),
        annBeats,
        chart: r.chart,
        analyses: kept.analyses,
        inputs: kept.analyses.map((a) => kept.recognizer.decodeInput(a)),
        build: (analyses) => buildAutoChart({ recording: { ...c.meta.recording }, segments: analyses, tool, durationSec }),
      }),
    );
  }
  return {
    schema: ANALYSIS_SCHEMA,
    generatedAt: new Date().toISOString(),
    config,
    configFile: args.config ? path.resolve(args.config) : null,
    git: { commit: git('rev-parse', 'HEAD'), dirty: git('status', '--porcelain', '--untracked-files=no') !== '' },
    runtime: info.runtime,
    models: info.models,
    inputs: { audio: path.resolve(args.audio), maps: path.resolve(args.maps), mapsSha256: createHash('sha256').update(mapsText).digest('hex'), annotations: path.resolve(args.annotations), songLists: files },
    songs,
    songMean: songMeans(songs),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const modelsDir = path.resolve(args.models);
  const ort = await import('onnxruntime-node');
  const runtime = `onnxruntime-node ${ort.env.versions?.node ?? ''} (cpu)`;
  const make = async (file: string): Promise<ModelRunner> => ortRunner(await ort.InferenceSession.create(path.join(modelsDir, file), { executionProviders: ['cpu'] }), ort.Tensor);
  const meta = JSON.parse(readFileSync(path.join(modelsDir, MODEL_FILES.btcMeta), 'utf8')) as BtcMeta;
  // The majmin model always runs here (disagreement analysis); it decides chords only when the config sets majmin.
  const models: ReplayModels = {
    beat: await make(MODEL_FILES.beat),
    chords: await make(MODEL_FILES.chords),
    chordMeta: meta.models.large,
    majmin: { runner: await make(MODEL_FILES.chordsMajmin), meta: meta.models.majmin },
  };
  const modelSha = Object.fromEntries([MODEL_FILES.beat, MODEL_FILES.chords, MODEL_FILES.chordsMajmin, MODEL_FILES.btcMeta].map((f) => [f, sha256File(path.join(modelsDir, f))]));
  const result = await runAnalysis(args, models, { runtime, models: modelSha });
  writeFileSync(path.resolve(args.out), `${JSON.stringify(result, (_, v) => (typeof v === 'number' && !Number.isFinite(v) ? null : v), 2)}\n`);
  console.log(`baseline analysis: ${result.songs.length} map songs, options ${JSON.stringify(result.config.recognizer)}`);
  console.log(analysisText(result.songs));
  console.log(`wrote ${path.resolve(args.out)}`);
}

if (process.argv[1] && /analysis-node\.mjs$/.test(process.argv[1])) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
