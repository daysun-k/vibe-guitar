import { describe, expect, it } from 'vitest';
import { CQT } from '../src/audio/features';
import { estimateKey } from '../src/music/key';
import {
  candidateUnits,
  classSpace,
  decodeCandidate,
  emissions,
  familyOf,
  hasCandidateOptions,
  isDiatonicChord,
  largeToMajmin,
  majminLabelFamily,
  MAJMIN_FAMILIES,
  rootRotation,
  shiftCqt,
  unitMeans,
  unitPenalties,
  type CandidateDecodeInput,
  type CandidateRecognizerOptions,
} from '../src/recognize/candidate-decode';
import { CandidateRecognizer } from '../src/recognize/candidate-recognizer';
import { buildVocabulary, decodeUnits, DEFAULT_DECODE, type BtcModelMeta, type DecodeUnit } from '../src/recognize/chords';
import { Recognizer } from '../src/recognize/recognizer';
import type { ModelRunner } from '../src/recognize/runner';
import { parseReplayConfig } from '../src/replay/replay';
import { testAudio } from './replay-helpers';

const FS = 0.1; // frame seconds in the synthetic matrices

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** Random normalised probabilities [frames × K], peaky so decodes are non-trivial. */
function randomProbs(frames: number, K: number, seed: number): Float32Array {
  const r = rng(seed);
  const p = new Float32Array(frames * K);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let k = 0; k < K; k++) sum += p[f * K + k] = Math.pow(r(), 4);
    for (let k = 0; k < K; k++) p[f * K + k] /= sum;
  }
  return p;
}

function randomUnits(frames: number, seed: number): DecodeUnit[] {
  const r = rng(seed);
  const units: DecodeUnit[] = [];
  let t = 0;
  let i = 0;
  while (t < frames * FS - 0.05) {
    const end = Math.min(frames * FS, t + 0.3 + r() * 0.6);
    units.push({ startSec: t, endSec: end, strength: (i === 0 ? 2 : i % 4 === 0 ? 0 : i % 2 === 0 ? 1 : 2) as 0 | 1 | 2 });
    t = end;
    i++;
  }
  return units;
}

/** Synthetic probabilities over named symbols: rows give each frame's probabilities by symbol name. */
function matrix(symbols: string[], rows: Record<string, number>[]): Float32Array {
  const p = new Float32Array(rows.length * symbols.length);
  rows.forEach((row, f) => {
    const rest = 1 - Object.values(row).reduce((a, b) => a + b, 0);
    const others = symbols.filter((s) => !(s in row));
    symbols.forEach((s, j) => (p[f * symbols.length + j] = s in row ? row[s] : rest / others.length));
  });
  return p;
}

const beatUnits = (n: number, framesPerUnit: number): DecodeUnit[] =>
  Array.from({ length: n }, (_, i) => ({ startSec: i * framesPerUnit * FS, endSec: (i + 1) * framesPerUnit * FS, strength: (i % 4 === 0 ? 0 : 2) as 0 | 2 }));

const input = (symbols: string[], probs: Float32Array, units: DecodeUnit[], majminProbs?: Float32Array): CandidateDecodeInput => ({
  frames: probs.length / symbols.length,
  frameSec: FS,
  frameStartSec: 0,
  units,
  symbols,
  probs,
  majminProbs,
});

const SIMPLE = ['C', 'Cm', 'C7', 'Cmaj7', 'Cm7', 'Csus4', 'Cdim', 'G', 'Gm', 'G7', 'Am', 'F', 'N'];

describe('candidate decode: defaults', () => {
  it('reproduces decodeUnits exactly with no option set (random matrices, several penalties)', () => {
    for (let seed = 1; seed <= 12; seed++) {
      const K = 5 + (seed % 7);
      const frames = 40 + seed * 7;
      const symbols = Array.from({ length: K }, (_, j) => (j === K - 1 ? 'N' : `S${j}`));
      const probs = randomProbs(frames, K, seed);
      const units = randomUnits(frames, seed + 100);
      const x = input(symbols, probs, units);
      expect(decodeCandidate(x, {})).toEqual(decodeUnits(probs, frames, K, FS, 0, units, symbols));
      for (const cp of [[1.5, 3, 4.5], [1, 2, 3], [0.5, 1, 1.5], [0, 0, 0]] as [number, number, number][])
        expect(decodeCandidate(x, { decode: { changePenalty: cp } })).toEqual(decodeUnits(probs, frames, K, FS, 0, units, symbols, { changePenalty: cp }));
    }
  });

  it('counts only non-plain options as candidate options', () => {
    expect(hasCandidateOptions({})).toBe(false);
    expect(hasCandidateOptions({ vocabulary: 'full', decode: { changePenalty: [1, 2, 3] } })).toBe(false);
    for (const o of [{ decode: { familyFirst: { penaltyScale: 1 } } }, { units: { halfBeat: true, offbeatExtraPenalty: 2 } }, { emission: 'meanLog' }, { majmin: 'average' }, { nLogPrior: -1 }, { pitchShift: [1] }, { keyPrior: { bonus: 1, margin: 0.15 } }] as CandidateRecognizerOptions[])
      expect(hasCandidateOptions(o)).toBe(true);
  });
});

describe('C1 family-first decoding', () => {
  it('groups maj / 7 / maj7 and min / m7 per root; other qualities and N stay their own classes', () => {
    expect(['C', 'C7', 'Cmaj7'].map(familyOf)).toEqual(['0:maj', '0:maj', '0:maj']);
    expect(['Cm', 'Cm7'].map(familyOf)).toEqual(['0:min', '0:min']);
    expect(['Csus2', 'Csus4', 'Cdim', 'Caug', 'Cm7b5', 'N', 'F#7'].map(familyOf)).toEqual(['Csus2', 'Csus4', 'Cdim', 'Caug', 'Cm7b5', 'N', '6:maj']);
  });

  it('lets a split family beat a single class and returns a real member quality', () => {
    // C and C7 split 0.56 between them; G alone has 0.4 → the plain decode says G.
    const rows = Array.from({ length: 8 }, () => ({ C: 0.3, C7: 0.26, G: 0.4 }));
    const x = input(SIMPLE, matrix(SIMPLE, rows), beatUnits(4, 2));
    expect(decodeCandidate(x, {}).map((u) => u.symbol)).toEqual(['G', 'G', 'G', 'G']);
    const fam = decodeCandidate(x, { decode: { familyFirst: { penaltyScale: 1 } } });
    expect(fam.map((u) => u.symbol)).toEqual(['C', 'C', 'C', 'C']);
    for (const u of fam) expect(SIMPLE).toContain(u.symbol);
  });

  it('picks the member with the highest mean probability over the whole decoded segment', () => {
    // C7 leads in the first beat, C in the other three: one C-family segment, member C overall.
    const rows = [
      ...Array.from({ length: 2 }, () => ({ C: 0.2, C7: 0.5 })),
      ...Array.from({ length: 6 }, () => ({ C: 0.5, C7: 0.2 })),
    ];
    const fam = decodeCandidate(input(SIMPLE, matrix(SIMPLE, rows), beatUnits(4, 2)), { decode: { familyFirst: { penaltyScale: 1 } } });
    expect(fam.map((u) => u.symbol)).toEqual(['C', 'C', 'C', 'C']);
    expect(fam[0].confidence).toBeCloseTo(0.2, 6); // confidence: the chosen symbol's mean in that unit
  });

  it('scales the change penalties during family decoding', () => {
    const symbols = ['C', 'G', 'N'];
    // A one-beat G blip worth 2·log(0.6/0.4) ≈ 0.81 against a change pair costing 2 × 0.5 (scale 1) or 2 × 1 (scale 2).
    const rows = [...Array.from({ length: 4 }, () => ({ C: 0.6, G: 0.4 })), { C: 0.2, G: 0.8 }, { C: 0.2, G: 0.8 }, ...Array.from({ length: 4 }, () => ({ C: 0.6, G: 0.4 }))];
    const units = beatUnits(5, 2).map((u) => ({ ...u, strength: 2 as const }));
    const x = input(symbols, matrix(symbols, rows), units);
    const decode = { changePenalty: [0.5, 0.5, 0.5] as [number, number, number] };
    expect(decodeCandidate(x, { decode: { ...decode, familyFirst: { penaltyScale: 1 } } }).map((u) => u.symbol)).toEqual(['C', 'C', 'G', 'C', 'C']);
    expect(decodeCandidate(x, { decode: { ...decode, familyFirst: { penaltyScale: 2 } } }).map((u) => u.symbol)).toEqual(['C', 'C', 'C', 'C', 'C']);
  });
});

describe('U half-beat units', () => {
  it('splits every unit; the mid boundary costs other-beat + extra, beat boundaries keep their strength', () => {
    const units: DecodeUnit[] = [
      { startSec: 0, endSec: 1, strength: 2 },
      { startSec: 1, endSec: 2, strength: 0 },
      { startSec: 2, endSec: 3, strength: 1 },
    ];
    const half = { halfBeat: true as const, offbeatExtraPenalty: 2 };
    const split = candidateUnits(units, half);
    expect(split.map((u) => [u.startSec, u.endSec, u.strength, !!u.offbeat])).toEqual([
      [0, 0.5, 2, false],
      [0.5, 1, 2, true],
      [1, 1.5, 0, false],
      [1.5, 2, 2, true],
      [2, 2.5, 1, false],
      [2.5, 3, 2, true],
    ]);
    expect([...unitPenalties(split, [2, 4, 6], half)].slice(1)).toEqual([8, 2, 8, 4, 8]);
    expect([...unitPenalties(split, [2, 4, 6], half, 1.25)].slice(1)).toEqual([10, 2.5, 10, 5, 10]);
  });

  it('finds a mid-beat change that beat units cannot place, and the extra penalty can suppress it', () => {
    const symbols = ['C', 'G', 'N'];
    // Beat 2 changes C → G halfway; 4 frames per beat.
    const rows = [...Array.from({ length: 6 }, () => ({ C: 0.9, G: 0.05 })), ...Array.from({ length: 10 }, () => ({ C: 0.05, G: 0.9 }))];
    const x = input(symbols, matrix(symbols, rows), beatUnits(4, 4).map((u) => ({ ...u, strength: 2 as const })));
    const beat = decodeCandidate(x, { decode: { changePenalty: [1, 1, 1] } });
    expect(beat).toHaveLength(4);
    const half = decodeCandidate(x, { decode: { changePenalty: [1, 1, 1] }, units: { halfBeat: true, offbeatExtraPenalty: 2 } });
    expect(half.map((u) => u.symbol)).toEqual(['C', 'C', 'C', 'G', 'G', 'G', 'G', 'G']);
    expect(half[3].startSec).toBeCloseTo(0.6, 9);
    const costly = decodeCandidate(x, { decode: { changePenalty: [1, 1, 1] }, units: { halfBeat: true, offbeatExtraPenalty: 100 } });
    expect(costly.map((u) => u.symbol)).toEqual(['C', 'C', 'G', 'G', 'G', 'G', 'G', 'G']);
  });
});

describe('E emissions', () => {
  const symbols = ['C', 'G', 'N'];
  const units: DecodeUnit[] = [
    { startSec: 0, endSec: 0.2, strength: 2 },
    { startSec: 0.2, endSec: 0.6, strength: 2 },
    { startSec: 0.6, endSec: 0.8, strength: 2 },
  ];
  const rows = [{ C: 0.5, G: 0.4 }, { C: 0.5, G: 0.4 }, { C: 0.98, G: 0.01 }, { C: 0.01, G: 0.98 }, { C: 0.5, G: 0.4 }, { C: 0.5, G: 0.4 }, { C: 0.3, G: 0.6 }, { C: 0.3, G: 0.6 }];
  const x = input(symbols, matrix(symbols, rows), units);
  const sp = classSpace(x, {});
  const avg = unitMeans(sp.probs, x.frames, 3, FS, 0, units);

  it('meanLog averages frame log-probabilities instead of taking the log of the mean', () => {
    const e = emissions(sp, x, units, avg, { emission: 'meanLog' }, null);
    const want = (Math.log(0.98 + 1e-9) + Math.log(0.01 + 1e-9) + 2 * Math.log(0.5 + 1e-9)) / 4;
    expect(e[1 * 3 + 0]).toBeCloseTo(want, 6);
    const plain = emissions(sp, x, units, avg, {}, null);
    expect(plain[1 * 3 + 0]).toBeCloseTo(Math.log((0.98 + 0.01 + 0.5 + 0.5) / 4 + 1e-9), 6);
  });

  it('durationWeighted multiplies log(mean p) by unit length / median unit length', () => {
    const e = emissions(sp, x, units, avg, { emission: 'durationWeighted' }, null);
    const plain = emissions(sp, x, units, avg, {}, null);
    // lengths 0.2, 0.4, 0.2 → median 0.2: weights 1, 2, 1
    expect(e[0]).toBeCloseTo(plain[0], 9);
    expect(e[3 + 1]).toBeCloseTo(2 * plain[3 + 1], 9);
  });
});

describe('C7 N prior', () => {
  it('adds the log-prior to N in every unit', () => {
    const symbols = ['C', 'G', 'N'];
    const rows = Array.from({ length: 8 }, () => ({ N: 0.5, C: 0.3 }));
    const x = input(symbols, matrix(symbols, rows), beatUnits(4, 2));
    expect(decodeCandidate(x, {}).every((u) => u.symbol === 'N')).toBe(true);
    expect(decodeCandidate(x, { nLogPrior: -1 }).every((u) => u.symbol === 'C')).toBe(true);
    const sp = classSpace(x, {});
    const avg = unitMeans(sp.probs, x.frames, 3, FS, 0, x.units);
    const e0 = emissions(sp, x, x.units, avg, {}, null);
    const e1 = emissions(sp, x, x.units, avg, { nLogPrior: -2 }, null);
    for (let u = 0; u < 4; u++) {
      expect(e1[u * 3 + 2] - e0[u * 3 + 2]).toBeCloseTo(-2, 12);
      expect(e1[u * 3]).toBe(e0[u * 3]);
    }
  });
});

describe('C4 key prior', () => {
  it('uses key.ts fit rule for diatonic chords', () => {
    const cMajor = { tonic: 0, mode: 'major' as const };
    expect(['C', 'Dm', 'Em', 'F', 'G', 'G7', 'Am', 'Bdim', 'Bm7b5', 'Cmaj7'].map((s) => isDiatonicChord(s, cMajor))).toEqual(Array(10).fill(true));
    expect(['D', 'Cm', 'Eb', 'Bb', 'N', 'E'].map((s) => isDiatonicChord(s, cMajor))).toEqual(Array(6).fill(false));
    const aMinor = { tonic: 9, mode: 'minor' as const };
    expect(['Am', 'C', 'Dm', 'Em', 'E', 'F', 'G'].map((s) => isDiatonicChord(s, aMinor))).toEqual(Array(7).fill(true));
    // Agrees with estimateKey's own fit on a plain progression.
    expect(estimateKey([{ chord: 'C', durationSec: 4 }, { chord: 'F', durationSec: 2 }, { chord: 'G', durationSec: 2 }])).toMatchObject({ tonic: 0, mode: 'major' });
  });

  it('adds the bonus only in units whose top-2 probabilities are within the margin', () => {
    const symbols = ['C', 'Cm', 'G', 'N'];
    const key = estimateKey([{ chord: 'C', durationSec: 8 }, { chord: 'G', durationSec: 4 }])!;
    const rows = [...Array.from({ length: 4 }, () => ({ Cm: 0.45, C: 0.4 })), ...Array.from({ length: 4 }, () => ({ Cm: 0.7, C: 0.2 }))];
    const x = input(symbols, matrix(symbols, rows), beatUnits(2, 4));
    const sp = classSpace(x, {});
    const avg = unitMeans(sp.probs, x.frames, 4, FS, 0, x.units);
    const kp = { keyPrior: { bonus: 0.5, margin: 0.15 } };
    const e0 = emissions(sp, x, x.units, avg, {}, null);
    const e1 = emissions(sp, x, x.units, avg, kp, key);
    expect([...e1.slice(0, 4)].map((v, j) => v - e0[j])).toEqual([0.5, 0, 0.5, 0]); // ambiguous unit: C and G get the bonus
    expect([...e1.slice(4)].map((v, j) => v - e0[4 + j])).toEqual([0, 0, 0, 0]); // clear unit: unchanged
    expect(emissions(sp, x, x.units, avg, kp, null)).toEqual(e0); // no key, no prior
    const d = decodeCandidate(x, { ...kp, decode: { changePenalty: [0, 0, 0] } }, key);
    expect(d.map((u) => u.symbol)).toEqual(['C', 'Cm']);
  });
});

describe('C6 pitch shift', () => {
  const B = CQT.nBins;
  const frames = 3;
  const cqt = new Float32Array(frames * B).map((_, i) => (i % B) + 1000 * Math.floor(i / B));

  it('shifts 2 bins per semitone and repeats the edge bin, never wrapping', () => {
    const up = shiftCqt(cqt, frames, 1);
    const down = shiftCqt(cqt, frames, -2);
    for (let f = 0; f < frames; f++) {
      const o = f * B;
      expect([up[o], up[o + 1], up[o + 2], up[o + 3]]).toEqual([cqt[o], cqt[o], cqt[o], cqt[o + 1]]);
      expect(up[o + B - 1]).toBe(cqt[o + B - 3]);
      expect(down[o]).toBe(cqt[o + 4]);
      for (let k = B - 4; k < B; k++) expect(down[o + k]).toBe(cqt[o + B - 1]);
      // never circular: no value of the opposite edge appears where padding is
      expect(up.subarray(o, o + 2).every((v) => v === cqt[o])).toBe(true);
    }
  });

  it('rotates chord roots and keeps N and X', () => {
    const roots = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    const labels = [...roots.flatMap((r) => [`${r}:min`, r, `${r}:hdim7`]), 'N', 'X'];
    const down = [...rootRotation(labels, -1)].map((i) => labels[i]);
    expect(down.slice(0, 6)).toEqual(['B:min', 'B', 'B:hdim7', 'C:min', 'C', 'C:hdim7']);
    expect(down.slice(-2)).toEqual(['N', 'X']);
    const up = [...rootRotation(labels, 2)].map((i) => labels[i]);
    expect(up[labels.indexOf('A#:min')]).toBe('C:min');
  });

  it('averages shifted runs with the unshifted one after rotating roots back', async () => {
    const C = 4;
    const meta: BtcModelMeta = { file: 'fake', mean: 0, std: 1, timestep: 8, num_chords: C, labels: ['C', 'C#', 'D', 'N'] };
    expect(() => rootRotation(meta.labels, -1)).toThrow(/no rotated label/); // B is not in this toy vocabulary
    const full = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B', 'N'];
    const m2: BtcModelMeta = { ...meta, num_chords: full.length, labels: full };
    // Fake model: always puts its mass on the class whose root is the pitch of the highest-energy bin pair.
    const runner: ModelRunner = {
      async run(_n, data, dims) {
        const T = dims[1];
        const logits = new Float32Array(T * full.length);
        for (let t = 0; t < T; t++) {
          let best = 0;
          for (let k = 0; k < B; k++) if (data[t * B + k] > data[t * B + best]) best = k;
          logits[t * full.length + (Math.floor(best / 2) % 12)] = 10;
        }
        return { logits };
      },
    };
    const x = new Float32Array(8 * B);
    for (let t = 0; t < 8; t++) x[t * B + 20] = 5; // bin 20 = pitch class 10 (A#)
    const rec = new CandidateRecognizer(runner, runner, m2, { pitchShift: [-1, 1] });
    const p = await rec.modelProbs(runner, m2, x, 8);
    // Each shifted run hears A# ± 1; rotated back, all three runs vote A#.
    for (let t = 0; t < 8; t++) expect(p[t * full.length + 10]).toBeGreaterThan(0.99);
  });
});

describe('C5 majmin model', () => {
  const majLabels = MAJMIN_FAMILIES.map((f) => (f === 'N' ? 'N' : f.endsWith(':min') ? `${['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'][Number(f.split(':')[0])]}:min` : ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'][Number(f.split(':')[0])]));

  it('maps btc_majmin labels and large symbols onto the 25 families', () => {
    expect(majLabels.map(majminLabelFamily)).toEqual(MAJMIN_FAMILIES.map((_, i) => i));
    expect([...largeToMajmin(['C', 'Cm', 'C7', 'Cmaj7', 'Cm7', 'Csus4', 'Cdim', 'Caug', 'Cm7b5', 'N'])].map((i) => MAJMIN_FAMILIES[i])).toEqual(['0:maj', '0:min', '0:maj', '0:maj', '0:min', '0:maj', '0:min', '0:maj', '0:min', 'N']);
  });

  const ROOTS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const symbols = buildVocabulary([...ROOTS.flatMap((r) => [`${r}:min`, r, `${r}:7`, `${r}:maj7`, `${r}:min7`, `${r}:sus4`, `${r}:dim`]), 'N', 'X'], 'simple').symbols;
  const familyRows = (fam: Record<string, number>) => {
    const p = new Float32Array(MAJMIN_FAMILIES.length);
    const rest = (1 - Object.values(fam).reduce((a, b) => a + b, 0)) / (MAJMIN_FAMILIES.length - Object.keys(fam).length);
    MAJMIN_FAMILIES.forEach((f, i) => (p[i] = f in fam ? fam[f] : rest));
    return p;
  };

  it('familyDecide: the majmin model decides the family, the large model the quality inside it', () => {
    // Large model prefers G; the majmin model says C major family; inside it the large model ranks C7 over C.
    const large = matrix(symbols, Array.from({ length: 4 }, () => ({ G: 0.4, C7: 0.2, C: 0.1 })));
    const mm = new Float32Array(4 * 25);
    for (let f = 0; f < 4; f++) mm.set(familyRows({ '0:maj': 0.8 }), f * 25);
    const x = input(symbols, large, beatUnits(2, 2), mm);
    expect(decodeCandidate(x, {}).map((u) => u.symbol)).toEqual(['G', 'G']);
    const d = decodeCandidate(x, { majmin: 'familyDecide' });
    expect(d.map((u) => u.symbol)).toEqual(['C7', 'C7']);
    expect(() => decodeCandidate(input(symbols, large, beatUnits(2, 2)), { majmin: 'familyDecide' })).toThrow(/majmin model did not run/);
  });

  it('average: mean of both models family probabilities; outputs only maj/7/maj7/min/m7/N members', () => {
    const large = matrix(symbols, Array.from({ length: 4 }, () => ({ G: 0.5, Cm: 0.3 })));
    const mm = new Float32Array(4 * 25);
    for (let f = 0; f < 4; f++) mm.set(familyRows({ '0:min': 0.6, '7:maj': 0.1 }), f * 25);
    const x = input(symbols, large, beatUnits(2, 2), mm);
    const sp = classSpace(x, { majmin: 'average' });
    const g = MAJMIN_FAMILIES.indexOf('7:maj');
    const cm = MAJMIN_FAMILIES.indexOf('0:min');
    // Large model collapsed by the majmin vocabulary rule: G family = G + G7 + Gmaj7 + Gsus4 (dim → minor).
    const fam = largeToMajmin(symbols);
    const largeFam = (i: number) => symbols.reduce((a, _, j) => a + (fam[j] === i ? large[j] : 0), 0);
    expect(largeFam(g)).toBeGreaterThan(0.5);
    expect(sp.probs[g]).toBeCloseTo(0.5 * (0.1 + largeFam(g)), 5);
    expect(sp.probs[cm]).toBeCloseTo(0.5 * (0.6 + largeFam(cm)), 5);
    expect(decodeCandidate(x, { majmin: 'average' }).map((u) => u.symbol)).toEqual(['Cm', 'Cm']);
    for (const m of sp.members.flat()) expect(symbols[m]).toMatch(/^([A-G]#?(|7|maj7|m|m7)|N)$/);
    expect(sp.members.flat()).toHaveLength(ROOTS.length * 5 + 1); // sus4 and dim are no member of any family
  });
});

describe('CandidateRecognizer end to end (fake models)', () => {
  const B = CQT.nBins;
  const labels = ['C:min', 'C', 'C:7', 'C:maj7', 'C:min7', 'C:sus4', 'G', 'G:min', 'G:7', 'A:min', 'F', 'N', 'X'];
  const meta: BtcModelMeta = { file: 'fake', mean: -3, std: 2, timestep: 108, num_chords: labels.length, labels };
  const chordRunner: ModelRunner = {
    async run(_n, data, dims) {
      const T = dims[1];
      const C = labels.length;
      const logits = new Float32Array(T * C);
      for (let t = 0; t < T; t++) for (let c = 0; c < C; c++) logits[t * C + c] = 3 * Math.sin(data[t * B + ((c * 11) % B)] * 2.1 + c + t * 0.05);
      return { logits };
    },
  };
  const beatRunner = (withBeats: boolean): ModelRunner => ({
    async run(_n, _data, dims) {
      const T = dims[1];
      const beat = new Float32Array(T).fill(-5);
      const downbeat = new Float32Array(T).fill(-5);
      if (withBeats) for (let t = 25; t < T; t += 25) {
        beat[t] = 5;
        if (t % 100 === 0) downbeat[t] = 5;
      }
      return { beat, downbeat };
    },
  });

  for (const withBeats of [true, false]) {
    it(`with no candidate option equals Recognizer (${withBeats ? 'beat units' : 'fixed units, < 4 beats'})`, async () => {
      const audio = testAudio(9, 7);
      const plain = await new Recognizer(beatRunner(withBeats), chordRunner, meta).analyzeSegment(audio, 3.25, undefined, true);
      const cand = await new CandidateRecognizer(beatRunner(withBeats), chordRunner, meta, {}).analyzeSegment(audio, 3.25, undefined, true);
      expect(cand.units).toEqual(plain.units);
      expect(cand.beats).toEqual(plain.beats);
      expect(cand.probs).toEqual(plain.probs);
      expect(new Set(cand.units.map((u) => u.symbol)).size).toBeGreaterThan(1);
    });
  }

  it('composes all options in one decode path and keeps the decode input', async () => {
    const mmMeta: BtcModelMeta = { file: 'fake-mm', mean: -3, std: 2, timestep: 108, num_chords: 25, labels: ['C', 'C:min', 'C#', 'C#:min', 'D', 'D:min', 'D#', 'D#:min', 'E', 'E:min', 'F', 'F:min', 'F#', 'F#:min', 'G', 'G:min', 'G#', 'G#:min', 'A', 'A:min', 'A#', 'A#:min', 'B', 'B:min', 'N'] };
    const mmRunner: ModelRunner = {
      async run(_n, data, dims) {
        const T = dims[1];
        const logits = new Float32Array(T * 25);
        for (let t = 0; t < T; t++) for (let c = 0; c < 25; c++) logits[t * 25 + c] = 2 * Math.cos(data[t * B + ((c * 5) % B)] + c);
        return { logits };
      },
    };
    const full: CandidateRecognizerOptions = {
      decode: { changePenalty: [1, 2, 3], familyFirst: { penaltyScale: 1.25 } },
      units: { halfBeat: true, offbeatExtraPenalty: 2 },
      emission: 'meanLog',
      majmin: 'average',
      nLogPrior: -1,
      pitchShift: [-1, 1],
      keyPrior: { bonus: 0.5, margin: 0.15 },
    };
    // The large toy vocabulary lacks most roots, so C6 needs the full label set: use all 12 roots.
    const roots = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    const bigLabels = [...roots.flatMap((r) => [`${r}:min`, r, `${r}:7`, `${r}:min7`]), 'N', 'X'];
    const bigMeta: BtcModelMeta = { ...meta, num_chords: bigLabels.length, labels: bigLabels };
    const bigRunner: ModelRunner = {
      async run(_n, data, dims) {
        const T = dims[1];
        const C = bigLabels.length;
        const logits = new Float32Array(T * C);
        for (let t = 0; t < T; t++) for (let c = 0; c < C; c++) logits[t * C + c] = 3 * Math.sin(data[t * B + ((c * 7) % B)] * 1.7 + c);
        return { logits };
      },
    };
    const rec = new CandidateRecognizer(beatRunner(true), bigRunner, bigMeta, full, { runner: mmRunner, meta: mmMeta });
    const a = await rec.analyzeSegment(testAudio(9, 3), 0);
    const input = rec.decodeInput(a);
    expect(input.majminProbs).toHaveLength(input.frames * 25);
    expect(a.units.length).toBe(2 * input.units.length);
    for (const u of a.units) expect(['N', ...roots.flatMap((r) => [r, `${r}m`, `${r}7`, `${r}m7`])]).toContain(u.symbol);
    const chart = { events: [{ startSec: 0, chord: 'C', confidence: 1, source: 'auto' as const }], coverage: [{ fromSec: 0, toSec: 9 }] } as never;
    const { analyses, key } = rec.applyKeyPrior([a], chart);
    expect(key).toMatchObject({ tonic: 0, mode: 'major' });
    expect(rec.decodeInput(analyses[0])).toBe(input);
    expect(() => new CandidateRecognizer(beatRunner(true), bigRunner, bigMeta, { majmin: 'average' })).toThrow(/needs the btc_majmin model/);
  });
});

describe('replay config: candidate options', () => {
  const settings: Record<string, unknown>[] = [
    { decode: { changePenalty: [1.5, 3, 4.5] } },
    { decode: { familyFirst: { penaltyScale: 1 } } },
    { decode: { familyFirst: { penaltyScale: 1.25 } } },
    { units: { halfBeat: true, offbeatExtraPenalty: 2 } },
    { emission: 'durationWeighted' },
    { emission: 'meanLog' },
    { majmin: 'familyDecide' },
    { majmin: 'average' },
    { nLogPrior: -1 },
    { pitchShift: [-2, -1, 1, 2] },
    { keyPrior: { bonus: 1, margin: 0.15 } },
  ];

  it('accepts every candidate setting unchanged', () => {
    for (const r of settings) expect(parseReplayConfig({ label: 'x', recognizer: r }).recognizer).toEqual(r);
  });

  it('rejects unknown or malformed fields', () => {
    const bad: [unknown, RegExp][] = [
      [{ decode: { familyFirst: { penaltyScale: 1, x: 1 } } }, /unknown field recognizer.decode.familyFirst.x/],
      [{ decode: { familyFirst: {} } }, /penaltyScale must be a number > 0/],
      [{ decode: {} }, /must set changePenalty or familyFirst/],
      [{ units: { halfBeat: false, offbeatExtraPenalty: 2 } }, /halfBeat must be true/],
      [{ units: { halfBeat: true } }, /offbeatExtraPenalty must be/],
      [{ units: { halfBeat: true, offbeatExtraPenalty: 2, beat: 1 } }, /unknown field recognizer.units.beat/],
      [{ emission: 'sum' }, /emission must be/],
      [{ majmin: true }, /majmin must be/],
      [{ nLogPrior: '1' }, /nLogPrior must be a finite number/],
      [{ pitchShift: [0, 1] }, /pitchShift must be/],
      [{ pitchShift: [1.5] }, /pitchShift must be/],
      [{ pitchShift: [1, 1] }, /pitchShift must be/],
      [{ keyPrior: { bonus: 1 } }, /keyPrior.margin must be/],
      [{ keyPrior: { bonus: 1, margin: 0.15, scope: 'local' } }, /unknown field recognizer.keyPrior.scope/],
      [{ smoothing: 3 }, /unknown field recognizer.smoothing/],
    ];
    for (const [r, re] of bad) expect(() => parseReplayConfig({ recognizer: r })).toThrow(re);
  });
});

describe('DEFAULT_DECODE', () => {
  it('is still [2, 4, 6]', () => expect(DEFAULT_DECODE.changePenalty).toEqual([2, 4, 6]));
});
