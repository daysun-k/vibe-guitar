// Paired frozen-map comparison of a baseline and a candidate chart set (docs/recognition-replay.md).
//   npm run paired-eval -- --maps <maps.json> --annotations <dir> --baseline <charts dir> --candidate <charts dir>
//     [--out <result.json>] [--subset-field btcTraining=not-known] [--groups <groups.json>] [--songs <list.json>]…
// Only the songs of the maps file are read and scored; each with its frozen offsetSec/rate/mediaDurationSec
// and the evaluator's unchanged scoreSong. Song lists are used only to find each song's annotation files,
// read exactly as eval-annotations reads them: a maps entry's songList (repository-relative) for that song,
// otherwise the --songs lists, otherwise the two DEV lists (docs/annotation-eval-songs.json and
// docs/annotation-eval-songs-heldout-v1.json). A held-out TEST list is read only when named.
// Local files only (no network).
import * as esbuild from 'esbuild';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const USAGE =
  'usage: npm run paired-eval -- --maps <maps.json> --annotations <dir> --baseline <charts dir> --candidate <charts dir> [--out <result.json>] [--subset-field field=value] [--groups <groups.json>] [--songs <list.json>]…';

/** Key a song list is named by: repository-relative inside the repository, absolute outside it. */
export function listKey(file) {
  const abs = path.resolve(root, file);
  const rel = path.relative(root, abs);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.split(path.sep).join('/') : abs;
}

export function parseArgs(argv) {
  const out = { songs: [] };
  const keys = { '--maps': 'maps', '--annotations': 'annotations', '--baseline': 'baseline', '--candidate': 'candidate', '--out': 'out', '--subset-field': 'subset', '--groups': 'groups' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') return { help: true };
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`${a} needs a value\n${USAGE}`);
    if (a === '--songs') out.songs.push(value);
    else if (keys[a]) out[keys[a]] = value;
    else throw new Error(`unknown argument: ${a}\n${USAGE}`);
    i++;
  }
  for (const k of ['maps', 'annotations', 'baseline', 'candidate']) if (!out[k]) throw new Error(`--${k} is required\n${USAGE}`);
  return out;
}

export async function loadModules() {
  const built = await esbuild.build({
    absWorkingDir: root,
    stdin: { contents: "export * from './src/eval/paired.ts'; export { parseSongList } from './src/eval/annotations.ts';", resolveDir: root, loader: 'ts' },
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

/** Resolves rel inside base; null when it would leave base (as in eval-annotations.mjs). */
function inside(base, ...rel) {
  const b = path.resolve(base);
  const p = path.resolve(b, ...rel);
  return p === b || p.startsWith(b + path.sep) ? p : null;
}

export function fileIo(args) {
  const chart = (dir) => (id) => {
    const p = inside(dir, `${id}.json`);
    return p && existsSync(p) ? readJson(p) : null;
  };
  return {
    readAnnotation(folder, rel) {
      const p = inside(args.annotations, folder, rel);
      return p && existsSync(p) ? readFileSync(p, 'utf8') : null;
    },
    readBaseline: chart(args.baseline),
    readCandidate: chart(args.candidate),
  };
}

export async function run(args, m) {
  const mapsText = readFileSync(args.maps, 'utf8');
  const maps = m.parseMaps(JSON.parse(mapsText));
  for (const s of maps.songs) if (s.songList) s.songList = listKey(s.songList);
  const { files, fallback } = m.songListsToLoad(maps, args.songs.map((f) => listKey(path.resolve(f))));
  const lists = files.map((file) => ({ file, list: m.parseSongList(readJson(path.resolve(root, file))) }));
  const groups = args.groups ? m.parseGroups(readJson(args.groups), maps) : undefined;
  const subset = args.subset ? m.parseSubset(args.subset) : undefined;
  const inputs = {
    maps: path.resolve(args.maps),
    mapsSha256: createHash('sha256').update(mapsText).digest('hex'),
    annotations: path.resolve(args.annotations),
    baseline: path.resolve(args.baseline),
    candidate: path.resolve(args.candidate),
    songLists: files.join(', '),
    groups: args.groups ? path.resolve(args.groups) : null,
  };
  return m.pairedEvaluate(maps, lists, fileIo(args), { fallbackLists: fallback, subset, groups, inputs });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  const m = await loadModules();
  const result = await run(args, m);
  if (args.out) {
    await writeFile(path.resolve(args.out), `${JSON.stringify(result, (_, v) => (typeof v === 'number' && !Number.isFinite(v) ? null : v), 2)}\n`, 'utf8');
    console.log(path.resolve(args.out));
  }
  console.log(m.pairedSummary(result));
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.error(e.message ?? e);
      process.exit(1);
    },
  );
}
