/**
 * Offline replay entry (bundled and run by scripts/replay-audio.mjs):
 *   --audio <captures dir> --out <charts dir> [--config <json>] [--ids a,b] [--models <dir>] [--runtime node|web]
 * Writes <out>/<key>.json (the replayed auto chart, the shape eval-annotations and paired-eval
 * read) and <out>/replay-manifest.json (config, git commit, model sha256, per-song timings).
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { BtcMeta } from '../recognize/chords';
import { MODEL_FILES, ortRunner, type ModelRunner } from '../recognize/runner';
import { modelHashMismatches, parseReplayConfig, replayCapture, type ReplayModels } from './replay';
import { readSegments, selectCaptures } from './store';

export const REPLAY_MANIFEST_SCHEMA = 'vibe-guitar-replay-run/1';
const USAGE = 'usage: npm run replay-audio -- --audio <captures dir> --out <charts dir> [--config <json>] [--ids a,b] [--models <dir>] [--runtime node|web]';

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = { models: 'models', runtime: 'node' };
  const known = ['audio', 'out', 'config', 'ids', 'models', 'runtime'];
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i].replace(/^--/, '');
    if (!argv[i].startsWith('--') || !known.includes(k) || argv[i + 1] === undefined) throw new Error(`bad argument ${argv[i]}\n${USAGE}`);
    out[k] = argv[++i];
  }
  if (!out.audio || !out.out) throw new Error(`--audio and --out are required\n${USAGE}`);
  if (out.runtime !== 'node' && out.runtime !== 'web') throw new Error('--runtime must be node or web');
  return out;
}

function git(...a: string[]): string {
  try {
    return execFileSync('git', a, { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

const sha256File = (p: string): string => createHash('sha256').update(readFileSync(p)).digest('hex');

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = parseReplayConfig(args.config ? JSON.parse(readFileSync(args.config, 'utf8')) : undefined);
  const ids = args.ids ? args.ids.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
  const { captures, skipped } = selectCaptures(path.resolve(args.audio), ids);
  if (!captures.length) throw new Error(`no captures under ${args.audio}`);
  const modelsDir = path.resolve(args.models);
  const outDir = path.resolve(args.out);
  mkdirSync(outDir, { recursive: true });

  let make: (file: string) => Promise<ModelRunner>;
  let runtime: string;
  if (args.runtime === 'web') {
    const ort = await import('onnxruntime-web');
    ort.env.wasm.numThreads = 1;
    runtime = `onnxruntime-web ${ort.env.versions?.web ?? ''} (wasm, 1 thread)`;
    make = async (file) => ortRunner(await ort.InferenceSession.create(readFileSync(path.join(modelsDir, file)), { executionProviders: ['wasm'] }), ort.Tensor);
  } else {
    const ort = await import('onnxruntime-node');
    runtime = `onnxruntime-node ${ort.env.versions?.node ?? ''} (cpu)`;
    make = async (file) => ortRunner(await ort.InferenceSession.create(path.join(modelsDir, file), { executionProviders: ['cpu'] }), ort.Tensor);
  }
  const meta = JSON.parse(readFileSync(path.join(modelsDir, MODEL_FILES.btcMeta), 'utf8')) as BtcMeta;
  const models: ReplayModels = { beat: await make(MODEL_FILES.beat), chords: await make(MODEL_FILES.chords), chordMeta: meta.models.large };
  const modelSha = Object.fromEntries([MODEL_FILES.beat, MODEL_FILES.chords, MODEL_FILES.btcMeta].map((f) => [f, sha256File(path.join(modelsDir, f))]));
  const commit = git('rev-parse', 'HEAD');
  const dirty = git('status', '--porcelain', '--untracked-files=no') !== '';
  const tool = `vibe-guitar offline replay (${runtime})${config.label ? `: ${config.label}` : ''}`;
  console.log(`replay: ${captures.length} captures, ${runtime}, options ${JSON.stringify(config.recognizer)}`);

  const songs = [];
  for (const c of captures) {
    const t0 = Date.now();
    const segments = readSegments(c);
    const r = await replayCapture(c.meta, segments, models, config.recognizer, tool);
    writeFileSync(path.join(outDir, `${c.key}.json`), `${JSON.stringify(r.chart, null, 2)}\n`);
    const modelMismatch = modelHashMismatches(c.meta.models ?? {}, modelSha);
    const audioSec = segments.reduce((s, g) => s + g.samples.length, 0) / c.meta.sampleRate;
    songs.push({ key: c.key, captureId: c.captureId, captureBuild: c.meta.build, segments: segments.length, analysedSegments: r.analysedSegments, audioSec, events: r.chart.events.length, ms: { ...r.ms, total: Date.now() - t0 }, modelMismatch });
    console.log(`${c.key} ${c.captureId}: ${segments.length} segments, ${audioSec.toFixed(1)} s, ${r.chart.events.length} events, ${Date.now() - t0} ms`);
    for (const x of modelMismatch) console.warn(`WARNING ${c.key}: ${x.file} loaded ${x.loaded.slice(0, 12)}, capture recorded ${x.recorded ? x.recorded.slice(0, 12) : 'no hash'}: the replay does not run the live model bytes`);
  }
  const manifest = {
    schema: REPLAY_MANIFEST_SCHEMA,
    generatedAt: new Date().toISOString(),
    config,
    configFile: args.config ? path.resolve(args.config) : null,
    git: { commit, dirty },
    runtime,
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    models: modelSha,
    audio: path.resolve(args.audio),
    songs,
    skipped,
  };
  writeFileSync(path.join(outDir, 'replay-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`wrote ${songs.length} charts and replay-manifest.json to ${outDir}${skipped.length ? ` (older captures skipped: ${skipped.length})` : ''}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
