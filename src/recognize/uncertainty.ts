/**
 * Uncertain-section flags (VGT-19, docs/uncertainty-protocol.md): per-unit statistics computed by the
 * shipped Recognizer after decoding, and the chart's `uncertain` spans built by buildAutoChart from
 * one signal and one threshold. The first-choice chart (events, confidences, beats, coverage) never
 * depends on anything here.
 */
import type { ChordEvent, UncertainSpan } from '../chart/types';
import type { DecodedUnit, UnitStats } from './chords';
import { familyOf } from './family';

export type UncertaintySignal = 'S1' | 'S2' | 'S3' | 'S4' | 'S5';
/** Simplicity order of the protocol's candidate signals. */
export const UNCERTAINTY_SIGNALS: readonly UncertaintySignal[] = ['S1', 'S2', 'S3', 'S4', 'S5'];

/** A unit is flagged when its signal is below `threshold` (full precision). */
export interface UncertaintyOptions {
  signal: UncertaintySignal;
  threshold: number;
}

const LOG_EPS = 1e-9;

/** Frame range [f0, f1) of a unit, exactly as decodeUnits computes it. */
export function unitFrameRange(u: { startSec: number; endSec: number }, frames: number, frameSec: number, frameStartSec: number): [number, number] {
  let f0 = Math.round((u.startSec - frameStartSec) / frameSec);
  let f1 = Math.round((u.endSec - frameStartSec) / frameSec);
  f0 = Math.max(0, Math.min(frames - 1, f0));
  f1 = Math.max(f0 + 1, Math.min(frames, f1));
  return [f0, f1];
}

/** Family of every vocabulary symbol and the families in vocabulary order (first member). */
export function vocabularyFamilies(symbols: string[]): { famOf: Int32Array; families: string[] } {
  const families: string[] = [];
  const index = new Map<string, number>();
  const famOf = new Int32Array(symbols.length);
  symbols.forEach((s, j) => {
    const f = familyOf(s);
    let k = index.get(f);
    if (k === undefined) {
      k = families.length;
      families.push(f);
      index.set(f, k);
    }
    famOf[j] = k;
  });
  return { famOf, families };
}

/**
 * Statistics of every decoded unit (one pass over its frames). The linear means are accumulated in
 * float32 in decodeUnits' order, so p_sym equals the unit's confidence exactly; the log means are
 * accumulated like decodeUnits' meanLog emission.
 */
export function unitStats(probs: Float32Array, frames: number, numOut: number, frameSec: number, frameStartSec: number, units: DecodedUnit[], symbols: string[]): UnitStats[] {
  const { famOf, families } = vocabularyFamilies(symbols);
  const symIndex = new Map(symbols.map((s, j) => [s, j]));
  const avg = new Float32Array(numOut);
  const logMean = new Float64Array(numOut);
  const famSum = new Float64Array(families.length);
  return units.map((u) => {
    const shown = symIndex.get(u.symbol);
    if (shown === undefined) throw new Error(`unit stats: ${u.symbol} is not in the vocabulary`);
    const [f0, f1] = unitFrameRange(u, frames, frameSec, frameStartSec);
    avg.fill(0);
    logMean.fill(0);
    for (let f = f0; f < f1; f++) {
      for (let j = 0; j < numOut; j++) {
        const p = probs[f * numOut + j];
        avg[j] += p;
        logMean[j] += Math.log(p + LOG_EPS);
      }
    }
    for (let j = 0; j < numOut; j++) {
      avg[j] /= f1 - f0;
      logMean[j] /= f1 - f0;
    }
    famSum.fill(0);
    for (let j = 0; j < numOut; j++) famSum[famOf[j]] += avg[j];
    const sf = famOf[shown];
    let alt = -1;
    for (let k = 0; k < families.length; k++) if (k !== sf && (alt < 0 || famSum[k] > famSum[alt])) alt = k;
    let outside = -Infinity;
    for (let j = 0; j < numOut; j++) if (famOf[j] !== sf && logMean[j] > outside) outside = logMean[j];
    const altSymbols: string[] = [];
    const altProbs: number[] = [];
    if (alt >= 0) {
      for (let j = 0; j < numOut; j++) {
        if (famOf[j] !== alt) continue;
        altSymbols.push(symbols[j]);
        altProbs.push(avg[j]);
      }
    }
    return {
      pSym: avg[shown],
      pFam: famSum[sf],
      altFamily: alt >= 0 ? families[alt] : null,
      pAlt: alt >= 0 ? famSum[alt] : 0,
      altSymbols,
      altProbs,
      s5: logMean[shown] - outside,
    };
  });
}

/** The units with their statistics attached (symbol, confidence and timing unchanged). */
export function withUnitStats(units: DecodedUnit[], probs: Float32Array, frames: number, numOut: number, frameSec: number, frameStartSec: number, symbols: string[]): DecodedUnit[] {
  const stats = unitStats(probs, frames, numOut, frameSec, frameStartSec, units, symbols);
  return units.map((u, i) => ({ ...u, stats: stats[i] }));
}

/** A unit's signal value; S1 reads the stored (rounded) confidence of the final event showing it. */
export function unitSignal(signal: UncertaintySignal, stats: UnitStats, eventConfidence: number): number {
  switch (signal) {
    case 'S1':
      return eventConfidence;
    case 'S2':
      return stats.pSym;
    case 'S3':
      return stats.pFam;
    case 'S4':
      return stats.pFam - stats.pAlt;
    case 'S5':
      return stats.s5;
  }
}

/** A decoded unit clipped to its owned range as buildAutoChart clips it, with the final event showing it. */
export interface PlacedUnit {
  unit: DecodedUnit;
  /** Clipped (unrounded) times. */
  startSec: number;
  endSec: number;
  /** Index of the final chart event the unit's run became (or merged into); -1 when flush skipped the run. */
  event: number;
}

const r3 = (x: number): number => Math.round(x * 1000) / 1000;

/** Whether a placed unit is flagged: below the threshold, shown by a final event with its own symbol, with an alt family. */
export function isFlagged(p: PlacedUnit, events: ChordEvent[], opts: UncertaintyOptions): boolean {
  const st = p.unit.stats;
  if (!st) throw new Error('uncertainty: decoded units carry no stats (the shipped Recognizer sets them)');
  if (p.event < 0 || st.altFamily === null) return false;
  const e = events[p.event];
  if (e.chord !== p.unit.symbol) return false;
  return unitSignal(opts.signal, st, e.confidence ?? 0) < opts.threshold;
}

/**
 * Spans: maximal runs of consecutive (touching) flagged units inside one final event with one alt
 * family; times rounded to 1 ms like event times; zero-length spans dropped. The second choice is the
 * alt-family member with the highest duration-weighted mean probability over the span (clipped
 * durations; ties: vocabulary order).
 */
export function uncertainSpans(placed: PlacedUnit[], events: ChordEvent[], opts: UncertaintyOptions): UncertainSpan[] {
  const spans: UncertainSpan[] = [];
  let cur: { event: number; alt: string; from: number; to: number; units: PlacedUnit[] } | null = null;
  const close = () => {
    if (!cur) return;
    const fromSec = r3(cur.from);
    const toSec = r3(cur.to);
    if (toSec > fromSec) {
      const st0 = cur.units[0].unit.stats!;
      const sums = new Float64Array(st0.altSymbols.length);
      for (const p of cur.units) {
        const w = p.endSec - p.startSec;
        p.unit.stats!.altProbs.forEach((v, k) => (sums[k] += v * w));
      }
      let best = 0;
      for (let k = 1; k < sums.length; k++) if (sums[k] > sums[best]) best = k;
      spans.push({ fromSec, toSec, chord: events[cur.event].chord, alt: st0.altSymbols[best] });
    }
    cur = null;
  };
  for (const p of placed) {
    if (!isFlagged(p, events, opts)) {
      close();
      continue;
    }
    const alt = p.unit.stats!.altFamily!;
    if (cur && cur.event === p.event && cur.alt === alt && Math.abs(p.startSec - cur.to) < 1e-9) {
      cur.to = p.endSec;
      cur.units.push(p);
    } else {
      close();
      cur = { event: p.event, alt, from: p.startSec, to: p.endSec, units: [p] };
    }
  }
  close();
  return spans;
}
