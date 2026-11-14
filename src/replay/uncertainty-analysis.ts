/**
 * VGT-19 uncertain-section measurement (docs/uncertainty-protocol.md): error classes of a replayed
 * chart against its time-mapped reference, the threshold θ_f per signal, the measured quantities per
 * (signal, θ), the pair bootstrap, and the mechanical criterion steps 1-4 (DEV) or the TEST reading.
 * Every number is read from the charts buildAutoChart returns (events, coverage and `uncertain`), over
 * the majmin-evaluated region of scoreSong (checked against scoreSong for every song).
 */
import { isNoChord } from '../arrange/chord';
import type { Chart } from '../chart/types';
import { annotationChart, overlapRanges, scoreSong, type AnnotationSegment } from '../eval/annotations';
import { chartIntervals, reduceSymbol, type LabeledInterval } from '../eval/metrics';
import type { MapEntry } from '../eval/paired';
import { BOOTSTRAP_RESAMPLES, BOOTSTRAP_SEED, CI_LEVEL, mulberry32, quantile } from '../eval/song-mean';
import { chartWithSecondChoices, chordChanges } from '../eval/uncertain-replace';
import { UNCERTAINTY_SIGNALS, unitSignal, type PlacedUnit, type UncertaintyOptions, type UncertaintySignal } from '../recognize/uncertainty';

export const NOMINAL_SHARES = [0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.4] as const;
/** Step 3: the operating point is the smallest of these at which the capture reaches 50%. */
export const OPERATING_SHARES = [0.1, 0.15, 0.2] as const;
export const SELECTION_SHARE = 0.2;
export const ERROR_CLASSES = ['differentChord', 'missedChange', 'boundary', 'N'] as const;
export type ErrorClass = (typeof ERROR_CLASSES)[number];
export type ClassKey = 'all' | ErrorClass;
export const CLASS_KEYS: ClassKey[] = ['all', ...ERROR_CLASSES];
/** The existing rule of the panel: S1 (event confidence) below 0.5. */
export const EXISTING_RULE: UncertaintyOptions = { signal: 'S1', threshold: 0.5 };

const r3 = (x: number): number => Math.round(x * 1000) / 1000;
const EPS = 1e-9;

interface Span {
  from: number;
  to: number;
}

/** Index of the interval containing t (sorted, non-overlapping, [from, to)); -1 if none. */
export function locate<T extends Span>(xs: T[], t: number): number {
  let lo = 0;
  let hi = xs.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (xs[mid].from <= t) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found >= 0 && t < xs[found].to ? found : -1;
}

const overlap = (a: Span, b: Span): number => Math.max(0, Math.min(a.to, b.to) - Math.max(a.from, b.from));
const toSpans = (xs: LabeledInterval[]): (Span & { symbol: string })[] => xs.map((i) => ({ from: i.startSec, to: i.endSec, symbol: i.symbol }));

// ---------------------------------------------------------------- Error classes

/** A reference segment: consecutive touching reference intervals with one majmin label; null = unevaluated (a barrier). */
export interface RefSegment extends Span {
  label: string | null;
}

/** Reference segments of the reference intervals and the segment of each interval. */
export function referenceSegments(ref: LabeledInterval[]): { segments: RefSegment[]; ofInterval: number[] } {
  const segments: RefSegment[] = [];
  const ofInterval: number[] = [];
  for (const i of ref) {
    const label = reduceSymbol(i.symbol, 'majmin');
    const last = segments[segments.length - 1];
    if (last && label !== null && last.label === label && Math.abs(last.to - i.startSec) < EPS) last.to = i.endSec;
    else segments.push({ from: i.startSec, to: i.endSec, label });
    ofInterval.push(segments.length - 1);
  }
  return { segments, ofInterval };
}

/** Chart runs: consecutive touching chart intervals with one majmin label (a non-majmin chord keys by its symbol); split at coverage gaps. */
export function chartRuns(est: LabeledInterval[]): { runs: Span[]; ofInterval: number[] } {
  const runs: (Span & { key: string })[] = [];
  const ofInterval: number[] = [];
  for (const i of est) {
    const key = reduceSymbol(i.symbol, 'majmin') ?? `other:${i.symbol}`;
    const last = runs[runs.length - 1];
    if (last && last.key === key && Math.abs(last.to - i.startSec) < EPS) last.to = i.endSec;
    else runs.push({ from: i.startSec, to: i.endSec, key });
    ofInterval.push(runs.length - 1);
  }
  return { runs, ofInterval };
}

/** One elementary stretch of the majmin-evaluated region. */
export interface Piece extends Span {
  dur: number;
  /** Reference majmin label (never null: unevaluated time is not in the region). */
  ref: string;
  refSeg: number;
  /** Chart chord (null: no chart event there) and its majmin label. */
  est: string | null;
  estRed: string | null;
  correct: boolean;
  /** Error class; null for correct time. */
  cls: ErrorClass | null;
  /** Unit (index into the unit layer) whose rounded interval holds the piece; -1 if none. */
  unit: number;
}

export interface SongAnatomy {
  pieces: Piece[];
  segments: RefSegment[];
  evaluatedSec: number;
  correctSec: number;
}

/**
 * Cuts the majmin-evaluated region (reference coverage ∩ chart coverage, reference labels inside the
 * majmin reduction) at every reference, chart and unit boundary and classifies each error piece:
 * N; hold-over (the chart label equals the label of the reference segment touching R before or after,
 * and the chart run holding the piece overlaps that neighbour) as missed change when the chart shows
 * R's label nowhere inside R, else boundary; every other error piece is a different chord.
 */
export function songAnatomy(reference: Chart, chart: Chart, unitLayer: Span[] = []): SongAnatomy {
  const refInts = chartIntervals(reference.events, reference.coverage);
  const estInts = chartIntervals(chart.events, chart.coverage);
  const refS = toSpans(refInts);
  const estS = toSpans(estInts);
  const { segments, ofInterval: segOf } = referenceSegments(refInts);
  const { runs, ofInterval: runOf } = chartRuns(estInts);
  // Does the chart show R's label anywhere inside R (positive duration)?
  const shows = segments.map((s) => s.label !== null && estS.some((e) => overlap(e, s) > 0 && reduceSymbol(e.symbol, 'majmin') === s.label));
  const bounds: number[] = [];
  for (const xs of [refS, estS, unitLayer]) for (const x of xs) bounds.push(x.from, x.to);
  bounds.sort((a, b) => a - b);
  const pieces: Piece[] = [];
  for (const r of overlapRanges(reference.coverage, chart.coverage)) {
    const times = [r.fromSec, ...bounds.filter((t) => t > r.fromSec && t < r.toSec), r.toSec].filter((t, k, a) => k === 0 || t !== a[k - 1]);
    for (let k = 0; k < times.length - 1; k++) {
      const from = times[k];
      const to = times[k + 1];
      const mid = (from + to) / 2;
      const ri = locate(refS, mid);
      if (ri < 0) continue;
      const ref = reduceSymbol(refS[ri].symbol, 'majmin');
      if (ref === null) continue;
      const ci = locate(estS, mid);
      const est = ci >= 0 ? estS[ci].symbol : null;
      const estRed = est === null ? null : reduceSymbol(est, 'majmin');
      const correct = estRed !== null && estRed === ref;
      const refSeg = segOf[ri];
      let cls: ErrorClass | null = null;
      if (!correct) {
        if (ref === 'N' || (est !== null && isNoChord(est))) cls = 'N';
        else {
          const R = segments[refSeg];
          const run = ci >= 0 ? runs[runOf[ci]] : null;
          const hold = [segments[refSeg - 1], segments[refSeg + 1]].some(
            (nb, side) =>
              nb !== undefined &&
              nb.label !== null &&
              Math.abs(side === 0 ? nb.to - R.from : R.to - nb.from) < EPS &&
              estRed === nb.label &&
              run !== null &&
              overlap(run, nb) > 0,
          );
          cls = hold ? (shows[refSeg] ? 'boundary' : 'missedChange') : 'differentChord';
        }
      }
      pieces.push({ from, to, dur: to - from, ref, refSeg, est, estRed, correct, cls, unit: locate(unitLayer, mid) });
    }
  }
  const evaluatedSec = pieces.reduce((a, p) => a + p.dur, 0);
  const correctSec = pieces.reduce((a, p) => a + (p.correct ? p.dur : 0), 0);
  return { pieces, segments, evaluatedSec, correctSec };
}

/** Reference segments with evaluated time and no correct chart time inside (whatever the error class). */
export function omittedSegments(pieces: Piece[]): number[] {
  const seg = new Map<number, { evalSec: number; correctSec: number }>();
  for (const p of pieces) {
    const s = seg.get(p.refSeg) ?? { evalSec: 0, correctSec: 0 };
    s.evalSec += p.dur;
    if (p.correct) s.correctSec += p.dur;
    seg.set(p.refSeg, s);
  }
  return [...seg.entries()].filter(([, s]) => s.evalSec > 0 && s.correctSec === 0).map(([k]) => k);
}

// ---------------------------------------------------------------- Songs

/** A placed unit with its rounded interval, the evaluated seconds inside it and its signal values. */
export interface UnitRecord extends Span {
  evalSec: number;
  /** Signal values; null when the unit can never be flagged (no final event of its own, or no alt family). */
  values: Record<UncertaintySignal, number> | null;
  /** The unit's alt-family member with the highest mean probability (oracle diagnostic). */
  bestAlt: string | null;
}

/** Signal values of a placed unit, or null when it cannot be flagged (as isFlagged decides). */
export function unitValues(p: PlacedUnit, chart: Chart): Record<UncertaintySignal, number> | null {
  const st = p.unit.stats;
  if (!st) throw new Error('uncertainty analysis: decoded units carry no stats (replay with the shipped Recognizer)');
  if (p.event < 0 || st.altFamily === null) return null;
  const e = chart.events[p.event];
  if (e.chord !== p.unit.symbol) return null;
  return Object.fromEntries(UNCERTAINTY_SIGNALS.map((s) => [s, unitSignal(s, st, e.confidence ?? 0)])) as Record<UncertaintySignal, number>;
}

export interface SongInput {
  id: string;
  youtubeId: string;
  map: MapEntry;
  segs: AnnotationSegment[];
  annBeats: number[] | null;
  /** The replayed chart without flags and the placed units buildAutoChart used for it. */
  chart: Chart;
  placed: PlacedUnit[];
  /** buildAutoChart of the same analyses with flags. */
  build(opts: UncertaintyOptions): Chart;
}

export interface PreparedSong {
  input: SongInput;
  majmin: number;
  anatomy: SongAnatomy;
  units: UnitRecord[];
  coverageSec: number;
  /** Error seconds per class and what the per-unit best alt member would fix (oracle). */
  errSec: Record<ClassKey, number>;
  oracleFixSec: Record<ClassKey, number>;
  /** Reference segments with evaluated time and no correct chart time inside. */
  omitted: number[];
}

const zeroByClass = (): Record<ClassKey, number> => ({ all: 0, differentChord: 0, missedChange: 0, boundary: 0, N: 0 });

export function songScore(x: Pick<SongInput, 'segs' | 'annBeats' | 'map'>, chart: Chart): { score: number; evaluatedSec: number } {
  const m = x.map;
  const s = scoreSong(x.segs, x.annBeats, chart, m.offsetSec, m.mediaDurationSec, 1, m.rate).comparison.majmin;
  return { score: s.score, evaluatedSec: s.evaluatedSec };
}

export function prepareSong(x: SongInput): PreparedSong {
  const m = x.map;
  const reference = annotationChart(x.segs, m.offsetSec, null, m.mediaDurationSec, false, m.rate);
  const records = x.placed.map((p) => ({ from: r3(p.startSec), to: r3(p.endSec), evalSec: 0, values: unitValues(p, x.chart), bestAlt: bestMember(p) }));
  // The unit layer: rounded unit intervals (they tile each owned range; zero-length ones hold no time).
  const layerIdx = records.map((r, k) => (r.to > r.from ? k : -1)).filter((k) => k >= 0);
  const layer = layerIdx.map((k) => records[k]);
  const anatomy = songAnatomy(reference, x.chart, layer);
  const official = songScore(x, x.chart);
  if (!(official.evaluatedSec > 0)) throw new Error(`${x.id}: no majmin-evaluated seconds under this map`);
  if (Math.abs(anatomy.evaluatedSec - official.evaluatedSec) > 1e-6 || Math.abs(anatomy.correctSec / anatomy.evaluatedSec - official.score) > 1e-6)
    throw new Error(`${x.id}: evaluated region differs from scoreSong (${anatomy.evaluatedSec} vs ${official.evaluatedSec} s)`);
  const errSec = zeroByClass();
  const oracleFixSec = zeroByClass();
  for (const p of anatomy.pieces) {
    if (p.unit >= 0) p.unit = layerIdx[p.unit];
    if (p.unit >= 0) records[p.unit].evalSec += p.dur;
    if (!p.cls) continue;
    errSec.all += p.dur;
    errSec[p.cls] += p.dur;
    const u = p.unit >= 0 ? records[p.unit] : null;
    if (u && u.values && u.bestAlt !== null && reduceSymbol(u.bestAlt, 'majmin') === p.ref) {
      oracleFixSec.all += p.dur;
      oracleFixSec[p.cls] += p.dur;
    }
  }
  const omitted = omittedSegments(anatomy.pieces);
  const coverageSec = x.chart.coverage.reduce((a, r) => a + r.toSec - r.fromSec, 0);
  return { input: x, majmin: official.score, anatomy, units: records, coverageSec, errSec, oracleFixSec, omitted };
}

function bestMember(p: PlacedUnit): string | null {
  const st = p.unit.stats;
  if (!st || st.altFamily === null || !st.altSymbols.length) return null;
  let best = 0;
  for (let k = 1; k < st.altProbs.length; k++) if (st.altProbs[k] > st.altProbs[best]) best = k;
  return st.altSymbols[best];
}

// ---------------------------------------------------------------- Thresholds

/**
 * θ_f: flags the largest pooled share of evaluated time at or below f (units below θ are flagged,
 * equal values together). θ is the smallest value with evaluated time that stays unflagged (Infinity
 * when everything can be flagged). Units without evaluated time do not move the share.
 */
export function thresholdFor(values: { v: number; t: number }[], totalSec: number, f: number): { threshold: number; share: number } {
  if (!(totalSec > 0)) throw new Error('threshold: no evaluated time');
  const sorted = values.filter((x) => x.t > 0).sort((a, b) => a.v - b.v);
  let cum = 0;
  let k = 0;
  while (k < sorted.length) {
    let j = k;
    let t = 0;
    while (j < sorted.length && sorted[j].v === sorted[k].v) t += sorted[j++].t;
    if ((cum + t) / totalSec > f) return { threshold: sorted[k].v, share: cum / totalSec };
    cum += t;
    k = j;
  }
  return { threshold: Infinity, share: cum / totalSec };
}

/** Pooled (value, evaluated seconds) of every flaggable unit of the songs, and their total evaluated seconds. */
export function pooledUnitValues(songs: PreparedSong[], signal: UncertaintySignal): { values: { v: number; t: number }[]; totalSec: number } {
  const values: { v: number; t: number }[] = [];
  let totalSec = 0;
  for (const s of songs) {
    totalSec += s.anatomy.evaluatedSec;
    for (const u of s.units) if (u.values) values.push({ v: u.values[signal], t: u.evalSec });
  }
  return { values, totalSec };
}

// ---------------------------------------------------------------- Statistics

export interface Interval95 {
  lower: number;
  upper: number;
  /** Draws with a non-zero denominator (the others are dropped). */
  validDraws: number;
}

/** A ratio of summed numerators to summed denominators over songs. value null = not assessable (zero denominator). */
export interface Share {
  value: number | null;
  num: number;
  den: number;
  /** Mean of per-song ratios over songs with a non-zero denominator. */
  songMean: number | null;
  songs: number;
  ci: Interval95 | null;
}

/**
 * Song-level percentile bootstrap of sum(num) / sum(den): each draw resamples songs' (num, den) pairs
 * with replacement (mulberry32, fixed seed); draws with a zero denominator are dropped.
 */
export function pairBootstrap(pairs: [number, number][], resamples = BOOTSTRAP_RESAMPLES, seed = BOOTSTRAP_SEED, level = CI_LEVEL): Interval95 | null {
  const n = pairs.length;
  if (!n) return null;
  const rnd = mulberry32(seed);
  const draws: number[] = [];
  for (let b = 0; b < resamples; b++) {
    let num = 0;
    let den = 0;
    for (let i = 0; i < n; i++) {
      const [a, d] = pairs[Math.floor(rnd() * n)];
      num += a;
      den += d;
    }
    if (den !== 0) draws.push(num / den);
  }
  if (!draws.length) return null;
  const a = (1 - level) / 2;
  return { lower: quantile(draws, a), upper: quantile(draws, 1 - a), validDraws: draws.length };
}

export function share(pairs: [number, number][], bootstrap = true): Share {
  const num = pairs.reduce((a, p) => a + p[0], 0);
  const den = pairs.reduce((a, p) => a + p[1], 0);
  const per = pairs.filter((p) => p[1] !== 0).map((p) => p[0] / p[1]);
  return {
    value: den !== 0 ? num / den : null,
    num,
    den,
    songMean: per.length ? per.reduce((a, b) => a + b, 0) / per.length : null,
    songs: per.length,
    ci: bootstrap && den !== 0 ? pairBootstrap(pairs) : null,
  };
}

// ---------------------------------------------------------------- One setting

/** Per-song sums of one (signal, θ) setting. */
export interface SongSetting {
  id: string;
  evalSec: number;
  flaggedSec: number;
  errSec: Record<ClassKey, number>;
  flaggedErrSec: Record<ClassKey, number>;
  altFixSec: Record<ClassKey, number>;
  altRightSec: number;
  shownRightSec: number;
  /** Majmin WCSR change when every span takes its second choice. */
  blindDelta: number;
  spans: number;
  spanDurations: number[];
  coverageSec: number;
  shownChanges: number;
  replacedChanges: number;
  omitted: number;
  omittedFlagged: number;
}

/** Measures one song's chart with `uncertain` (built for opts) and checks it against the unit values. */
export function measureSong(song: PreparedSong, chart: Chart, opts: UncertaintyOptions): SongSetting {
  const spans = (chart.uncertain ?? []).map((s) => ({ from: s.fromSec, to: s.toSec, alt: s.alt, chord: s.chord }));
  const errSec = zeroByClass();
  const flaggedErrSec = zeroByClass();
  const altFixSec = zeroByClass();
  let flaggedSec = 0;
  let altRightSec = 0;
  let shownRightSec = 0;
  const flaggedSegs = new Set<number>();
  for (const p of song.anatomy.pieces) {
    if (p.cls) {
      errSec.all += p.dur;
      errSec[p.cls] += p.dur;
    }
    const k = locate(spans, (p.from + p.to) / 2);
    if (k < 0) continue;
    const s = spans[k];
    if (p.est !== s.chord) throw new Error(`${song.input.id}: span ${s.from}-${s.to} names ${s.chord}, the chart shows ${p.est}`);
    flaggedSec += p.dur;
    flaggedSegs.add(p.refSeg);
    const altRight = reduceSymbol(s.alt, 'majmin') === p.ref;
    if (altRight) altRightSec += p.dur;
    if (p.correct) shownRightSec += p.dur;
    if (p.cls) {
      flaggedErrSec.all += p.dur;
      flaggedErrSec[p.cls] += p.dur;
      if (altRight) {
        altFixSec.all += p.dur;
        altFixSec[p.cls] += p.dur;
      }
    }
  }
  // The spans' evaluated time equals the evaluated time of the units below θ (one rule, two readings).
  const expected = song.units.reduce((a, u) => a + (u.values && u.values[opts.signal] < opts.threshold ? u.evalSec : 0), 0);
  if (Math.abs(expected - flaggedSec) > 1e-6) throw new Error(`${song.input.id}: flagged ${flaggedSec} s in spans but ${expected} s in units below θ (${opts.signal} < ${opts.threshold})`);
  const replaced = chartWithSecondChoices(chart);
  return {
    id: song.input.id,
    evalSec: song.anatomy.evaluatedSec,
    flaggedSec,
    errSec,
    flaggedErrSec,
    altFixSec,
    altRightSec,
    shownRightSec,
    blindDelta: songScore(song.input, replaced).score - song.majmin,
    spans: spans.length,
    spanDurations: spans.map((s) => s.to - s.from),
    coverageSec: song.coverageSec,
    shownChanges: chordChanges(chart),
    replacedChanges: chordChanges(replaced),
    omitted: song.omitted.length,
    omittedFlagged: song.omitted.filter((k) => flaggedSegs.has(k)).length,
  };
}

export interface SettingResult {
  signal: UncertaintySignal;
  /** Nominal share (null for a fixed threshold). */
  f: number | null;
  /** Full precision (Infinity is written as null in JSON). */
  threshold: number;
  flaggedShare: Share;
  capture: Record<ClassKey, Share>;
  precision: Share;
  secondChoice: { altRight: Share; shownRight: Share; fixes: Record<ClassKey, Share> };
  /** Song-mean majmin change if every span took its second choice (diagnostic). */
  blindReplacement: Share;
  spread: {
    flaggedShareBySong: { min: number; median: number; max: number } | null;
    spansPerMin: number | null;
    spanDurationSec: { median: number; p10: number } | null;
    chordChangesPerMin: { shown: number; secondChoices: number; added: number } | null;
  };
  omittedSegments: { segments: number; withFlaggedTime: number };
}

const byClass = <T>(f: (k: ClassKey) => T): Record<ClassKey, T> => Object.fromEntries(CLASS_KEYS.map((k) => [k, f(k)])) as Record<ClassKey, T>;

export function aggregateSetting(signal: UncertaintySignal, f: number | null, threshold: number, rows: SongSetting[], bootstrap = true): SettingResult {
  const pairs = (num: (r: SongSetting) => number, den: (r: SongSetting) => number) => share(rows.map((r) => [num(r), den(r)]), bootstrap);
  const perSong = rows.filter((r) => r.evalSec > 0).map((r) => r.flaggedSec / r.evalSec);
  const durations = rows.flatMap((r) => r.spanDurations);
  const covMin = rows.reduce((a, r) => a + r.coverageSec, 0) / 60;
  const shown = rows.reduce((a, r) => a + r.shownChanges, 0);
  const replaced = rows.reduce((a, r) => a + r.replacedChanges, 0);
  return {
    signal,
    f,
    threshold,
    flaggedShare: pairs((r) => r.flaggedSec, (r) => r.evalSec),
    capture: byClass((k) => pairs((r) => r.flaggedErrSec[k], (r) => r.errSec[k])),
    precision: pairs((r) => r.flaggedErrSec.all, (r) => r.flaggedSec),
    secondChoice: {
      altRight: pairs((r) => r.altRightSec, (r) => r.flaggedSec),
      shownRight: pairs((r) => r.shownRightSec, (r) => r.flaggedSec),
      fixes: byClass((k) => pairs((r) => r.altFixSec[k], (r) => r.flaggedErrSec[k])),
    },
    blindReplacement: pairs((r) => r.blindDelta, () => 1),
    spread: {
      flaggedShareBySong: perSong.length ? { min: Math.min(...perSong), median: quantile(perSong, 0.5), max: Math.max(...perSong) } : null,
      spansPerMin: covMin > 0 ? rows.reduce((a, r) => a + r.spans, 0) / covMin : null,
      spanDurationSec: durations.length ? { median: quantile(durations, 0.5), p10: quantile(durations, 0.1) } : null,
      chordChangesPerMin: covMin > 0 ? { shown: shown / covMin, secondChoices: replaced / covMin, added: (replaced - shown) / covMin } : null,
    },
    omittedSegments: { segments: rows.reduce((a, r) => a + r.omitted, 0), withFlaggedTime: rows.reduce((a, r) => a + r.omittedFlagged, 0) },
  };
}

/** Oracle diagnostic: every error piece flagged, second choice = the unit's best alt member. */
export function oracleDiagnostic(songs: PreparedSong[], bootstrap = true): Record<ClassKey, Share> {
  return byClass((k) => share(songs.map((s) => [s.oracleFixSec[k], s.errSec[k]]), bootstrap));
}

export function measureSetting(songs: PreparedSong[], signal: UncertaintySignal, f: number | null, threshold: number, bootstrap = true): { result: SettingResult; charts: Chart[] } {
  const opts = { signal, threshold };
  const charts = songs.map((s) => s.input.build(opts));
  const rows = songs.map((s, i) => measureSong(s, charts[i], opts));
  return { result: aggregateSetting(signal, f, threshold, rows, bootstrap), charts };
}

// ---------------------------------------------------------------- Criterion (DEV) and TEST reading

export type AlarmId = 'A1' | 'A2' | 'A3' | 'A4' | 'T1' | 'T2' | 'T3' | 'T4';
export interface Alarm {
  id: AlarmId;
  raised: boolean;
  detail: string;
}

export interface Criterion {
  /** Step 1: all-error capture at θ_20 per signal and whether it reaches 50%. */
  atSelectionShare: { signal: UncertaintySignal; capture: number | null; missedChange: number | null; share: number | null; eligible: boolean }[];
  eligible: UncertaintySignal[];
  /** Step 2. */
  nearBest: UncertaintySignal[];
  signal: UncertaintySignal | null;
  /** Step 3. */
  operatingPoint: { f: number; threshold: number; share: number | null; capture: number | null } | null;
  /** Step 4 (A5, resource limits, is the parent's). */
  alarms: Alarm[];
  stop: boolean;
}

const fmt = (x: number | null, d = 1) => (x === null ? 'not assessable' : `${(100 * x).toFixed(d)}%`);

/** Alarms 2-4 (or T2-T4) at one setting. */
function settingAlarms(s: SettingResult, ids: [AlarmId, AlarmId, AlarmId]): Alarm[] {
  const share = s.flaggedShare.value;
  const mc = s.capture.missedChange.value;
  const fix = s.secondChoice.fixes.all.value;
  const alt = s.secondChoice.altRight.value;
  const shown = s.secondChoice.shownRight.value;
  return [
    { id: ids[0], raised: mc === null || share === null || mc < 1.5 * share, detail: `missed-change capture ${fmt(mc)} vs 1.5 × flagged share ${share === null ? 'not assessable' : fmt(1.5 * share)}` },
    { id: ids[1], raised: fix === null || fix < 1 / 3, detail: `second choice fixes ${fmt(fix)} of flagged error time (needs ≥ 33.3%)` },
    { id: ids[2], raised: alt === null || shown === null || alt <= shown, detail: `on flagged time second choice right ${fmt(alt)} vs shown chord right ${fmt(shown)}` },
  ];
}

export function criterion(settings: SettingResult[]): Criterion {
  const at = (sig: UncertaintySignal, f: number) => settings.find((s) => s.signal === sig && s.f !== null && Math.abs(s.f - f) < 1e-12);
  const atSelectionShare = UNCERTAINTY_SIGNALS.map((signal) => {
    const s = at(signal, SELECTION_SHARE);
    if (!s) throw new Error(`criterion: no ${signal} setting at f = ${SELECTION_SHARE}`);
    const capture = s.capture.all.value;
    const share = s.flaggedShare.value;
    return { signal, capture, missedChange: s.capture.missedChange.value, share, eligible: capture !== null && capture >= 0.5 && share !== null && share <= SELECTION_SHARE + 1e-12 };
  });
  const eligible = atSelectionShare.filter((x) => x.eligible);
  if (!eligible.length)
    return { atSelectionShare, eligible: [], nearBest: [], signal: null, operatingPoint: null, alarms: [{ id: 'A1', raised: true, detail: 'no signal captures at least 50% of error time at θ_20' }], stop: true };
  const best = Math.max(...eligible.map((x) => x.capture!));
  const near = eligible.filter((x) => best - x.capture! <= 0.01 + 1e-12);
  let chosen = near[0];
  for (const x of near.slice(1)) if ((x.missedChange ?? -Infinity) > (chosen.missedChange ?? -Infinity)) chosen = x;
  const signal = chosen.signal;
  let op: SettingResult | undefined;
  for (const f of OPERATING_SHARES) {
    const s = at(signal, f);
    if (s && s.capture.all.value !== null && s.capture.all.value >= 0.5) {
      op = s;
      break;
    }
  }
  if (!op) throw new Error('criterion: an eligible signal must reach 50% capture at f = 20%');
  const alarms: Alarm[] = [{ id: 'A1', raised: false, detail: `${eligible.length} eligible signal(s)` }, ...settingAlarms(op, ['A2', 'A3', 'A4'])];
  return {
    atSelectionShare,
    eligible: eligible.map((x) => x.signal),
    nearBest: near.map((x) => x.signal),
    signal,
    operatingPoint: { f: op.f!, threshold: op.threshold, share: op.flaggedShare.value, capture: op.capture.all.value },
    alarms,
    stop: alarms.some((a) => a.raised),
  };
}

/** DEV numbers the TEST reading compares with (from the DEV sweep result's criterion). */
export interface DevReference {
  signal: UncertaintySignal;
  threshold: number;
  capture: number;
  share: number;
}

export interface TestReading {
  reading: 'similar' | 'different' | 'not assessable';
  dev: DevReference | null;
  detail: string;
  alarms: Alarm[];
}

export function testReading(s: SettingResult, dev: DevReference | null): TestReading {
  const cap = s.capture.all.value;
  const share = s.flaggedShare.value;
  const alarms: Alarm[] = [{ id: 'T1', raised: cap === null || cap < 0.5, detail: `all-error capture ${fmt(cap)} (needs ≥ 50%)` }, ...settingAlarms(s, ['T2', 'T3', 'T4'])];
  if (!dev) return { reading: 'not assessable', dev, detail: 'no DEV result given (--dev-result)', alarms };
  if (cap === null || share === null) return { reading: 'not assessable', dev, detail: 'TEST capture or flagged share not assessable', alarms };
  const similar = cap >= dev.capture - 0.1 - 1e-12 && share <= dev.share + 0.05 + 1e-12;
  return {
    reading: similar ? 'similar' : 'different',
    dev,
    detail: `TEST capture ${fmt(cap)} vs DEV ${fmt(dev.capture)} − 10 pp; TEST share ${fmt(share)} vs DEV ${fmt(dev.share)} + 5 pp`,
    alarms,
  };
}

/** Reads the frozen criterion out of a DEV sweep result JSON. */
export function devReferenceOf(v: unknown): DevReference {
  const r = v as { criterion?: Criterion; settings?: SettingResult[] };
  const c = r?.criterion;
  if (!c || !c.signal || !c.operatingPoint) throw new Error('--dev-result: no chosen signal / operating point in this file (a DEV sweep result is required)');
  const op = c.operatingPoint;
  if (op.capture === null || op.share === null || op.threshold === null) throw new Error('--dev-result: the operating point has no capture / share / threshold');
  return { signal: c.signal, threshold: op.threshold, capture: op.capture, share: op.share };
}

// ---------------------------------------------------------------- Text

const pc = (x: number | null) => (x === null ? '  n/a' : (100 * x).toFixed(1).padStart(5));

export function settingLine(s: SettingResult): string {
  const th = Number.isFinite(s.threshold) ? s.threshold.toPrecision(6) : '∞';
  return `${s.signal} ${s.f === null ? 'fixed' : `f=${String(Math.round(s.f * 100)).padStart(2)}%`} θ=${th} | share ${pc(s.flaggedShare.value)}% | capture all ${pc(s.capture.all.value)} dc ${pc(s.capture.differentChord.value)} mc ${pc(s.capture.missedChange.value)} bd ${pc(s.capture.boundary.value)} N ${pc(s.capture.N.value)} | prec ${pc(s.precision.value)} | alt right ${pc(s.secondChoice.altRight.value)} shown right ${pc(s.secondChoice.shownRight.value)} fixes ${pc(s.secondChoice.fixes.all.value)}`;
}

export function criterionText(c: Criterion): string {
  const lines = [`criterion: eligible ${c.eligible.join(', ') || 'none'}; within 1 pp: ${c.nearBest.join(', ') || '-'}; signal ${c.signal ?? '-'}`];
  if (c.operatingPoint) lines.push(`operating point f=${Math.round(c.operatingPoint.f * 100)}% θ=${c.operatingPoint.threshold} share ${fmt(c.operatingPoint.share)} capture ${fmt(c.operatingPoint.capture)}`);
  for (const a of c.alarms) lines.push(`${a.id} ${a.raised ? 'RAISED' : 'ok'}: ${a.detail}`);
  lines.push('A5 (resource limits) is checked by the parent.');
  lines.push(c.stop ? 'STOP: an alarm is raised; nothing is frozen until the user decides.' : 'no alarm in A1-A4.');
  return lines.join('\n');
}

