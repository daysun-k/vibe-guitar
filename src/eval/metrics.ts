/**
 * Evaluation metrics in the spirit of mir_eval:
 * - weighted chord symbol recall (WCSR) under the majmin / root / sevenths reductions,
 *   duration-weighted over the time both labelings cover;
 * - beat F-measure with a ±70 ms window (no 5 s trimming, unlike mir_eval's default);
 * - chart-vs-chart comparison, for evaluating user-made charts against auto charts.
 */
import { isNoChord, parseChord } from '../arrange/chord';
import { normalizeCoverage } from '../chart/coverage';
import type { Chart, CoverageRange } from '../chart/types';

export type Reduction = 'majmin' | 'root' | 'sevenths';

/** Reduced label, or null when the reference chord is outside the reduction (excluded). */
export function reduceSymbol(symbol: string, reduction: Reduction): string | null {
  if (isNoChord(symbol)) return 'N';
  let c;
  try {
    c = parseChord(symbol);
  } catch {
    return null;
  }
  const root = String(c.root);
  if (reduction === 'root') return root;
  if (reduction === 'majmin') {
    if (c.triad === 'maj' || c.triad === 'min') return `${root}:${c.triad}`;
    return null;
  }
  // sevenths: maj, min, 7, maj7, min7
  if (c.triad === 'maj' && c.seventh === 'none' && !c.extension) return `${root}:maj`;
  if (c.triad === 'min' && c.seventh === 'none' && !c.extension) return `${root}:min`;
  if (c.triad === 'maj' && c.seventh === 'b7') return `${root}:7`;
  if (c.triad === 'maj' && c.seventh === 'maj7') return `${root}:maj7`;
  if (c.triad === 'min' && c.seventh === 'b7') return `${root}:min7`;
  return null;
}

export interface LabeledInterval {
  startSec: number;
  endSec: number;
  symbol: string;
}

/** Events → intervals clipped to coverage (an event lasts until the next event or the end of its range). */
export function chartIntervals(events: { startSec: number; chord: string }[], coverage: CoverageRange[]): LabeledInterval[] {
  const ranges = normalizeCoverage(coverage);
  const sorted = [...events].sort((a, b) => a.startSec - b.startSec);
  const out: LabeledInterval[] = [];
  for (const r of ranges) {
    const inside = sorted.filter((e) => e.startSec >= r.fromSec && e.startSec < r.toSec);
    inside.forEach((e, i) => out.push({ startSec: e.startSec, endSec: inside[i + 1]?.startSec ?? r.toSec, symbol: e.chord }));
  }
  return out;
}

export interface WcsrResult {
  /** Fraction of the evaluated duration where the reduced labels agree (NaN if nothing to evaluate). */
  score: number;
  /** Seconds evaluated (both labeled and the reference is inside the reduction). */
  evaluatedSec: number;
}

/** Duration-weighted agreement of two labelings. Times not labeled by `est` count as wrong. */
export function wcsr(ref: LabeledInterval[], est: LabeledInterval[], reduction: Reduction): WcsrResult {
  // Merge boundaries.
  const cuts = new Set<number>();
  for (const i of [...ref, ...est]) {
    cuts.add(i.startSec);
    cuts.add(i.endSec);
  }
  const times = [...cuts].sort((a, b) => a - b);
  const at = (xs: LabeledInterval[], t: number) => xs.find((i) => t >= i.startSec && t < i.endSec);
  let good = 0;
  let total = 0;
  for (let k = 0; k < times.length - 1; k++) {
    const a = times[k];
    const b = times[k + 1];
    const mid = (a + b) / 2;
    const r = at(ref, mid);
    if (!r) continue;
    const rr = reduceSymbol(r.symbol, reduction);
    if (rr === null) continue;
    total += b - a;
    const e = at(est, mid);
    // An estimate outside the reduction (e.g. Csus4 for a C reference) counts as wrong.
    if (e && reduceSymbol(e.symbol, reduction) === rr) good += b - a;
  }
  return { score: total > 0 ? good / total : NaN, evaluatedSec: total };
}

export interface FMeasure {
  f: number;
  precision: number;
  recall: number;
}

/**
 * Maximum one-to-one matching within ±tol seconds. Every reference beat's window has the
 * same width, so the windows are ordered by both ends; matching each reference (in time
 * order) to the earliest unused estimate inside its window is then a maximum matching.
 */
export function beatFMeasure(ref: number[], est: number[], tol = 0.07): FMeasure {
  if (!ref.length && !est.length) return { f: 1, precision: 1, recall: 1 };
  if (!ref.length || !est.length) return { f: 0, precision: 0, recall: 0 };
  const r = [...ref].sort((a, b) => a - b);
  const e = [...est].sort((a, b) => a - b);
  const eps = 1e-9;
  let hits = 0;
  let j = 0;
  for (const t of r) {
    while (j < e.length && e[j] < t - tol - eps) j++;
    if (j < e.length && e[j] <= t + tol + eps) {
      hits++;
      j++;
    }
  }
  const precision = hits / est.length;
  const recall = hits / ref.length;
  return { f: precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0, precision, recall };
}

export interface ChartComparison {
  /** Seconds covered by both charts. */
  overlapSec: number;
  majmin: WcsrResult;
  root: WcsrResult;
  sevenths: WcsrResult;
  /** Present when both charts carry explicit beat times. */
  beatF?: FMeasure;
}

function intersect(a: CoverageRange[], b: CoverageRange[]): CoverageRange[] {
  const out: CoverageRange[] = [];
  for (const x of normalizeCoverage(a)) {
    for (const y of normalizeCoverage(b)) {
      const from = Math.max(x.fromSec, y.fromSec);
      const to = Math.min(x.toSec, y.toSec);
      if (to > from) out.push({ fromSec: from, toSec: to });
    }
  }
  return out;
}

/** Charts without coverage are treated as covering [first event, last event + 4 s). */
function effectiveCoverage(c: Chart): CoverageRange[] {
  if (c.coverage.length) return c.coverage;
  if (!c.events.length) return [];
  return [{ fromSec: c.events[0].startSec, toSec: c.events[c.events.length - 1].startSec + 4 }];
}

function clip(intervals: LabeledInterval[], ranges: CoverageRange[]): LabeledInterval[] {
  const out: LabeledInterval[] = [];
  for (const i of intervals) {
    for (const r of ranges) {
      const s = Math.max(i.startSec, r.fromSec);
      const e = Math.min(i.endSec, r.toSec);
      if (e > s) out.push({ startSec: s, endSec: e, symbol: i.symbol });
    }
  }
  return out;
}

/**
 * Compares an estimate chart (e.g. auto) against a reference chart (e.g. hand-made)
 * over the time both cover. Use for "user charts vs auto charts" evaluation.
 */
export function compareCharts(reference: Chart, estimate: Chart): ChartComparison {
  const refCov = effectiveCoverage(reference);
  const estCov = effectiveCoverage(estimate);
  const both = intersect(refCov, estCov);
  const ref = clip(chartIntervals(reference.events, refCov), both);
  const est = clip(chartIntervals(estimate.events, estCov), both);
  const result: ChartComparison = {
    overlapSec: both.reduce((s, r) => s + r.toSec - r.fromSec, 0),
    majmin: wcsr(ref, est, 'majmin'),
    root: wcsr(ref, est, 'root'),
    sevenths: wcsr(ref, est, 'sevenths'),
  };
  const rb = reference.timing.beatTimes;
  const eb = estimate.timing.beatTimes;
  if (rb?.length && eb?.length) {
    const inBoth = (t: number) => both.some((r) => t >= r.fromSec && t < r.toSec);
    const refBeats = rb.filter(inBoth);
    if (refBeats.length) result.beatF = beatFMeasure(refBeats, eb.filter(inBoth));
  }
  return result;
}
