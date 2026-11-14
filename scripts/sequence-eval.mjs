// Chord-order comparison of one chart set against reference sequences (src/eval/sequence.ts,
// docs/recognition-replay.md, docs/kpop-eval-protocol.md amendment 1).
//   npm run sequence-eval -- --maps <maps.json> --annotations <root> [--annotations-sevenths <root>]
//     --charts <dir of <youtubeId>.json> [--songs <list.json>]… [--groups <groups.json>] [--whole-chart] --out <result.json>
//   npm run sequence-eval -- --gap <A result.json> <B result.json> [--out <gap.json>]
// Annotation files are found through the song lists exactly as paired-eval finds them (a maps entry's
// songList, otherwise the --songs lists, otherwise the two DEV lists). The sevenths view reads the same
// relative path under --annotations-sevenths (default: --annotations). --whole-chart: the reference is not
// cut to the chart's coverage (references without real timing, e.g. the K-pop consensus with dummy
// one-second segments); recorded as inputs.wholeChart: true and referenceWindow "none".
// --gap: A minus B of the song-mean majmin F with an independent percentile bootstrap of both song sets
// (mulberry32, seed 7007 for A and 7008 for B, 10 000 resamples) and the gap with each group left out.
// Local files only (no network).
import * as esbuild from 'esbuild';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { listKey } from './paired-eval.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const USAGE = [
  'usage: npm run sequence-eval -- --maps <maps.json> --annotations <root> [--annotations-sevenths <root>] --charts <dir> [--songs <list.json>]… [--groups <groups.json>] [--whole-chart] --out <result.json>',
  '       npm run sequence-eval -- --gap <A result.json> <B result.json> [--out <gap.json>]',
].join('\n');

export function parseArgs(argv) {
  const out = { songs: [], wholeChart: false };
  const keys = { '--maps': 'maps', '--annotations': 'annotations', '--annotations-sevenths': 'annotationsSevenths', '--charts': 'charts', '--out': 'out', '--groups': 'groups' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') return { help: true };
    if (a === '--whole-chart') {
      out.wholeChart = true;
      continue;
    }
    if (a === '--gap') {
      const [x, y] = [argv[i + 1], argv[i + 2]];
      if (x === undefined || y === undefined || x.startsWith('--') || y.startsWith('--')) throw new Error(`--gap needs two result files\n${USAGE}`);
      out.gap = [x, y];
      i += 2;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`${a} needs a value\n${USAGE}`);
    if (a === '--songs') out.songs.push(value);
    else if (keys[a]) out[keys[a]] = value;
    else throw new Error(`unknown argument: ${a}\n${USAGE}`);
    i++;
  }
  if (out.gap) {
    for (const k of ['maps', 'annotations', 'annotationsSevenths', 'charts', 'groups']) if (out[k]) throw new Error(`--gap takes only two result files and --out\n${USAGE}`);
    if (out.songs.length || out.wholeChart) throw new Error(`--gap takes only two result files and --out\n${USAGE}`);
    return out;
  }
  for (const k of ['maps', 'annotations', 'charts', 'out']) if (!out[k]) throw new Error(`--${k} is required\n${USAGE}`);
  return out;
}

export async function loadModules() {
  const built = await esbuild.build({
    absWorkingDir: root,
    stdin: {
      contents: "export * from './src/eval/sequence.ts'; export { parseMaps, parseGroups, songListsToLoad } from './src/eval/paired.ts'; export { parseSongList } from './src/eval/annotations.ts';",
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

/** Resolves rel inside base; null when it would leave base (as in paired-eval.mjs). */
function inside(base, ...rel) {
  const b = path.resolve(base);
  const p = path.resolve(b, ...rel);
  return p === b || p.startsWith(b + path.sep) ? p : null;
}

export function fileIo(args) {
  const annotation = (base) => (folder, rel) => {
    const p = inside(base, folder, rel);
    return p && existsSync(p) ? readFileSync(p, 'utf8') : null;
  };
  return {
    readAnnotation: annotation(args.annotations),
    readAnnotationSevenths: annotation(args.annotationsSevenths ?? args.annotations),
    readChart(id) {
      const p = inside(args.charts, `${id}.json`);
      return p && existsSync(p) ? readJson(p) : null;
    },
  };
}

export async function run(args, m) {
  const mapsText = readFileSync(args.maps, 'utf8');
  const maps = m.parseMaps(JSON.parse(mapsText));
  for (const s of maps.songs) if (s.songList) s.songList = listKey(s.songList);
  const { files, fallback } = m.songListsToLoad(maps, args.songs.map((f) => listKey(path.resolve(f))));
  const lists = files.map((file) => ({ file, list: m.parseSongList(readJson(path.resolve(root, file))) }));
  const groups = args.groups ? m.parseGroups(readJson(args.groups), maps) : undefined;
  const inputs = {
    maps: path.resolve(args.maps),
    mapsSha256: sha256(mapsText),
    annotations: path.resolve(args.annotations),
    annotationsSevenths: path.resolve(args.annotationsSevenths ?? args.annotations),
    charts: path.resolve(args.charts),
    songLists: files.join(', '),
    groups: args.groups ? path.resolve(args.groups) : null,
  };
  return m.sequenceEvaluate(maps, lists, fileIo(args), { fallbackLists: fallback, groups, inputs, wholeChart: args.wholeChart === true });
}

export function runGap(args, m) {
  const [fa, fb] = args.gap;
  const ta = readFileSync(fa, 'utf8');
  const tb = readFileSync(fb, 'utf8');
  const inputs = { a: path.resolve(fa), aSha256: sha256(ta), b: path.resolve(fb), bSha256: sha256(tb) };
  return m.sequenceGap(m.parseSequenceResult(JSON.parse(ta), fa), m.parseSequenceResult(JSON.parse(tb), fb), { inputs });
}

const toJson = (v) => `${JSON.stringify(v, (_, x) => (typeof x === 'number' && !Number.isFinite(x) ? null : x), 2)}\n`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  const m = await loadModules();
  const result = args.gap ? runGap(args, m) : await run(args, m);
  if (args.out) {
    await writeFile(path.resolve(args.out), toJson(result), 'utf8');
    console.log(path.resolve(args.out));
  }
  console.log(args.gap ? m.gapSummary(result) : m.sequenceSummary(result));
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
