/**
 * The predeclared held-out Billboard pool and draw of VGT-7 (PR #31, frozen before any result):
 * normalization, one canonical entry per song, the four exclusion rules in order and the seeded
 * order. Pure apart from sha256; the script scripts/heldout-songs.mjs supplies the files.
 */
import { createHash } from 'node:crypto';
import { chordChangeLandmarks, parseLab, type AnnotationSegment } from './annotations';

export const POOL_SCHEMA = 'vibe-guitar-annotation-heldout-pool/1';
export const USPOP_TITLES_SCHEMA = 'vibe-guitar-btc-uspop2002-titles/1';
export const DRAW_SEED = 'vgt7-billboard-heldout-v1';
/** Fewer chord-change landmarks than this and alignment would exclude the song. */
export const MIN_CHANGES = 12;
export const EXCLUSION_REASONS = ['btc-uspop-title', 'btc-isophonics-or-rw-artist', 'already-seen', 'too-few-changes'] as const;
export type PoolExclusion = (typeof EXCLUSION_REASONS)[number];
/** Isophonics artists BTC trained on, plus Robbie Williams. */
export const BTC_ARTISTS = ['The Beatles', 'Queen', 'Carole King', 'Zweieck', 'Robbie Williams'];

/**
 * Lower case; `&` -> `and`; drop parenthesized parts; drop a leading `the ` (after trimming the
 * spaces the earlier steps can leave); keep only [a-z0-9].
 */
export function normalize(text: string): string {
  let t = text.toLowerCase().replace(/&/g, 'and').replace(/\([^)]*\)/g, '').trim();
  if (t.startsWith('the ')) t = t.slice(4);
  return t.replace(/[^a-z0-9]/g, '');
}

/** RFC 4180 style: comma separated, double-quoted fields with "" for a quote. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.length > 1 || r[0] !== '');
}

export interface IndexRow {
  id: number;
  chartDate: string;
  title: string;
  artist: string;
}

export function parseBillboardIndex(text: string): IndexRow[] {
  const [head, ...rows] = parseCsv(text);
  const col = (name: string) => {
    const i = head.indexOf(name);
    if (i < 0) throw new Error(`billboard index: no ${name} column`);
    return i;
  };
  const [id, date, title, artist] = [col('id'), col('chart_date'), col('title'), col('artist')];
  return rows.map((r) => {
    const n = Number(r[id]);
    if (!Number.isInteger(n) || n <= 0) throw new Error(`billboard index: bad id "${r[id]}"`);
    return { id: n, chartDate: r[date] ?? '', title: r[title] ?? '', artist: r[artist] ?? '' };
  });
}

export const id4 = (id: number) => String(id).padStart(4, '0');
export const labPath = (id: number) => `McGill-Billboard/${id4(id)}/full.lab`;

export interface UsPopTitle {
  path: string;
  artist: string;
  title: string;
}

/**
 * uspopLabels/<artist>/<album>/<NN-Title>.lab files of a GitHub tree response (RWC and anything
 * else ignored). Title: file name without the extension, invisible format characters and the
 * track number; underscores become spaces.
 */
export function usPopTitlesFromTree(tree: { tree: { path: string; type: string }[] }): UsPopTitle[] {
  return tree.tree
    .filter((e) => e.type === 'blob' && /^uspopLabels\/[^/]+\/[^/]+\/[^/]+\.lab$/.test(e.path))
    .map((e) => {
      const [, artist, , file] = e.path.split('/');
      const title = file
        .replace(/\.lab$/, '')
        .replace(/^\p{Cf}+/u, '')
        .replace(/^\d+[-_ ]*/, '')
        .replace(/_/g, ' ');
      return { path: e.path, artist: artist.replace(/_/g, ' '), title };
    })
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Python round(x, 2) on the float (half to even on exact ties), as make_list.py does. */
export function round2(x: number): number {
  const s = x * 100;
  const f = Math.floor(s);
  // An exact .5 at the third decimal needs x to be a multiple of 1/8 (binary exact).
  if (s - f === 0.5 && Number.isInteger(x * 8)) return (f % 2 === 0 ? f : f + 1) / 100;
  return Number(x.toFixed(2));
}

export type Complexity = 'simple' | 'moderate' | 'complex';

/**
 * Annotation length and complexity exactly as the existing list computed them (make_list.py
 * stats()): length = latest segment end rounded to 2 decimals; over chord time (N and X ignored),
 * complex when >= 20 distinct labels or >= 40% is not a plain major/minor triad, simple when <= 10
 * labels and < 20%, otherwise moderate. Complexity is null when the file has no chord time.
 */
export function annotationStats(segs: AnnotationSegment[]): { durationSec: number; complexity: Complexity | null; changes: number } {
  let total = 0;
  let plain = 0;
  const labels = new Set<string>();
  for (const s of segs) {
    if (s.label === 'N' || s.label === 'X') continue;
    total += s.endSec - s.startSec;
    labels.add(s.label);
    if (/^[A-G][#b]*(:(maj|min))?$/.test(s.label)) plain += s.endSec - s.startSec;
  }
  let complexity: Complexity | null = null;
  if (total > 0) {
    const non = 1 - plain / total;
    complexity = labels.size >= 20 || non >= 0.4 ? 'complex' : labels.size <= 10 && non < 0.2 ? 'simple' : 'moderate';
  }
  const durationSec = segs.length ? round2(Math.max(...segs.map((s) => s.endSec))) : 0;
  return { durationSec, complexity, changes: chordChangeLandmarks(segs).length };
}

export const rankKey = (id: number) => createHash('sha256').update(`${DRAW_SEED}:${id4(id)}`).digest('hex');

export interface PoolSong {
  /** Canonical (numerically lowest) id. */
  id: number;
  /** Every index entry of the song, ascending. */
  ids: number[];
  artist: string;
  title: string;
  chartDate: string;
  annotationDurationSec: number;
  complexity: Complexity | null;
  changes: number;
}

export interface RankedSong extends PoolSong {
  rank: number;
  key: string;
}

export interface ExcludedSong extends PoolSong {
  reason: PoolExclusion;
  /** What matched (UsPop path, artist, already-seen id or change count). */
  detail: string;
}

export interface PoolInput {
  index: IndexRow[];
  /** Text of McGill-Billboard/<id4>/full.lab, or null when the archive has none. */
  readLab(id: number): string | null;
  usPopTitles: UsPopTitle[];
  /** Billboard ids of the songs already on an earlier list. */
  alreadySeenIds: number[];
}

export interface PoolResult {
  counts: {
    indexRows: number;
    rowsWithTitle: number;
    entriesWithLab: number;
    uniqueSongs: number;
    excluded: Record<PoolExclusion, number>;
    eligible: number;
  };
  excluded: Record<PoolExclusion, ExcludedSong[]>;
  order: RankedSong[];
}

export function buildPool(input: PoolInput): PoolResult {
  const withTitle = input.index.filter((r) => r.title.trim() !== '');
  const labs = new Map<number, string>();
  for (const r of withTitle) {
    const t = input.readLab(r.id);
    if (t !== null) labs.set(r.id, t);
  }
  const entries = withTitle.filter((r) => labs.has(r.id));
  const groups = new Map<string, IndexRow[]>();
  for (const r of entries) {
    const k = `${normalize(r.artist)}\u0000${normalize(r.title)}`;
    const g = groups.get(k);
    if (g) g.push(r);
    else groups.set(k, [r]);
  }
  const uspop = new Map<string, string>();
  for (const u of input.usPopTitles) {
    const k = normalize(u.title);
    if (!uspop.has(k)) uspop.set(k, u.path);
  }
  const btcArtists = new Set(BTC_ARTISTS.map(normalize));
  const seen = new Set(input.alreadySeenIds);
  const excluded = Object.fromEntries(EXCLUSION_REASONS.map((r) => [r, [] as ExcludedSong[]])) as Record<PoolExclusion, ExcludedSong[]>;
  const eligible: PoolSong[] = [];
  for (const g of groups.values()) {
    g.sort((a, b) => a.id - b.id);
    const c = g[0];
    const stats = annotationStats(parseLab(labs.get(c.id)!));
    const song: PoolSong = { id: c.id, ids: g.map((r) => r.id), artist: c.artist, title: c.title, chartDate: c.chartDate, annotationDurationSec: stats.durationSec, complexity: stats.complexity, changes: stats.changes };
    const hitUspop = uspop.get(normalize(c.title));
    const hitSeen = song.ids.find((i) => seen.has(i));
    let reason: [PoolExclusion, string] | null = null;
    if (hitUspop !== undefined) reason = ['btc-uspop-title', hitUspop];
    else if (btcArtists.has(normalize(c.artist))) reason = ['btc-isophonics-or-rw-artist', c.artist];
    else if (hitSeen !== undefined) reason = ['already-seen', id4(hitSeen)];
    else if (stats.changes < MIN_CHANGES) reason = ['too-few-changes', `${stats.changes} changes`];
    if (reason) excluded[reason[0]].push({ ...song, reason: reason[0], detail: reason[1] });
    else eligible.push(song);
  }
  for (const r of EXCLUSION_REASONS) excluded[r].sort((a, b) => a.id - b.id);
  const order = eligible
    .map((s) => ({ ...s, key: rankKey(s.id) }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.id - b.id))
    .map((s, i) => ({ rank: i + 1, ...s }));
  return {
    counts: {
      indexRows: input.index.length,
      rowsWithTitle: withTitle.length,
      entriesWithLab: entries.length,
      uniqueSongs: groups.size,
      excluded: Object.fromEntries(EXCLUSION_REASONS.map((r) => [r, excluded[r].length])) as Record<PoolExclusion, number>,
      eligible: order.length,
    },
    excluded,
    order,
  };
}

/** Billboard ids (from McGill-Billboard/<id>/full.lab chord paths) of a song list's Billboard songs. */
export function billboardIdsOfList(list: { songs: { dataset: string; chords: string }[] }, dataset = 'billboard-2.0.1-lab'): number[] {
  return list.songs
    .filter((s) => s.dataset === dataset)
    .map((s) => {
      const m = /^McGill-Billboard\/(\d{4})\/full\.lab$/.exec(s.chords);
      if (!m) throw new Error(`not a Billboard chord path: ${s.chords}`);
      return Number(m[1]);
    });
}
