/**
 * Paired frozen-map comparison of two chart sets (baseline and candidate) on the same songs
 * (docs/recognition-replay.md). Every song's time map (offsetSec, rate) and media length come
 * from a maps file written beforehand and are never re-estimated; both arms are scored with the
 * evaluator's unchanged scoreSong against the annotation (annotation beats, never chart beats),
 * with the annotation read through the song list exactly as evaluateSongs reads it.
 */
import { subtractCoverage } from '../chart/merge';
import type { Chart, CoverageRange } from '../chart/types';
import { reduceSymbol, type Reduction } from './metrics';
import {
  annotationChart,
  changeTimes,
  chartFromExport,
  EvalInputError,
  harteToSymbol,
  overlapRanges,
  parseBeats,
  parseLab,
  scoreSong,
  type EvalIo,
  type SongEntry,
  type SongList,
  type SongScore,
} from './annotations';
import { bootstrapMeanCi, BOOTSTRAP_RESAMPLES, BOOTSTRAP_SEED, CI_LEVEL } from './song-mean';

export const PAIRED_MAPS_SCHEMA = 'vibe-guitar-paired-maps/1';
/** Also accepted: the frozen recognition maps (docs/recognition-dev-maps.json and later sets). */
const MAPS_SCHEMA_RE = /^vibe-guitar-(paired|recognition-[a-z0-9-]+)-maps\/1$/;
/** Song lists used when neither the map entry nor the caller names one: the two DEV lists (never a held-out TEST list). */
export const DEFAULT_SONG_LISTS = ['docs/annotation-eval-songs.json', 'docs/annotation-eval-songs-heldout-v1.json'];
export const PAIRED_RESULT_SCHEMA = 'vibe-guitar-paired-eval/1';
/** Chord-change matching window for the boundary diagnostics. */
export const BOUNDARY_WINDOW_SEC = 0.25;
/** Evaluated seconds of the two arms may differ by float rounding only. */
export const EVALUATED_SEC_TOLERANCE = 1e-6;
const METRICS: Reduction[] = ['majmin', 'root', 'sevenths'];

export interface MapEntry {
  id: string;
  dataset: string;
  youtubeId: string;
  offsetSec: number;
  rate: number;
  mediaDurationSec: number | null;
  btcTraining: string;
  groups: string[];
  /** Song list (repository-relative path) that holds this song; only that list is used for it. */
  songList?: string;
}

export interface PairedMaps {
  schema: string;
  songs: MapEntry[];
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export function parseMaps(v: unknown): PairedMaps {
  if (!isObj(v) || typeof v.schema !== 'string' || !MAPS_SCHEMA_RE.test(v.schema) || !Array.isArray(v.songs))
    throw new EvalInputError(`maps: expected { schema: "${PAIRED_MAPS_SCHEMA}" (or vibe-guitar-recognition-*-maps/1), songs: [...] }`);
  const ids = new Set<string>();
  for (const s of v.songs as unknown[]) {
    if (!isObj(s) || typeof s.id !== 'string' || typeof s.dataset !== 'string') throw new EvalInputError('maps: every song needs id and dataset');
    if (ids.has(s.id)) throw new EvalInputError(`maps: duplicate id ${s.id}`);
    ids.add(s.id);
    if (typeof s.youtubeId !== 'string' || !/^[A-Za-z0-9_-]{6,20}$/.test(s.youtubeId)) throw new EvalInputError(`maps: ${s.id} needs a youtubeId`);
    if (!finite(s.offsetSec) || !finite(s.rate) || s.rate <= 0) throw new EvalInputError(`maps: ${s.id} needs a finite offsetSec and a positive rate`);
    if (s.mediaDurationSec !== null && !(finite(s.mediaDurationSec) && s.mediaDurationSec > 0)) throw new EvalInputError(`maps: ${s.id} needs mediaDurationSec (seconds or null)`);
    if (typeof s.btcTraining !== 'string') throw new EvalInputError(`maps: ${s.id} needs btcTraining`);
    if (!Array.isArray(s.groups) || !s.groups.every((g) => typeof g === 'string')) throw new EvalInputError(`maps: ${s.id} needs groups (an array of strings)`);
    if (s.songList !== undefined && (typeof s.songList !== 'string' || !s.songList)) throw new EvalInputError(`maps: ${s.id} has a bad songList`);
  }
  return v as unknown as PairedMaps;
}

/** --groups file: { "<group>": ["songId", …] }; every id must be in the maps. */
export function parseGroups(v: unknown, maps: PairedMaps): Record<string, string[]> {
  if (!isObj(v)) throw new EvalInputError('groups: expected { "<group>": ["songId", …] }');
  const known = new Set(maps.songs.map((s) => s.id));
  const out: Record<string, string[]> = {};
  for (const [g, ids] of Object.entries(v)) {
    if (g.startsWith('$')) continue;
    if (!Array.isArray(ids) || !ids.every((x) => typeof x === 'string')) throw new EvalInputError(`groups: ${g} must list song ids`);
    const unknown = ids.filter((x) => !known.has(x));
    if (unknown.length) throw new EvalInputError(`groups: ${g} lists songs not in the maps file: ${unknown.join(', ')}`);
    out[g] = ids;
  }
  return out;
}

/** --subset-field field=value on map entries, e.g. btcTraining=not-known. */
export function parseSubset(spec: string): { field: keyof MapEntry; value: string } {
  const eq = spec.indexOf('=');
  const field = spec.slice(0, eq) as keyof MapEntry;
  if (eq <= 0 || !['id', 'dataset', 'youtubeId', 'btcTraining'].includes(field)) throw new EvalInputError(`--subset-field: expected field=value with field one of id, dataset, youtubeId, btcTraining`);
  return { field, value: spec.slice(eq + 1) };
}

/** A loaded song list and the key it is named by (repository-relative path, or absolute outside the repository). */
export interface NamedSongList {
  file: string;
  list: SongList;
}

/**
 * The song lists paired-eval must load: each entry's songList, plus (when some entry names none)
 * the caller's lists or else DEFAULT_SONG_LISTS. A held-out TEST list is read only when named.
 */
export function songListsToLoad(maps: PairedMaps, callerLists: string[]): { files: string[]; fallback: string[] } {
  const fallback = maps.songs.some((s) => !s.songList) ? (callerLists.length ? callerLists : DEFAULT_SONG_LISTS) : [];
  return { files: [...new Set([...maps.songs.flatMap((s) => (s.songList ? [s.songList] : [])), ...fallback])], fallback };
}

/**
 * Song-list entries for the map songs: an entry with songList is looked up only in that list,
 * one without in the fallback lists (one id must not mean two different annotations).
 */
export function lookupSongs(lists: NamedSongList[], maps: PairedMaps, fallback: string[] = lists.map((l) => l.file)): Map<string, { song: SongEntry; list: SongList }> {
  const out = new Map<string, { song: SongEntry; list: SongList }>();
  for (const m of maps.songs) {
    const files = m.songList ? [m.songList] : fallback;
    for (const f of files) if (!lists.some((l) => l.file === f)) throw new EvalInputError(`maps: song list ${f} for ${m.id} is not loaded`);
    const hits = lists.filter((l) => files.includes(l.file)).flatMap(({ list }) => list.songs.filter((s) => s.id === m.id).map((song) => ({ song, list })));
    if (!hits.length) throw new EvalInputError(`maps: ${m.id} is in no song list (${files.join(', ')})`);
    const key = (h: { song: SongEntry; list: SongList }) => `${h.list.datasets[h.song.dataset].folder}/${h.song.chords}|${h.song.beats}`;
    if (new Set(hits.map(key)).size > 1) throw new EvalInputError(`maps: ${m.id} has different annotations in different song lists`);
    if (hits[0].song.dataset !== m.dataset) throw new EvalInputError(`maps: ${m.id} dataset ${m.dataset} differs from the song list (${hits[0].song.dataset})`);
    out.set(m.id, hits[0]);
  }
  return out;
}

export interface PairedIo {
  readAnnotation: EvalIo['readAnnotation'];
  readBaseline(youtubeId: string): unknown;
  readCandidate(youtubeId: string): unknown;
}

export interface BoundaryStats {
  predicted: number;
  annotated: number;
  matched: number;
  precision: number;
  recall: number;
  f: number;
}

export interface ArmScore {
  majmin: number;
  root: number;
  sevenths: number;
  evaluatedSec: Record<Reduction, number>;
  overlapSec: number;
  boundaries: BoundaryStats;
}

export interface PairedSong {
  id: string;
  dataset: string;
  youtubeId: string;
  btcTraining: string;
  groups: string[];
  baseline: ArmScore;
  candidate: ArmScore;
  /** candidate − baseline (NaN when a metric has nothing to evaluate). */
  delta: Record<Reduction, number>;
  /** candidate − baseline boundary precision, recall and F (NaN when undefined in an arm). */
  boundaryDelta: Record<BoundaryRate, number>;
}

export type BoundaryRate = 'precision' | 'recall' | 'f';
const BOUNDARY_RATES: BoundaryRate[] = ['precision', 'recall', 'f'];

/** Song means of one boundary rate over the songs where it is defined in both arms (so the delta is paired). */
export interface BoundaryMean {
  n: number;
  baseline: number;
  candidate: number;
  /** candidate − baseline over the same songs (the flicker guard reads this for precision). */
  delta: number;
}

/** Majmin-reduced label; a chord outside the reduction keeps its own symbol, so changes into and out of it count. */
const majminLabel = (symbol: string): string => reduceSymbol(symbol, 'majmin') ?? `other:${symbol}`;

/** Greedy in time order; for points on a line with a symmetric window this is a maximum one-to-one matching. */
export function matchChanges(ref: number[], est: number[], windowSec = BOUNDARY_WINDOW_SEC): number {
  const r = [...ref].sort((a, b) => a - b);
  const e = [...est].sort((a, b) => a - b);
  let i = 0;
  let j = 0;
  let matched = 0;
  while (i < r.length && j < e.length) {
    if (e[j] < r[i] - windowSec - 1e-9) j++;
    else if (r[i] < e[j] - windowSec - 1e-9) i++;
    else {
      matched++;
      i++;
      j++;
    }
  }
  return matched;
}

/** Media-time ranges of the X/unmapped reference segments, each widened by padSec on both sides (unmerged). */
export function unknownRanges(segs: ReturnType<typeof parseLab>, offsetSec: number, rate: number, padSec: number): CoverageRange[] {
  const m = (t: number) => offsetSec + rate * t;
  return segs
    .filter((s) => {
      const kind = harteToSymbol(s.label).kind;
      return kind === 'X' || kind === 'unmapped';
    })
    .map((s) => ({ fromSec: m(s.startSec) - padSec, toSec: m(s.endSec) + padSec }));
}

/**
 * Chord-change diagnostics inside the region both the time-mapped annotation and the chart cover:
 * changes of the majmin-reduced label, matched one-to-one within ±250 ms.
 * With maskUnknown (opt-in; off by default), the reference regions labelled X or with an unmapped
 * label (the seconds scoreSong counts as unknownSec), mapped to media time and widened by windowSec
 * on both sides, are removed from that region first, as WCSR leaves them out: a reference change
 * into or out of such a region and a chart change inside or near it are not counted.
 */
export function boundaryStats(
  segs: ReturnType<typeof parseLab>,
  chart: Chart,
  offsetSec: number,
  mediaDurationSec: number | null,
  rate: number,
  windowSec = BOUNDARY_WINDOW_SEC,
  maskUnknown = false,
): BoundaryStats {
  const ref = annotationChart(segs, offsetSec, null, mediaDurationSec, false, rate);
  const covered: CoverageRange[] = overlapRanges(ref.coverage, chart.coverage);
  const both = maskUnknown ? subtractCoverage(covered, unknownRanges(segs, offsetSec, rate, windowSec)) : covered;
  const reduce = (events: { startSec: number; chord: string }[]) => events.map((e) => ({ startSec: e.startSec, chord: majminLabel(e.chord) }));
  const refChanges = changeTimes(reduce(ref.events), both);
  const estChanges = changeTimes(reduce(chart.events), both);
  const matched = matchChanges(refChanges, estChanges, windowSec);
  const precision = estChanges.length ? matched / estChanges.length : NaN;
  const recall = refChanges.length ? matched / refChanges.length : NaN;
  const f = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : Number.isNaN(precision) || Number.isNaN(recall) ? NaN : 0;
  return { predicted: estChanges.length, annotated: refChanges.length, matched, precision, recall, f };
}

function loadChart(raw: unknown, what: string): Chart {
  if (raw === null || raw === undefined) throw new EvalInputError(`${what}: no chart`);
  const chart = chartFromExport(raw);
  if (!chart) throw new EvalInputError(`${what}: not a chart`);
  if (chart.provenance?.createdBy && chart.provenance.createdBy !== 'recognizer') throw new EvalInputError(`${what}: not an auto chart (createdBy ${chart.provenance.createdBy})`);
  return chart;
}

function armScore(score: SongScore, boundaries: BoundaryStats): ArmScore {
  const c = score.comparison;
  return {
    majmin: c.majmin.score,
    root: c.root.score,
    sevenths: c.sevenths.score,
    evaluatedSec: { majmin: c.majmin.evaluatedSec, root: c.root.evaluatedSec, sevenths: c.sevenths.evaluatedSec },
    overlapSec: c.overlapSec,
    boundaries,
  };
}

const sameCoverage = (a: CoverageRange[], b: CoverageRange[]) => a.length === b.length && a.every((r, i) => r.fromSec === b[i].fromSec && r.toSec === b[i].toSec);

/** Scores one map song in both arms; throws when the arms do not cover the same audio. */
export function scorePairedSong(m: MapEntry, entry: { song: SongEntry; list: SongList }, io: PairedIo, maskUnknownBoundaries = false): PairedSong {
  const folder = entry.list.datasets[entry.song.dataset].folder;
  const labText = io.readAnnotation(folder, entry.song.chords);
  if (labText === null) throw new EvalInputError(`${m.id}: annotation file not found: ${folder}/${entry.song.chords}`);
  const segs = parseLab(labText);
  let annBeats: number[] | null = null;
  if (entry.song.beats) {
    const t = io.readAnnotation(folder, entry.song.beats);
    if (t === null) throw new EvalInputError(`${m.id}: beat file not found: ${folder}/${entry.song.beats}`);
    annBeats = parseBeats(t).map((b) => b.sec);
  }
  const base = loadChart(io.readBaseline(m.youtubeId), `${m.id} baseline ${m.youtubeId}.json`);
  const cand = loadChart(io.readCandidate(m.youtubeId), `${m.id} candidate ${m.youtubeId}.json`);
  if (!sameCoverage(base.coverage, cand.coverage)) throw new EvalInputError(`${m.id}: baseline and candidate coverage differ (${JSON.stringify(base.coverage)} vs ${JSON.stringify(cand.coverage)})`);
  const sb = scoreSong(segs, annBeats, base, m.offsetSec, m.mediaDurationSec, 1, m.rate);
  const sc = scoreSong(segs, annBeats, cand, m.offsetSec, m.mediaDurationSec, 1, m.rate);
  if (!(sb.comparison.majmin.evaluatedSec > 0)) throw new EvalInputError(`${m.id}: no majmin-evaluated seconds under this map (does the map belong to this chart?)`);
  for (const k of METRICS) {
    const a = sb.comparison[k].evaluatedSec;
    const b = sc.comparison[k].evaluatedSec;
    if (Math.abs(a - b) > EVALUATED_SEC_TOLERANCE) throw new EvalInputError(`${m.id}: evaluated ${k} seconds differ (baseline ${a}, candidate ${b})`);
  }
  const baseline = armScore(sb, boundaryStats(segs, base, m.offsetSec, m.mediaDurationSec, m.rate, BOUNDARY_WINDOW_SEC, maskUnknownBoundaries));
  const candidate = armScore(sc, boundaryStats(segs, cand, m.offsetSec, m.mediaDurationSec, m.rate, BOUNDARY_WINDOW_SEC, maskUnknownBoundaries));
  const delta = Object.fromEntries(METRICS.map((k) => [k, candidate[k] - baseline[k]])) as Record<Reduction, number>;
  const boundaryDelta = Object.fromEntries(BOUNDARY_RATES.map((k) => [k, candidate.boundaries[k] - baseline.boundaries[k]])) as Record<BoundaryRate, number>;
  return { id: m.id, dataset: m.dataset, youtubeId: m.youtubeId, btcTraining: m.btcTraining, groups: m.groups, baseline, candidate, delta, boundaryDelta };
}

const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const finiteOf = (xs: number[]) => xs.filter(Number.isFinite);

export interface PairedAggregate {
  songs: number;
  /** Song means over songs where the metric is defined (majmin is defined for every scored song). */
  baseline: Record<Reduction, number>;
  candidate: Record<Reduction, number>;
  meanDelta: Record<Reduction, number>;
  /** Paired percentile bootstrap of the mean majmin delta over songs. */
  majminDeltaCi: { method: 'paired percentile bootstrap'; resamples: number; prng: 'mulberry32'; seed: number; level: number; lower: number; upper: number };
  /** Mean majmin delta with each song left out in turn. */
  leaveOneOut: { min: number; minWithout: string; max: number; maxWithout: string } | null;
  largestLoss: { id: string; majminDelta: number } | null;
  /** Song-mean boundary precision, recall and F of both arms and their paired deltas, plus change counts. */
  boundaries: Record<BoundaryRate, BoundaryMean> & { baselinePredicted: number; candidatePredicted: number; annotated: number };
}

export function boundaryMean(rows: PairedSong[], k: BoundaryRate): BoundaryMean {
  const both = rows.filter((r) => Number.isFinite(r.baseline.boundaries[k]) && Number.isFinite(r.candidate.boundaries[k]));
  const baseline = mean(both.map((r) => r.baseline.boundaries[k]));
  const candidate = mean(both.map((r) => r.candidate.boundaries[k]));
  return { n: both.length, baseline, candidate, delta: candidate - baseline };
}

export function aggregate(rows: PairedSong[], resamples = BOOTSTRAP_RESAMPLES, seed = BOOTSTRAP_SEED): PairedAggregate {
  const pick = (arm: 'baseline' | 'candidate') => Object.fromEntries(METRICS.map((k) => [k, mean(finiteOf(rows.map((r) => r[arm][k])))])) as Record<Reduction, number>;
  const deltas = rows.map((r) => r.delta.majmin);
  const ci = rows.length ? bootstrapMeanCi(deltas, resamples, seed) : { lower: NaN, upper: NaN };
  let leaveOneOut: PairedAggregate['leaveOneOut'] = null;
  if (rows.length >= 2) {
    const sum = deltas.reduce((a, b) => a + b, 0);
    const loo = rows.map((r, i) => ({ id: r.id, v: (sum - deltas[i]) / (rows.length - 1) }));
    const lo = loo.reduce((a, b) => (b.v < a.v ? b : a));
    const hi = loo.reduce((a, b) => (b.v > a.v ? b : a));
    leaveOneOut = { min: lo.v, minWithout: lo.id, max: hi.v, maxWithout: hi.id };
  }
  const worst = rows.length ? rows.reduce((a, b) => (b.delta.majmin < a.delta.majmin ? b : a)) : null;
  return {
    songs: rows.length,
    baseline: pick('baseline'),
    candidate: pick('candidate'),
    meanDelta: Object.fromEntries(METRICS.map((k) => [k, mean(finiteOf(rows.map((r) => r.delta[k])))])) as Record<Reduction, number>,
    majminDeltaCi: { method: 'paired percentile bootstrap', resamples, prng: 'mulberry32', seed, level: CI_LEVEL, lower: ci.lower, upper: ci.upper },
    leaveOneOut,
    largestLoss: worst ? { id: worst.id, majminDelta: worst.delta.majmin } : null,
    boundaries: {
      precision: boundaryMean(rows, 'precision'),
      recall: boundaryMean(rows, 'recall'),
      f: boundaryMean(rows, 'f'),
      baselinePredicted: rows.reduce((s, r) => s + r.baseline.boundaries.predicted, 0),
      candidatePredicted: rows.reduce((s, r) => s + r.candidate.boundaries.predicted, 0),
      annotated: rows.reduce((s, r) => s + r.baseline.boundaries.annotated, 0),
    },
  };
}

export interface PairedResult {
  schema: string;
  generatedAt: string;
  /** Caller's inputs; maskUnknownBoundaries: true is added only when that option is on (absent means off). */
  inputs: Record<string, string | boolean | null>;
  boundaryWindowSec: number;
  songs: PairedSong[];
  all: PairedAggregate;
  subset: { field: string; value: string; aggregate: PairedAggregate } | null;
  groups: Record<string, { n: number; meanDelta: Record<Reduction, number> }>;
}

export function pairedEvaluate(
  maps: PairedMaps,
  lists: NamedSongList[],
  io: PairedIo,
  opts: { fallbackLists?: string[]; subset?: { field: keyof MapEntry; value: string }; groups?: Record<string, string[]>; inputs?: Record<string, string | null>; now?: Date; maskUnknownBoundaries?: boolean } = {},
): PairedResult {
  const entries = lookupSongs(lists, maps, opts.fallbackLists);
  const mask = opts.maskUnknownBoundaries === true;
  const songs = maps.songs.map((m) => scorePairedSong(m, entries.get(m.id)!, io, mask));
  const groupIds = new Map<string, Set<string>>();
  for (const s of songs) for (const g of s.groups) (groupIds.get(g) ?? groupIds.set(g, new Set()).get(g)!).add(s.id);
  for (const [g, ids] of Object.entries(opts.groups ?? {})) for (const id of ids) (groupIds.get(g) ?? groupIds.set(g, new Set()).get(g)!).add(id);
  const groups: PairedResult['groups'] = {};
  for (const [g, ids] of [...groupIds].sort(([a], [b]) => a.localeCompare(b))) {
    const rows = songs.filter((s) => ids.has(s.id));
    groups[g] = { n: rows.length, meanDelta: Object.fromEntries(METRICS.map((k) => [k, mean(finiteOf(rows.map((r) => r.delta[k])))])) as Record<Reduction, number> };
  }
  const sub = opts.subset;
  return {
    schema: PAIRED_RESULT_SCHEMA,
    generatedAt: (opts.now ?? new Date()).toISOString(),
    inputs: mask ? { ...opts.inputs, maskUnknownBoundaries: true } : (opts.inputs ?? {}),
    boundaryWindowSec: BOUNDARY_WINDOW_SEC,
    songs,
    all: aggregate(songs),
    subset: sub ? { field: String(sub.field), value: sub.value, aggregate: aggregate(songs.filter((s) => String(s[sub.field as keyof PairedSong]) === sub.value)) } : null,
    groups,
  };
}

const pct = (x: number) => (Number.isFinite(x) ? (100 * x).toFixed(1) : 'n/a');
const pp = (x: number) => (Number.isFinite(x) ? `${x >= 0 ? '+' : ''}${(100 * x).toFixed(2)}` : 'n/a');

function aggregateLines(name: string, a: PairedAggregate): string[] {
  const lines = [
    `${name}: ${a.songs} songs`,
    `  majmin ${pct(a.baseline.majmin)} → ${pct(a.candidate.majmin)} (mean Δ ${pp(a.meanDelta.majmin)} pp, 95% paired bootstrap [${pp(a.majminDeltaCi.lower)}, ${pp(a.majminDeltaCi.upper)}])`,
    `  root ${pct(a.baseline.root)} → ${pct(a.candidate.root)} (Δ ${pp(a.meanDelta.root)}); sevenths ${pct(a.baseline.sevenths)} → ${pct(a.candidate.sevenths)} (Δ ${pp(a.meanDelta.sevenths)})`,
  ];
  if (a.leaveOneOut) lines.push(`  leave-one-out mean Δ majmin: min ${pp(a.leaveOneOut.min)} (without ${a.leaveOneOut.minWithout}), max ${pp(a.leaveOneOut.max)} (without ${a.leaveOneOut.maxWithout})`);
  if (a.largestLoss) lines.push(`  worst single-song majmin Δ: ${a.largestLoss.id} ${pp(a.largestLoss.majminDelta)}`);
  const b = a.boundaries;
  const rate = (name: string, m: BoundaryMean) => `${name} ${pct(m.baseline)} → ${pct(m.candidate)} (Δ ${pp(m.delta)})`;
  lines.push(`  boundaries ±${BOUNDARY_WINDOW_SEC * 1000} ms, song means: ${rate('precision', b.precision)}, ${rate('recall', b.recall)}, ${rate('F', b.f)} over ${b.precision.n} songs`);
  lines.push(`  changes predicted ${b.baselinePredicted} → ${b.candidatePredicted} (annotated ${b.annotated})`);
  return lines;
}

/** Short text summary (deltas in percentage points). */
export function pairedSummary(r: PairedResult): string {
  const lines = aggregateLines('all', r.all);
  if (r.subset) lines.push(...aggregateLines(`subset ${r.subset.field}=${r.subset.value}`, r.subset.aggregate));
  for (const [g, v] of Object.entries(r.groups)) lines.push(`group ${g} (${v.n}): mean Δ majmin ${pp(v.meanDelta.majmin)}, root ${pp(v.meanDelta.root)}, sevenths ${pp(v.meanDelta.sevenths)}`);
  if (r.inputs.maskUnknownBoundaries === true) lines.push(`boundaries exclude X/unmapped reference regions widened by ±${BOUNDARY_WINDOW_SEC * 1000} ms (--mask-unknown-boundaries)`);
  return lines.join('\n');
}
