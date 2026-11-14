/**
 * VGT-18 recognizer candidates (docs/recognition-candidates.md), offline evaluation only: the
 * extension does not import this module, so the packaged recognizer is unchanged. Every option is
 * off unless set; with none set, decodeCandidate reproduces decodeUnits exactly (tests/candidates.test.ts).
 * The options compose in one decode path: units → decode classes → per-unit emissions (+ priors)
 * → Viterbi with change penalties → symbols.
 */
import { isNoChord, parseChord, type Chord } from '../arrange/chord';
import { mod12 } from '../arrange/notes';
import { CQT } from '../audio/features';
import type { KeyEstimate } from '../music/key';
import { DEFAULT_DECODE, type DecodedUnit, type DecodeOptions, type DecodeUnit } from './chords';
import type { RecognizerOptions } from './recognizer';

/** C1: Viterbi over chord families, then the member quality per decoded segment. */
export interface FamilyFirstOptions {
  /** Multiplies every change penalty during family decoding. */
  penaltyScale: number;
}

export interface CandidateDecodeOptions {
  /** C2. Default [2, 4, 6] (bar start, half bar, other beats). */
  changePenalty?: DecodeOptions['changePenalty'];
  familyFirst?: FamilyFirstOptions;
}

/** U: every unit split in two; the mid-unit boundary costs the other-beat penalty + offbeatExtraPenalty. */
export interface HalfBeatOptions {
  halfBeat: true;
  offbeatExtraPenalty: number;
}

/** E: durationWeighted = log(mean p) × unit length / median unit length; meanLog = mean of frame log p. */
export type EmissionMode = 'durationWeighted' | 'meanLog';

/** C5: familyDecide = the majmin model decides root + major/minor family; average = mean of both models' family probabilities. */
export type MajminMode = 'familyDecide' | 'average';

/** C4: bonus on chords diatonic to the global key, only in units whose top-2 probabilities are within margin. */
export interface KeyPriorOptions {
  bonus: number;
  margin: number;
}

/**
 * C10: in units whose top-2 classes are fifth-related (roots 7 semitones apart, same major/minor
 * family) and within `margin` in mean probability, take the one whose root is the strongest bass
 * pitch class (the decoder's choice stays when the bass matches neither).
 */
export interface BassRootOptions {
  margin: number;
}

/**
 * C8: each unit's class vector becomes (1 − weight)·own + weight·mean of its `k` most similar units by
 * beat-chroma cosine similarity, excluding units within ±4 of itself (same segment).
 */
export interface RepetitionOptions {
  k: number;
  weight: number;
}

/** RecognizerOptions plus the candidate options (replay config `recognizer`, bench --config). */
export interface CandidateRecognizerOptions extends Omit<RecognizerOptions, 'decode' | 'emission'> {
  decode?: CandidateDecodeOptions;
  units?: HalfBeatOptions;
  emission?: EmissionMode;
  majmin?: MajminMode;
  /** C7: log-prior added to N in every unit's emission. */
  nLogPrior?: number;
  /** C6: semitone shifts averaged with the unshifted run (equal weights). */
  pitchShift?: number[];
  keyPrior?: KeyPriorOptions;
  /** C10: bass-aware root choice between fifth-related top-2 classes. */
  bassRoot?: BassRootOptions;
  /** C8: repetition smoothing of beat vectors over similar beats. */
  repetition?: RepetitionOptions;
}

/** True when an option outside the plain Recognizer (vocabulary, decode.changePenalty, noBeats, emission meanLog, pitchShift) is set. */
export function hasCandidateOptions(o: CandidateRecognizerOptions): boolean {
  return (
    o.decode?.familyFirst !== undefined ||
    o.units !== undefined ||
    (o.emission !== undefined && o.emission !== 'meanLog') ||
    o.majmin !== undefined ||
    o.nLogPrior !== undefined ||
    o.keyPrior !== undefined ||
    o.bassRoot !== undefined ||
    o.repetition !== undefined
  );
}

/** The plain Recognizer options of a config without candidate options. */
export function plainRecognizerOptions(o: CandidateRecognizerOptions): RecognizerOptions {
  if (hasCandidateOptions(o)) throw new Error('plainRecognizerOptions: candidate options are set');
  const out: RecognizerOptions = {};
  if (o.vocabulary !== undefined) out.vocabulary = o.vocabulary;
  if (o.noBeats !== undefined) out.noBeats = o.noBeats;
  if (o.decode?.changePenalty) out.decode = { changePenalty: [...o.decode.changePenalty] };
  if (o.emission === 'meanLog') out.emission = 'meanLog';
  if (o.pitchShift !== undefined) out.pitchShift = [...o.pitchShift];
  return out;
}

// ---------------------------------------------------------------- Symbols and families

const PC: Record<string, number> = { C: 0, 'C#': 1, D: 2, 'D#': 3, E: 4, F: 5, 'F#': 6, G: 7, 'G#': 8, A: 9, 'A#': 10, B: 11 };
export const SHARP_ROOTS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** Root pitch class and quality suffix of a recognizer symbol ("C#m7" → 1, "m7"); null for N. */
export function splitSymbol(symbol: string): { root: number; suffix: string } | null {
  if (symbol === 'N') return null;
  const m = /^([A-G]#?)(.*)$/.exec(symbol);
  if (!m || PC[m[1]] === undefined) throw new Error(`candidate decode: unexpected symbol ${symbol}`);
  return { root: PC[m[1]], suffix: m[2] };
}

const MAJOR_FAMILY = ['', '7', 'maj7'];
const MINOR_FAMILY = ['m', 'm7'];

/**
 * Family key of a symbol (C1): "<pc>:maj" for maj / 7 / maj7, "<pc>:min" for min / m7, "N" for N;
 * any other quality (sus2, sus4, dim, aug, m7b5, and the full vocabulary's 6, m6, m(maj7), dim7)
 * stays its own class, keyed by the symbol itself.
 */
export function familyOf(symbol: string): string {
  const s = splitSymbol(symbol);
  if (!s) return 'N';
  if (MAJOR_FAMILY.includes(s.suffix)) return `${s.root}:maj`;
  if (MINOR_FAMILY.includes(s.suffix)) return `${s.root}:min`;
  return symbol;
}

/** A representative chart symbol of a family key (for the key prior and the majmin model's names). */
export function familySymbol(family: string): string {
  const m = /^(\d+):(maj|min)$/.exec(family);
  if (!m) return family;
  return `${SHARP_ROOTS[Number(m[1])]}${m[2] === 'min' ? 'm' : ''}`;
}

/** The 25 majmin families in btc_majmin label order: C, C:min, C#, C#:min, …, B:min, N. */
export const MAJMIN_FAMILIES: string[] = [...SHARP_ROOTS.flatMap((_, pc) => [`${pc}:maj`, `${pc}:min`]), 'N'];

/** Index of a BTC majmin-model label ("C#:min", "C", "N") in MAJMIN_FAMILIES. */
export function majminLabelFamily(label: string): number {
  if (label === 'N') return MAJMIN_FAMILIES.length - 1;
  const [root, q = 'maj'] = label.split(':');
  if (PC[root] === undefined || (q !== 'maj' && q !== 'min')) throw new Error(`candidate decode: unexpected majmin label ${label}`);
  return MAJMIN_FAMILIES.indexOf(`${PC[root]}:${q}`);
}

/**
 * Maps frame probabilities over `from` classes onto `numTo` classes by `map` (−1 = dropped), summing.
 * No renormalisation (callers pass maps that keep every class).
 */
export function sumClasses(probs: Float32Array, frames: number, numFrom: number, map: Int32Array, numTo: number): Float32Array {
  const out = new Float32Array(frames * numTo);
  for (let f = 0; f < frames; f++) for (let c = 0; c < numFrom; c++) if (map[c] >= 0) out[f * numTo + map[c]] += probs[f * numFrom + c];
  return out;
}

// ---------------------------------------------------------------- C4 diatonic chords

// The tables and triad families of src/music/key.ts (copied: the extension bundles key.ts with its
// source in the source maps, and the packaged dist must stay byte-identical).
const MAJOR_STEPS = [0, 2, 4, 5, 7, 9, 11];
const MINOR_STEPS = [0, 2, 3, 5, 7, 8, 10];
const MAJOR_TRIADS: Chord['triad'][] = ['maj', 'min', 'min', 'maj', 'maj', 'min', 'dim'];
const MINOR_TRIADS: Chord['triad'][] = ['min', 'dim', 'maj', 'min', 'min', 'maj', 'maj'];

function triadFamily(c: Chord): 'maj' | 'min' | 'dim' | 'other' {
  if (c.triad === 'maj' || c.triad === 'aug' || c.triad === 'sus2' || c.triad === 'sus4' || c.triad === '5') return 'maj';
  if (c.triad === 'min') return 'min';
  if (c.triad === 'dim') return 'dim';
  return 'other';
}

/**
 * Whether a chord is diatonic to the key by the rule key.ts scoreKey counts as a fit: its root is a
 * scale degree and its triad family (maj / min / dim; sus and aug count as maj) is that degree's
 * diatonic triad; a minor key also accepts a major V. N and unparseable symbols are not diatonic.
 */
export function isDiatonicChord(symbol: string, key: Pick<KeyEstimate, 'tonic' | 'mode'>): boolean {
  if (isNoChord(symbol)) return false;
  let c: Chord;
  try {
    c = parseChord(symbol);
  } catch {
    return false;
  }
  const deg = (key.mode === 'major' ? MAJOR_STEPS : MINOR_STEPS).indexOf(mod12(c.root - key.tonic));
  if (deg < 0) return false;
  const fam = triadFamily(c);
  return (key.mode === 'major' ? MAJOR_TRIADS : MINOR_TRIADS)[deg] === fam || (key.mode === 'minor' && deg === 4 && fam === 'maj');
}

// C6 pitch shift (shiftCqt, rootRotation) lives in chords.ts, shared with the extension's Recognizer.
export { BINS_PER_SEMITONE, rootRotation, shiftCqt } from './chords';

// ---------------------------------------------------------------- C10 / C8 chroma

/**
 * CQT bins of the bass chroma: the two lowest octaves, bins 0-47 = C1 (32.7 Hz) up to a quarter tone
 * above B2 (≈ 127 Hz), where bass fundamentals lie.
 */
export const BASS_BINS: [number, number] = [0, 48];
/** All bins, for the beat chroma of C8. */
export const ALL_BINS: [number, number] = [0, CQT.nBins];

/**
 * 12-bin chroma of frames [f0, f1) over CQT bins [b0, b1): linear magnitude exp(log-CQT) − eps summed by
 * pitch class (bin 0 = C1; even bins are semitones, odd bins are quarter tones split half/half between
 * their two neighbouring semitones).
 */
export function chroma(cqt: Float32Array, f0: number, f1: number, [b0, b1]: [number, number], nBins = CQT.nBins): Float64Array {
  const out = new Float64Array(12);
  for (let f = f0; f < f1; f++) {
    for (let k = b0; k < b1; k++) {
      const m = Math.max(0, Math.exp(cqt[f * nBins + k]) - CQT.logEps);
      const s = k / 2;
      if (k % 2 === 0) out[s % 12] += m;
      else {
        out[Math.floor(s) % 12] += m / 2;
        out[Math.ceil(s) % 12] += m / 2;
      }
    }
  }
  return out;
}

const argmax12 = (c: Float64Array): number => {
  let b = 0;
  for (let i = 1; i < 12; i++) if (c[i] > c[b]) b = i;
  return c[b] > 0 ? b : -1;
};

/**
 * C8 neighbours: for each unit, the indices of its k most similar units by cosine similarity of their
 * chroma (ties: lower index), excluding units within ±4 of itself. Fewer when fewer qualify.
 */
export function repetitionNeighbours(chromas: Float64Array[], k: number, exclude = 4): number[][] {
  const norm = chromas.map((c) => Math.sqrt(c.reduce((a, x) => a + x * x, 0)));
  return chromas.map((c, u) => {
    const sims: { j: number; s: number }[] = [];
    for (let j = 0; j < chromas.length; j++) {
      if (Math.abs(j - u) <= exclude) continue;
      let dot = 0;
      for (let i = 0; i < 12; i++) dot += c[i] * chromas[j][i];
      sims.push({ j, s: norm[u] > 0 && norm[j] > 0 ? dot / (norm[u] * norm[j]) : 0 });
    }
    sims.sort((a, b) => b.s - a.s || a.j - b.j);
    return sims.slice(0, k).map((x) => x.j);
  });
}

/** (1 − w)·own + w·mean(neighbours) per unit; units without neighbours stay. */
export function smoothVectors(v: Float32Array | Float64Array, U: number, K: number, nb: number[][], w: number): Float64Array {
  const out = Float64Array.from(v);
  for (let u = 0; u < U; u++) {
    if (!nb[u].length) continue;
    for (let j = 0; j < K; j++) {
      let m = 0;
      for (const n of nb[u]) m += v[n * K + j];
      out[u * K + j] = (1 - w) * v[u * K + j] + (w * m) / nb[u].length;
    }
  }
  return out;
}

/** Root pitch class and major/minor family of a class name ("G7" → 7, maj), null otherwise. */
function rootFamily(name: string): { root: number; fam: 'maj' | 'min' } | null {
  const f = familyOf(name);
  const m = /^(\d+):(maj|min)$/.exec(f);
  return m ? { root: Number(m[1]), fam: m[2] as 'maj' | 'min' } : null;
}

/**
 * C10 for one unit: the class to output, or −1 to keep the decoder's choice. Applies only when the
 * decoded class is one of the unit's top-2 classes, the two are fifth-related in the same family, their
 * mean probabilities are within margin, and the strongest bass pitch class is one of their roots.
 */
export function bassRootChoice(names: string[], avg: ArrayLike<number>, u: number, decoded: number, bass: Float64Array, margin: number): number {
  const K = names.length;
  let t1 = -1;
  let t2 = -1;
  for (let j = 0; j < K; j++) {
    const p = avg[u * K + j];
    if (t1 < 0 || p > avg[u * K + t1]) {
      t2 = t1;
      t1 = j;
    } else if (t2 < 0 || p > avg[u * K + t2]) t2 = j;
  }
  if (t2 < 0 || (decoded !== t1 && decoded !== t2)) return -1;
  if (avg[u * K + t1] - avg[u * K + t2] > margin) return -1;
  const a = rootFamily(names[t1]);
  const b = rootFamily(names[t2]);
  if (!a || !b || a.fam !== b.fam) return -1;
  const d = (((a.root - b.root) % 12) + 12) % 12;
  if (d !== 5 && d !== 7) return -1;
  const pc = argmax12(bass);
  if (pc === a.root) return t1;
  if (pc === b.root) return t2;
  return -1;
}

// ---------------------------------------------------------------- Decoding

/** Everything decodeCandidate needs for one segment (kept for the key-prior second pass and analyses). */
export interface CandidateDecodeInput {
  frames: number;
  frameSec: number;
  frameStartSec: number;
  /** Beat (or fixed) units before any split. */
  units: DecodeUnit[];
  /** Output vocabulary of the large model and its reduced frame probabilities [frames × symbols]. */
  symbols: string[];
  probs: Float32Array;
  /** btc_majmin frame probabilities in MAJMIN_FAMILIES order [frames × 25] (when the majmin model ran). */
  majminProbs?: Float32Array;
  /** Log-CQT frames [frames × CQT.nBins] (unshifted), for C10 bass chroma and C8 beat chroma. */
  cqt?: Float32Array;
}

export interface CandidateUnit extends DecodeUnit {
  /** Mid-unit half created by units.halfBeat (its start costs other-beat + offbeatExtraPenalty). */
  offbeat?: boolean;
}

/** Units for decoding: the input units, or each split in two (U). */
export function candidateUnits(units: DecodeUnit[], half?: HalfBeatOptions): CandidateUnit[] {
  if (!half?.halfBeat) return units;
  const out: CandidateUnit[] = [];
  for (const u of units) {
    const mid = (u.startSec + u.endSec) / 2;
    out.push({ startSec: u.startSec, endSec: mid, strength: u.strength });
    out.push({ startSec: mid, endSec: u.endSec, strength: 2, offbeat: true });
  }
  return out;
}

/** Penalty of a change at the start of each unit (index 0 unused). */
export function unitPenalties(units: CandidateUnit[], changePenalty: DecodeOptions['changePenalty'], half?: HalfBeatOptions, scale = 1): Float64Array {
  return Float64Array.from(units, (u) => (changePenalty[u.strength] + (u.offbeat ? (half?.offbeatExtraPenalty ?? 0) : 0)) * scale);
}

/** Frame range [f0, f1) of a unit, exactly as decodeUnits computes it. */
export function unitFrames(u: { startSec: number; endSec: number }, frames: number, frameSec: number, frameStartSec: number): [number, number] {
  let f0 = Math.round((u.startSec - frameStartSec) / frameSec);
  let f1 = Math.round((u.endSec - frameStartSec) / frameSec);
  f0 = Math.max(0, Math.min(frames - 1, f0));
  f1 = Math.max(f0 + 1, Math.min(frames, f1));
  return [f0, f1];
}

/** Per-unit mean frame probabilities [U × K] (same accumulation order as decodeUnits). */
export function unitMeans(probs: Float32Array, frames: number, K: number, frameSec: number, frameStartSec: number, units: { startSec: number; endSec: number }[]): Float32Array {
  const avg = new Float32Array(units.length * K);
  for (let u = 0; u < units.length; u++) {
    const [f0, f1] = unitFrames(units[u], frames, frameSec, frameStartSec);
    for (let f = f0; f < f1; f++) for (let j = 0; j < K; j++) avg[u * K + j] += probs[f * K + j];
    for (let j = 0; j < K; j++) avg[u * K + j] /= f1 - f0;
  }
  return avg;
}

/** Decode classes: their frame probabilities, the output symbols that belong to each, and a name for priors. */
export interface ClassSpace {
  kind: 'symbols' | 'families' | 'majmin';
  /** Symbol for N-prior / key-prior purposes ("C", "Cm", "Csus4", "N"). */
  names: string[];
  probs: Float32Array;
  /** Indices into input.symbols that a decoded class may output. */
  members: number[][];
}

/** The classes the Viterbi runs over for these options. */
export function classSpace(input: CandidateDecodeInput, opts: CandidateRecognizerOptions): ClassSpace {
  const { symbols, probs, frames } = input;
  const S = symbols.length;
  if (opts.majmin) {
    if (!input.majminProbs) throw new Error('candidate decode: majmin option set but the majmin model did not run');
    const famIdx = new Map(MAJMIN_FAMILIES.map((f, i) => [f, i]));
    const members = MAJMIN_FAMILIES.map(() => [] as number[]);
    symbols.forEach((s, j) => {
      const f = famIdx.get(familyOf(s));
      if (f !== undefined) members[f].push(j);
    });
    members.forEach((m, i) => {
      if (!m.length) throw new Error(`candidate decode: family ${MAJMIN_FAMILIES[i]} has no member symbol in this vocabulary`);
    });
    let cls = input.majminProbs;
    if (opts.majmin === 'average') {
      const large = sumClasses(probs, frames, S, largeToMajmin(symbols), MAJMIN_FAMILIES.length);
      cls = new Float32Array(cls.length);
      for (let i = 0; i < cls.length; i++) cls[i] = 0.5 * (input.majminProbs[i] + large[i]);
    }
    return { kind: 'majmin', names: MAJMIN_FAMILIES.map(familySymbol), probs: cls, members };
  }
  if (opts.decode?.familyFirst) {
    const keys: string[] = [];
    const members: number[][] = [];
    const map = new Int32Array(S);
    symbols.forEach((s, j) => {
      const k = familyOf(s);
      let i = keys.indexOf(k);
      if (i < 0) {
        i = keys.length;
        keys.push(k);
        members.push([]);
      }
      members[i].push(j);
      map[j] = i;
    });
    return { kind: 'families', names: keys.map(familySymbol), probs: sumClasses(probs, frames, S, map, keys.length), members };
  }
  return { kind: 'symbols', names: symbols, probs, members: symbols.map((_, j) => [j]) };
}

/**
 * The large model's output symbols collapsed onto MAJMIN_FAMILIES by the repository's majmin
 * vocabulary rule (buildVocabulary 'majmin': min / m6 / m7 / m(maj7) / dim / dim7 / m7b5 → minor,
 * everything else → major).
 */
export function largeToMajmin(symbols: string[]): Int32Array {
  return Int32Array.from(symbols, (s) => {
    const p = splitSymbol(s);
    if (!p) return MAJMIN_FAMILIES.length - 1;
    const minor = ['m', 'm6', 'm7', 'm(maj7)', 'dim', 'dim7', 'm7b5'].includes(p.suffix);
    return 2 * p.root + (minor ? 1 : 0);
  });
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
};

/** Per-unit log emissions [U × K] with the emission mode, the N prior and the key prior applied. */
export function emissions(space: ClassSpace, input: CandidateDecodeInput, units: CandidateUnit[], avg: Float32Array | Float64Array, opts: CandidateRecognizerOptions, key: KeyEstimate | null, neighbours: number[][] | null = null): Float64Array {
  const K = space.names.length;
  const U = units.length;
  const e = new Float64Array(U * K);
  if (opts.emission === 'meanLog') {
    for (let u = 0; u < U; u++) {
      const [f0, f1] = unitFrames(units[u], input.frames, input.frameSec, input.frameStartSec);
      for (let f = f0; f < f1; f++) for (let j = 0; j < K; j++) e[u * K + j] += Math.log(space.probs[f * K + j] + 1e-9);
      for (let j = 0; j < K; j++) e[u * K + j] /= f1 - f0;
    }
    if (neighbours && opts.repetition) {
      // C8 with meanLog: smooth the per-unit geometric-mean probabilities, then back to logs.
      const g = smoothVectors(e.map(Math.exp), U, K, neighbours, opts.repetition.weight);
      for (let i = 0; i < U * K; i++) e[i] = Math.log(g[i]);
    }
  } else {
    for (let i = 0; i < U * K; i++) e[i] = Math.log(avg[i] + 1e-9);
    if (opts.emission === 'durationWeighted') {
      const med = median(units.map((u) => u.endSec - u.startSec));
      if (med > 0) for (let u = 0; u < U; u++) for (let j = 0; j < K; j++) e[u * K + j] *= (units[u].endSec - units[u].startSec) / med;
    }
  }
  if (opts.nLogPrior !== undefined) {
    const n = space.names.indexOf('N');
    if (n >= 0) for (let u = 0; u < U; u++) e[u * K + n] += opts.nLogPrior;
  }
  if (opts.keyPrior && key) {
    const diatonic = space.names.map((s) => isDiatonicChord(s, key));
    for (let u = 0; u < U; u++) {
      let p1 = -Infinity;
      let p2 = -Infinity;
      for (let j = 0; j < K; j++) {
        const p = avg[u * K + j];
        if (p > p1) {
          p2 = p1;
          p1 = p;
        } else if (p > p2) p2 = p;
      }
      if (p1 - p2 <= opts.keyPrior.margin) for (let j = 0; j < K; j++) if (diatonic[j]) e[u * K + j] += opts.keyPrior.bonus;
    }
  }
  return e;
}

/** Best class sequence: the same recursion and tie-breaking as decodeUnits. */
export function viterbi(e: Float64Array, U: number, K: number, pen: Float64Array): Int32Array {
  const path = new Int32Array(U);
  if (!U) return path;
  let score = new Float64Array(K);
  const back = new Int32Array(U * K);
  for (let j = 0; j < K; j++) score[j] = e[j];
  for (let u = 1; u < U; u++) {
    let best = 0;
    for (let j = 1; j < K; j++) if (score[j] > score[best]) best = j;
    const next = new Float64Array(K);
    for (let j = 0; j < K; j++) {
      const stay = score[j];
      const move = score[best] - pen[u];
      if (stay >= move || best === j) {
        next[j] = stay + e[u * K + j];
        back[u * K + j] = j;
      } else {
        next[j] = move + e[u * K + j];
        back[u * K + j] = best;
      }
    }
    score = next;
  }
  let j = 0;
  for (let k = 1; k < K; k++) if (score[k] > score[j]) j = k;
  for (let u = U - 1; u >= 0; u--) {
    path[u] = j;
    j = back[u * K + j];
  }
  return path;
}

/**
 * Decodes one segment with the candidate options. With no option set this equals
 * decodeUnits(probs, …, units, symbols, DEFAULT_DECODE). Family classes (C1, C5) output, per maximal
 * run of one family, the member symbol with the highest mean probability over that run's frames.
 */
export function decodeCandidate(input: CandidateDecodeInput, opts: CandidateRecognizerOptions, key: KeyEstimate | null = null): DecodedUnit[] {
  const units = candidateUnits(input.units, opts.units);
  const U = units.length;
  if (!U) return [];
  const space = classSpace(input, opts);
  const K = space.names.length;
  let avg: Float32Array | Float64Array = unitMeans(space.probs, input.frames, K, input.frameSec, input.frameStartSec, units);
  const unitChroma = (bins: [number, number]) => {
    if (!input.cqt) throw new Error('candidate decode: bassRoot / repetition need the log-CQT frames');
    return units.map((u) => chroma(input.cqt!, ...unitFrames(u, input.frames, input.frameSec, input.frameStartSec), bins));
  };
  let neighbours: number[][] | null = null;
  if (opts.repetition) {
    neighbours = repetitionNeighbours(unitChroma(ALL_BINS), opts.repetition.k);
    avg = smoothVectors(avg, U, K, neighbours, opts.repetition.weight);
  }
  const e = emissions(space, input, units, avg, opts, key, neighbours);
  const scale = space.kind === 'symbols' ? 1 : (opts.decode?.familyFirst?.penaltyScale ?? 1);
  const pen = unitPenalties(units, opts.decode?.changePenalty ?? DEFAULT_DECODE.changePenalty, opts.units, scale);
  const path = viterbi(e, U, K, pen);
  const out = space.kind === 'symbols' ? units.map((u, i) => ({ startSec: u.startSec, endSec: u.endSec, strength: u.strength, symbol: input.symbols[path[i]], confidence: avg[i * K + path[i]] })) : familyOutput(input, space, units, path);
  if (opts.bassRoot) {
    const bass = unitChroma(BASS_BINS);
    const S = input.symbols.length;
    const symAvg = unitMeans(input.probs, input.frames, S, input.frameSec, input.frameStartSec, units);
    for (let u = 0; u < U; u++) {
      const c = bassRootChoice(space.names, avg, u, path[u], bass[u], opts.bassRoot.margin);
      if (c < 0 || c === path[u]) continue;
      let pick = space.members[c][0];
      for (const j of space.members[c]) if (symAvg[u * S + j] > symAvg[u * S + pick]) pick = j;
      out[u] = { ...out[u], symbol: input.symbols[pick], confidence: symAvg[u * S + pick] };
    }
  }
  return out;
}

/** Family classes (C1, C5): per maximal run of one class, the member with the highest mean probability over the run's frames. */
function familyOutput(input: CandidateDecodeInput, space: ClassSpace, units: CandidateUnit[], path: Int32Array): DecodedUnit[] {
  const U = units.length;

  const S = input.symbols.length;
  const symAvg = unitMeans(input.probs, input.frames, S, input.frameSec, input.frameStartSec, units);
  const nFrames = units.map((u) => {
    const [f0, f1] = unitFrames(u, input.frames, input.frameSec, input.frameStartSec);
    return f1 - f0;
  });
  const out: DecodedUnit[] = [];
  for (let a = 0; a < U; ) {
    let b = a + 1;
    while (b < U && path[b] === path[a]) b++;
    let pick = -1;
    let pickMean = -Infinity;
    for (const j of space.members[path[a]]) {
      let s = 0;
      let n = 0;
      for (let u = a; u < b; u++) {
        s += symAvg[u * S + j] * nFrames[u];
        n += nFrames[u];
      }
      if (s / n > pickMean) {
        pickMean = s / n;
        pick = j;
      }
    }
    for (let u = a; u < b; u++) out.push({ startSec: units[u].startSec, endSec: units[u].endSec, strength: units[u].strength, symbol: input.symbols[pick], confidence: symAvg[u * S + pick] });
    a = b;
  }
  return out;
}
