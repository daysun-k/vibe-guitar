/**
 * The predeclared VGT-7 analysis (PR #31): the unweighted mean of per-song majmin WCSR with a
 * percentile bootstrap 95% interval over songs, a Student t interval and 0/100 bounds as
 * sensitivity, and the precision check that decides whether VGT-7 can close. Types only from
 * annotations.ts, so the evaluator can import this module without a cycle at run time.
 */
import type { ExclusionCode, SongResult } from './annotations';

export const BOOTSTRAP_RESAMPLES = 10_000;
export const BOOTSTRAP_SEED = 7007;
export const CI_LEVEL = 0.95;
/** VGT-7 closes only with at least this many songs in the primary mean ... */
export const SUFFICIENT_MIN_SONGS = 15;
/** ... and a bootstrap half-width, (upper - lower) / 2, of at most this. */
export const SUFFICIENT_MAX_HALF_WIDTH = 0.1;
/** Rounding slack for the half-width comparison (far below any reported digit). */
const HALF_WIDTH_EPS = 1e-12;

/** Linear-interpolation quantile (the evaluator's, used for change offsets and the interval). */
export function quantile(xs: number[], q: number): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

/** Percentile bootstrap of the mean: resamples of n values with replacement. */
export function bootstrapMeanCi(xs: number[], resamples = BOOTSTRAP_RESAMPLES, seed = BOOTSTRAP_SEED, level = CI_LEVEL): { lower: number; upper: number } {
  if (!xs.length) return { lower: NaN, upper: NaN };
  const rnd = mulberry32(seed);
  const n = xs.length;
  const means = new Array<number>(resamples);
  for (let b = 0; b < resamples; b++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += xs[Math.floor(rnd() * n)];
    means[b] = s / n;
  }
  const a = (1 - level) / 2;
  return { lower: quantile(means, a), upper: quantile(means, 1 - a) };
}

// Student t quantile through the regularized incomplete beta function (Numerical Recipes).
function logGamma(x: number): number {
  const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x;
  const tmp = x + 5.5 - (x + 0.5) * Math.log(x + 5.5);
  let ser = 1.000000000190015;
  for (const v of c) ser += v / ++y;
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}

function betaCf(a: number, b: number, x: number): number {
  const tiny = 1e-300;
  let c = 1;
  let d = 1 - ((a + b) * x) / (a + 1);
  if (Math.abs(d) < tiny) d = tiny;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 300; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((a + m2 - 1) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + aa / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (a + b + m) * x) / ((a + m2) * (a + m2 + 1));
    d = 1 + aa * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + aa / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-15) break;
  }
  return h;
}

function incompleteBeta(a: number, b: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? (bt * betaCf(a, b, x)) / a : 1 - (bt * betaCf(b, a, 1 - x)) / b;
}

/** P(T <= t) for Student t with df degrees of freedom. */
export function studentTCdf(t: number, df: number): number {
  const tail = 0.5 * incompleteBeta(df / 2, 0.5, df / (df + t * t));
  return t >= 0 ? 1 - tail : tail;
}

/** Quantile of Student t (p in (0.5, 1)), by bisection to 1e-12. */
export function studentTQuantile(p: number, df: number): number {
  let lo = 0;
  let hi = 1;
  while (studentTCdf(hi, df) < p) hi *= 2;
  for (let i = 0; i < 200 && hi - lo > 1e-12; i++) {
    const mid = (lo + hi) / 2;
    if (studentTCdf(mid, df) < p) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Student t interval of the mean; null below two songs. */
export function tMeanCi(xs: number[], level = CI_LEVEL): { lower: number; upper: number; df: number; tCrit: number; sd: number } | null {
  const n = xs.length;
  if (n < 2) return null;
  const m = mean(xs);
  const sd = Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (n - 1));
  const tCrit = studentTQuantile(1 - (1 - level) / 2, n - 1);
  const h = (tCrit * sd) / Math.sqrt(n);
  return { lower: m - h, upper: m + h, df: n - 1, tCrit, sd };
}

/** The VGT-7 closing check: n >= 15 and (upper - lower) / 2 <= 0.10 (both inputs reported). */
export function precisionCheck(n: number, lower: number, upper: number): { minSongs: number; maxHalfWidth: number; n: number; halfWidth: number; met: boolean } {
  const halfWidth = (upper - lower) / 2;
  return {
    minSongs: SUFFICIENT_MIN_SONGS,
    maxHalfWidth: SUFFICIENT_MAX_HALF_WIDTH,
    n,
    halfWidth,
    met: n >= SUFFICIENT_MIN_SONGS && Number.isFinite(halfWidth) && halfWidth <= SUFFICIENT_MAX_HALF_WIDTH + HALF_WIDTH_EPS,
  };
}

export interface SongMeanAnalysis {
  population: string;
  counts: {
    /** Eval songs of the group (the list's selected songs). */
    selected: number;
    scored: number;
    /** Scored with a finite majmin score and majmin evaluated seconds > 0. */
    primary: number;
    /** Scored but outside the primary population. */
    scoredNotPrimary: number;
    excluded: number;
    excludedByCode: Partial<Record<ExclusionCode, number>>;
    missing: number;
    error: number;
    /** Songs whose alignment found the near-0 / bar-phase conflict (VGT-7 rule 4). */
    barConflict: number;
  };
  /** Unweighted mean of per-song majmin WCSR (primary). */
  mean: number;
  median: number;
  min: number;
  max: number;
  /** Song means of root and sevenths over the primary songs (finite scores). */
  songMean: { root: number; sevenths: number };
  bootstrap: { method: 'percentile'; resamples: number; prng: 'mulberry32'; seed: number; level: number; lower: number; upper: number; halfWidth: number };
  /** Sensitivity only, never swapped in. Null below two songs. */
  tInterval: { lower: number; upper: number; df: number; tCrit: number; sd: number } | null;
  /** Mean over every selected song with unscored songs at 0 (lower) or 1 (upper): bounds, not imputed scores. */
  bounds: { songs: number; lower: number; upper: number };
  /** Over the primary songs; lengthSec is the annotation length (min, median, max). */
  composition: { complexity: Record<string, number>; lengthSec: { min: number; median: number; max: number }; repeatedArtists: { artist: string; songs: number }[] };
  sufficiency: ReturnType<typeof precisionCheck>;
}

const isPrimary = (r: SongResult) => r.status === 'scored' && !!r.score && Number.isFinite(r.score.comparison.majmin.score) && r.score.comparison.majmin.evaluatedSec > 0;

/** The predeclared analysis over the given eval rows (the caller picks the group). */
export function songMeanAnalysis(rows: SongResult[]): SongMeanAnalysis {
  const primary = rows.filter(isPrimary);
  const xs = primary.map((r) => r.score!.comparison.majmin.score);
  const sorted = [...xs].sort((a, b) => a - b);
  const excludedByCode: Partial<Record<ExclusionCode, number>> = {};
  for (const r of rows) {
    const code = r.status === 'excluded' ? r.alignment?.excluded?.code : undefined;
    if (code) excludedByCode[code] = (excludedByCode[code] ?? 0) + 1;
  }
  const count = (s: SongResult['status']) => rows.filter((r) => r.status === s).length;
  const ci = bootstrapMeanCi(xs);
  const finiteMean = (k: 'root' | 'sevenths') => mean(primary.map((r) => r.score!.comparison[k].score).filter(Number.isFinite));
  const sum = xs.reduce((a, b) => a + b, 0);
  const others = rows.length - primary.length;
  const complexity: Record<string, number> = {};
  const artists = new Map<string, number>();
  for (const r of primary) {
    complexity[r.complexity] = (complexity[r.complexity] ?? 0) + 1;
    artists.set(r.artist, (artists.get(r.artist) ?? 0) + 1);
  }
  const lengths = primary.map((r) => r.annotationDurationSec).filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
  return {
    population: 'eval songs of the group with status scored, a finite majmin score and majmin evaluated seconds > 0',
    counts: {
      selected: rows.length,
      scored: count('scored'),
      primary: primary.length,
      scoredNotPrimary: count('scored') - primary.length,
      excluded: count('excluded'),
      excludedByCode,
      missing: count('missing'),
      error: count('error'),
      barConflict: rows.filter((r) => r.alignment?.barConflict).length,
    },
    mean: mean(xs),
    median: quantile(xs, 0.5),
    min: sorted.length ? sorted[0] : NaN,
    max: sorted.length ? sorted[sorted.length - 1] : NaN,
    songMean: { root: finiteMean('root'), sevenths: finiteMean('sevenths') },
    bootstrap: { method: 'percentile', resamples: BOOTSTRAP_RESAMPLES, prng: 'mulberry32', seed: BOOTSTRAP_SEED, level: CI_LEVEL, lower: ci.lower, upper: ci.upper, halfWidth: (ci.upper - ci.lower) / 2 },
    tInterval: tMeanCi(xs),
    bounds: { songs: rows.length, lower: rows.length ? sum / rows.length : NaN, upper: rows.length ? (sum + others) / rows.length : NaN },
    composition: {
      complexity,
      lengthSec: { min: lengths.length ? Math.min(...lengths) : NaN, median: quantile(lengths, 0.5), max: lengths.length ? Math.max(...lengths) : NaN },
      repeatedArtists: [...artists].filter(([, n]) => n > 1).map(([artist, songs]) => ({ artist, songs })).sort((a, b) => b.songs - a.songs || (a.artist < b.artist ? -1 : 1)),
    },
    sufficiency: precisionCheck(primary.length, ci.lower, ci.upper),
  };
}
