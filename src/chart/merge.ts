/**
 * Merging a new auto chart into the previous auto chart of the same recording, so that a
 * short re-analysis never silently shrinks what was already heard.
 */
import { coverageRangeAt, normalizeCoverage } from './coverage';
import type { Chart, ChordEvent, CoverageRange, UncertainSpan } from './types';

const r3 = (x: number): number => Math.round(x * 1000) / 1000;
/** Leftover slivers shorter than this are dropped. */
const MIN_PART_SEC = 0.05;

/** Parts of `ranges` not covered by `taken` (both normalized first). */
export function subtractCoverage(ranges: readonly CoverageRange[], taken: readonly CoverageRange[]): CoverageRange[] {
  const cut = normalizeCoverage(taken);
  const out: CoverageRange[] = [];
  for (const r of normalizeCoverage(ranges)) {
    let parts: CoverageRange[] = [r];
    for (const t of cut) {
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
    out.push(...parts.filter((p) => p.toSec - p.fromSec > MIN_PART_SEC));
  }
  return out;
}

/**
 * The newer chart wins wherever it has coverage; the previous chart keeps the ranges only
 * it heard. The chord sounding at the start of a kept range is restarted there. Coverage
 * of the result is the union of both. Timing: the newer bpm/meter, beat times from both
 * (bar numbering can shift by a few beats across a seam between the two charts). Uncertain
 * spans: the newer chart's, plus the previous chart's spans lying wholly in the kept ranges.
 */
export function mergeAutoCharts(prev: Chart, next: Chart): Chart {
  const nextCov = normalizeCoverage(next.coverage);
  const prevCov = normalizeCoverage(prev.coverage);
  const kept = subtractCoverage(prevCov, nextCov);
  if (!kept.length) return next;
  const within = (t: number, ranges: CoverageRange[]) => coverageRangeAt(ranges, t) !== null;

  const candidates: ChordEvent[] = next.events.filter((e) => within(e.startSec, nextCov));
  for (const k of kept) {
    const home = coverageRangeAt(prevCov, k.fromSec);
    let active: ChordEvent | undefined;
    for (const e of prev.events) {
      if (e.startSec <= k.fromSec + 1e-9) active = e;
      else break;
    }
    if (active && home && active.startSec >= home.fromSec - 1e-9) candidates.push({ ...active, startSec: r3(k.fromSec) });
    candidates.push(...prev.events.filter((e) => e.startSec > k.fromSec + 1e-9 && e.startSec < k.toSec));
  }
  candidates.sort((a, b) => a.startSec - b.startSec);

  const coverage = normalizeCoverage([...nextCov, ...kept]).map((r) => ({ fromSec: r3(r.fromSec), toSec: r3(r.toSec) }));
  const events: ChordEvent[] = [];
  for (const e of candidates) {
    const last = events[events.length - 1];
    if (last && e.startSec <= last.startSec) continue;
    // Same chord continuing across the seam of one heard range: keep the first event only.
    if (last && last.chord === e.chord && coverageRangeAt(coverage, last.startSec) === coverageRangeAt(coverage, e.startSec)) continue;
    events.push(e);
  }

  const beats = [
    ...(next.timing.beatTimes ?? []).filter((b) => within(b, nextCov)),
    ...(prev.timing.beatTimes ?? []).filter((b) => within(b, kept)),
  ].sort((a, b) => a - b);
  const beatTimes: number[] = [];
  for (const b of beats) if (!beatTimes.length || b - beatTimes[beatTimes.length - 1] > MIN_PART_SEC) beatTimes.push(b);
  const timing = { ...next.timing };
  if (beatTimes.length >= 2) {
    timing.beatTimes = beatTimes;
    timing.firstDownbeatSec = beatTimes[0];
  } else delete timing.beatTimes;

  const heard = coverage.reduce((s, r) => s + r.toSec - r.fromSec, 0);
  const note = `${next.provenance.note ?? 'Automatic chart.'} Merged with the earlier auto chart from ${prev.provenance.createdAt}; heard ${Math.round(heard)} s in total.`;
  const out: Chart = { ...next, timing, events, coverage, provenance: { ...next.provenance, note } };
  const uncertain = mergeUncertain(prev.uncertain, next.uncertain, kept);
  if (uncertain) out.uncertain = uncertain;
  else delete out.uncertain;
  return out;
}

/**
 * Spans of the merged chart: every span of the newer chart, and the previous chart's spans that
 * lie inside one kept range (a span reaching into the newer coverage was heard again there).
 * Sorted, and a span overlapping an earlier one is dropped. Undefined when neither chart has spans.
 */
export function mergeUncertain(prev: readonly UncertainSpan[] | undefined, next: readonly UncertainSpan[] | undefined, kept: readonly CoverageRange[]): UncertainSpan[] | undefined {
  if (!prev && !next) return undefined;
  const old = (prev ?? []).filter((s) => kept.some((k) => s.fromSec >= k.fromSec - 1e-9 && s.toSec <= k.toSec + 1e-9));
  const all = [...(next ?? []), ...old].sort((a, b) => a.fromSec - b.fromSec || a.toSec - b.toSec);
  const out: UncertainSpan[] = [];
  for (const s of all) if (!out.length || s.fromSec >= out[out.length - 1].toSec) out.push({ ...s });
  return out;
}
