/**
 * Chord-order comparison (VGT-21 amendment 1, docs/kpop-eval-protocol.md; docs/recognition-replay.md):
 * reference and chart are each reduced to a sequence of chord tokens with no timing, aligned by
 * global edit distance, and scored by matches, recall, precision and F in three views
 * (majmin, root, sevenths), plus an error anatomy of the majmin alignment.
 *
 * Tokens
 * - Reference: each LAB segment through parseLab/harteToSymbol. N is dropped; X and unmapped
 *   labels become the WILDCARD token; a chord becomes its view token (below). With a time window
 *   (the default), only segments whose mapped span (media = offsetSec + rate × t, cut at
 *   mediaDurationSec) overlaps the chart's coverage are kept, so a partly captured song is compared
 *   on the captured part. Consecutive equal tokens are collapsed (consecutive wildcards too).
 * - Chart: the chart's events inside its coverage (chartIntervals, as WCSR reads them), N dropped,
 *   same view token, consecutive equal tokens collapsed.
 * - View tokens: majmin = majminLabel of the boundary metric ("<pc>:maj" / "<pc>:min"; a chord
 *   outside majmin keeps its own symbol as "other:<symbol>"); root = the root pitch class
 *   (a symbol without a parseable root is dropped like N); sevenths = the evaluator's sevenths
 *   reduction ("<pc>:maj|min|7|maj7|min7"; outside it "other:<symbol>"). The sevenths reference
 *   may come from a second annotation root (sevenths-level labels).
 *
 * Alignment (alignSequences): global edit distance with substitution, insertion and deletion cost 1
 * and a match cost 0. A reference WILDCARD stands for an unknown stretch: it absorbs zero or more
 * consecutive chart tokens at cost 0 and is excluded from every count, as are the chart tokens it
 * absorbs. Tie-break, on the backward trace from the end of both sequences: in a wildcard row,
 * closing the wildcard first, then absorbing the chart token (so at equal cost a chart token is
 * counted, e.g. as a substitution of a known neighbour, rather than hidden by the wildcard); in any
 * other row, the diagonal (match or substitution) first, then deletion, then insertion. The trace
 * is therefore unique.
 *
 * Counts per view: matches; recall = matches / non-wildcard reference tokens; precision = matches /
 * chart tokens not absorbed by a wildcard; F = 2 × matches / (reference tokens + counted chart
 * tokens) (the harmonic mean of the two; 0 when nothing matches, NaN only when both are empty).
 */
import { parseChord } from '../arrange/chord';
import { normalizeCoverage } from '../chart/coverage';
import type { Chart, CoverageRange } from '../chart/types';
import { chartIntervals, reduceSymbol } from './metrics';
import { chartFromExport, EvalInputError, harteToSymbol, parseLab, type AnnotationSegment, type EvalIo, type SongEntry, type SongList } from './annotations';
import { lookupSongs, majminLabel, type MapEntry, type NamedSongList, type PairedMaps } from './paired';
import { bootstrapMeanCi, BOOTSTRAP_RESAMPLES, BOOTSTRAP_SEED, CI_LEVEL, mulberry32, quantile } from './song-mean';

export const SEQUENCE_RESULT_SCHEMA = 'vibe-guitar-sequence-eval/1';
export const SEQUENCE_GAP_SCHEMA = 'vibe-guitar-sequence-gap/1';
/** Reference token that matches anything and is never counted. */
export const WILDCARD = '*';
/** The gap bootstrap resamples file A with BOOTSTRAP_SEED and file B with this seed (two mulberry32 streams). */
export const GAP_SEED_B = 7008;

export type View = 'majmin' | 'root' | 'sevenths';
export const VIEWS: View[] = ['majmin', 'root', 'sevenths'];
export type Rate = 'recall' | 'precision' | 'f';
export const RATES: Rate[] = ['recall', 'precision', 'f'];

// ---------------------------------------------------------------- Tokens

/** View token of a chart or reference chord symbol; null when it is dropped (N, or no root in the root view). */
export function viewToken(symbol: string, view: View): string | null {
  if (view === 'majmin') {
    const t = majminLabel(symbol);
    return t === 'N' ? null : t;
  }
  if (view === 'root') {
    const r = reduceSymbol(symbol, 'root');
    return r === null || r === 'N' ? null : r;
  }
  const s = reduceSymbol(symbol, 'sevenths') ?? `other:${symbol}`;
  return s === 'N' ? null : s;
}

/** Consecutive equal tokens collapsed into one (wildcards too). */
export function collapse(tokens: string[]): string[] {
  return tokens.filter((t, i) => i === 0 || t !== tokens[i - 1]);
}

/** The time window a reference is cut to: the song's frozen map and the chart's coverage (media time). */
export interface ReferenceWindow {
  offsetSec: number;
  rate: number;
  mediaDurationSec: number | null;
  coverage: CoverageRange[];
}

/** Reference tokens of LAB segments; with a window, only segments overlapping the chart's coverage after mapping. */
export function referenceTokens(segs: AnnotationSegment[], view: View, window: ReferenceWindow | null = null): string[] {
  const ranges = window ? normalizeCoverage(window.coverage) : [];
  const out: string[] = [];
  for (const s of [...segs].sort((a, b) => a.startSec - b.startSec)) {
    if (window) {
      const from = window.offsetSec + window.rate * s.startSec;
      const to = Math.min(window.offsetSec + window.rate * s.endSec, window.mediaDurationSec ?? Infinity);
      if (!ranges.some((r) => Math.min(to, r.toSec) > Math.max(from, r.fromSec))) continue;
    }
    const h = harteToSymbol(s.label);
    if (h.kind === 'N') continue;
    if (h.kind === 'X' || h.kind === 'unmapped') {
      out.push(WILDCARD);
      continue;
    }
    const t = viewToken(h.symbol, view);
    if (t !== null) out.push(t);
  }
  return collapse(out);
}

/** Chart tokens: events inside the chart's coverage, N dropped, consecutive equal tokens collapsed. */
export function chartTokens(chart: Chart, view: View): string[] {
  return collapse(
    chartIntervals(chart.events, chart.coverage)
      .map((i) => viewToken(i.symbol, view))
      .filter((t): t is string => t !== null),
  );
}

// ---------------------------------------------------------------- Alignment

export type AlignOp =
  | { op: 'match' | 'sub'; ref: number; est: number }
  | { op: 'del'; ref: number; est: null }
  | { op: 'ins'; ref: null; est: number }
  /** A chart token absorbed by a reference wildcard, or (est null) a wildcard that absorbed nothing. */
  | { op: 'wild'; ref: number; est: number | null };

/** Optimal global alignment (see the module comment for costs and the tie-break), in sequence order. */
export function alignSequences(ref: string[], est: string[]): { ops: AlignOp[]; cost: number } {
  const n = ref.length;
  const m = est.length;
  const D: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let j = 1; j <= m; j++) D[0][j] = j;
  for (let i = 1; i <= n; i++) {
    const wild = ref[i - 1] === WILDCARD;
    D[i][0] = D[i - 1][0] + (wild ? 0 : 1);
    for (let j = 1; j <= m; j++) {
      if (wild) D[i][j] = Math.min(D[i - 1][j], D[i][j - 1]);
      else D[i][j] = Math.min(D[i - 1][j - 1] + (ref[i - 1] === est[j - 1] ? 0 : 1), D[i - 1][j] + 1, D[i][j - 1] + 1);
    }
  }
  const ops: AlignOp[] = [];
  let i = n;
  let j = m;
  let absorbed = false;
  while (i > 0 || j > 0) {
    if (i > 0 && ref[i - 1] === WILDCARD) {
      if (D[i][j] === D[i - 1][j]) {
        if (!absorbed) ops.push({ op: 'wild', ref: i - 1, est: null });
        absorbed = false;
        i--;
      } else {
        ops.push({ op: 'wild', ref: i - 1, est: j - 1 });
        absorbed = true;
        j--;
      }
      continue;
    }
    if (i > 0 && j > 0 && D[i][j] === D[i - 1][j - 1] + (ref[i - 1] === est[j - 1] ? 0 : 1)) {
      ops.push({ op: ref[i - 1] === est[j - 1] ? 'match' : 'sub', ref: i - 1, est: j - 1 });
      i--;
      j--;
    } else if (i > 0 && D[i][j] === D[i - 1][j] + 1) {
      ops.push({ op: 'del', ref: i - 1, est: null });
      i--;
    } else {
      ops.push({ op: 'ins', ref: null, est: j - 1 });
      j--;
    }
  }
  return { ops: ops.reverse(), cost: D[n][m] };
}

export interface ViewScore {
  /** Non-wildcard reference tokens (recall denominator). */
  refTokens: number;
  refWildcards: number;
  chartTokens: number;
  /** Chart tokens not absorbed by a wildcard (precision denominator). */
  chartCounted: number;
  matches: number;
  substitutions: number;
  deletions: number;
  insertions: number;
  /** Chart tokens absorbed by wildcards. */
  absorbed: number;
  editDistance: number;
  recall: number;
  precision: number;
  f: number;
}

export function scoreTokens(ref: string[], est: string[]): { score: ViewScore; ops: AlignOp[] } {
  const { ops, cost } = alignSequences(ref, est);
  const count = (op: AlignOp['op']) => ops.filter((o) => o.op === op).length;
  const refWildcards = ref.filter((t) => t === WILDCARD).length;
  const refTokens = ref.length - refWildcards;
  const absorbed = ops.filter((o) => o.op === 'wild' && o.est !== null).length;
  const chartCounted = est.length - absorbed;
  const matches = count('match');
  const score: ViewScore = {
    refTokens,
    refWildcards,
    chartTokens: est.length,
    chartCounted,
    matches,
    substitutions: count('sub'),
    deletions: count('del'),
    insertions: count('ins'),
    absorbed,
    editDistance: cost,
    recall: refTokens ? matches / refTokens : NaN,
    precision: chartCounted ? matches / chartCounted : NaN,
    f: refTokens + chartCounted ? (2 * matches) / (refTokens + chartCounted) : NaN,
  };
  return { score, ops };
}

// ---------------------------------------------------------------- Error anatomy (majmin)

export type SubClass = 'fifth' | 'parallel' | 'relative' | 'semitone' | 'other';
export const SUB_CLASSES: SubClass[] = ['fifth', 'parallel', 'relative', 'semitone', 'other'];
export type AnatomyKey = SubClass | 'deletion' | 'insertion';
export const ANATOMY_KEYS: AnatomyKey[] = [...SUB_CLASSES, 'deletion', 'insertion'];

const mod12 = (x: number) => ((x % 12) + 12) % 12;

/** Root pitch class and quality of a majmin token ("other:<symbol>" has quality 'other'). */
function parseMajminToken(t: string): { root: number | null; quality: 'maj' | 'min' | 'other' } {
  const mm = /^(\d+):(maj|min)$/.exec(t);
  if (mm) return { root: Number(mm[1]), quality: mm[2] as 'maj' | 'min' };
  try {
    return { root: parseChord(t.replace(/^other:/, '')).root, quality: 'other' };
  } catch {
    return { root: null, quality: 'other' };
  }
}

/**
 * Class of a majmin substitution (reference token → chart token): parallel (same root, maj↔min),
 * relative (maj↔min with the major root = the minor root + 3), fifth (root interval 5 or 7, any
 * quality), semitone (root interval 1 or 11), else other (also when a root is unknown).
 */
export function classifySubstitution(ref: string, est: string): SubClass {
  const a = parseMajminToken(ref);
  const b = parseMajminToken(est);
  if (a.root === null || b.root === null) return 'other';
  const d = mod12(b.root - a.root);
  const majmin = a.quality !== 'other' && b.quality !== 'other' && a.quality !== b.quality;
  if (majmin && d === 0) return 'parallel';
  if (majmin) {
    const [maj, min] = a.quality === 'maj' ? [a.root, b.root] : [b.root, a.root];
    if (maj === mod12(min + 3)) return 'relative';
  }
  if (d === 5 || d === 7) return 'fifth';
  if (d === 1 || d === 11) return 'semitone';
  return 'other';
}

export interface Anatomy {
  counts: Record<AnatomyKey, number>;
  /** Substitution classes and deletions as a share of non-wildcard reference tokens; insertions of counted chart tokens. */
  shares: Record<AnatomyKey, number>;
}

export function anatomy(ref: string[], est: string[], ops: AlignOp[], score: ViewScore): Anatomy {
  const counts = Object.fromEntries(ANATOMY_KEYS.map((k) => [k, 0])) as Record<AnatomyKey, number>;
  for (const o of ops) {
    if (o.op === 'sub') counts[classifySubstitution(ref[o.ref], est[o.est])]++;
    else if (o.op === 'del') counts.deletion++;
    else if (o.op === 'ins') counts.insertion++;
  }
  const shares = Object.fromEntries(
    ANATOMY_KEYS.map((k) => {
      const den = k === 'insertion' ? score.chartCounted : score.refTokens;
      return [k, den ? counts[k] / den : NaN];
    }),
  ) as Record<AnatomyKey, number>;
  return { counts, shares };
}

// ---------------------------------------------------------------- Songs

export interface SequenceIo {
  readAnnotation: EvalIo['readAnnotation'];
  /** Sevenths-level annotation (the second root; the first when none was named). */
  readAnnotationSevenths: EvalIo['readAnnotation'];
  readChart(youtubeId: string): unknown;
}

export interface SequenceSong {
  id: string;
  dataset: string;
  youtubeId: string;
  btcTraining: string;
  groups: string[];
  /** Majmin reference wildcards / all majmin reference tokens (wildcards included). */
  wildcardShare: number;
  views: Record<View, ViewScore>;
  anatomy: Anatomy;
}

function loadChart(raw: unknown, what: string): Chart {
  if (raw === null || raw === undefined) throw new EvalInputError(`${what}: no chart`);
  const chart = chartFromExport(raw);
  if (!chart) throw new EvalInputError(`${what}: not a chart`);
  if (chart.provenance?.createdBy && chart.provenance.createdBy !== 'recognizer') throw new EvalInputError(`${what}: not an auto chart (createdBy ${chart.provenance.createdBy})`);
  if (!normalizeCoverage(chart.coverage).length) throw new EvalInputError(`${what}: chart has no coverage`);
  return chart;
}

/**
 * Scores one map song. wholeChart: the reference is not cut to the chart's coverage (a reference
 * without real timing, such as the K-pop sheet consensus with dummy one-second segments).
 */
export function scoreSequenceSong(m: MapEntry, entry: { song: SongEntry; list: SongList }, io: SequenceIo, wholeChart = false): SequenceSong {
  const folder = entry.list.datasets[entry.song.dataset].folder;
  const read = (fn: EvalIo['readAnnotation'], what: string) => {
    const t = fn(folder, entry.song.chords);
    if (t === null) throw new EvalInputError(`${m.id}: ${what} annotation file not found: ${folder}/${entry.song.chords}`);
    return parseLab(t);
  };
  const segs = read(io.readAnnotation, 'majmin');
  const segs7 = read(io.readAnnotationSevenths, 'sevenths');
  const chart = loadChart(io.readChart(m.youtubeId), `${m.id} ${m.youtubeId}.json`);
  const window: ReferenceWindow | null = wholeChart ? null : { offsetSec: m.offsetSec, rate: m.rate, mediaDurationSec: m.mediaDurationSec, coverage: chart.coverage };
  const views = {} as Record<View, ViewScore>;
  let anat: Anatomy | null = null;
  let wildcardShare = NaN;
  for (const v of VIEWS) {
    const ref = referenceTokens(v === 'sevenths' ? segs7 : segs, v, window);
    const est = chartTokens(chart, v);
    const { score, ops } = scoreTokens(ref, est);
    views[v] = score;
    if (v === 'majmin') {
      if (!score.refTokens) throw new EvalInputError(`${m.id}: no majmin reference tokens inside the chart's coverage (does the map belong to this chart?)`);
      anat = anatomy(ref, est, ops, score);
      wildcardShare = score.refWildcards / ref.length;
    }
  }
  return { id: m.id, dataset: m.dataset, youtubeId: m.youtubeId, btcTraining: m.btcTraining, groups: m.groups, wildcardShare, views, anatomy: anat! };
}

// ---------------------------------------------------------------- Aggregates

const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const finiteOf = (xs: number[]) => xs.filter(Number.isFinite);

export type ViewMeans = Record<View, Record<Rate, number>>;

export interface Bootstrap {
  method: 'percentile bootstrap of the song mean';
  resamples: number;
  prng: 'mulberry32';
  seed: number;
  level: number;
}

export interface SequenceAggregate {
  songs: number;
  /** Song means over the songs where the value is defined. */
  means: ViewMeans;
  ci: Record<View, Record<Rate, { lower: number; upper: number }>>;
  bootstrap: Bootstrap;
  anatomyShareMeans: Record<AnatomyKey, number>;
  wildcardShareMean: number;
}

export function viewMeans(rows: SequenceSong[]): ViewMeans {
  return Object.fromEntries(VIEWS.map((v) => [v, Object.fromEntries(RATES.map((r) => [r, mean(finiteOf(rows.map((s) => s.views[v][r])))]))])) as ViewMeans;
}

export function aggregateSequence(rows: SequenceSong[], resamples = BOOTSTRAP_RESAMPLES, seed = BOOTSTRAP_SEED): SequenceAggregate {
  const ci = Object.fromEntries(VIEWS.map((v) => [v, Object.fromEntries(RATES.map((r) => [r, bootstrapMeanCi(finiteOf(rows.map((s) => s.views[v][r])), resamples, seed)]))])) as SequenceAggregate['ci'];
  return {
    songs: rows.length,
    means: viewMeans(rows),
    ci,
    bootstrap: { method: 'percentile bootstrap of the song mean', resamples, prng: 'mulberry32', seed, level: CI_LEVEL },
    anatomyShareMeans: Object.fromEntries(ANATOMY_KEYS.map((k) => [k, mean(finiteOf(rows.map((s) => s.anatomy.shares[k])))])) as Record<AnatomyKey, number>,
    wildcardShareMean: mean(finiteOf(rows.map((s) => s.wildcardShare))),
  };
}

export interface SequenceResult {
  schema: string;
  generatedAt: string;
  inputs: Record<string, string | boolean | null>;
  /** 'chart-coverage': reference cut to the chart's coverage through the map; 'none': whole reference (--whole-chart). */
  referenceWindow: 'chart-coverage' | 'none';
  songs: SequenceSong[];
  all: SequenceAggregate;
  /** Song means per group (map entry groups plus the --groups file). */
  groups: Record<string, { n: number; ids: string[]; means: ViewMeans }>;
  /** Song means with each group left out in turn. */
  leaveOneGroupOut: Record<string, { n: number; means: ViewMeans }>;
}

export function sequenceEvaluate(
  maps: PairedMaps,
  lists: NamedSongList[],
  io: SequenceIo,
  opts: { fallbackLists?: string[]; groups?: Record<string, string[]>; inputs?: Record<string, string | null>; now?: Date; wholeChart?: boolean } = {},
): SequenceResult {
  const entries = lookupSongs(lists, maps, opts.fallbackLists);
  const whole = opts.wholeChart === true;
  const songs = maps.songs.map((m) => scoreSequenceSong(m, entries.get(m.id)!, io, whole));
  const groupIds = new Map<string, Set<string>>();
  const add = (g: string, id: string) => (groupIds.get(g) ?? groupIds.set(g, new Set()).get(g)!).add(id);
  for (const s of songs) for (const g of s.groups) add(g, s.id);
  for (const [g, ids] of Object.entries(opts.groups ?? {})) for (const id of ids) add(g, id);
  const groups: SequenceResult['groups'] = {};
  const leaveOneGroupOut: SequenceResult['leaveOneGroupOut'] = {};
  for (const [g, ids] of [...groupIds].sort(([a], [b]) => a.localeCompare(b))) {
    const inG = songs.filter((s) => ids.has(s.id));
    const rest = songs.filter((s) => !ids.has(s.id));
    groups[g] = { n: inG.length, ids: inG.map((s) => s.id), means: viewMeans(inG) };
    leaveOneGroupOut[g] = { n: rest.length, means: viewMeans(rest) };
  }
  return {
    schema: SEQUENCE_RESULT_SCHEMA,
    generatedAt: (opts.now ?? new Date()).toISOString(),
    inputs: whole ? { ...opts.inputs, wholeChart: true } : (opts.inputs ?? {}),
    referenceWindow: whole ? 'none' : 'chart-coverage',
    songs,
    all: aggregateSequence(songs),
    groups,
    leaveOneGroupOut,
  };
}

// ---------------------------------------------------------------- Gap between two result files

export interface SequenceGap {
  schema: string;
  generatedAt: string;
  inputs: Record<string, string | null>;
  metric: 'song-mean majmin F';
  a: { songs: number; mean: number };
  b: { songs: number; mean: number };
  /** A mean − B mean. */
  gap: number;
  /** Independent percentile bootstrap: each resample draws A's songs from mulberry32(seedA) and B's from mulberry32(seedB). */
  ci: { method: 'independent percentile bootstrap of both song sets'; resamples: number; prng: 'mulberry32'; seedA: number; seedB: number; level: number; lower: number; upper: number };
  /** The gap with each group of file A, then of file B, left out in turn. */
  leaveOneGroupOut: { a: Record<string, { n: number; gap: number }>; b: Record<string, { n: number; gap: number }> };
}

function majminF(r: SequenceResult): { id: string; f: number }[] {
  return r.songs.map((s) => ({ id: s.id, f: s.views.majmin.f })).filter((x) => Number.isFinite(x.f));
}

export function parseSequenceResult(v: unknown, what: string): SequenceResult {
  const o = v as Partial<SequenceResult> | null;
  if (!o || typeof o !== 'object' || o.schema !== SEQUENCE_RESULT_SCHEMA || !Array.isArray(o.songs)) throw new EvalInputError(`${what}: expected a ${SEQUENCE_RESULT_SCHEMA} result`);
  // JSON writes NaN as null; read it back as NaN so it stays out of the means.
  for (const s of o.songs) if (s.views?.majmin && s.views.majmin.f === null) s.views.majmin.f = NaN;
  return o as SequenceResult;
}

export function sequenceGap(
  a: SequenceResult,
  b: SequenceResult,
  opts: { resamples?: number; seedA?: number; seedB?: number; inputs?: Record<string, string | null>; now?: Date } = {},
): SequenceGap {
  const resamples = opts.resamples ?? BOOTSTRAP_RESAMPLES;
  const seedA = opts.seedA ?? BOOTSTRAP_SEED;
  const seedB = opts.seedB ?? GAP_SEED_B;
  const xa = majminF(a).map((x) => x.f);
  const xb = majminF(b).map((x) => x.f);
  if (!xa.length || !xb.length) throw new EvalInputError('gap: both result files need at least one song with a majmin F');
  const ra = mulberry32(seedA);
  const rb = mulberry32(seedB);
  const draws = new Array<number>(resamples);
  for (let k = 0; k < resamples; k++) {
    let sa = 0;
    for (let i = 0; i < xa.length; i++) sa += xa[Math.floor(ra() * xa.length)];
    let sb = 0;
    for (let i = 0; i < xb.length; i++) sb += xb[Math.floor(rb() * xb.length)];
    draws[k] = sa / xa.length - sb / xb.length;
  }
  const level = CI_LEVEL;
  const q = (1 - level) / 2;
  const ma = mean(xa);
  const mb = mean(xb);
  const logo = (r: SequenceResult, other: number, sign: 1 | -1) =>
    Object.fromEntries(
      Object.entries(r.groups ?? {}).map(([g, info]) => {
        const rest = majminF(r).filter((x) => !info.ids.includes(x.id)).map((x) => x.f);
        const m = mean(rest);
        return [g, { n: rest.length, gap: sign === 1 ? m - other : other - m }];
      }),
    );
  return {
    schema: SEQUENCE_GAP_SCHEMA,
    generatedAt: (opts.now ?? new Date()).toISOString(),
    inputs: opts.inputs ?? {},
    metric: 'song-mean majmin F',
    a: { songs: xa.length, mean: ma },
    b: { songs: xb.length, mean: mb },
    gap: ma - mb,
    ci: { method: 'independent percentile bootstrap of both song sets', resamples, prng: 'mulberry32', seedA, seedB, level, lower: quantile(draws, q), upper: quantile(draws, 1 - q) },
    leaveOneGroupOut: { a: logo(a, mb, 1), b: logo(b, ma, -1) },
  };
}

// ---------------------------------------------------------------- Text summaries

const pct = (x: number) => (Number.isFinite(x) ? (100 * x).toFixed(1) : 'n/a');
const pp = (x: number) => (Number.isFinite(x) ? `${x >= 0 ? '+' : ''}${(100 * x).toFixed(2)}` : 'n/a');

export function sequenceSummary(r: SequenceResult): string {
  const a = r.all;
  const lines = [`${a.songs} songs, reference window ${r.referenceWindow}; song means (95% bootstrap):`];
  for (const v of VIEWS) lines.push(`  ${v}: ${RATES.map((k) => `${k === 'f' ? 'F' : k} ${pct(a.means[v][k])} [${pct(a.ci[v][k].lower)}, ${pct(a.ci[v][k].upper)}]`).join(', ')}`);
  lines.push(`  majmin anatomy (song-mean shares): ${ANATOMY_KEYS.map((k) => `${k} ${pct(a.anatomyShareMeans[k])}`).join(', ')}`);
  lines.push(`  reference wildcard share (song mean): ${pct(a.wildcardShareMean)}`);
  for (const [g, v] of Object.entries(r.groups)) lines.push(`group ${g} (${v.n}): majmin F ${pct(v.means.majmin.f)}; without it (${r.leaveOneGroupOut[g].n}): ${pct(r.leaveOneGroupOut[g].means.majmin.f)}`);
  return lines.join('\n');
}

export function gapSummary(g: SequenceGap): string {
  const lines = [
    `majmin F song mean: A ${pct(g.a.mean)} (${g.a.songs}) − B ${pct(g.b.mean)} (${g.b.songs}) = ${pp(g.gap)} pp, 95% independent bootstrap [${pp(g.ci.lower)}, ${pp(g.ci.upper)}] (seeds ${g.ci.seedA}/${g.ci.seedB})`,
  ];
  for (const side of ['a', 'b'] as const) for (const [k, v] of Object.entries(g.leaveOneGroupOut[side])) lines.push(`  without ${side.toUpperCase()} group ${k} (${v.n} left): ${pp(v.gap)} pp`);
  return lines.join('\n');
}
