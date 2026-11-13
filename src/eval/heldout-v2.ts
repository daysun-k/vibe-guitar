/**
 * The second held-out Billboard batch of VGT-7 (v2, PR #33): the same frozen pool order and raw
 * search log as v1 (PR #31), walked from a start rank under the amended-v1 upload rule until N
 * songs have a qualifying upload. N comes from the size rule below. Every decision is recomputed
 * from the entry's raw query results; the logged `decision` and `decisionAmended` fields are never
 * read (from rank 33 on, `decisionAmended` only records v1's stop as `not-needed`).
 */
import { id4, type RankedSong } from './heldout-draw';
import { BILLBOARD_DATASET, decideEntry, songEntry, SEARCH_LOG_SCHEMA, type HeldoutListResult, type SearchLog } from './heldout-list';
import type { UploadRule } from './heldout-uploads';
import { SONG_LIST_SCHEMA, type DatasetInfo, type SongEntry, type SongList, type UploadEntry } from './annotations';

/** v1's amended stop was rank 32. */
export const V2_START_RANK = 33;
export const V2_RULE: UploadRule = 'amended-v1';
/** Songs v1 selected (the trials behind k). */
export const V1_SELECTED = 25;
/** Count condition of the VGT-7 status criterion. */
export const V2_MIN_SONGS = 15;
export const V2_ASSURANCE = 0.95;
/** Largest N tried before the size rule gives up. */
export const V2_MAX_SIZE = 10_000;

// Lanczos approximation (g = 7, 9 coefficients), relative error about 1e-15 for x > 0.
const LANCZOS = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012,
  9.9843695780195716e-6, 1.5056327351493116e-7,
];

export function logGamma(x: number): number {
  if (!(x > 0)) throw new Error(`logGamma: ${x} is not positive`);
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  const z = x - 1;
  let a = LANCZOS[0];
  const t = z + 7.5;
  for (let i = 1; i < 9; i++) a += LANCZOS[i] / (z + i);
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a);
}

const logBeta = (a: number, b: number) => logGamma(a) + logGamma(b) - logGamma(a + b);

/** P(X = x) for X ~ BetaBinomial(n, a, b), through log-gamma. */
export function betaBinomialPmf(x: number, n: number, a: number, b: number): number {
  if (!Number.isInteger(x) || x < 0 || x > n) return 0;
  const logChoose = logGamma(n + 1) - logGamma(x + 1) - logGamma(n - x + 1);
  return Math.exp(logChoose + logBeta(x + a, n - x + b) - logBeta(a, b));
}

/** P(X >= m) for X ~ BetaBinomial(n, a, b): the sum over the shorter side (1 minus P(X < m) when that side is below m). */
export function betaBinomialAtLeast(m: number, n: number, a: number, b: number): number {
  const lo = Math.max(0, Math.ceil(m));
  if (lo > n) return 0;
  let p = 0;
  if (lo <= n - lo) {
    for (let x = 0; x < lo; x++) p += betaBinomialPmf(x, n, a, b);
    return Math.min(1, Math.max(0, 1 - p));
  }
  for (let x = lo; x <= n; x++) p += betaBinomialPmf(x, n, a, b);
  return Math.min(1, p);
}

export interface V2SizeRule {
  /** v1 songs scored with a finite majmin score and a positive majmin evaluated duration under PR #32's evaluator. */
  k: number;
  /** Songs v1 selected. */
  trials: number;
  minSongs: number;
  assurance: number;
  /** a = 1 + k, b = 1 + trials - k. */
  a: number;
  b: number;
  /** Smallest N with P(X >= minSongs) >= assurance. */
  n: number;
  /** P(X >= minSongs) at that N. */
  probability: number;
  rule: string;
}

/** N = smallest N with P(X >= 15) >= 0.95 for X ~ BetaBinomial(N, 1 + k, 1 + 25 - k) (PR #33). */
export function heldoutV2Size(k: number): V2SizeRule {
  if (!Number.isInteger(k) || k < 0 || k > V1_SELECTED) throw new Error(`size rule: k must be an integer from 0 to ${V1_SELECTED}, got ${k}`);
  const a = 1 + k;
  const b = 1 + V1_SELECTED - k;
  for (let n = V2_MIN_SONGS; n <= V2_MAX_SIZE; n++) {
    const probability = betaBinomialAtLeast(V2_MIN_SONGS, n, a, b);
    if (probability >= V2_ASSURANCE)
      return {
        k,
        trials: V1_SELECTED,
        minSongs: V2_MIN_SONGS,
        assurance: V2_ASSURANCE,
        a,
        b,
        n,
        probability,
        rule: `smallest N with P(X >= ${V2_MIN_SONGS}) >= ${V2_ASSURANCE} for X ~ BetaBinomial(N, 1 + k, 1 + ${V1_SELECTED} - k): a uniform prior updated by v1's ${V1_SELECTED} selected songs, of which k entered PR #31's primary mean under PR #32's evaluator (count only, never score values); exact sum of log-gamma terms. Planning for the count condition only, assuming v2's songs behave like v1's; not an assurance that VGT-7 closes, and the half-width condition is not modelled.`,
      };
  }
  throw new Error(`size rule: no N up to ${V2_MAX_SIZE} reaches ${V2_ASSURANCE} for k = ${k}`);
}

export function heldoutV2Purpose(size: V2SizeRule, startRank = V2_START_RANK): string {
  return (
    `Predeclared before any v2 song is captured or scored (VGT-7, PR #33): the second held-out batch (v2) of McGill Billboard 2.0.1 songs with no known BTC training-song overlap, for scoring Vibe Guitar auto charts against public, time-aligned chord annotations. ` +
    `Songs: the frozen v1 pool and order (docs/annotation-heldout-v1-pool.json) from rank ${startRank} (v1's amended stop was rank ${startRank - 1}), upload rule amended-v1 exactly as in PR #31, recomputed from the raw results of docs/annotation-heldout-v1-search-log.json (no new search; that log's not-needed marks are not decisions); songs without a qualifying upload are skipped and the walk stops at the first N = ${size.n} with one. ` +
    `Size: k = ${size.k} v1 songs in PR #31's primary mean under PR #32's evaluator; N = ${size.n} is the smallest N with P(X >= ${size.minSongs}) >= ${size.assurance} for X ~ BetaBinomial(N, ${size.a}, ${size.b}) (P = ${size.probability.toFixed(4)}); planning for the count condition only. ` +
    `Capture as frozen in PR #33: list order, a build of main after PR #33; a technical failure (no chart, or a chart covering less than 90% of the upload) is retried up to 2 more times before any v2 scoring, then the song is missing; no song is ever replaced and N stays the denominator. ` +
    `Analysis: PR #31's analysis on v2 alone (unweighted mean of per-song majmin WCSR, percentile bootstrap 95% interval over songs, 10 000 resamples, mulberry32 seed 7007), never pooled with v1 or the earlier lists. Results never change the list: no redraw, no replacement or addition.`
  );
}

export type HeldoutV2List = SongList & {
  v2: {
    protocol: string;
    pool: string;
    searchLog: string;
    uploadRule: UploadRule;
    startRank: number;
    stopRank: number;
    searchedFromStart: number;
    skipped: { rank: number; id: string; reason: string }[];
    sizeRule: V2SizeRule;
  };
};

export interface HeldoutV2Result extends Omit<HeldoutListResult, 'list'> {
  list: HeldoutV2List;
  startRank: number;
}

const V2_SEARCH = 'the PR #31 search log, walked for the v2 batch (PR #33)';

export function buildHeldoutV2List(input: { order: RankedSong[]; log: SearchLog; dataset: DatasetInfo; declaredAt: string; size: V2SizeRule; startRank?: number }): HeldoutV2Result {
  const startRank = input.startRank ?? V2_START_RANK;
  const target = input.size.n;
  if (!Number.isInteger(startRank) || startRank < 1) throw new Error(`v2 list: start rank must be a positive integer, got ${startRank}`);
  if (input.log.schema !== SEARCH_LOG_SCHEMA) throw new Error(`search log: expected schema ${SEARCH_LOG_SCHEMA}`);
  const entries = input.log.entries;
  const chosen: HeldoutListResult['chosen'] = [];
  const skipped: HeldoutListResult['skipped'] = [];
  const songs: SongEntry[] = [];
  const uploads: Record<string, UploadEntry> = {};
  let stopRank = 0;
  let searched = 0;
  let started = false;
  for (let i = 0; i < entries.length && chosen.length < target; i++) {
    const song = input.order[i];
    if (!song) throw new Error(`search log: entry ${i + 1} is past the end of the pool`);
    if (entries[i].rank !== song.rank || entries[i].id !== song.id) throw new Error(`search log: entry ${i + 1} is rank ${entries[i].rank} id ${entries[i].id}, the pool order has rank ${song.rank} id ${song.id}`);
    if (song.rank < startRank) continue;
    started = true;
    searched++;
    // Only the raw query results are used: the logged decisions belong to the v1 walks.
    const decision = decideEntry(song, { rank: entries[i].rank, id: entries[i].id, queries: entries[i].queries }, V2_RULE);
    if (decision.status === 'chosen') {
      const e = songEntry(song, decision, V2_RULE, V2_SEARCH);
      songs.push(e);
      const c = decision.chosen!;
      uploads[e.id] = { youtubeId: c.videoId, durationSec: c.lengthSec!, channel: c.channel, uploadTitle: c.title };
      chosen.push({ rank: song.rank, id: song.id, songId: e.id, decision });
      if (chosen.length === target) stopRank = song.rank;
    } else skipped.push({ rank: song.rank, id: song.id, artist: song.artist, title: song.title, decision });
  }
  if (!started) throw new Error(`search log: no entry at or after rank ${startRank}`);
  if (chosen.length < target)
    throw new Error(`search log: only ${chosen.length} of ${target} songs have an upload from rank ${startRank} to the end of the log (rank ${entries.at(-1)!.rank}); stop and ask the user (no new search)`);
  const list: HeldoutV2List = {
    schema: SONG_LIST_SCHEMA,
    declaredAt: input.declaredAt,
    purpose: heldoutV2Purpose(input.size, startRank),
    datasets: { [BILLBOARD_DATASET]: input.dataset },
    songs,
    v2: {
      protocol: 'PR #33',
      pool: 'docs/annotation-heldout-v1-pool.json',
      searchLog: 'docs/annotation-heldout-v1-search-log.json',
      uploadRule: V2_RULE,
      startRank,
      stopRank,
      searchedFromStart: searched,
      skipped: skipped.map((s) => ({ rank: s.rank, id: id4(s.id), reason: s.decision.reason ?? s.decision.status })),
      sizeRule: input.size,
    },
  };
  return { rule: V2_RULE, startRank, stopRank, list, uploads, chosen, skipped };
}
