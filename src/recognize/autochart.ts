/**
 * Builds an auto chart (source: auto) from analysed segments. Coverage lists only the
 * heard ranges; where segments overlap (the user seeked back), the longer segment wins.
 */
import { normalizeCoverage } from '../chart/coverage';
import type { Chart, ChordEvent, CoverageRange, Recording, Timing } from '../chart/types';
import { estimateBeatsPerBar, estimateBpm } from './beats';
import type { SegmentAnalysis } from './recognizer';
import { uncertainSpans, type PlacedUnit, type UncertaintyOptions } from './uncertainty';

const r3 = (x: number): number => Math.round(x * 1000) / 1000;

/** Parts of [from, to) not covered by `taken` (normalized). */
function subtract(from: number, to: number, taken: CoverageRange[]): CoverageRange[] {
  let parts: CoverageRange[] = [{ fromSec: from, toSec: to }];
  for (const t of taken) {
    const next: CoverageRange[] = [];
    for (const p of parts) {
      if (t.toSec <= p.fromSec || t.fromSec >= p.toSec) next.push(p);
      else {
        if (t.fromSec > p.fromSec) next.push({ fromSec: p.fromSec, toSec: t.fromSec });
        if (t.toSec < p.toSec) next.push({ fromSec: t.toSec, toSec: p.toSec });
      }
    }
    parts = next;
  }
  return parts.filter((p) => p.toSec - p.fromSec > 0.05);
}

interface Owned {
  seg: SegmentAnalysis;
  range: CoverageRange;
}

/** A segment stored right after playback started at 0 s can start slightly before 0 s: ranges are clipped there. */
function ownership(segments: SegmentAnalysis[]): Owned[] {
  const byLength = [...segments].sort((a, b) => b.endSec - b.startSec - (a.endSec - a.startSec));
  const taken: CoverageRange[] = [];
  const owned: Owned[] = [];
  for (const seg of byLength) {
    const fromSec = Math.max(0, seg.startSec);
    for (const range of subtract(fromSec, seg.endSec, normalizeCoverage(taken))) owned.push({ seg, range });
    taken.push({ fromSec, toSec: seg.endSec });
  }
  return owned.sort((a, b) => a.range.fromSec - b.range.fromSec);
}

export interface AutoChartInput {
  recording: Recording;
  segments: SegmentAnalysis[];
  tool: string;
  durationSec?: number;
  createdAt?: string;
  /** Uncertain-section flags (docs/uncertainty-protocol.md); absent = no `uncertain` key (unchanged chart). */
  uncertainty?: UncertaintyOptions | null;
}

export function buildAutoChart(input: AutoChartInput): Chart {
  return assembleAutoChart(input).chart;
}

/** buildAutoChart plus every clipped unit with the final event showing it (offline analysis). */
export function assembleAutoChart(input: AutoChartInput): { chart: Chart; placed: PlacedUnit[] } {
  const owned = ownership(input.segments.filter((s) => s.endSec - s.startSec > 0.5));
  const inRange = (t: number, r: CoverageRange) => t >= r.fromSec && t < r.toSec;

  // Beats and downbeats from the owning segment of each range.
  const beats: number[] = [];
  const downbeats: number[] = [];
  for (const o of owned) {
    beats.push(...o.seg.beats.filter((b) => inRange(b, o.range)));
    downbeats.push(...o.seg.downbeats.filter((b) => inRange(b, o.range)));
  }
  beats.sort((a, b) => a - b);
  downbeats.sort((a, b) => a - b);
  // Adjacent segments can each contribute a beat near their shared boundary: keep one.
  const roughPeriod = 60 / (estimateBpm(beats) ?? 120);
  const deduped = beats.filter((b, i) => i === 0 || b - beats[i - 1] > 0.35 * roughPeriod);
  beats.length = 0;
  beats.push(...deduped);
  const bpm = estimateBpm(beats) ?? 120;
  const beatsPerBar = estimateBeatsPerBar(beats, downbeats);

  // Chord events: units of the owning segment, merged when the symbol repeats. Each clipped unit
  // records the final event its run became (uncertain spans must agree with the final events).
  const events: ChordEvent[] = [];
  const placed: PlacedUnit[] = [];
  for (const o of owned) {
    let current: { symbol: string; start: number; confSum: number; durSum: number; units: PlacedUnit[] } | null = null;
    const flush = () => {
      if (!current) return;
      const startSec = r3(current.start);
      const conf = current.durSum > 0 ? current.confSum / current.durSum : 0;
      const prev = events[events.length - 1];
      let event = -1;
      if (prev && prev.chord === current.symbol && Math.abs(prev.startSec - startSec) < 1e-9) event = events.length - 1;
      else if (!(prev && startSec <= prev.startSec)) {
        events.push({ startSec, chord: current.symbol, confidence: Math.round(Math.min(1, Math.max(0, conf)) * 1000) / 1000, source: 'auto' });
        event = events.length - 1;
      }
      for (const p of current.units) p.event = event;
    };
    for (const u of o.seg.units) {
      const s = Math.max(u.startSec, o.range.fromSec);
      const e = Math.min(u.endSec, o.range.toSec);
      if (e - s <= 0) continue;
      if (!current || current.symbol !== u.symbol) {
        flush();
        current = { symbol: u.symbol, start: s, confSum: 0, durSum: 0, units: [] };
      }
      current.confSum += u.confidence * (e - s);
      current.durSum += e - s;
      const p: PlacedUnit = { unit: u, startSec: s, endSec: e, event: -1 };
      current.units.push(p);
      placed.push(p);
    }
    flush();
  }

  const coverage = normalizeCoverage(owned.map((o) => o.range)).map((r) => ({ fromSec: r3(r.fromSec), toSec: r3(r.toSec) }));
  const firstDown = downbeats[0] ?? beats[0] ?? coverage[0]?.fromSec ?? 0;
  const beatTimes = fillBeatGaps(beats.filter((b) => b >= firstDown - 1e-6), 60 / bpm).map(r3);
  const timing: Timing = { bpm: Math.round(bpm * 10) / 10, beatsPerBar, beatUnit: 4, firstDownbeatSec: r3(Math.max(0, firstDown)) };
  if (beatTimes.length >= 2) {
    timing.beatTimes = beatTimes;
    timing.firstDownbeatSec = beatTimes[0];
  }
  const heard = coverage.reduce((s, r) => s + r.toSec - r.fromSec, 0);
  const pct = input.durationSec ? ` (${Math.round((heard / input.durationSec) * 100)}% of ${Math.round(input.durationSec)} s)` : '';
  const chart: Chart = {
    schemaVersion: 1,
    recording: { ...input.recording },
    timing,
    events,
    coverage,
    provenance: {
      createdBy: 'recognizer',
      createdAt: input.createdAt ?? new Date().toISOString(),
      tool: input.tool,
      note: `Automatic chart from listening mode: heard ${Math.round(heard)} s${pct}. Not verified by a person.`,
    },
  };
  if (input.uncertainty) chart.uncertain = uncertainSpans(placed, events, input.uncertainty);
  return { chart, placed };
}

/** Inserts evenly spaced beats into gaps longer than 1.5 beat periods (coverage holes, missed beats). */
export function fillBeatGaps(beats: number[], period: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < beats.length; i++) {
    if (i > 0) {
      const gap = beats[i] - beats[i - 1];
      if (gap > 1.5 * period) {
        const n = Math.round(gap / period);
        for (let k = 1; k < n; k++) out.push(beats[i - 1] + (gap * k) / n);
      }
    }
    out.push(beats[i]);
  }
  return out;
}
