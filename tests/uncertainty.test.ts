/**
 * VGT-19 core (docs/uncertainty-protocol.md): per-unit statistics of the shipped Recognizer and the
 * chart's `uncertain` spans built by buildAutoChart. Synthetic probabilities and units only.
 */
import { describe, expect, it } from 'vitest';
import { validateChart } from '../src/chart';
import type { Chart } from '../src/chart/types';
import { chartWithSecondChoices, chordChanges } from '../src/eval/uncertain-replace';
import { assembleAutoChart, buildAutoChart, type AutoChartInput } from '../src/recognize/autochart';
import { unitFrames } from '../src/recognize/candidate-decode';
import { decodeUnits, DEFAULT_DECODE, type DecodedUnit, type DecodeUnit, type UnitStats } from '../src/recognize/chords';
import { familyOf } from '../src/recognize/family';
import type { SegmentAnalysis } from '../src/recognize/recognizer';
import { EXTENSION_UNCERTAINTY } from '../src/recognize/extension-options';
import { unitFrameRange, unitStats, vocabularyFamilies, type UncertaintyOptions } from '../src/recognize/uncertainty';
import { UNCERTAINTY_CRITERION } from '../src/recognize/uncertainty-criterion';

const SYMBOLS = ['C', 'Cm', 'C7', 'Cmaj7', 'Cm7', 'G', 'Gm', 'N'];
const FS = 0.1;

/** Frames × symbols matrix from per-frame rows (missing symbols 0). */
function matrix(rows: Record<string, number>[]): Float32Array {
  const out = new Float32Array(rows.length * SYMBOLS.length);
  rows.forEach((r, f) => SYMBOLS.forEach((s, j) => (out[f * SYMBOLS.length + j] = r[s] ?? 0)));
  return out;
}

describe('unit statistics', () => {
  it('families follow familyOf in vocabulary order', () => {
    const { famOf, families } = vocabularyFamilies(SYMBOLS);
    expect(families).toEqual(['0:maj', '0:min', '7:maj', '7:min', 'N']);
    expect([...famOf]).toEqual([0, 1, 0, 0, 1, 2, 3, 4]);
    expect(SYMBOLS.map(familyOf)).toEqual(['0:maj', '0:min', '0:maj', '0:maj', '0:min', '7:maj', '7:min', 'N']);
  });

  it('frame ranges equal decodeUnits / candidate-decode', () => {
    for (const u of [
      { startSec: 0, endSec: 0.2 },
      { startSec: 0.149, endSec: 0.151 },
      { startSec: 0.95, endSec: 2 },
    ])
      expect(unitFrameRange(u, 10, FS, 0)).toEqual(unitFrames(u, 10, FS, 0));
  });

  it('p_sym equals the decoded confidence; p_fam, the alt family, p_alt, its members and S5 from the same frames', () => {
    const probs = matrix([
      { C: 0.4, C7: 0.2, Cm: 0.1, G: 0.2, N: 0.1 },
      { C: 0.3, C7: 0.1, Cmaj7: 0.1, Gm: 0.2, Cm7: 0.3 },
      { G: 0.6, Gm: 0.1, C: 0.3 },
      { G: 0.5, C: 0.25, Cm: 0.25 },
    ]);
    const units: DecodeUnit[] = [
      { startSec: 0, endSec: 0.2, strength: 0 },
      { startSec: 0.2, endSec: 0.4, strength: 2 },
    ];
    const decoded = decodeUnits(probs, 4, SYMBOLS.length, FS, 0, units, SYMBOLS, DEFAULT_DECODE);
    const stats = unitStats(probs, 4, SYMBOLS.length, FS, 0, decoded, SYMBOLS);
    decoded.forEach((u, i) => expect(stats[i].pSym).toBe(u.confidence));
    expect(decoded[0].symbol).toBe('C');
    const mean = (s: string, f0: number, f1: number) => {
      let a = 0;
      for (let f = f0; f < f1; f++) a += probs[f * SYMBOLS.length + SYMBOLS.indexOf(s)];
      return a / (f1 - f0);
    };
    const s0 = stats[0];
    expect(s0.pFam).toBeCloseTo(mean('C', 0, 2) + mean('C7', 0, 2) + mean('Cmaj7', 0, 2), 6);
    // Other families over frames 0-1: C minor 0.2, G major 0.1, G minor 0.1, N 0.05.
    expect(s0.altFamily).toBe('0:min');
    expect(s0.pAlt).toBeCloseTo(mean('Cm', 0, 2) + mean('Cm7', 0, 2), 6);
    expect(s0.altSymbols).toEqual(['Cm', 'Cm7']);
    expect(s0.altProbs[0]).toBeCloseTo(mean('Cm', 0, 2), 6);
    expect(s0.altProbs[1]).toBeCloseTo(mean('Cm7', 0, 2), 6);
    const ml = (s: string) => (Math.log(probs[SYMBOLS.indexOf(s)] + 1e-9) + Math.log(probs[SYMBOLS.length + SYMBOLS.indexOf(s)] + 1e-9)) / 2;
    const outside = Math.max(...['Cm', 'Cm7', 'G', 'Gm', 'N'].map(ml));
    expect(s0.s5).toBeCloseTo(ml('C') - outside, 9);
  });

  it('alt family ties go to the family listed first in the vocabulary', () => {
    // C minor family 0.125 + 0.125 = G major family 0.25 exactly (float32-exact values).
    const probs = matrix([{ C: 0.5, Cm: 0.125, Cm7: 0.125, G: 0.25 }]);
    const units: DecodedUnit[] = [{ startSec: 0, endSec: 0.1, strength: 0, symbol: 'C', confidence: 0.5 }];
    const [s] = unitStats(probs, 1, SYMBOLS.length, FS, 0, units, SYMBOLS);
    expect(s.altFamily).toBe('0:min');
    expect(s.pAlt).toBe(0.25);
    expect(s.pFam).toBe(0.5);
  });
});

// ---------------------------------------------------------------- Spans

const stats = (pSym: number, altSymbols: string[], altProbs: number[], altFamily = familyOf(altSymbols[0])): UnitStats => ({ pSym, pFam: pSym, altFamily, pAlt: altProbs.reduce((a, b) => a + b, 0), altSymbols, altProbs, s5: Math.log(pSym) });
const unit = (startSec: number, endSec: number, symbol: string, conf: number, st?: UnitStats): DecodedUnit => ({ startSec, endSec, strength: 2, symbol, confidence: conf, stats: st ?? stats(conf, ['Am', 'Am7'], [0.2, 0.1]) });
const seg = (startSec: number, endSec: number, units: DecodedUnit[]): SegmentAnalysis => ({ startSec, endSec, beats: [], downbeats: [], units, timingsMs: { features: 0, beats: 0, chords: 0, decode: 0 } });
const input = (segments: SegmentAnalysis[], extra: Partial<AutoChartInput> = {}): AutoChartInput => ({
  recording: { source: 'youtube', id: 'abcdefghijk', title: 't', artist: 'a' },
  segments,
  tool: 'test',
  durationSec: 20,
  createdAt: '2026-11-14T00:00:00.000Z',
  ...extra,
});

/** Every span lies inside exactly one final event interval and names that event's chord. */
function spansAgree(chart: Chart): void {
  expect(validateChart(chart).ok, validateChart(chart).errors.join('; ')).toBe(true);
  const ev = [...chart.events].sort((a, b) => a.startSec - b.startSec);
  const cov = chart.coverage;
  for (const s of chart.uncertain ?? []) {
    const k = ev.findIndex((e, i) => e.startSec <= s.fromSec + 1e-12 && s.fromSec < (ev[i + 1]?.startSec ?? Infinity));
    expect(k).toBeGreaterThanOrEqual(0);
    const end = Math.min(ev[k + 1]?.startSec ?? Infinity, cov.find((r) => r.fromSec <= s.fromSec && s.fromSec < r.toSec)!.toSec);
    expect(s.toSec).toBeLessThanOrEqual(end + 1e-12);
    expect(s.chord).toBe(ev[k].chord);
    expect(s.alt).not.toBe(s.chord);
  }
}

describe('buildAutoChart uncertain spans', () => {
  const G = ['G', 'G7'];
  const segs = () => [
    seg(0, 4, [
      unit(0, 1, 'C', 0.9),
      unit(1, 2, 'C', 0.3),
      unit(2, 2.5004, 'C', 0.2, stats(0.2, G, [0.1, 0.3])),
      unit(2.5004, 3, 'F', 0.1, stats(0.1, G, [0.1, 0.3])),
      unit(3, 4, 'F', 0.8),
    ]),
  ];

  it('without the option the chart is byte-identical (no uncertain key), and the option leaves events, timing and coverage alone', () => {
    const plain = buildAutoChart(input(segs()));
    expect('uncertain' in plain).toBe(false);
    expect(JSON.stringify(buildAutoChart(input(segs(), { uncertainty: null })))).toBe(JSON.stringify(plain));
    const flagged = buildAutoChart(input(segs(), { uncertainty: { signal: 'S2', threshold: 0.5 } }));
    const { uncertain, ...rest } = flagged;
    expect(uncertain).toBeDefined();
    expect(JSON.stringify(rest)).toBe(JSON.stringify(plain));
  });

  it('splits at final event boundaries and alt-family changes, rounds to 1 ms, picks the best member', () => {
    const chart = buildAutoChart(input(segs(), { uncertainty: { signal: 'S2', threshold: 0.5 } }));
    expect(chart.events.map((e) => [e.startSec, e.chord])).toEqual([
      [0, 'C'],
      [2.5, 'F'],
    ]);
    expect(chart.uncertain).toEqual([
      { fromSec: 1, toSec: 2, chord: 'C', alt: 'Am' },
      { fromSec: 2, toSec: 2.5, chord: 'C', alt: 'G7' },
      { fromSec: 2.5, toSec: 3, chord: 'F', alt: 'G7' },
    ]);
    spansAgree(chart);
  });

  it('S1 flags every unit of an event whose stored confidence is below θ', () => {
    const chart = buildAutoChart(input(segs(), { uncertainty: { signal: 'S1', threshold: 0.5 } }));
    // C: (0.9 + 0.3 + 0.2 × 0.5004) / 2.5004 ≈ 0.52 (not flagged); F: (0.1 × 0.4996 + 0.8) / 1.4996 ≈ 0.567 (not flagged).
    expect(chart.events.map((e) => e.confidence)).toEqual([0.52, 0.567]);
    expect(chart.uncertain).toEqual([]);
    const lower = buildAutoChart(input(segs(), { uncertainty: { signal: 'S1', threshold: 0.53 } }));
    // Every unit of the C event (0.52 < 0.53) is flagged; the alt family changes at 2 s.
    expect(lower.uncertain).toEqual([
      { fromSec: 0, toSec: 2, chord: 'C', alt: 'Am' },
      { fromSec: 2, toSec: 2.5, chord: 'C', alt: 'G7' },
    ]);
    spansAgree(lower);
  });

  it('clips to owned ranges and weights the second choice by clipped durations', () => {
    const W = ['Em', 'Em7'];
    const long = seg(0, 10, [unit(0, 10, 'C', 0.9)]);
    // The shorter segment owns only [10, 12): its first unit is clipped from [9.5, 10.5) to [10, 10.5).
    const short = seg(8, 12, [unit(8, 9.5, 'D', 0.1, stats(0.1, W, [0.5, 0.5])), unit(9.5, 10.5, 'D', 0.1, stats(0.1, W, [0.9, 0.1])), unit(10.5, 12, 'D', 0.1, stats(0.1, W, [0.2, 0.5]))]);
    const chart = buildAutoChart(input([short, long], { uncertainty: { signal: 'S2', threshold: 0.5 } }));
    expect(chart.coverage).toEqual([{ fromSec: 0, toSec: 12 }]);
    // Clipped weights 0.5 and 1.5: Em 0.75 vs Em7 0.8 (unclipped 1.0/1.5 would pick Em).
    expect(chart.uncertain).toEqual([{ fromSec: 10, toSec: 12, chord: 'D', alt: 'Em7' }]);
    spansAgree(chart);
  });

  it('ties of the second choice go to vocabulary order; runs flush skipped are never flagged', () => {
    const tie = buildAutoChart(input([seg(0, 2, [unit(0, 2, 'C', 0.1, stats(0.1, ['Am', 'Am7'], [0.3, 0.3]))])], { uncertainty: { signal: 'S2', threshold: 0.5 } }));
    expect(tie.uncertain).toEqual([{ fromSec: 0, toSec: 2, chord: 'C', alt: 'Am' }]);
    // The D run starts at 0.0003 s: rounded to 0 it is not after the C event, so flush skips it and C is shown there.
    const { chart, placed } = assembleAutoChart(input([seg(0, 2, [unit(0, 0.0003, 'C', 0.9), unit(0.0003, 2, 'D', 0.1)])], { uncertainty: { signal: 'S2', threshold: 0.5 } }));
    expect(chart.events.map((e) => e.chord)).toEqual(['C']);
    expect(placed.map((p) => p.event)).toEqual([0, -1]);
    expect(chart.uncertain).toEqual([]);
    spansAgree(chart);
  });

  it('drops zero-length spans and refuses units without stats', () => {
    const tiny = buildAutoChart(input([seg(0, 2, [unit(0, 1, 'C', 0.9), unit(1, 1.0004, 'C', 0.1), unit(1.0004, 2, 'C', 0.9)])], { uncertainty: { signal: 'S2', threshold: 0.5 } }));
    expect(tiny.uncertain).toEqual([]);
    const bare = seg(0, 2, [{ startSec: 0, endSec: 2, strength: 0, symbol: 'C', confidence: 0.1 }]);
    expect(() => buildAutoChart(input([bare], { uncertainty: { signal: 'S2', threshold: 0.5 } }))).toThrow(/no stats/);
    expect(() => buildAutoChart(input([bare]))).not.toThrow();
  });

  it('second choices replace exactly the spans', () => {
    const chart = buildAutoChart(input(segs(), { uncertainty: { signal: 'S2', threshold: 0.5 } }));
    const r = chartWithSecondChoices(chart);
    expect(r.uncertain).toBeUndefined();
    expect(r.events.map((e) => [e.startSec, e.chord])).toEqual([
      [0, 'C'],
      [1, 'Am'],
      [2, 'G7'],
      [2.5, 'G7'],
      [3, 'F'],
    ]);
    expect(chordChanges(chart)).toBe(1);
    expect(chordChanges(r)).toBe(3);
  });
});

// ---------------------------------------------------------------- Two tiers (Amendment 1)

describe('replace tier (Amendment 1)', () => {
  const G = ['G', 'G7'];
  const AM = ['Am', 'Am7'];
  // One C event 0–3 s with S2 0.1 / 0.3 / 0.1, then F 3–4 s (confident).
  const tiered = () => [seg(0, 4, [unit(0, 1, 'C', 0.1, stats(0.1, G, [0.3, 0.1])), unit(1, 2, 'C', 0.3, stats(0.3, G, [0.3, 0.1])), unit(2, 3, 'C', 0.1, stats(0.1, G, [0.3, 0.1])), unit(3, 4, 'F', 0.9)])];

  it('without replaceBelow the chart is byte-identical to before (no replace key)', () => {
    const plain = buildAutoChart(input(tiered(), { uncertainty: { signal: 'S2', threshold: 0.5 } }));
    expect(JSON.stringify(plain)).not.toContain('replace');
    expect(JSON.stringify(buildAutoChart(input(tiered(), { uncertainty: { signal: 'S2', threshold: 0.5, replaceBelow: undefined } })))).toBe(JSON.stringify(plain));
    expect(plain.uncertain).toEqual([{ fromSec: 0, toSec: 3, chord: 'C', alt: 'G' }]);
  });

  it('runs split at the tier boundary; replace-tier spans carry replace: true', () => {
    const chart = buildAutoChart(input(tiered(), { uncertainty: { signal: 'S2', threshold: 0.5, replaceBelow: 0.2 } }));
    expect(chart.uncertain).toEqual([
      { fromSec: 0, toSec: 1, chord: 'C', alt: 'G', replace: true },
      { fromSec: 1, toSec: 2, chord: 'C', alt: 'G' },
      { fromSec: 2, toSec: 3, chord: 'C', alt: 'G', replace: true },
    ]);
    spansAgree(chart);
  });

  it('replace-tier spans equal the spans of θ = replaceBelow; all spans cover the time of θ = threshold (seeded synthetic units)', () => {
    let a = 0x19a1;
    const rnd = () => ((a = (Math.imul(a, 1103515245) + 12345) >>> 0) / 4294967296);
    let replaceSpans = 0;
    let infoSpans = 0;
    for (let trial = 0; trial < 40; trial++) {
      const units: DecodedUnit[] = [];
      let sym = 'C';
      for (let k = 0; k < 30; k++) {
        if (rnd() < 0.2) sym = sym === 'C' ? 'F' : 'C';
        const p = Math.round(rnd() * 1000) / 1000;
        const fam = rnd() < 0.7 ? G : AM;
        units.push(unit(k, k + 1, sym, p, stats(p, fam, [0.3, 0.2])));
      }
      const make = (u: UncertaintyOptions) => buildAutoChart(input([seg(0, 30, units)], { durationSec: 40, uncertainty: u })).uncertain ?? [];
      const two = make({ signal: 'S2', threshold: 0.6, replaceBelow: 0.25 });
      const low = make({ signal: 'S2', threshold: 0.25 });
      const high = make({ signal: 'S2', threshold: 0.6 });
      expect(two.filter((s) => s.replace).map(({ replace: _r, ...s }) => s)).toEqual(low);
      expect(two.filter((s) => !s.replace).every((s) => !('replace' in s))).toBe(true);
      const union = (ss: { fromSec: number; toSec: number }[]) => {
        const out: [number, number][] = [];
        for (const s of [...ss].sort((x, y) => x.fromSec - y.fromSec)) {
          const last = out[out.length - 1];
          if (last && s.fromSec <= last[1] + 1e-9) last[1] = Math.max(last[1], s.toSec);
          else out.push([s.fromSec, s.toSec]);
        }
        return out;
      };
      expect(union(two)).toEqual(union(high));
      replaceSpans += two.filter((s) => s.replace).length;
      infoSpans += two.filter((s) => !s.replace).length;
    }
    expect(replaceSpans).toBeGreaterThan(40); // not vacuous: both tiers occur often
    expect(infoSpans).toBeGreaterThan(40);
  });

  it('the extension uses the frozen criterion with both thresholds', () => {
    expect(EXTENSION_UNCERTAINTY).toEqual({ signal: 'S4', threshold: UNCERTAINTY_CRITERION.threshold, replaceBelow: UNCERTAINTY_CRITERION.replaceBelow });
    expect(UNCERTAINTY_CRITERION.replaceBelow).toBeLessThan(UNCERTAINTY_CRITERION.threshold);
  });
});
