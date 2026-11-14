import { describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs without types
import { deepMerge, evaluateStep, mergedConfig, notLowerRounded, resourceChecks, roundPp, stepSummary } from '../scripts/candidate-step.mjs';

const GROUPS = ['dataset:billboard', 'complexity:simple'];

/** A paired result shaped like paired-eval's (fractions). */
function paired(rows: { id: string; ref: number; cand: number; groups?: string[] }[], over: Record<string, unknown> = {}) {
  const deltas = rows.map((r) => r.cand - r.ref);
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const loo = rows.map((r, i) => ({ id: r.id, v: (deltas.reduce((a, b) => a + b, 0) - deltas[i]) / (rows.length - 1) })).reduce((a, b) => (b.v < a.v ? b : a));
  const agg = {
    songs: rows.length,
    baseline: { majmin: mean(rows.map((r) => r.ref)), root: 0.85, sevenths: 0.7 },
    candidate: { majmin: mean(rows.map((r) => r.cand)), root: 0.85, sevenths: 0.7 },
    meanDelta: { majmin: mean(deltas), root: 0, sevenths: 0 },
    majminDeltaCi: { lower: 0.002, upper: 0.01, resamples: 10000, seed: 7007 },
    leaveOneOut: { min: loo.v, minWithout: loo.id },
    boundaries: { precision: { baseline: 0.6, candidate: 0.59, delta: -0.01 }, baselinePredicted: 100, candidatePredicted: 120, annotated: 150 },
    ...over,
  };
  return {
    songs: rows.map((r) => ({ id: r.id, groups: r.groups ?? GROUPS, baseline: { majmin: r.ref }, candidate: { majmin: r.cand }, delta: { majmin: r.cand - r.ref } })),
    all: agg,
    subset: { aggregate: { ...agg, songs: rows.length } },
  };
}

const bench = (m: number, r: number, s: number) => ({ wcsr: { majmin: m, root: r, sevenths: s } });
const baselineRes = { distBytesExclMaps: 1000, replay4min: { tot: 5522 }, medianAnalyzeMs: 812, wholeRun: { peakRssBytes: 1000 } };
const okRes = resourceChecks(baselineRes, { packagedBytes: 1000, total4minMs: 5600, medianAnalyzeMs: 800, peakRssBytes: 1100 });
const good = [
  { id: 'a', ref: 0.8, cand: 0.81 },
  { id: 'b', ref: 0.7, cand: 0.71 },
  { id: 'c', ref: 0.9, cand: 0.905 },
];

describe('candidate step rules', () => {
  it('rounds pp to one decimal with Math.round(10x)/10; equal rounded values are not lower', () => {
    expect(roundPp(0.81249)).toBe(81.2);
    expect(roundPp(0.81251)).toBe(81.3);
    expect(notLowerRounded(0.8124, 0.8116)).toBe(true); // both 81.2
    expect(notLowerRounded(0.8114, 0.8116)).toBe(false); // 81.1 < 81.2
    expect(notLowerRounded(0.9, 0.9)).toBe(true);
  });

  it('deep-merges recognizer options with the setting winning, arrays replaced', () => {
    expect(deepMerge({ decode: { changePenalty: [1, 2, 3], familyFirst: { penaltyScale: 1 } }, nLogPrior: -1 }, { decode: { changePenalty: [0, 0, 0] }, pitchShift: [1] })).toEqual({
      decode: { changePenalty: [0, 0, 0], familyFirst: { penaltyScale: 1 } },
      nLogPrior: -1,
      pitchShift: [1],
    });
    expect(mergedConfig({ label: 'baseline', recognizer: {} }, { label: 'c2', recognizer: { decode: { changePenalty: [1, 2, 3] } } })).toEqual({ label: 'baseline + c2', recognizer: { decode: { changePenalty: [1, 2, 3] } } });
  });

  it('resource limits: bytes +10%, time +max(50%, 1 s), peak memory +20%', () => {
    const r = resourceChecks(baselineRes, { packagedBytes: 1101, total4minMs: 5522 + 2761, medianAnalyzeMs: 812 + 1001, peakRssBytes: 1200 });
    expect([r.packagedBytes.ok, r.analysisTime4minMs.ok, r.medianAnalyzeMs.ok, r.peakRssBytes.ok]).toEqual([false, true, false, true]);
    expect(r.medianAnalyzeMs.limit).toBe(1812);
    expect(r.medianAnalyzeMs.diagnostic).toBe(true);
  });

  it('is eligible only when P1..P6 all hold, and reports without deciding', () => {
    const r = evaluateStep({ vsIncumbent: paired(good), vsBaseline: paired(good), benchIncumbent: bench(0.97, 0.95, 0.9), benchCandidate: bench(0.97, 0.95, 0.9), resources: okRes });
    expect(r.meanDeltaPp).toBeCloseTo(0.8333, 3);
    expect(r.P).toEqual({ P1: true, P2: true, P3: true, P4: true, P5: true, P6: true });
    expect(r.eligible).toBe(true);
    expect(r.anyAlarm).toBe(false);
    expect(stepSummary('x', r).split('\n').length).toBeLessThanOrEqual(25);

    // P1 needs >= 0.50 pp.
    const small = [{ id: 'a', ref: 0.8, cand: 0.804 }, { id: 'b', ref: 0.7, cand: 0.704 }, { id: 'c', ref: 0.9, cand: 0.904 }];
    expect(evaluateStep({ vsIncumbent: paired(small), vsBaseline: paired(small), benchIncumbent: bench(0.97, 0.95, 0.9), benchCandidate: bench(0.97, 0.95, 0.9), resources: okRes }).P.P1).toBe(false);
    // P5: a synthetic guard lower at one decimal fails; equal after rounding passes.
    const lowBench = evaluateStep({ vsIncumbent: paired(good), vsBaseline: paired(good), benchIncumbent: bench(0.9705, 0.95, 0.9), benchCandidate: bench(0.9694, 0.95, 0.9), resources: okRes });
    expect(lowBench.P.P5).toBe(false);
    const sameRounded = evaluateStep({ vsIncumbent: paired(good), vsBaseline: paired(good), benchIncumbent: bench(0.9704, 0.95, 0.9), benchCandidate: bench(0.9696, 0.95, 0.9), resources: okRes });
    expect(sameRounded.P.P5).toBe(true);
    // P5 flicker guard: precision may drop by 2.0 pp but not more.
    const flick = (d: number) => evaluateStep({ vsIncumbent: paired(good, { boundaries: { precision: { baseline: 0.6, candidate: 0.6 + d, delta: d }, baselinePredicted: 1, candidatePredicted: 1, annotated: 1 } }), vsBaseline: paired(good), benchIncumbent: bench(0.97, 0.95, 0.9), benchCandidate: bench(0.97, 0.95, 0.9), resources: okRes }).P.P5;
    expect(flick(-0.02)).toBe(true);
    expect(flick(-0.0201)).toBe(false);
    // P2, P4, P6.
    expect(evaluateStep({ vsIncumbent: paired(good, { majminDeltaCi: { lower: 0, upper: 0.01 } }), vsBaseline: paired(good), benchIncumbent: bench(0.97, 0.95, 0.9), benchCandidate: bench(0.97, 0.95, 0.9), resources: okRes }).P.P2).toBe(false);
    const oneCarries = [{ id: 'a', ref: 0.5, cand: 0.6 }, { id: 'b', ref: 0.7, cand: 0.69 }, { id: 'c', ref: 0.9, cand: 0.89 }];
    expect(evaluateStep({ vsIncumbent: paired(oneCarries), vsBaseline: paired(oneCarries), benchIncumbent: bench(0.97, 0.95, 0.9), benchCandidate: bench(0.97, 0.95, 0.9), resources: okRes }).P.P4).toBe(false);
    const badRes = resourceChecks(baselineRes, { packagedBytes: 2000, total4minMs: 1, medianAnalyzeMs: 1, peakRssBytes: 1 });
    const r6 = evaluateStep({ vsIncumbent: paired(good), vsBaseline: paired(good), benchIncumbent: bench(0.97, 0.95, 0.9), benchCandidate: bench(0.97, 0.95, 0.9), resources: badRes });
    expect([r6.P.P6, r6.eligible, r6.alarms.resources]).toEqual([false, false, ['packagedBytes']]);
    // PR #36 review F2: the median analyze time is a diagnostic and never gates P6 or raises an alarm.
    const slowMedian = resourceChecks(baselineRes, { packagedBytes: 1000, total4minMs: 5600, medianAnalyzeMs: 99999, peakRssBytes: 1100 });
    const rMed = evaluateStep({ vsIncumbent: paired(good), vsBaseline: paired(good), benchIncumbent: bench(0.97, 0.95, 0.9), benchCandidate: bench(0.97, 0.95, 0.9), resources: slowMedian });
    expect([slowMedian.medianAnalyzeMs.ok, rMed.P.P6, rMed.eligible, rMed.alarms.resources, rMed.anyAlarm]).toEqual([false, true, true, [], false]);
    // PR #36 review F1: a missing required measurement is "not verified": P6 fails and an alarm is raised.
    for (const gap of [{ total4minMs: null }, { peakRssBytes: null }, { peakRssBytes: undefined }, { packagedBytes: Number.NaN }]) {
      const res = resourceChecks(baselineRes, { packagedBytes: 1000, total4minMs: 5600, medianAnalyzeMs: 800, peakRssBytes: 1100, ...gap });
      const rGap = evaluateStep({ vsIncumbent: paired(good), vsBaseline: paired(good), benchIncumbent: bench(0.97, 0.95, 0.9), benchCandidate: bench(0.97, 0.95, 0.9), resources: res });
      expect([rGap.P.P6, rGap.eligible, rGap.anyAlarm, rGap.alarms.resources, rGap.alarms.resourcesNotVerified.length]).toEqual([false, false, true, [], 1]);
    }
    const noMedian = resourceChecks(baselineRes, { packagedBytes: 1000, total4minMs: 5600, medianAnalyzeMs: null, peakRssBytes: 1100 });
    expect(evaluateStep({ vsIncumbent: paired(good), vsBaseline: paired(good), benchIncumbent: bench(0.97, 0.95, 0.9), benchCandidate: bench(0.97, 0.95, 0.9), resources: noMedian }).P.P6).toBe(true);
  });

  it('raises group alarms on rounded group means and song-loss alarms vs incumbent or baseline', () => {
    const rows = [
      { id: 'a', ref: 0.8, cand: 0.95, groups: ['dataset:billboard'] },
      { id: 'b', ref: 0.8, cand: 0.79, groups: ['complexity:simple'] },
      { id: 'c', ref: 0.9, cand: 0.83, groups: ['complexity:simple'] },
    ];
    const vsBase = [
      { id: 'a', ref: 0.8, cand: 0.95, groups: ['dataset:billboard'] },
      { id: 'b', ref: 0.9, cand: 0.79, groups: ['complexity:simple'] },
      { id: 'c', ref: 0.83, cand: 0.83, groups: ['complexity:simple'] },
    ];
    const r = evaluateStep({ vsIncumbent: paired(rows), vsBaseline: paired(vsBase), benchIncumbent: bench(0.97, 0.95, 0.9), benchCandidate: bench(0.97, 0.95, 0.9), resources: okRes });
    expect(r.alarms.groups.map((g: { against: string; group: string }) => `${g.against}:${g.group}`)).toEqual(['incumbent:complexity:simple', 'baseline:complexity:simple']);
    expect(r.alarms.songLoss10.map((l: { against: string; id: string }) => `${l.against}:${l.id}`)).toEqual(['baseline:b']);
    expect(r.alarms.songLoss5to10.map((l: { against: string; id: string }) => `${l.against}:${l.id}`)).toEqual(['incumbent:c']);
    expect(r.anyAlarm).toBe(true);
  });
});
