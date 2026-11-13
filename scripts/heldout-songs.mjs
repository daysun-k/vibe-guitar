// The VGT-7 held-out Billboard list (PR #31), in three steps run in this order:
//   node scripts/heldout-songs.mjs titles --tree <uspop-tree.json> [--out docs/btc-uspop2002-titles.json]
//   node scripts/heldout-songs.mjs pool --index <billboard-2.0-index.csv> --labs <folder holding McGill-Billboard/>
//        [--archive <billboard-2.0.1-lab.tar.gz>] [--out docs/annotation-heldout-v1-pool.json]
//   node scripts/heldout-songs.mjs list --log <search-log.json> [--pool docs/annotation-heldout-v1-pool.json]
//        [--declared-at YYYY-MM-DD] [--out docs/annotation-eval-songs-heldout-v1.json]
//        [--uploads-out docs/annotation-heldout-v1-uploads.json]
// titles: the UsPop2002 title list BTC trained on (rule 1). pool: the ordered pool with every
// exclusion. list: walks the pool with the search log and writes the song list and uploads.
// Bundles src/eval/heldout-*.ts in memory with esbuild; reads and writes local files only.
import * as esbuild from 'esbuild';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const doc = (f) => path.join(root, 'docs', f);

export const USPOP_SOURCE = {
  repository: 'https://github.com/tmc323/Chord-Annotations',
  treeSha: '4b022ff5a95ff1d9ba1057ea4c982e45484d764f',
  treeFileSha256: 'dfbb885d245371c253ba4bdce0c425b15f2c8eada26a61ceb152f8fb255d8269',
};
export const LAB_ARCHIVE_SHA256 = '78c07c6a7cc10622228146f14820b05e94e09dd6eb211c3c5e93048560f39831';
export const INDEX_SHA256 = 'fc39435098814f1a4f1dd5c95c72aff399b648b78f33a59682924dfb9b5280fb';

const USAGE = 'usage: node scripts/heldout-songs.mjs titles|pool|list [options] (see the header of this file)';

export function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === '--help' || cmd === '-h') return { help: true };
  if (!['titles', 'pool', 'list'].includes(cmd)) throw new Error(`unknown step: ${cmd}\n${USAGE}`);
  const out = { cmd };
  const keys = { '--tree': 'tree', '--out': 'out', '--index': 'index', '--labs': 'labs', '--archive': 'archive', '--log': 'log', '--pool': 'pool', '--declared-at': 'declaredAt', '--uploads-out': 'uploadsOut', '--songs': 'songs', '--titles': 'titles' };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    const eq = a.indexOf('=');
    const flag = eq > 0 ? a.slice(0, eq) : a;
    const key = keys[flag];
    if (!key) throw new Error(`unknown argument: ${a}\n${USAGE}`);
    const value = eq > 0 ? a.slice(eq + 1) : rest[++i];
    if (!value) throw new Error(`${flag} needs a value`);
    out[key] = value;
  }
  const need = { titles: ['tree'], pool: ['index', 'labs'], list: ['log'] }[cmd];
  for (const k of need) if (!out[k]) throw new Error(`${cmd} needs --${k}\n${USAGE}`);
  return out;
}

async function loadModules() {
  const built = await esbuild.build({
    absWorkingDir: root,
    stdin: {
      contents: "export * from './src/eval/heldout-draw.ts'; export * from './src/eval/heldout-uploads.ts'; export * from './src/eval/heldout-list.ts'; export { parseSongList, parseUploads } from './src/eval/annotations.ts';",
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

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const rel = (p) => path.relative(root, path.resolve(p)) || '.';
const json = (v) => `${JSON.stringify(v, null, 2)}\n`;

async function titles(m, args) {
  const buf = readFileSync(args.tree);
  const hash = sha256(buf);
  if (hash !== USPOP_SOURCE.treeFileSha256) throw new Error(`tree file sha256 ${hash} is not the frozen ${USPOP_SOURCE.treeFileSha256}`);
  const tree = JSON.parse(buf.toString('utf8'));
  if (tree.sha !== USPOP_SOURCE.treeSha || tree.truncated) throw new Error(`tree ${tree.sha} (truncated ${tree.truncated}) is not the frozen ${USPOP_SOURCE.treeSha}`);
  const entries = m.usPopTitlesFromTree(tree);
  const out = {
    schema: m.USPOP_TITLES_SCHEMA,
    purpose: "UsPop2002 chord annotations BTC lists as training data (uspopLabels/<artist>/<album>/<NN-Title>.lab; RWC_Pop_Chords ignored), for exclusion rule 1 of the VGT-7 held-out list (PR #31). Title = file name without the track number (and without invisible format characters), underscores as spaces; artist = folder name, underscores as spaces.",
    source: { ...USPOP_SOURCE, path: 'uspopLabels/**/*.lab' },
    count: entries.length,
    entries,
  };
  const file = args.out ?? doc('btc-uspop2002-titles.json');
  await writeFile(file, json(out), 'utf8');
  console.log(`${file}: ${entries.length} titles`);
}

async function pool(m, args) {
  const indexBuf = readFileSync(args.index);
  const indexHash = sha256(indexBuf);
  if (indexHash !== INDEX_SHA256) throw new Error(`index sha256 ${indexHash} is not the frozen ${INDEX_SHA256}`);
  let archiveHash = null;
  if (args.archive) {
    archiveHash = sha256(readFileSync(args.archive));
    if (archiveHash !== LAB_ARCHIVE_SHA256) throw new Error(`LAB archive sha256 ${archiveHash} is not the frozen ${LAB_ARCHIVE_SHA256}`);
  }
  const titlesFile = args.titles ?? doc('btc-uspop2002-titles.json');
  const titlesText = readFileSync(titlesFile, 'utf8');
  const songsFile = args.songs ?? doc('annotation-eval-songs.json');
  const songsText = readFileSync(songsFile, 'utf8');
  const seenIds = m.billboardIdsOfList(m.parseSongList(JSON.parse(songsText)));
  const labHashes = [];
  const result = m.buildPool({
    index: m.parseBillboardIndex(indexBuf.toString('utf8')),
    readLab(id) {
      const p = path.join(args.labs, m.labPath(id));
      if (!existsSync(p)) return null;
      const buf = readFileSync(p);
      labHashes.push(`${m.labPath(id)} ${sha256(buf)}`);
      return buf.toString('utf8');
    },
    usPopTitles: JSON.parse(titlesText).entries,
    alreadySeenIds: seenIds,
  });
  const labDirs = readdirSync(path.join(args.labs, 'McGill-Billboard')).filter((d) => /^\d{4}$/.test(d)).length;
  labHashes.sort();
  const out = {
    schema: m.POOL_SCHEMA,
    purpose: 'Ordered pool of the VGT-7 held-out Billboard list, committed before the upload search (PR #31). The song list takes songs from the top of this order.',
    seed: m.DRAW_SEED,
    orderRule: `sha256("${m.DRAW_SEED}:" + canonical id as 4 digits) as hex ascending; ties by numeric id`,
    normalization: 'lower case; & -> and; drop parenthesized parts; drop a leading "the " (after trimming); keep only [a-z0-9]',
    canonical: 'one song per (normalized artist, normalized title) over index rows with a title and a McGill-Billboard/<id>/full.lab; canonical entry = numerically lowest id; artist, title, chart date and annotation from it',
    exclusionOrder: m.EXCLUSION_REASONS,
    minChanges: m.MIN_CHANGES,
    btcArtists: m.BTC_ARTISTS,
    sources: {
      billboardIndex: { file: 'billboard-2.0-index.csv', sha256: indexHash },
      billboardLab: {
        archive: 'billboard-2.0.1-lab.tar.gz',
        sha256: LAB_ARCHIVE_SHA256,
        archiveVerified: archiveHash !== null,
        labFolders: labDirs,
        labFilesRead: labHashes.length,
        labFilesSha256: sha256(`${labHashes.join('\n')}\n`),
        labFilesSha256Rule: 'sha256 of the sorted lines "<path> <sha256 of file>" joined by \\n with a trailing \\n, over every lab file read',
      },
      usPopTitles: { file: rel(titlesFile), sha256: sha256(titlesText) },
      alreadySeen: { file: rel(songsFile), sha256: sha256(songsText), ids: seenIds.map(m.id4) },
    },
    counts: result.counts,
    excluded: Object.fromEntries(Object.entries(result.excluded).map(([k, v]) => [k, v.map((s) => ({ id: m.id4(s.id), ids: s.ids.map(m.id4), artist: s.artist, title: s.title, detail: s.detail }))])),
    order: result.order.map((s) => ({ rank: s.rank, id: m.id4(s.id), ids: s.ids.map(m.id4), artist: s.artist, title: s.title, chartDate: s.chartDate, annotationDurationSec: s.annotationDurationSec, complexity: s.complexity, changes: s.changes, key: s.key })),
  };
  const file = args.out ?? doc('annotation-heldout-v1-pool.json');
  await writeFile(file, json(out), 'utf8');
  const c = result.counts;
  console.log(`${file}: index rows ${c.indexRows}, with title ${c.rowsWithTitle}, with LAB ${c.entriesWithLab}, unique songs ${c.uniqueSongs}, eligible ${c.eligible}`);
  console.log(`excluded: ${Object.entries(c.excluded).map(([k, v]) => `${k} ${v}`).join(', ')}`);
}

/** Pool file order -> RankedSong (numeric ids). */
export function rankedFromPoolFile(p) {
  return p.order.map((s) => ({ ...s, id: Number(s.id), ids: s.ids.map(Number) }));
}

async function list(m, args) {
  const poolFile = args.pool ?? doc('annotation-heldout-v1-pool.json');
  const p = JSON.parse(readFileSync(poolFile, 'utf8'));
  if (p.schema !== m.POOL_SCHEMA) throw new Error(`${poolFile}: expected schema ${m.POOL_SCHEMA}`);
  const existing = m.parseSongList(JSON.parse(readFileSync(args.songs ?? doc('annotation-eval-songs.json'), 'utf8')));
  const dataset = existing.datasets[m.BILLBOARD_DATASET];
  const log = JSON.parse(readFileSync(args.log, 'utf8'));
  const declaredAt = args.declaredAt ?? new Date().toISOString().slice(0, 10);
  const r = m.buildHeldoutList({ order: rankedFromPoolFile(p), log, dataset, declaredAt });
  m.parseSongList(r.list);
  m.parseUploads(r.uploads);
  const listFile = args.out ?? doc('annotation-eval-songs-heldout-v1.json');
  const uploadsFile = args.uploadsOut ?? doc('annotation-heldout-v1-uploads.json');
  await writeFile(listFile, json(r.list), 'utf8');
  await writeFile(uploadsFile, json({ $comment: 'Uploads chosen by the frozen PR #31 search (docs/annotation-heldout-v1-search-log.json); copy into the charts folder as uploads.json.', ...r.uploads }), 'utf8');
  console.log(`${listFile}: ${r.chosen.length} songs; skipped ${r.skipped.length} (ranks ${r.skipped.map((s) => s.rank).join(', ') || 'none'})`);
  console.log(uploadsFile);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  const m = await loadModules();
  await { titles, pool, list }[args.cmd](m, args);
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
