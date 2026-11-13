// The VGT-7 held-out Billboard list (PR #31), in three steps run in this order:
//   node scripts/heldout-songs.mjs titles --tree <uspop-tree.json> [--out docs/btc-uspop2002-titles.json]
//   node scripts/heldout-songs.mjs pool --index <billboard-2.0-index.csv> --labs <folder holding McGill-Billboard/>
//        [--archive <billboard-2.0.1-lab.tar.gz>] [--out docs/annotation-heldout-v1-pool.json]
//   node scripts/heldout-songs.mjs list --log <search-log.json> [--pool docs/annotation-heldout-v1-pool.json]
//        [--declared-at YYYY-MM-DD] [--out docs/annotation-eval-songs-heldout-v1.json]
//        [--uploads-out docs/annotation-heldout-v1-uploads.json] [--rule amended-v1|topic-only-v1]
//   node scripts/heldout-songs.mjs amend-log [--log docs/annotation-heldout-v1-search-log.json] [--pool ...]
//   node scripts/heldout-songs.mjs diff [--log ...] [--pool ...] [--out docs/annotation-heldout-v1-selection-diff.json]
//   node scripts/heldout-songs.mjs list-v2 --eligible-k <k> [--start-rank 33] [--pool ...] [--log ...]
//        [--declared-at YYYY-MM-DD] [--out docs/annotation-eval-songs-heldout-v2.json]
//        [--uploads-out docs/annotation-heldout-v2-uploads.json]
// titles: the UsPop2002 title list BTC trained on (rule 1). pool: the ordered pool with every
// exclusion. list: walks the pool with the search log and writes the song list and uploads
// (default rule amended-v1, the PR #31 amendment). amend-log: adds the amended-v1 decision to every
// log entry (original decisions unchanged). diff: the selection under both rules side by side.
// list-v2: the second held-out batch (PR #33) from the same pool and log, walked from the start rank
// under amended-v1 (recomputed from the raw results) to N songs, N from the size rule for k.
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

const USAGE = 'usage: node scripts/heldout-songs.mjs titles|pool|list|amend-log|diff|list-v2 [options] (see the header of this file)';

export function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === '--help' || cmd === '-h') return { help: true };
  if (!['titles', 'pool', 'list', 'amend-log', 'diff', 'list-v2'].includes(cmd)) throw new Error(`unknown step: ${cmd}\n${USAGE}`);
  const out = { cmd };
  const keys = { '--tree': 'tree', '--out': 'out', '--index': 'index', '--labs': 'labs', '--archive': 'archive', '--log': 'log', '--pool': 'pool', '--declared-at': 'declaredAt', '--uploads-out': 'uploadsOut', '--songs': 'songs', '--titles': 'titles', '--rule': 'rule', '--start-rank': 'startRank', '--eligible-k': 'eligibleK' };
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
  const need = { titles: ['tree'], pool: ['index', 'labs'], list: [], 'amend-log': [], diff: [], 'list-v2': ['eligibleK'] }[cmd];
  if (out.rule && !['amended-v1', 'topic-only-v1'].includes(out.rule)) throw new Error(`unknown rule: ${out.rule}`);
  for (const k of need) if (!out[k]) throw new Error(`${cmd} needs --${k === 'eligibleK' ? 'eligible-k' : k}\n${USAGE}`);
  for (const k of ['startRank', 'eligibleK']) {
    if (out[k] === undefined) continue;
    if (!/^\d+$/.test(out[k])) throw new Error(`--${k === 'eligibleK' ? 'eligible-k' : 'start-rank'} must be a whole number, got ${out[k]}`);
    out[k] = Number(out[k]);
  }
  return out;
}

async function loadModules() {
  const built = await esbuild.build({
    absWorkingDir: root,
    stdin: {
      contents: "export * from './src/eval/heldout-draw.ts'; export * from './src/eval/heldout-uploads.ts'; export * from './src/eval/heldout-list.ts'; export * from './src/eval/heldout-v2.ts'; export { parseSongList, parseUploads } from './src/eval/annotations.ts';",
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

function readPool(m, args) {
  const poolFile = args.pool ?? doc('annotation-heldout-v1-pool.json');
  const p = JSON.parse(readFileSync(poolFile, 'utf8'));
  if (p.schema !== m.POOL_SCHEMA) throw new Error(`${poolFile}: expected schema ${m.POOL_SCHEMA}`);
  return rankedFromPoolFile(p);
}

const logFile = (args) => args.log ?? doc('annotation-heldout-v1-search-log.json');
const billboardDataset = (m, args) => m.parseSongList(JSON.parse(readFileSync(args.songs ?? doc('annotation-eval-songs.json'), 'utf8'))).datasets[m.BILLBOARD_DATASET];

export const AMENDMENT = {
  rule: 'amended-v1',
  replaces: 'topic-only-v1',
  decidedAt: '2026-11-13',
  recordedAt: '2026-11-13',
  before: 'any capture, chart or accuracy result of a held-out song',
  topicOnlyChannelRule: "the channel name ends with ' - Topic', and its artist part, normalized, contains or is contained in the normalized Billboard artist (normalized Topic artist part nonempty)",
  amendedChannelRule:
    "A result satisfies the channel condition if either: (1) its channel name ends with the exact suffix ' - Topic', and the channel name with that suffix removed and the Billboard artist, both normalized by the existing normalization, are nonempty and either contains the other; or (2) its channel name does not end with that suffix, its recorded extra.snippet starts exactly and case-sensitively with 'Provided to YouTube by', its recorded extra.ownerBadges contains BADGE_STYLE_TYPE_VERIFIED_ARTIST, and its full channel name and the Billboard artist, normalized as above, are nonempty and either contains the other. Missing snippet or badge data fails branch (2).",
  reason:
    "Under topic-only-v1 only 25 of 136 searched songs qualified: artists with an official artist channel publish their auto-generated 'Provided to YouTube' tracks under the artist channel name, not '<artist> - Topic', so the rule kept mostly artists without such a channel. Decided by the Paseo parent after an Astra advisor round, before any capture; re-judged from this same log, no new searches. All other conditions, query limits, ordering, tie-break and the stop at 25 are unchanged.",
  unchanged: 'decision (topic-only-v1) of every entry is left as it was; decisionAmended is added',
};

async function amendLogCmd(m, args) {
  const file = logFile(args);
  const log = JSON.parse(readFileSync(file, 'utf8'));
  const amended = m.amendLog(readPool(m, args), log);
  const counts = (status) => amended.entries.filter((e) => e.decisionAmended.status === status).length;
  const stop = amended.entries.filter((e) => e.decisionAmended.status !== 'not-needed').at(-1).rank;
  const out = {
    ...amended,
    notes: [...(log.notes ?? []).filter((n) => !n.startsWith('Amendment amended-v1')), `Amendment amended-v1 (${AMENDMENT.decidedAt}): ${AMENDMENT.reason} Each entry keeps 'decision' (topic-only-v1) and gains 'decisionAmended'; entries past the amended stop (rank ${stop}) are '${m.NOT_NEEDED_REASON}'.`],
    amendment: AMENDMENT,
    amended: { rule: 'amended-v1', stoppedAtRank: stop, chosen: counts('chosen'), skipped: counts('skipped'), notNeeded: counts('not-needed') },
  };
  await writeFile(file, json(out), 'utf8');
  console.log(`${file}: amended stop rank ${stop}, chosen ${out.amended.chosen}, skipped ${out.amended.skipped}, not needed ${out.amended.notNeeded}`);
}

async function diff(m, args) {
  const order = readPool(m, args);
  const log = JSON.parse(readFileSync(logFile(args), 'utf8'));
  const dataset = billboardDataset(m, args);
  const a = m.buildHeldoutList({ order, log, dataset, declaredAt: 'x', rule: 'topic-only-v1' });
  const b = m.buildHeldoutList({ order, log, dataset, declaredAt: 'x', rule: 'amended-v1' });
  const out = {
    ...m.selectionDiff(order, a, b),
    purpose: 'Selection-sensitivity record of the VGT-7 held-out list (PR #31 amendment): the same pool and search log walked under the original topic-only-v1 rule and the amended-v1 rule. The list uses amended-v1; the songs only in the topic-only selection are not captured.',
    sources: { pool: 'docs/annotation-heldout-v1-pool.json', searchLog: 'docs/annotation-heldout-v1-search-log.json' },
  };
  const file = args.out ?? doc('annotation-heldout-v1-selection-diff.json');
  await writeFile(file, json(out), 'utf8');
  console.log(`${file}: topic-only stop ${a.stopRank}, amended stop ${b.stopRank}, overlap ${out.overlap.length}`);
}

async function list(m, args) {
  const rule = args.rule ?? 'amended-v1';
  const dataset = billboardDataset(m, args);
  const log = JSON.parse(readFileSync(logFile(args), 'utf8'));
  const declaredAt = args.declaredAt ?? new Date().toISOString().slice(0, 10);
  const r = m.buildHeldoutList({ order: readPool(m, args), log, dataset, declaredAt, rule });
  m.parseSongList(r.list);
  m.parseUploads(r.uploads);
  const listFile = args.out ?? doc('annotation-eval-songs-heldout-v1.json');
  const uploadsFile = args.uploadsOut ?? doc('annotation-heldout-v1-uploads.json');
  await writeFile(listFile, json(r.list), 'utf8');
  await writeFile(uploadsFile, json({ $comment: `Uploads chosen by the PR #31 search under rule ${rule} (docs/annotation-heldout-v1-search-log.json); copy into the charts folder as uploads.json.`, ...r.uploads }), 'utf8');
  console.log(`${listFile}: rule ${rule}, stop rank ${r.stopRank}, ${r.chosen.length} songs; skipped ${r.skipped.length} (ranks ${r.skipped.map((s) => s.rank).join(', ') || 'none'})`);
  console.log(uploadsFile);
}

async function listV2(m, args) {
  const size = m.heldoutV2Size(args.eligibleK);
  const declaredAt = args.declaredAt ?? new Date().toISOString().slice(0, 10);
  const log = JSON.parse(readFileSync(logFile(args), 'utf8'));
  const r = m.buildHeldoutV2List({ order: readPool(m, args), log, dataset: billboardDataset(m, args), declaredAt, size, startRank: args.startRank ?? m.V2_START_RANK });
  m.parseSongList(r.list);
  m.parseUploads(r.uploads);
  const listFile = args.out ?? doc('annotation-eval-songs-heldout-v2.json');
  const uploadsFile = args.uploadsOut ?? doc('annotation-heldout-v2-uploads.json');
  await writeFile(listFile, json(r.list), 'utf8');
  await writeFile(
    uploadsFile,
    json({ $comment: `Uploads of the v2 held-out batch (PR #33): docs/annotation-heldout-v1-search-log.json walked from rank ${r.startRank} under rule ${r.rule}; copy into the charts folder as uploads.json.`, ...r.uploads }),
    'utf8',
  );
  console.log(`${listFile}: rule ${r.rule}, k ${size.k}, N ${size.n} (P ${size.probability.toFixed(4)}), start rank ${r.startRank}, stop rank ${r.stopRank}, ${r.chosen.length} songs; skipped ${r.skipped.length}`);
  console.log(uploadsFile);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  const m = await loadModules();
  await { titles, pool, list, 'amend-log': amendLogCmd, diff, 'list-v2': listV2 }[args.cmd](m, args);
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
