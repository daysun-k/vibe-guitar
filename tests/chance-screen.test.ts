// Chance-level screen of the annotation alignment (VGT-7, PR #32): V0 cases with known truth.
import { describe, expect, it } from 'vitest';
import { CHANCE_ALPHA, alignAnnotation, beatWindowCoverage, binomialUpperTail, chanceScreen, type AlignInput, type Alignment } from '../src/eval/annotations';

function grid(start: number, end: number, period: number, jitter = 0): number[] {
  const out: number[] = [];
  for (let t = start, k = 0; t < end; t += period, k++) out.push(t + jitter * Math.sin(k * 1.7));
  return out;
}

/** Deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function beatsInput(est: number[], ann: number[], extra: Partial<AlignInput> = {}): AlignInput {
  return {
    method: 'beats',
    landmarks: ann,
    downbeatLandmarks: ann.filter((_, k) => k % 4 === 0),
    annotationDurationSec: 200,
    chordSpan: { fromSec: ann[0], toSec: ann[ann.length - 1] },
    estimateBeats: est,
    estimateFirstDownbeatSec: est[0],
    estimateBeatsPerBar: 4,
    mediaDurationSec: 200,
    ...extra,
  };
}

const changesInput = (est: number[], lm: number[], extra: Partial<AlignInput> = {}) => beatsInput(est, lm, { method: 'chord-boundaries', downbeatLandmarks: lm, ...extra });

/** The floor that existed before PR #32: 30% overall and per third, at least 4 per third. */
const passesOldFloor = (a: Alignment) => a.matchedFraction >= 0.3 && a.segments.every((s) => s.landmarks > 0 && s.matched / s.landmarks >= 0.3 && s.matched >= 4);

const est = grid(1, 190, 0.5, 0.01);
const changes = grid(3, 180, 2).map((t) => t - 0.15);

describe('chance-level screen: building blocks', () => {
  it('computes the exact one-sided binomial tail in log space', () => {
    const direct = (n: number, k: number, p: number) => {
      let s = 0;
      for (let j = k; j <= n; j++) {
        let c = 1;
        for (let i = 1; i <= j; i++) c = (c * (n - j + i)) / i;
        s += c * p ** j * (1 - p) ** (n - j);
      }
      return s;
    };
    expect(binomialUpperTail(18, 6, 0.3125)).toBeCloseTo(direct(18, 6, 0.3125), 12);
    expect(binomialUpperTail(20, 13, 0.4)).toBeCloseTo(direct(20, 13, 0.4), 12);
    expect(binomialUpperTail(10, 0, 0.4)).toBe(1);
    expect(binomialUpperTail(10, 11, 0.4)).toBe(0);
    expect(binomialUpperTail(10, 10, 0.4)).toBeCloseTo(0.4 ** 10, 15);
    // Several hundred landmarks (the beats method) stay finite and in [0, 1].
    const big = binomialUpperTail(600, 400, 0.28);
    expect(big).toBeGreaterThan(0);
    expect(big).toBeLessThan(1e-50);
    expect(binomialUpperTail(600, 160, 0.28)).toBeGreaterThan(0.4);
  });

  it('takes chance as the union coverage of the beat windows (2 × tol / period on an even grid)', () => {
    const even = grid(0, 100, 0.5);
    expect(beatWindowCoverage(even, 0.1, 10, 60)).toBeCloseTo(0.4, 6);
    // Overlapping windows are a union, never more than the window.
    expect(beatWindowCoverage(even, 0.3, 10, 60)).toBe(1);
    // Uneven grid: half the beats missing leaves gaps.
    const uneven = even.filter((_, k) => k % 4 < 2);
    expect(beatWindowCoverage(uneven, 0.1, 10, 60)).toBeCloseTo(0.2, 6);
    const s = chanceScreen(changes, est, 0.15, 1, 0.1);
    expect(s.gridChance).toBeCloseTo(0.4, 2);
    expect(s.windows.map((w) => w.part)).toEqual(['span', 'start', 'middle', 'end']);
    expect(s.alpha).toBe(CHANCE_ALPHA);
  });
});

describe('chance-level screen: V0 cases with known truth (VGT-7, PR #32)', () => {
  it('passes landmarks on beats at the right map, with the screen counts equal to the third checks', () => {
    const a = alignAnnotation(changesInput(est, changes));
    expect(a.excluded).toBeNull();
    expect(a.offsetSec).toBeCloseTo(0.15, 2);
    expect(a.chance!.passed).toBe(true);
    expect(a.chance!.windows.slice(1).map((w) => [w.landmarks, w.matched])).toEqual(a.segments.map((s) => [s.landmarks, s.matched]));
    expect(a.chance!.windows[0].matched).toBe(Math.round(a.matchedFraction * a.landmarks));
  });

  it('passes syncopated but correct changes (a third of them half a beat early or late)', () => {
    const synco = changes.map((t, k) => t + (k % 3 === 2 ? 0.25 : 0));
    const a = alignAnnotation(changesInput(est, synco));
    expect(a.excluded).toBeNull();
    expect(a.offsetSec).toBeCloseTo(0.15, 2);
    expect(a.chance!.passed).toBe(true);
  });

  it('passes unequal third sizes (dense start, sparse middle and end)', () => {
    const uneq = [...grid(3, 60, 1), ...grid(61, 180, 4)].map((t) => t - 0.15);
    const a = alignAnnotation(changesInput(est, uneq));
    expect(a.excluded).toBeNull();
    const n = a.chance!.windows.map((w) => w.landmarks);
    expect(n[1]).toBeGreaterThan(3 * n[2]);
    expect(a.chance!.passed).toBe(true);
  });

  it('passes clustered and repeated landmarks on beats', () => {
    const clus: number[] = [];
    for (let c = 5; c < 180; c += 20) for (const d of [0, 0.5, 1, 1.5]) clus.push(c + d - 0.15);
    clus.push(...clus.slice(0, 6));
    const a = alignAnnotation(changesInput(est, clus.sort((x, y) => x - y)));
    expect(a.excluded).toBeNull();
    expect(a.chance!.windows[0].landmarks).toBe(42);
    expect(a.chance!.passed).toBe(true);
  });

  it('passes under slowly varying tempo (±3%), with chance from the local grid', () => {
    const vb: number[] = [];
    for (let t = 1; t < 190; ) {
      vb.push(t);
      t += 0.5 * (1 + 0.03 * Math.sin((2 * Math.PI * t) / 60));
    }
    const a = alignAnnotation(changesInput(vb, vb.filter((_, k) => k % 4 === 2).map((t) => t - 0.15)));
    expect(a.offsetSec).toBeCloseTo(0.15, 2);
    expect(a.chance!.passed).toBe(true);
    expect(a.excluded?.code).not.toBe('near-chance');
  });

  it('passes with missing, doubled and halved estimate beats; flags windows too small to pass', () => {
    const r = rng(7);
    const missing = est.filter(() => r() > 0.1);
    const doubled: number[] = [];
    est.forEach((b, i) => {
      doubled.push(b);
      if (i + 1 < est.length) doubled.push((b + est[i + 1]) / 2);
    });
    const halved = est.filter((_, k) => k % 2 === 0);
    for (const beats of [missing, doubled, halved]) {
      const a = alignAnnotation(changesInput(beats, changes));
      expect(a.offsetSec).toBeCloseTo(0.15, 2);
      expect(a.chance!.passed).toBe(true);
      expect(a.chance!.windows.some((w) => w.insufficient)).toBe(false);
    }
    expect(alignAnnotation(changesInput(doubled, changes)).chance!.windows[1].chance).toBeCloseTo(0.8, 1);
    // 12 landmarks on a doubled grid: 4 per third at 80% chance cannot pass even all on beats.
    const few = grid(3, 180, 15).map((t) => t - 0.15);
    const a = alignAnnotation(changesInput(doubled, few));
    expect(a.chance!.windows.slice(1).every((w) => w.insufficient && w.matched === w.landmarks)).toBe(true);
    expect(a.excluded?.code).toBe('near-chance');
    expect(a.excluded?.reason).toMatch(/too few landmarks to pass/);
  });

  it('passes a small fitted rate difference (0.1%)', () => {
    const a = alignAnnotation(beatsInput(est, est.map((b) => (b - 0.05) * 1.001)));
    expect(a.excluded).toBeNull();
    expect(a.rate).not.toBe(1);
    expect(a.chance!.passed).toBe(true);
  });

  it('passes offsets near the search bound (±1.9 s of ±2 s)', () => {
    const slow = grid(1, 190, 1.1, 0.01);
    for (const off of [1.9, -1.9]) {
      const ann = slow.map((b) => b - off).filter((t) => t > 0);
      const down = slow.filter((_, k) => k % 4 === 0).map((b) => b - off).filter((t) => t > 0);
      const a = alignAnnotation(beatsInput(slow, ann, { downbeatLandmarks: down }));
      expect(a.excluded).toBeNull();
      expect(a.offsetSec).toBeCloseTo(off, 2);
      expect(a.chance!.passed).toBe(true);
    }
  });

  it('rejects landmarks at random phases that pass the old floor (beats every 0.64 s, 31% chance)', () => {
    const r = rng(2);
    const lm = Array.from({ length: 48 }, () => 5 + r() * 180).sort((x, y) => x - y);
    const a = alignAnnotation(changesInput(grid(1, 190, 0.64), lm, { estimateFirstDownbeatSec: null }));
    expect(passesOldFloor(a)).toBe(true);
    expect(a.chance!.windows[1].chance).toBeCloseTo(0.3125, 2);
    expect(a.excluded?.code).toBe('near-chance');
    expect(a.excluded?.reason).toMatch(/start third 6\/18 \(chance 31%, p 0\.5/);
  });

  it('rejects a song whose last third sits at random phases, naming only that window', () => {
    const r = rng(1);
    const lm = [...grid(3, 120, 2).map((t) => t - 0.15), ...Array.from({ length: 30 }, () => 121 + r() * 59)].sort((x, y) => x - y);
    const a = alignAnnotation(changesInput(est, lm));
    expect(passesOldFloor(a)).toBe(true);
    expect(a.excluded?.code).toBe('near-chance');
    expect(a.excluded?.reason).toMatch(/end third 12\/30/);
    expect(a.excluded?.reason).not.toMatch(/start third|middle third|whole span/);
  });

  it('records the screen whichever exclusion is primary, and keeps landmarks-disagree and duration first', () => {
    const dur = alignAnnotation(beatsInput(est, est, { mediaDurationSec: 203 }));
    expect(dur.excluded?.code).toBe('duration-mismatch');
    expect(dur.chance!.passed).toBe(true);
    const off = alignAnnotation(beatsInput(est, grid(1.25, 190, 0.731), { estimateFirstDownbeatSec: null }));
    expect(off.excluded?.code).toBe('landmarks-disagree');
    expect(off.chance).not.toBeNull();
    expect(alignAnnotation(beatsInput([], est)).chance).toBeNull();
  });
});
