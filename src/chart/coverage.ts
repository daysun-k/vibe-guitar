/** Coverage helpers: every consumer must use the normalized (merged) ranges. */
import type { CoverageRange } from './types';

/**
 * Sort ranges and merge touching, overlapping and nested ones. Invalid ranges
 * (non-finite or toSec <= fromSec) are skipped. Real gaps are kept.
 */
export function normalizeCoverage(ranges: readonly CoverageRange[]): CoverageRange[] {
  const valid = ranges
    .filter((r) => Number.isFinite(r.fromSec) && Number.isFinite(r.toSec) && r.toSec > r.fromSec)
    .map((r) => ({ fromSec: r.fromSec, toSec: r.toSec }))
    .sort((a, b) => a.fromSec - b.fromSec || a.toSec - b.toSec);
  const out: CoverageRange[] = [];
  for (const r of valid) {
    const last = out[out.length - 1];
    if (last && r.fromSec <= last.toSec) last.toSec = Math.max(last.toSec, r.toSec);
    else out.push(r);
  }
  return out;
}

/** The merged range containing `sec` (start inclusive, end exclusive), or null. */
export function coverageRangeAt(merged: readonly CoverageRange[], sec: number): CoverageRange | null {
  return merged.find((r) => sec >= r.fromSec && sec < r.toSec) ?? null;
}
