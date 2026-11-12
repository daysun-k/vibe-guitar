/**
 * Accuracy overview: the user's own charts (references) against the auto charts of the
 * same recordings, per song and in total. Pure functions; the side panel reads storage
 * (see findAccuracyPairs in extension/storage.ts) and renders the result.
 */
import type { Chart, RecordingSource } from '../chart/types';
import { chordChangeOffset, compareCharts, median, type ChartComparison, type WcsrResult } from './metrics';

/** 'manual': made by hand. 'edited': an auto chart with some chords fixed by hand (the rest is still auto). */
export type ReferenceKind = 'manual' | 'edited';

export interface AccuracyPair {
  source: RecordingSource;
  id: string;
  /** Where the reference came from: the chart in use, or the hand-made chart kept when the auto chart was adopted. */
  referenceFrom: 'main' | 'backup';
  reference: Chart;
  auto: Chart;
}

export interface AccuracyRow {
  source: RecordingSource;
  id: string;
  title: string;
  artist: string;
  referenceKind: ReferenceKind;
  referenceFrom: 'main' | 'backup';
  /** Reference events entered or fixed by hand, out of all reference events. */
  manualEvents: number;
  events: number;
  comparison: ChartComparison;
  /**
   * Chord-change timing, hand-made references only. Null for an edited reference: fixing a
   * chord keeps the auto chart's times, so its changes would match the auto chart at 0 ms.
   */
  timing: ChangeTiming | null;
  /** Matched change offsets (ms), kept for the pooled total; empty when timing is null; not exported. */
  offsetsMs: number[];
}

export interface ChangeTiming {
  medianMs: number;
  matched: number;
  unmatched: number;
}

export interface AccuracyTotals {
  songs: number;
  overlapSec: number;
  /** Duration-weighted over songs: sum(score × evaluated seconds) / sum(evaluated seconds). */
  majmin: WcsrResult;
  root: WcsrResult;
  sevenths: WcsrResult;
  /** Median over every matched change of the songs with timing (hand-made references); null if none. */
  timing: ChangeTiming | null;
}

/** Window for matching a reference chord change to the nearest auto change. */
export const CHANGE_WINDOW_SEC = 1;

export function accuracyRow(pair: AccuracyPair, windowSec = CHANGE_WINDOW_SEC): AccuracyRow {
  const { reference, auto } = pair;
  const referenceKind: ReferenceKind = reference.provenance.createdBy === 'edited' ? 'edited' : 'manual';
  const t = referenceKind === 'manual' ? chordChangeOffset(reference, auto, windowSec) : null;
  return {
    source: pair.source,
    id: pair.id,
    title: reference.recording.title || auto.recording.title,
    artist: reference.recording.artist || auto.recording.artist,
    referenceKind,
    referenceFrom: pair.referenceFrom,
    manualEvents: reference.events.filter((e) => e.source === 'manual').length,
    events: reference.events.length,
    comparison: compareCharts(reference, auto),
    timing: t ? { medianMs: t.medianMs, matched: t.matched, unmatched: t.unmatched } : null,
    offsetsMs: t ? t.offsetsMs : [],
  };
}

function pooled(rows: AccuracyRow[], key: 'majmin' | 'root' | 'sevenths'): WcsrResult {
  let good = 0;
  let total = 0;
  for (const r of rows) {
    const w = r.comparison[key];
    if (w.evaluatedSec > 0 && Number.isFinite(w.score)) {
      good += w.score * w.evaluatedSec;
      total += w.evaluatedSec;
    }
  }
  return { score: total > 0 ? good / total : NaN, evaluatedSec: total };
}

export function accuracyTotals(rows: AccuracyRow[]): AccuracyTotals {
  const timed = rows.filter((r) => r.timing);
  const offsets = timed.flatMap((r) => r.offsetsMs);
  return {
    songs: rows.length,
    overlapSec: rows.reduce((s, r) => s + r.comparison.overlapSec, 0),
    majmin: pooled(rows, 'majmin'),
    root: pooled(rows, 'root'),
    sevenths: pooled(rows, 'sevenths'),
    timing: timed.length ? { medianMs: median(offsets), matched: offsets.length, unmatched: timed.reduce((s, r) => s + (r.timing?.unmatched ?? 0), 0) } : null,
  };
}

export interface AccuracyOverview {
  rows: AccuracyRow[];
  /** Hand-made references only, edited references only, and both. */
  totals: Record<ReferenceKind | 'all', AccuracyTotals>;
}

export function accuracyOverview(pairs: AccuracyPair[], windowSec = CHANGE_WINDOW_SEC): AccuracyOverview {
  return overviewFromRows(pairs.map((p) => accuracyRow(p, windowSec)));
}

export function overviewFromRows(rows: AccuracyRow[]): AccuracyOverview {
  return {
    rows,
    totals: {
      manual: accuracyTotals(rows.filter((r) => r.referenceKind === 'manual')),
      edited: accuracyTotals(rows.filter((r) => r.referenceKind === 'edited')),
      all: accuracyTotals(rows),
    },
  };
}

/** The downloadable result: per-song numbers and totals only (no audio, lyrics or chord events). NaN becomes null. */
export function accuracyExport(o: AccuracyOverview, exportedAt: Date, windowSec = CHANGE_WINDOW_SEC): unknown {
  const nan = (x: number) => (Number.isFinite(x) ? x : null);
  const wcsr = (w: WcsrResult) => ({ score: nan(w.score), evaluatedSec: w.evaluatedSec });
  const timing = (t: ChangeTiming | null) => (t ? { medianOffsetMs: nan(t.medianMs), matched: t.matched, unmatched: t.unmatched } : null);
  const totals = (t: AccuracyTotals) => ({ songs: t.songs, overlapSec: t.overlapSec, majmin: wcsr(t.majmin), root: wcsr(t.root), sevenths: wcsr(t.sevenths), timing: timing(t.timing) });
  return {
    format: 'vibe-guitar-accuracy-overview',
    version: 1,
    exportedAt: exportedAt.toISOString(),
    changeWindowSec: windowSec,
    note: 'timing.medianOffsetMs = auto chord change minus reference chord change (positive: auto is later). Estimate only. timing is null for edited references (their times are the auto chart\'s) and is pooled from manual references only.',
    rows: o.rows.map((r) => ({
      source: r.source,
      id: r.id,
      title: r.title,
      artist: r.artist,
      referenceKind: r.referenceKind,
      referenceFrom: r.referenceFrom,
      manualEvents: r.manualEvents,
      events: r.events,
      overlapSec: r.comparison.overlapSec,
      majmin: wcsr(r.comparison.majmin),
      root: wcsr(r.comparison.root),
      sevenths: wcsr(r.comparison.sevenths),
      ...(r.comparison.beatF ? { beatF: r.comparison.beatF.f } : {}),
      timing: timing(r.timing),
    })),
    totals: { manual: totals(o.totals.manual), edited: totals(o.totals.edited), all: totals(o.totals.all) },
  };
}
