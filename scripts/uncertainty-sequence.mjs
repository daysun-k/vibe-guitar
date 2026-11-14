// VGT-19 K-pop reference check (docs/uncertainty-protocol.md "K-pop reference check"): charts WITH
// `uncertain` spans (written by `npm run uncertainty-analysis -- … --charts-out <dir>`) against the
// VGT-21 chord-order references, read exactly as `npm run sequence-eval -- --whole-chart` reads them
// (majmin tokens, N dropped, consecutive equal tokens collapsed, X wildcards, whole chart):
//   npm run uncertainty-sequence -- --maps <maps.json> --annotations <root> --charts <dir of <youtubeId>.json>
//     [--songs <list.json>]… [--whole-chart] --out <result.json>
// --whole-chart is the only mode (accepted for symmetry with sequence-eval). A map song without a chart is
// listed and the check is reported as incomplete. Local files only (no network).
import * as esbuild from 'esbuild';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { listKey } from './paired-eval.mjs';
import { fileIo } from './sequence-eval.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const USAGE = 'usage: npm run uncertainty-sequence -- --maps <maps.json> --annotations <root> --charts <dir> [--songs <list.json>]… [--whole-chart] --out <result.json>';

export function parseArgs(argv) {
  const out = { songs: [] };
  const keys = { '--maps': 'maps', '--annotations': 'annotations', '--charts': 'charts', '--out': 'out' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') return { help: true };
    if (a === '--whole-chart') continue;
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`${a} needs a value\n${USAGE}`);
    if (a === '--songs') out.songs.push(value);
    else if (keys[a]) out[keys[a]] = value;
    else throw new Error(`unknown argument: ${a}\n${USAGE}`);
    i++;
  }
  for (const k of ['maps', 'annotations', 'charts', 'out']) if (!out[k]) throw new Error(`--${k} is required\n${USAGE}`);
  return out;
}

export async function loadModules() {
  const built = await esbuild.build({
    absWorkingDir: root,
    stdin: {
      contents: "export * from './src/eval/uncertainty-sequence.ts'; export { parseMaps, songListsToLoad } from './src/eval/paired.ts'; export { parseSongList } from './src/eval/annotations.ts';",
      resolveDir: root,
      loader: 'ts',
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    write: false,
    logLevel: 'error',
  });
  return import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
}

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const sha256 = (text) => createHash('sha256').update(text).digest('hex');

export function run(args, m) {
  const mapsText = readFileSync(args.maps, 'utf8');
  const maps = m.parseMaps(JSON.parse(mapsText));
  for (const s of maps.songs) if (s.songList) s.songList = listKey(s.songList);
  const { files, fallback } = m.songListsToLoad(maps, args.songs.map((f) => listKey(path.resolve(f))));
  const lists = files.map((file) => ({ file, list: m.parseSongList(readJson(path.resolve(root, file))) }));
  const inputs = {
    maps: path.resolve(args.maps),
    mapsSha256: sha256(mapsText),
    annotations: path.resolve(args.annotations),
    charts: path.resolve(args.charts),
    songLists: files.join(', '),
  };
  return m.uncertainSequenceEvaluate(maps, lists, fileIo(args), { fallbackLists: fallback, inputs });
}

const toJson = (v) => `${JSON.stringify(v, (_, x) => (typeof x === 'number' && !Number.isFinite(x) ? null : x), 2)}\n`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  const m = await loadModules();
  const result = run(args, m);
  await writeFile(path.resolve(args.out), toJson(result), 'utf8');
  console.log(path.resolve(args.out));
  console.log(m.uncertainSequenceSummary(result));
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    },
  );
}
