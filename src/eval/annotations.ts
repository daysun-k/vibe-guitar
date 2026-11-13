/**
 * Accuracy of auto charts against public, time-aligned chord annotations (Isophonics,
 * McGill Billboard): Harte label mapping, annotation parsing, alignment from landmarks
 * that do not use chord predictions, and scoring with the repository's comparison code
 * (compareCharts: overlap, majmin / root / sevenths WCSR).
 *
 * Time convention: media time (the upload's playback time) = annotation time + offsetSec.
 */
import { parseChord } from '../arrange/chord';
import type { Chart, CoverageRange } from '../chart/types';
import { normalizeCoverage } from '../chart/coverage';
import { chordChangeOffset, compareCharts, median, type ChartComparison } from './metrics';

// ---------------------------------------------------------------- Harte labels

/** Result of mapping one annotation label to a chart chord symbol. */
export type MappedLabel =
  | { kind: 'chord'; symbol: string }
  | { kind: 'N' }
  | { kind: 'X' }
  | { kind: 'unmapped'; reason: string };

const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;
const LETTER_PC: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const SCALE = [0, 2, 4, 5, 7, 9, 11];

/** Harte shorthands as degree lists (the root, degree 1, is implicit). */
const SHORTHAND: Record<string, string[]> = {
  maj: ['3', '5'],
  min: ['b3', '5'],
  dim: ['b3', 'b5'],
  aug: ['3', '#5'],
  maj7: ['3', '5', '7'],
  min7: ['b3', '5', 'b7'],
  '7': ['3', '5', 'b7'],
  dim7: ['b3', 'b5', 'bb7'],
  hdim7: ['b3', 'b5', 'b7'],
  minmaj7: ['b3', '5', '7'],
  maj6: ['3', '5', '6'],
  min6: ['b3', '5', '6'],
  '9': ['3', '5', 'b7', '9'],
  maj9: ['3', '5', '7', '9'],
  min9: ['b3', '5', 'b7', '9'],
  '11': ['3', '5', 'b7', '9', '11'],
  min11: ['b3', '5', 'b7', '9', '11'],
  '13': ['3', '5', 'b7', '9', '11', '13'],
  maj13: ['3', '5', '7', '9', '11', '13'],
  min13: ['b3', '5', 'b7', '9', '11', '13'],
  sus2: ['2', '5'],
  sus4: ['4', '5'],
  '5': ['5'],
  '1': [],
};

const mod12 = (n: number) => ((n % 12) + 12) % 12;

/** "b3" → 3, "#11" → 18, "bb7" → 9; null when malformed. */
export function degreeSemitones(token: string): number | null {
  const m = /^([b#]*)(\d+)$/.exec(token.trim());
  if (!m) return null;
  const n = Number(m[2]);
  if (n < 1 || n > 15) return null;
  const base = SCALE[(n - 1) % 7] + 12 * Math.floor((n - 1) / 7);
  let shift = 0;
  for (const c of m[1]) shift += c === '#' ? 1 : -1;
  return base + shift;
}

function rootPc(text: string): number | null {
  const m = /^([A-G])([b#]*)$/.exec(text);
  if (!m) return null;
  let pc = LETTER_PC[m[1]];
  for (const c of m[2]) pc += c === '#' ? 1 : -1;
  return mod12(pc);
}

const HARTE_RE = /^([A-G][b#]*)(?::([A-Za-z0-9]*)(?:\(([^)]*)\))?)?(?:\/([b#]*\d+))?$/;

type Triad = 'maj' | 'min' | 'dim' | 'aug' | 'sus2' | 'sus4' | 'root';

/**
 * Maps a Harte label ("C:maj7/3", "Bb:sus4(b7,9)", "N", "X") to a chord symbol the
 * repository parses, at concert pitch with sharp spelling (Db and C# both become "C#").
 * The label becomes a set of pitch classes above the root, which is classified into
 * triad, seventh/sixth, natural extension, added tones and alterations. Labels without a
 * third or a sus tone (power chords "C:5", single notes "C:(1)", "C:min(*b3)") become
 * "C5": root-only, so they count for the root reduction and are excluded from majmin and
 * sevenths, as in mir_eval. The bass (inversion) is kept on the symbol; the reductions
 * ignore it.
 */
export function harteToSymbol(label: string): MappedLabel {
  const text = label.trim();
  if (text === 'N') return { kind: 'N' };
  if (text === 'X') return { kind: 'X' };
  const m = HARTE_RE.exec(text);
  if (!m) return { kind: 'unmapped', reason: `not Harte syntax: ${text}` };
  const root = rootPc(m[1]);
  if (root === null) return { kind: 'unmapped', reason: `bad root: ${m[1]}` };
  const shorthand = m[2];
  const list = m[3];
  let tokens: string[];
  if (shorthand) {
    const base = SHORTHAND[shorthand];
    if (!base) return { kind: 'unmapped', reason: `unknown shorthand: ${shorthand}` };
    tokens = [...base];
  } else tokens = list === undefined ? [...SHORTHAND.maj] : [];
  const semis = new Set<number>();
  for (const t of tokens) semis.add(mod12(degreeSemitones(t)!));
  for (const raw of (list ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const remove = raw.startsWith('*');
    const d = degreeSemitones(remove ? raw.slice(1) : raw);
    if (d === null) return { kind: 'unmapped', reason: `bad degree: ${raw}` };
    if (remove) semis.delete(mod12(d));
    else semis.add(mod12(d));
  }
  semis.delete(0);
  let bass: number | null = null;
  if (m[4]) {
    const d = degreeSemitones(m[4]);
    if (d === null) return { kind: 'unmapped', reason: `bad bass: ${m[4]}` };
    bass = mod12(root + d);
  }
  const symbol = buildSymbol(root, semis, bass);
  if (symbol === null) return { kind: 'unmapped', reason: `no chart symbol for ${text}` };
  try {
    parseChord(symbol);
  } catch {
    return { kind: 'unmapped', reason: `chart symbol does not parse: ${symbol}` };
  }
  return { kind: 'chord', symbol };
}

function buildSymbol(root: number, s: Set<number>, bass: number | null): string | null {
  const has = (n: number) => s.has(n);
  const maj3 = has(4);
  const min3 = has(3) && !maj3;
  const p5 = has(7);
  let triad: Triad;
  const alts: string[] = [];
  if (maj3) {
    if (has(8) && !p5) triad = 'aug';
    else {
      triad = 'maj';
      if (has(6) && !p5) alts.push('b5');
    }
  } else if (min3) {
    if (has(6) && !p5) triad = 'dim';
    else {
      triad = 'min';
      if (has(8) && !p5 && !has(6)) alts.push('#5');
    }
  } else if (has(5)) triad = 'sus4';
  else if (has(2)) triad = 'sus2';
  else triad = 'root';

  const name = (pc: number) => SHARP_NAMES[mod12(pc)];
  const slash = bass === null || bass === root ? '' : `/${name(bass)}`;
  if (triad === 'root') return `${name(root)}5${slash}`;

  let seventh: 'maj7' | 'b7' | 'dim7' | '6' | 'none' = 'none';
  if (has(11)) seventh = 'maj7';
  else if (has(10)) seventh = 'b7';
  else if (has(9)) seventh = triad === 'dim' ? 'dim7' : '6';

  const n9 = has(2) && triad !== 'sus2';
  const n11 = has(5) && triad !== 'sus4';
  const n13 = has(9) && (seventh === 'maj7' || seventh === 'b7');
  if (has(1)) alts.push('b9');
  if (has(3) && maj3) alts.push('#9');
  if (has(6) && p5) alts.push('#11');
  if (has(8) && triad !== 'aug' && !alts.includes('#5')) alts.push('b13');

  const tq = { maj: '', min: 'm', dim: 'dim', aug: 'aug', sus2: '', sus4: '' }[triad];
  const ext = n13 ? 13 : n11 ? 11 : n9 ? 9 : null;
  const adds: string[] = [];
  let body: string;
  switch (seventh) {
    case 'maj7':
      if (triad === 'dim') return null;
      body = triad === 'min' ? `m(maj${ext ?? 7})` : triad === 'aug' ? `augmaj${ext ?? 7}` : `maj${ext ?? 7}`;
      break;
    case 'b7':
      body = triad === 'dim' ? 'm7b5' : `${tq}${ext ?? 7}`;
      break;
    case 'dim7':
      body = 'dim7';
      break;
    case '6':
      body = `${tq}${n9 ? '69' : '6'}`;
      if (n11) adds.push('add11');
      break;
    default:
      body = tq;
      if (n9) adds.push('add9');
      if (n11) adds.push('add11');
  }
  if (triad === 'sus2' || triad === 'sus4') body += triad;
  const paren = [...adds, ...alts];
  return `${name(root)}${body}${paren.length ? `(${paren.join(',')})` : ''}${slash}`;
}

/** The symbol without its slash bass ("C/E" → "C"); N and X unchanged. */
export function withoutBass(symbol: string): string {
  const i = symbol.lastIndexOf('/');
  return i > 0 && /^[A-G]/.test(symbol.slice(i + 1)) ? symbol.slice(0, i) : symbol;
}

// ---------------------------------------------------------------- Annotation files

export interface AnnotationSegment {
  startSec: number;
  endSec: number;
  label: string;
}

/**
 * "start end label" per line (spaces or tabs); blank lines ignored. Throws on a line that is
 * not numeric; skips segments that end at or before their start (one Billboard file has one).
 */
export function parseLab(text: string): AnnotationSegment[] {
  const out: AnnotationSegment[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    if (!line.trim()) return;
    const parts = line.trim().split(/\s+/);
    const start = Number(parts[0]);
    const end = Number(parts[1]);
    const label = parts.slice(2).join(' ');
    if (!Number.isFinite(start) || !Number.isFinite(end) || !label) throw new Error(`lab line ${i + 1}: "${line}"`);
    if (end > start) out.push({ startSec: start, endSec: end, label });
  });
  return out.sort((a, b) => a.startSec - b.startSec);
}

export interface AnnotationBeat {
  sec: number;
  /** Position in the bar when the file gives one (1 = downbeat). */
  position: number | null;
}

/** Isophonics beat files: "time position" per line; lines that are not numeric are skipped. */
export function parseBeats(text: string): AnnotationBeat[] {
  const out: AnnotationBeat[] = [];
  for (const line of text.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    const sec = Number(parts[0]);
    if (!parts[0] || !Number.isFinite(sec)) continue;
    const pos = parts[1] !== undefined && /^\d+$/.test(parts[1]) ? Number(parts[1]) : null;
    out.push({ sec, position: pos });
  }
  return out.sort((a, b) => a.sec - b.sec);
}

/** Track length implied by the lab file (end of the last segment, usually a trailing N). */
export const labDuration = (segs: AnnotationSegment[]) => segs.reduce((m, s) => Math.max(m, s.endSec), 0);

/** Start of the first and end of the last segment that is not N (null if all N). */
export function chordSpan(segs: AnnotationSegment[]): { fromSec: number; toSec: number } | null {
  const chords = segs.filter((s) => s.label.trim() !== 'N');
  if (!chords.length) return null;
  return { fromSec: chords[0].startSec, toSec: Math.max(...chords.map((s) => s.endSec)) };
}

/** Starts of chord segments whose label differs from the previous segment's (N excluded). */
export function chordChangeLandmarks(segs: AnnotationSegment[]): number[] {
  const out: number[] = [];
  let prev = '';
  for (const s of segs) {
    const l = s.label.trim();
    if (l !== 'N' && l !== 'X' && l !== prev) out.push(s.startSec);
    prev = l;
  }
  return out;
}

// ---------------------------------------------------------------- Alignment

export type AlignMethod = 'beats' | 'chord-boundaries';

export interface AlignOptions {
  /** Offsets searched: [-maxShiftSec, +maxShiftSec]. */
  maxShiftSec: number;
  stepSec: number;
  /** A landmark matches when an estimate beat lies within ±tolSec. */
  tolSec: number;
  /** Offsets scoring at least this fraction of the best score are candidates. */
  tieRatio: number;
  /** Bar-phase score margin needed to prefer one candidate over another. */
  barMargin: number;
  /** A candidate offset this close to 0 is taken without consulting bar phase. */
  nearZeroSec: number;
  /** Local offsets (start / middle / end) may differ by at most this much. */
  driftLimitSec: number;
  /** Upload and annotation lengths may differ by at most this much. */
  durationLimitSec: number;
  /** Minimum share of landmarks matched overall and in each third. */
  minMatchFraction: number;
}

export const ALIGN_DEFAULTS: Record<AlignMethod, AlignOptions> = {
  beats: { maxShiftSec: 2, stepSec: 0.005, tolSec: 0.07, tieRatio: 0.95, barMargin: 0.15, nearZeroSec: 0.2, driftLimitSec: 0.1, durationLimitSec: 2, minMatchFraction: 0.5 },
  'chord-boundaries': { maxShiftSec: 2, stepSec: 0.005, tolSec: 0.1, tieRatio: 0.95, barMargin: 0.15, nearZeroSec: 0.2, driftLimitSec: 0.1, durationLimitSec: 2, minMatchFraction: 0.3 },
};

export interface AlignInput {
  method: AlignMethod;
  /** Annotation times used to align: beats, or chord-change starts. */
  landmarks: number[];
  /** Annotation times expected on downbeats (beats with position 1, or chord changes). */
  downbeatLandmarks: number[];
  annotationDurationSec: number;
  chordSpan: { fromSec: number; toSec: number } | null;
  /** The auto chart's Beat This! beat times (media time). */
  estimateBeats: number[];
  estimateFirstDownbeatSec: number | null;
  estimateBeatsPerBar: number | null;
  /** Upload length; null when unknown. */
  mediaDurationSec: number | null;
}

export interface AlignSegmentCheck {
  part: 'start' | 'middle' | 'end';
  fromSec: number;
  toSec: number;
  landmarks: number;
  matched: number;
  /** Local offset (the time map's offset in this third + median residual), null when nothing matched. */
  offsetSec: number | null;
}

export interface AlignCandidate {
  /** Media − annotation time at annotation time 0 (the lead-in difference). */
  offsetSec: number;
  /** Media seconds per annotation second; 1 unless a fitted speed difference passed the held-out test. */
  rate: number;
  matchedFraction: number;
  /** Share of downbeat landmarks on an estimated downbeat; null when not computable. */
  barScore: number | null;
}

/** Held-out test of a fitted rate (see alignAnnotation); null when no rate other than 1 was tried. */
export interface RateFit {
  /** Best rate fitted on all landmarks for the chosen beat phase. */
  rate: number;
  /** Pooled held-out gain over rate 1 (share of landmarks on a beat). */
  heldOutGain: number;
  /** Pooled held-out share of landmarks on a beat with the fitted rate. */
  heldOutMatched: number;
  /** Share a landmark at a random time would reach (2 × tolerance / estimate beat period, at most 1). */
  chanceMatched: number;
  /** Held-out gain per temporal third (start, middle, end). */
  thirdGains: number[];
  accepted: boolean;
}

export type ExclusionCode = 'no-estimate-beats' | 'too-few-landmarks' | 'duration-mismatch' | 'landmarks-disagree' | 'drift' | 'ambiguous';

export interface Alignment {
  method: AlignMethod;
  strength: 'strong' | 'weak';
  /** Time map: media = offsetSec + rate × annotation time. */
  offsetSec: number;
  rate: number;
  rateFit: RateFit | null;
  matchedFraction: number;
  landmarks: number;
  /** Near-tie offsets (usually one beat apart); the chosen one is first. */
  candidates: AlignCandidate[];
  /** True when more than one candidate survives the near-0 rule and bar phase; such songs are excluded. */
  ambiguous: boolean;
  segments: AlignSegmentCheck[];
  driftSec: number | null;
  /** Coarse check: first estimate beat − first chord, last estimate beat − last chord end. */
  coarse: { startOffsetSec: number | null; endOffsetSec: number | null };
  /** Upload length − annotation length; null when the upload length is unknown. */
  durationDiffSec: number | null;
  warnings: string[];
  excluded: { code: ExclusionCode; reason: string } | null;
}

function lowerBound(xs: number[], t: number): number {
  let lo = 0;
  let hi = xs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Signed distance from t to the nearest element of sorted xs (Infinity if empty). */
export function nearestResidual(xs: number[], t: number): number {
  const i = lowerBound(xs, t);
  let best = Infinity;
  for (const j of [i - 1, i]) if (j >= 0 && j < xs.length && Math.abs(xs[j] - t) < Math.abs(best)) best = xs[j] - t;
  return best;
}

function matchedResiduals(landmarks: number[], beats: number[], offset: number, tol: number): number[] {
  const out: number[] = [];
  for (const l of landmarks) {
    const r = nearestResidual(beats, l + offset);
    if (Math.abs(r) <= tol + 1e-9) out.push(r);
  }
  return out;
}

/**
 * Playback-rate check. An upload a little faster or slower than the annotated recording drifts
 * by whole beats across the song, and matching each landmark to its nearest beat hides that
 * (with beats every half second, some beat is always close). Searching many time scales would
 * overfit sparse or noisy landmarks, so only one hypothesis is tested, taken from independent
 * evidence: the length ratio of the upload to the annotated recording. The landmark times are
 * scaled by that ratio about the first landmark, the best offset is taken for it and for scale 1,
 * and the scale wins only when it puts clearly more landmarks on beats.
 */
export function rateCheck(landmarks: number[], beats: number[], o: AlignOptions, scale: number): { scale: number; matchedFraction: number; matchedAtOne: number } {
  const steps = Math.round(o.maxShiftSec / o.stepSec);
  const t0 = landmarks[0];
  const bestAt = (rate: number) => {
    const scaled = landmarks.map((l) => t0 + (l - t0) * rate);
    let best = 0;
    for (let k = -steps; k <= steps; k++) best = Math.max(best, matchedResiduals(scaled, beats, k * o.stepSec, o.tolSec).length);
    return best / landmarks.length;
  };
  return { scale, matchedFraction: bestAt(scale), matchedAtOne: bestAt(1) };
}

/** How much more of the landmarks (fraction on beats) the length-ratio scale must fit than 1. */
export const RATE_WIN_MARGIN = 0.15;
/**
 * Guards against chance fits on sparse or noisy boundaries: the test runs only with enough
 * landmarks, and the scaled landmarks must mostly fall on beats, as a real speed change makes them.
 */
export const RATE_MIN_LANDMARKS = 30;
export const RATE_MIN_FRACTION = 0.8;

/** Downbeats implied by the first downbeat and a fixed bar length, or null. */
export function impliedDownbeats(beats: number[], firstDownbeatSec: number | null, beatsPerBar: number | null): number[] | null {
  if (firstDownbeatSec === null || !beatsPerBar || beatsPerBar < 2 || !beats.length) return null;
  const k0 = lowerBound(beats, firstDownbeatSec - 0.05);
  if (k0 >= beats.length || Math.abs(beats[k0] - firstDownbeatSec) > 0.05) return null;
  return beats.filter((_, k) => (((k - k0) % beatsPerBar) + beatsPerBar) % beatsPerBar === 0);
}

/**
 * Bound on a fitted speed difference between the annotated recording and the upload: a declared
 * evaluation tolerance for transfer-level differences (0.2% ≈ 3.5 cents). PR #25's 1% case is far
 * outside it and stays excluded.
 */
export const RATE_FIT_MAX = 0.002;
/** A fitted rate is tested on this many contiguous temporal folds, each held out once. */
export const RATE_FIT_FOLDS = 5;
/** Pooled held-out gain (share of landmarks on a beat) a fitted rate needs over rate 1. */
export const RATE_FIT_MIN_GAIN = 0.05;

/** Media time of annotation time t under a time map given at pivot p: t + c + (r − 1)(t − p). */
const mapAt = (t: number, c: number, r: number, p: number) => t + c + (r - 1) * (t - p);

function mappedResiduals(landmarks: number[], beats: number[], c: number, r: number, p: number, tol: number): number[] {
  const out: number[] = [];
  for (const l of landmarks) {
    const res = nearestResidual(beats, mapAt(l, c, r, p));
    if (Math.abs(res) <= tol + 1e-9) out.push(res);
  }
  return out;
}

function countMapped(landmarks: number[], beats: number[], c: number, r: number, p: number, tol: number): number {
  let n = 0;
  for (const l of landmarks) if (Math.abs(nearestResidual(beats, mapAt(l, c, r, p))) <= tol + 1e-9) n++;
  return n;
}

/**
 * Rates searched: 1 first, then outward to ±RATE_FIT_MAX (both bounds included), with a step whose
 * largest movement at either end of the landmark span (half-span from the pivot) is tolSec / 2.
 */
export function rateGrid(halfSpanSec: number, tolSec: number): number[] {
  if (!(halfSpanSec > 0) || !(tolSec > 0)) return [1];
  const step = tolSec / 2 / halfSpanSec;
  const k = Math.ceil(RATE_FIT_MAX / step - 1e-9);
  const out = [1];
  for (let i = 1; i <= k; i++) {
    const d = Math.min(RATE_FIT_MAX, i * step);
    out.push(1 + d, 1 - d);
  }
  return out;
}

interface MapFit {
  /** Offset at the pivot. */
  c: number;
  r: number;
  hits: number;
  /** Sum of squared residuals of the landmarks on a beat. */
  sse: number;
}

/**
 * Best (offset at pivot, rate) over the given grids: most landmarks on a beat, then the smallest
 * sum of squared residuals among them (a tolerance plateau does not decide the map), then the rate
 * nearest 1 and the offset nearest `center`.
 */
function bestFit(landmarks: number[], beats: number[], p: number, tol: number, cs: number[], rates: number[], center: number): MapFit {
  let best: MapFit = { c: center, r: 1, hits: -1, sse: Infinity };
  for (const r of rates)
    for (const c of cs) {
      let hits = 0;
      let sse = 0;
      for (const l of landmarks) {
        const e = nearestResidual(beats, mapAt(l, c, r, p));
        if (Math.abs(e) <= tol + 1e-9) {
          hits++;
          sse += e * e;
        }
      }
      const better =
        hits > best.hits ||
        (hits === best.hits &&
          (sse < best.sse - 1e-12 ||
            (Math.abs(sse - best.sse) <= 1e-12 && (Math.abs(r - 1) < Math.abs(best.r - 1) - 1e-12 || (Math.abs(Math.abs(r - 1) - Math.abs(best.r - 1)) <= 1e-12 && Math.abs(c - center) < Math.abs(best.c - center))))));
      if (better) best = { c, r, hits, sse };
    }
  return best;
}

/**
 * Out-of-sample test of a fitted rate for the song: the landmarks are split into RATE_FIT_FOLDS
 * contiguous temporal folds; for each fold, the best rate-1 map and the best map over all rates
 * are fitted on the other folds (offsets limited to `cs`, one beat period wide) and both are
 * evaluated on the held-out fold. The rate passes only with a pooled held-out gain of at least
 * RATE_FIT_MIN_GAIN, pooled held-out matching of at least RATE_MIN_FRACTION above chance (the share
 * random landmarks would reach on this beat grid: dense beats make most landmarks "match"), and no
 * negative aggregate gain in any temporal third.
 */
function crossValidateRate(landmarks: number[], beats: number[], p: number, tol: number, cs: number[], rates: number[], center: number, rate: number, chance: number): RateFit {
  const n = landmarks.length;
  const first = landmarks[0];
  const span = landmarks[n - 1] - first;
  const gains = [0, 0, 0];
  let heldR = 0;
  let held1 = 0;
  for (let f = 0; f < RATE_FIT_FOLDS; f++) {
    const a = Math.floor((f * n) / RATE_FIT_FOLDS);
    const b = Math.floor(((f + 1) * n) / RATE_FIT_FOLDS);
    if (b <= a) continue;
    const train = [...landmarks.slice(0, a), ...landmarks.slice(b)];
    const fit1 = bestFit(train, beats, p, tol, cs, [1], center);
    const fitR = bestFit(train, beats, p, tol, cs, rates, center);
    for (let i = a; i < b; i++) {
      const t = landmarks[i];
      const h1 = Math.abs(nearestResidual(beats, mapAt(t, fit1.c, 1, p))) <= tol + 1e-9 ? 1 : 0;
      const hR = Math.abs(nearestResidual(beats, mapAt(t, fitR.c, fitR.r, p))) <= tol + 1e-9 ? 1 : 0;
      held1 += h1;
      heldR += hR;
      const third = span > 0 ? Math.min(2, Math.floor(((t - first) / span) * 3)) : 0;
      gains[third] += hR - h1;
    }
  }
  const heldOutGain = (heldR - held1) / n;
  const heldOutMatched = heldR / n;
  const thirdGains = gains.map((g) => g / n);
  const aboveChance = chance < 1 ? (heldOutMatched - chance) / (1 - chance) : 0;
  const accepted = heldOutGain >= RATE_FIT_MIN_GAIN - 1e-12 && aboveChance >= RATE_MIN_FRACTION - 1e-12 && gains.every((g) => g >= 0);
  return { rate, heldOutGain, heldOutMatched, chanceMatched: chance, thirdGains, accepted };
}

/**
 * The time map from landmarks that do not involve chord predictions: annotation beats (or
 * annotation chord changes) against the auto chart's Beat This! beats. The map is an offset plus a
 * bounded rate (media = offsetSec + rate × annotation time): the same recording on another transfer
 * can run slightly faster or slower, which a single offset turns into drift at the song's ends and
 * into a biased offset search. Offsets are scanned at the middle of the landmark span (so offset and
 * rate are decorrelated) together with rates up to ±RATE_FIT_MAX; a rate other than 1 is used only
 * with at least RATE_MIN_LANDMARKS landmarks, when it gains RATE_FIT_MIN_GAIN on all landmarks, and
 * when it passes one held-out test for the song (crossValidateRate). Beat phases are found at each
 * fixed rate; a rejected rate leaves exactly the rate-1 phases.
 *
 * Beats repeat, so maps one beat apart score almost the same; each such beat phase is a candidate.
 * A candidate within nearZeroSec of 0 (same master: little lead-in difference) is taken without
 * bar phase only when the nearest other candidate is more than 2 × nearZeroSec away; closer
 * spacing puts some candidate near 0 whatever the true offset. Otherwise bar phase (annotation
 * downbeats against downbeats implied by the chart's first downbeat and bar length) decides, and
 * when more than one candidate survives the song is ambiguous and excluded. The map is then
 * checked separately in the first, middle and last third of the song (residual drift after the
 * map), PR #25's length-ratio speed test runs unchanged, and the upload length is compared with
 * the annotation's.
 */
export function alignAnnotation(input: AlignInput, options?: Partial<AlignOptions>): Alignment {
  const o: AlignOptions = { ...ALIGN_DEFAULTS[input.method], ...options };
  const beats = [...input.estimateBeats].sort((a, b) => a - b);
  const landmarks = [...input.landmarks].sort((a, b) => a - b);
  const durationDiffSec = input.mediaDurationSec === null ? null : input.mediaDurationSec - input.annotationDurationSec;
  const coarse = {
    startOffsetSec: input.chordSpan && beats.length ? beats[0] - input.chordSpan.fromSec : null,
    endOffsetSec: input.chordSpan && beats.length ? beats[beats.length - 1] - input.chordSpan.toSec : null,
  };
  const base: Alignment = {
    method: input.method,
    strength: input.method === 'beats' ? 'strong' : 'weak',
    offsetSec: 0,
    rate: 1,
    rateFit: null,
    matchedFraction: 0,
    landmarks: landmarks.length,
    candidates: [],
    ambiguous: false,
    segments: [],
    driftSec: null,
    coarse,
    durationDiffSec,
    warnings: [],
    excluded: null,
  };
  if (beats.length < 8) return { ...base, excluded: { code: 'no-estimate-beats', reason: 'auto chart has fewer than 8 beat times' } };
  if (landmarks.length < 12) return { ...base, excluded: { code: 'too-few-landmarks', reason: `only ${landmarks.length} landmarks` } };

  const first = landmarks[0];
  const last = landmarks[landmarks.length - 1];
  const pivot = (first + last) / 2;
  const rates = landmarks.length >= RATE_MIN_LANDMARKS ? rateGrid((last - first) / 2, o.tolSec) : [1];

  // 1. Score every offset at the pivot for every rate. A beat phase is a run of near-best offsets
  // at one fixed rate: at rate 1 exactly as before rates were fitted, and at each other rate
  // relative to that rate's own best. (A maximum over rates would let rejected rate hypotheses
  // bridge phases that rate 1 keeps apart.)
  const steps = Math.round(o.maxShiftSec / o.stepSec);
  const cOf = (k: number) => (k - steps) * o.stepSec;
  const hitsBy = rates.map((r) => {
    const row: number[] = [];
    for (let k = 0; k <= 2 * steps; k++) row.push(countMapped(landmarks, beats, cOf(k), r, pivot, o.tolSec));
    return row;
  });
  const runsOf = (row: number[]): [number, number][] => {
    const threshold = Math.max(...row) * o.tieRatio;
    const out: [number, number][] = [];
    for (let i = 0; i < row.length; ) {
      if (row[i] < threshold) {
        i++;
        continue;
      }
      let j = i;
      while (j + 1 < row.length && row[j + 1] >= threshold) j++;
      out.push([i, j]);
      i = j + 1;
    }
    return out;
  };

  // 2. Candidates. Each rate-1 run gives a rate-1 map at the top of its plateau. Each beat phase
  // found at another rate is tried once: the best (offset, rate) in that run's window must gain
  // RATE_FIT_MIN_GAIN over the best rate-1 map in the same window on all landmarks and pass the
  // held-out test; an accepted map is a candidate, a rejected one adds nothing (the rate-1 runs
  // cover that phase). Offsets are then refined by the median residual.
  const down = impliedDownbeats(beats, input.estimateFirstDownbeatSec, input.estimateBeatsPerBar);
  const downLandmarks = [...input.downbeatLandmarks].sort((a, b) => a - b);
  const padSteps = Math.max(1, Math.round(o.tolSec / o.stepSec));
  type Built = AlignCandidate & { c: number; fit: RateFit | null; hits: number };
  const build = (c0: number, r0: number, fit: RateFit | null): Built => {
    let c = c0;
    let r = r0;
    if (r !== 1) {
      // Refine an accepted rate off the grid: least squares of the matched residuals on time.
      const pts = landmarks.map((t) => [t - pivot, nearestResidual(beats, mapAt(t, c, r, pivot))]).filter(([, e]) => Math.abs(e) <= o.tolSec + 1e-9);
      const n = pts.length;
      const mx = pts.reduce((sum, [x]) => sum + x, 0) / n;
      const my = pts.reduce((sum, [, y]) => sum + y, 0) / n;
      const sxx = pts.reduce((sum, [x]) => sum + (x - mx) ** 2, 0);
      if (n >= 2 && sxx > 0) {
        const slope = pts.reduce((sum, [x, y]) => sum + (x - mx) * (y - my), 0) / sxx;
        const r2 = Math.min(1 + RATE_FIT_MAX, Math.max(1 - RATE_FIT_MAX, r + slope));
        const c2 = c + my - slope * mx;
        if (countMapped(landmarks, beats, c2, r2, pivot, o.tolSec) >= countMapped(landmarks, beats, c, r, pivot, o.tolSec)) {
          c = c2;
          r = r2;
        }
      }
    }
    const res = mappedResiduals(landmarks, beats, c, r, pivot, o.tolSec);
    if (res.length) c += median(res);
    const hits = countMapped(landmarks, beats, c, r, pivot, o.tolSec);
    const offsetSec = c - (r - 1) * pivot;
    const barScore =
      down && downLandmarks.length >= 4 ? downLandmarks.filter((l) => Math.abs(nearestResidual(down, offsetSec + r * l)) <= o.tolSec + 1e-9).length / downLandmarks.length : null;
    return { offsetSec, rate: r, matchedFraction: hits / landmarks.length, barScore, c, fit, hits };
  };
  const built: Built[] = runsOf(hitsBy[0]).map(([i, j]) => {
    let top = i;
    for (let k = i; k <= j; k++) if (hitsBy[0][k] > hitsBy[0][top]) top = k;
    let topEnd = top;
    while (topEnd + 1 <= j && hitsBy[0][topEnd + 1] === hitsBy[0][top]) topEnd++;
    return build(cOf((top + topEnd) / 2), 1, null);
  });
  let songFit: RateFit | null = null;
  if (rates.length > 1) {
    // One held-out test per song: a speed difference belongs to the recording pair, not to a beat
    // phase, and one test keeps the chance of a false acceptance from growing with the number of
    // phases. Its offset window spans one estimate beat period (plus the tolerance) around the best
    // offset over all rates, so the fits on the training folds can take any beat phase and the
    // window does not carry the held-out folds' preferred phase into them.
    let kBest = 0;
    let top = -1;
    for (const row of hitsBy)
      for (let k = 0; k < row.length; k++)
        if (row[k] > top) {
          top = row[k];
          kBest = k;
        }
    const period = median(beats.slice(1).map((b, i) => b - beats[i]));
    const half = Math.round((period / 2 + o.tolSec) / o.stepSec);
    const window: number[] = [];
    for (let k = Math.max(0, kBest - half); k <= Math.min(2 * steps, kBest + half); k++) window.push(cOf(k));
    const center = cOf(kBest);
    const full = bestFit(landmarks, beats, pivot, o.tolSec, window, rates, center);
    const one = bestFit(landmarks, beats, pivot, o.tolSec, window, [1], center);
    if (full.r !== 1 && full.hits - one.hits >= RATE_FIT_MIN_GAIN * landmarks.length - 1e-9) {
      const chance = Math.min(1, (2 * o.tolSec) / period);
      songFit = crossValidateRate(landmarks, beats, pivot, o.tolSec, window, rates, center, full.r, chance);
      if (songFit.accepted) {
        // Every beat phase found at a rate other than 1 gets its own fitted map.
        const rateRuns: { i: number; j: number; peak: number; center: number }[] = [];
        for (let q = 1; q < rates.length; q++)
          for (const [i, j] of runsOf(hitsBy[q])) {
            let t = i;
            for (let k = i; k <= j; k++) if (hitsBy[q][k] > hitsBy[q][t]) t = k;
            rateRuns.push({ i, j, peak: hitsBy[q][t], center: cOf(t) });
          }
        rateRuns.sort((x, y) => y.peak - x.peak);
        const tried: number[] = [];
        for (const run of rateRuns) {
          if (tried.some((t) => Math.abs(t - run.center) <= o.tolSec)) continue;
          tried.push(run.center);
          const w: number[] = [];
          for (let k = Math.max(0, run.i - padSteps); k <= Math.min(2 * steps, run.j + padSteps); k++) w.push(cOf(k));
          const f = bestFit(landmarks, beats, pivot, o.tolSec, w, rates, run.center);
          if (f.r !== 1) built.push(build(f.c, f.r, songFit));
        }
      }
    }
  }
  // A rate-1 refit can fall below the near-best threshold; keep only near-best maps. Runs that
  // refine to maps within the matching tolerance of each other are one beat phase (landmarks
  // cannot tell them apart): keep the one with more hits.
  const bestHits = Math.max(...built.map((b) => b.hits));
  const kept: Built[] = [];
  for (const b of [...built].sort((x, y) => y.hits - x.hits))
    if (b.hits >= bestHits * o.tieRatio && !kept.some((k) => Math.abs(k.c - b.c) <= o.tolSec)) kept.push(b);

  // 3. Choose. The near-0 rule takes a candidate within nearZeroSec only when it stands apart
  // (nearest other candidate more than 2 × nearZeroSec away); bar phase then only warns, since a
  // misplaced first downbeat or a meter change shifts the implied downbeats. Otherwise keep the
  // candidates with the best bar phase; more than one left (bar phase unavailable, or whole bars
  // apart) is ambiguous.
  kept.sort((a, b) => Math.abs(a.offsetSec) - Math.abs(b.offsetSec));
  const warnings: string[] = [];
  let chosen = kept[0];
  let ambiguous = false;
  let survivors = 1;
  if (kept.length > 1) {
    const bar = kept.every((k) => k.barScore !== null) ? Math.max(...kept.map((k) => k.barScore!)) : null;
    const eligible = bar === null ? kept : kept.filter((k) => k.barScore! > bar - o.barMargin);
    const gap = Math.min(...kept.slice(1).map((k) => Math.abs(k.offsetSec - chosen.offsetSec)));
    const nearZero = Math.abs(chosen.offsetSec) <= o.nearZeroSec;
    if (nearZero && gap > 2 * o.nearZeroSec) {
      if (!eligible.includes(chosen)) warnings.push(`bar phase prefers offset ${eligible[0].offsetSec.toFixed(3)} s; kept the one near 0`);
    } else {
      if (nearZero) warnings.push(`candidates ${gap.toFixed(2)} s apart: a candidate near 0 is expected by chance, so bar phase decides`);
      chosen = eligible[0];
      survivors = eligible.length;
      ambiguous = survivors > 1;
      if (ambiguous)
        warnings.push(
          bar === null
            ? `bar phase unavailable: ${eligible.length} candidates one beat apart remain; reported the one nearest 0`
            : `bar phase cannot decide between ${eligible.length} candidates (${eligible.map((e) => e.offsetSec.toFixed(3)).join(', ')} s); reported the one nearest 0`,
        );
      else warnings.push(nearZero ? 'offset chosen by bar phase' : 'no candidate near 0: offset chosen by bar phase');
    }
  }
  const ordered = [chosen, ...kept.filter((k) => k !== chosen)];
  const strip = (b: Built): AlignCandidate => ({ offsetSec: b.offsetSec, rate: b.rate, matchedFraction: b.matchedFraction, barScore: b.barScore });
  const offsetSec = chosen.offsetSec;
  const rate = chosen.rate;
  const result: Alignment = { ...base, offsetSec, rate, rateFit: songFit, matchedFraction: chosen.matchedFraction, candidates: ordered.map(strip), ambiguous, warnings };
  if (rate !== 1 && songFit) warnings.push(`speed difference ${((rate - 1) * 100).toFixed(3)}% fitted (held-out gain ${Math.round(songFit.heldOutGain * 100)} points)`);

  // 4. Start / middle / end checks on the residuals after the map.
  const third = (last - first) / 3;
  const parts: AlignSegmentCheck['part'][] = ['start', 'middle', 'end'];
  const localResidual: (number | null)[] = [];
  result.segments = parts.map((part, i) => {
    const fromSec = first + i * third;
    const toSec = i === 2 ? last + 1e-9 : first + (i + 1) * third;
    const inPart = landmarks.filter((l) => l >= fromSec && l < toSec + (i === 2 ? 1e-9 : 0));
    const res = mappedResiduals(inPart, beats, chosen.c, rate, pivot, o.tolSec);
    const local = res.length ? median(res) : null;
    localResidual.push(local);
    const mid = (fromSec + Math.min(toSec, last)) / 2;
    return { part, fromSec, toSec: Math.min(toSec, last), landmarks: inPart.length, matched: res.length, offsetSec: local === null ? null : offsetSec + (rate - 1) * mid + local };
  });
  const locals = localResidual.filter((x): x is number => x !== null);
  result.driftSec = locals.length === 3 ? Math.max(...locals) - Math.min(...locals) : null;
  // PR #25, unchanged: a length-ratio time scale that fits clearly more raw landmarks than scale 1
  // means the upload runs at another speed; its displacement across the landmarks counts as drift.
  let rateNote: string | null = null;
  const scale = input.mediaDurationSec && input.annotationDurationSec > 0 ? input.mediaDurationSec / input.annotationDurationSec : 1;
  const rateDrift = Math.abs(scale - 1) * (last - first);
  if (rateDrift > o.driftLimitSec && landmarks.length >= RATE_MIN_LANDMARKS) {
    const rf = rateCheck(landmarks, beats, o, scale);
    if (rf.matchedFraction >= RATE_MIN_FRACTION && rf.matchedFraction >= rf.matchedAtOne + RATE_WIN_MARGIN) {
      result.driftSec = Math.max(result.driftSec ?? 0, rateDrift);
      rateNote = `landmarks fit the length-ratio time scale ${(scale * 100).toFixed(2)}% (${Math.round(rf.matchedFraction * 100)}% on beats vs ${Math.round(rf.matchedAtOne * 100)}% at 100%): the upload runs at another speed, about ${Math.round(rateDrift * 1000)} ms apart by the end`;
    }
  }
  const coarseRef = [input.chordSpan?.fromSec ?? 0, input.chordSpan?.toSec ?? 0];
  const coarseVals = [coarse.startOffsetSec, coarse.endOffsetSec];
  for (let k = 0; k < 2; k++) {
    const c = coarseVals[k];
    const expected = offsetSec + (rate - 1) * coarseRef[k];
    if (c !== null && Math.abs(c - expected) > 2) {
      result.warnings.push(`coarse check differs from the offset by ${(c - expected).toFixed(1)} s`);
      break;
    }
  }

  // 5. Exclusions, most structural first; an unresolved offset last.
  if (durationDiffSec !== null && Math.abs(durationDiffSec) > o.durationLimitSec)
    result.excluded = { code: 'duration-mismatch', reason: `upload is ${durationDiffSec > 0 ? 'longer' : 'shorter'} than the annotation by ${Math.abs(durationDiffSec).toFixed(1)} s` };
  else if (chosen.matchedFraction < o.minMatchFraction)
    result.excluded = { code: 'landmarks-disagree', reason: `only ${Math.round(chosen.matchedFraction * 100)}% of landmarks fall on an estimated beat` };
  else {
    const weak = result.segments.find((s) => s.landmarks === 0 || s.matched / s.landmarks < o.minMatchFraction || s.matched < 4);
    if (weak) result.excluded = { code: 'landmarks-disagree', reason: `${weak.part} third: ${weak.matched}/${weak.landmarks} landmarks on an estimated beat` };
    else if (result.driftSec !== null && result.driftSec > o.driftLimitSec)
      result.excluded = { code: 'drift', reason: rateNote ?? `local offsets differ by ${Math.round(result.driftSec * 1000)} ms across the song${rate !== 1 ? ' after the fitted speed difference' : ''}` };
    else if (ambiguous)
      result.excluded = { code: 'ambiguous', reason: `offset not determined: ${survivors} candidates remain after the near-0 rule and bar phase` };
  }
  if (durationDiffSec === null) result.warnings.push('upload length unknown; duration check skipped');
  return result;
}

// ---------------------------------------------------------------- Scoring

export interface ChangeResidual {
  /** Annotation chord change, media time. */
  refSec: number;
  /** Auto change minus annotation change, ms; null when no auto change within the window. */
  offsetMs: number | null;
}

export interface SongScore {
  comparison: ChartComparison;
  /** Seconds of the annotation chord span (media time) inside the upload. */
  annotatedSec: number;
  /** Annotated seconds the auto chart does not cover. */
  notCoveredSec: number;
  /** Seconds inside the overlap labeled X or with an unmapped label. */
  unknownSec: number;
  /** Per reduction: overlap seconds left out (X, unmapped, outside the reduction). */
  excludedSec: { majmin: number; root: number; sevenths: number };
  changes: ChangeResidual[];
  /** chordChangeOffset summary (repository code). */
  changeMedianMs: number;
  /** Labels that could not be mapped, with seconds. */
  unmapped: { label: string; sec: number }[];
}

/**
 * Annotation segments → a reference chart in media time (events at segment starts), through the
 * alignment's time map media = offsetSec + rate × annotation time (rate 1: a plain offset).
 */
export function annotationChart(segs: AnnotationSegment[], offsetSec: number, beats: number[] | null, mediaDurationSec: number | null, stripBass = false, rate = 1): Chart {
  const m = (t: number) => offsetSec + rate * t;
  const span = chordSpan(segs);
  const end = mediaDurationSec ?? Infinity;
  const from = span ? Math.max(0, m(span.fromSec)) : 0;
  // A negative offset can move the first chords before 0 s, where coverage starts. compareCharts
  // drops events that start before coverage, so the chord still sounding at the coverage start
  // moves to it (earlier ones that ended before it are dropped).
  const shifted = segs.map((s) => {
    const h = harteToSymbol(s.label);
    const chord = h.kind === 'chord' ? (stripBass ? withoutBass(h.symbol) : h.symbol) : h.kind === 'N' ? 'N' : 'X';
    return { startSec: Math.max(from, m(s.startSec)), chord, confidence: 1, source: 'manual' as const };
  });
  const events = shifted.filter((e, i) => !(e.startSec === from && shifted[i + 1]?.startSec === from));
  const coverage: CoverageRange[] = span ? [{ fromSec: from, toSec: Math.min(end, m(span.toSec)) }] : [];
  // The last segment ends the coverage; an extra event closes the final chord at its end.
  const lastEnd = m(Math.max(...segs.map((s) => s.endSec)));
  events.push({ startSec: lastEnd, chord: 'N', confidence: 1, source: 'manual' });
  return {
    schemaVersion: 1,
    recording: { source: 'youtube', id: 'annotation', title: 'annotation', artist: '' },
    timing: { bpm: 120, beatsPerBar: 4, firstDownbeatSec: 0, ...(beats?.length ? { beatTimes: beats.map(m) } : {}) },
    events,
    coverage: coverage.filter((r) => r.toSec > r.fromSec),
    provenance: { createdBy: 'manual', createdAt: '1970-01-01T00:00:00.000Z' },
  };
}

function changeTimes(events: { startSec: number; chord: string }[], ranges: CoverageRange[]): number[] {
  const sorted = [...events].sort((a, b) => a.startSec - b.startSec);
  const out: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const t = sorted[i].startSec;
    if (sorted[i].chord !== sorted[i - 1].chord && ranges.some((r) => t > r.fromSec && t < r.toSec)) out.push(t);
  }
  return out;
}

function overlapRanges(a: CoverageRange[], b: CoverageRange[]): CoverageRange[] {
  const out: CoverageRange[] = [];
  for (const x of normalizeCoverage(a))
    for (const y of normalizeCoverage(b)) {
      const from = Math.max(x.fromSec, y.fromSec);
      const to = Math.min(x.toSec, y.toSec);
      if (to > from) out.push({ fromSec: from, toSec: to });
    }
  return out;
}

const sumRanges = (rs: CoverageRange[]) => rs.reduce((s, r) => s + r.toSec - r.fromSec, 0);

/**
 * Scores an auto chart against an aligned annotation with compareCharts (the same code as
 * `npm run bench -- --compare` and the accuracy overview), plus every chord-change residual
 * (auto minus annotation, nearest auto change within ±windowSec, bass ignored). The annotation
 * goes through the alignment's frozen time map (offsetSec, rate); all reported seconds are media seconds.
 */
export function scoreSong(segs: AnnotationSegment[], beats: number[] | null, auto: Chart, offsetSec: number, mediaDurationSec: number | null, windowSec = 1, rate = 1): SongScore {
  const m = (t: number) => offsetSec + rate * t;
  const reference = annotationChart(segs, offsetSec, beats, mediaDurationSec, false, rate);
  const comparison = compareCharts(reference, auto);
  // Same fallback as compareCharts for a chart without coverage.
  const autoCov = auto.coverage.length
    ? auto.coverage
    : auto.events.length
      ? [{ fromSec: Math.min(...auto.events.map((e) => e.startSec)), toSec: Math.max(...auto.events.map((e) => e.startSec)) + 4 }]
      : [];
  const both = overlapRanges(reference.coverage, autoCov);
  const annotatedSec = sumRanges(reference.coverage);

  let unknownSec = 0;
  const unmappedSec = new Map<string, number>();
  for (const s of segs) {
    const h = harteToSymbol(s.label);
    if (h.kind !== 'X' && h.kind !== 'unmapped') continue;
    const inBoth = sumRanges(overlapRanges([{ fromSec: m(s.startSec), toSec: m(s.endSec) }], both));
    unknownSec += inBoth;
    if (h.kind === 'unmapped') unmappedSec.set(s.label, (unmappedSec.get(s.label) ?? 0) + m(s.endSec) - m(s.startSec));
  }

  const timingRef = annotationChart(segs, offsetSec, null, mediaDurationSec, true, rate);
  const summary = chordChangeOffset(timingRef, auto, windowSec);
  const refChanges = changeTimes(timingRef.events, both);
  const autoChanges = changeTimes(auto.events, normalizeCoverage(autoCov));
  const changes = refChanges.map((t) => {
    let bestD: number | null = null;
    for (const e of autoChanges) if (Math.abs(e - t) <= windowSec + 1e-9 && (bestD === null || Math.abs(e - t) < Math.abs(bestD))) bestD = e - t;
    return { refSec: t, offsetMs: bestD === null ? null : bestD * 1000 };
  });
  const ex = (w: { evaluatedSec: number }) => Math.max(0, comparison.overlapSec - w.evaluatedSec);
  return {
    comparison,
    annotatedSec,
    notCoveredSec: Math.max(0, annotatedSec - comparison.overlapSec),
    unknownSec,
    excludedSec: { majmin: ex(comparison.majmin), root: ex(comparison.root), sevenths: ex(comparison.sevenths) },
    changes,
    changeMedianMs: summary.medianMs,
    unmapped: [...unmappedSec].map(([label, sec]) => ({ label, sec })),
  };
}

// ---------------------------------------------------------------- Song list and evaluation

export const SONG_LIST_SCHEMA = 'vibe-guitar-annotation-eval-songs/1';
export const RESULT_SCHEMA = 'vibe-guitar-annotation-eval-result/1';

export interface DatasetInfo {
  name: string;
  page: string;
  downloads: string[];
  /** Folder name under the annotations folder the archives are extracted into. */
  folder: string;
  licence: string;
  licenceQuote: string;
  attribution: string;
  /** Whether BTC (our chord model) was trained on this dataset, per its README. */
  btcTraining: string;
}

export interface SongEntry {
  id: string;
  role: 'pilot' | 'eval';
  artist: string;
  title: string;
  release: string;
  dataset: string;
  /** Chord lab path inside the dataset folder. */
  chords: string;
  /** Beat file path inside the dataset folder, or null. */
  beats: string | null;
  annotationDurationSec: number;
  btcTraining: 'likely' | 'not-known';
  complexity: 'simple' | 'moderate' | 'complex';
  search: string[];
  uploadHint: string;
}

export interface SongList {
  schema: string;
  declaredAt: string;
  purpose: string;
  datasets: Record<string, DatasetInfo>;
  songs: SongEntry[];
}

export interface UploadEntry {
  youtubeId: string;
  /** Upload length in seconds (video.duration in the player). */
  durationSec?: number;
  channel?: string;
  uploadTitle?: string;
}

export class EvalInputError extends Error {}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function parseSongList(v: unknown): SongList {
  if (!isObj(v) || v.schema !== SONG_LIST_SCHEMA || !Array.isArray(v.songs) || !isObj(v.datasets)) throw new EvalInputError(`song list: expected schema ${SONG_LIST_SCHEMA}`);
  const ids = new Set<string>();
  for (const s of v.songs as unknown[]) {
    if (!isObj(s) || typeof s.id !== 'string' || typeof s.chords !== 'string' || typeof s.dataset !== 'string') throw new EvalInputError('song list: every song needs id, dataset and chords');
    if (ids.has(s.id)) throw new EvalInputError(`song list: duplicate id ${s.id}`);
    ids.add(s.id);
    if (!(s.dataset in (v.datasets as object))) throw new EvalInputError(`song list: ${s.id} uses unknown dataset ${s.dataset}`);
  }
  return v as unknown as SongList;
}

export function parseUploads(v: unknown): Record<string, UploadEntry> {
  if (!isObj(v)) throw new EvalInputError('uploads.json: expected an object { songId: { youtubeId, durationSec } }');
  const out: Record<string, UploadEntry> = {};
  for (const [k, e] of Object.entries(v)) {
    if (k.startsWith('$')) continue;
    if (!isObj(e) || typeof e.youtubeId !== 'string' || !/^[A-Za-z0-9_-]{6,20}$/.test(e.youtubeId)) throw new EvalInputError(`uploads.json: ${k} needs a youtubeId`);
    if (e.durationSec !== undefined && !(typeof e.durationSec === 'number' && Number.isFinite(e.durationSec) && e.durationSec > 0)) throw new EvalInputError(`uploads.json: ${k} has a bad durationSec`);
    out[k] = e as unknown as UploadEntry;
  }
  return out;
}

/** An exported auto chart: the stored chart, or { chart } wrapping it. */
export function chartFromExport(v: unknown): Chart | null {
  const c = isObj(v) && isObj(v.chart) ? v.chart : v;
  if (!isObj(c) || !Array.isArray(c.events) || !isObj(c.timing) || !Array.isArray(c.coverage)) return null;
  return c as unknown as Chart;
}

export type SongStatus = 'scored' | 'excluded' | 'missing' | 'error';

export interface SongResult {
  id: string;
  role: 'pilot' | 'eval';
  artist: string;
  title: string;
  dataset: string;
  btcTraining: 'likely' | 'not-known';
  complexity: SongEntry['complexity'];
  status: SongStatus;
  /** Why the song is not scored (missing upload, alignment exclusion, error). */
  reason?: string;
  youtubeId?: string;
  uploadTitle?: string;
  channel?: string;
  mediaDurationSec?: number | null;
  mediaDurationSource?: 'uploads.json' | 'coverage';
  annotationDurationSec?: number;
  alignment?: Alignment;
  /** Present only when scored. */
  score?: SongScore;
}

export interface GroupTotals {
  songs: number;
  /** Duration-weighted (pooled) WCSR and the evaluated seconds. */
  majmin: { score: number; evaluatedSec: number };
  root: { score: number; evaluatedSec: number };
  sevenths: { score: number; evaluatedSec: number };
  /** Mean of per-song scores. */
  songMean: { majmin: number; root: number; sevenths: number };
  changes: { matched: number; unmatched: number; medianMs: number; p10Ms: number; p90Ms: number; within100Ms: number };
}

export interface EvalResult {
  schema: string;
  generatedAt: string;
  songList: { declaredAt: string; sha256: string | null; songs: number };
  datasets: Record<string, DatasetInfo>;
  songs: SongResult[];
  totals: { all: GroupTotals; heldOut: GroupTotals; trainingOverlap: GroupTotals };
}

export interface EvalIo {
  /** Text of a file inside a dataset folder, or null when it does not exist. */
  readAnnotation(datasetFolder: string, relPath: string): string | null;
  /** Parsed JSON of <chartsDir>/<youtubeId>.json, or null when it does not exist. */
  readChart(youtubeId: string): unknown;
}

function quantile(xs: number[], q: number): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

export function groupTotals(rows: SongResult[]): GroupTotals {
  const scored = rows.filter((r) => r.status === 'scored' && r.score);
  const pooled = (k: 'majmin' | 'root' | 'sevenths') => {
    let good = 0;
    let total = 0;
    for (const r of scored) {
      const w = r.score!.comparison[k];
      if (w.evaluatedSec > 0) {
        good += w.score * w.evaluatedSec;
        total += w.evaluatedSec;
      }
    }
    return { score: total > 0 ? good / total : NaN, evaluatedSec: total };
  };
  const mean = (k: 'majmin' | 'root' | 'sevenths') => {
    const xs = scored.map((r) => r.score!.comparison[k].score).filter(Number.isFinite);
    return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
  };
  const offsets = scored.flatMap((r) => r.score!.changes.map((c) => c.offsetMs).filter((x): x is number => x !== null));
  const unmatched = scored.reduce((s, r) => s + r.score!.changes.filter((c) => c.offsetMs === null).length, 0);
  return {
    songs: scored.length,
    majmin: pooled('majmin'),
    root: pooled('root'),
    sevenths: pooled('sevenths'),
    songMean: { majmin: mean('majmin'), root: mean('root'), sevenths: mean('sevenths') },
    changes: {
      matched: offsets.length,
      unmatched,
      medianMs: median(offsets),
      p10Ms: quantile(offsets, 0.1),
      p90Ms: quantile(offsets, 0.9),
      within100Ms: offsets.length ? offsets.filter((x) => Math.abs(x) <= 100).length / offsets.length : NaN,
    },
  };
}

function evaluateOne(song: SongEntry, list: SongList, upload: UploadEntry | undefined, io: EvalIo): SongResult {
  const row: SongResult = {
    id: song.id,
    role: song.role,
    artist: song.artist,
    title: song.title,
    dataset: song.dataset,
    btcTraining: song.btcTraining,
    complexity: song.complexity,
    status: 'missing',
  };
  const folder = list.datasets[song.dataset].folder;
  const labText = io.readAnnotation(folder, song.chords);
  if (labText === null) return { ...row, status: 'error', reason: `annotation file not found: ${folder}/${song.chords}` };
  const segs = parseLab(labText);
  const annotationDurationSec = labDuration(segs);
  row.annotationDurationSec = annotationDurationSec;
  if (!upload) return { ...row, reason: 'no upload chosen yet (uploads.json)' };
  row.youtubeId = upload.youtubeId;
  row.uploadTitle = upload.uploadTitle;
  row.channel = upload.channel;
  const raw = io.readChart(upload.youtubeId);
  if (raw === null || raw === undefined) return { ...row, reason: `no exported auto chart: ${upload.youtubeId}.json` };
  const chart = chartFromExport(raw);
  if (!chart) return { ...row, status: 'error', reason: `${upload.youtubeId}.json is not a chart` };
  if (chart.provenance?.createdBy && chart.provenance.createdBy !== 'recognizer') return { ...row, status: 'error', reason: `${upload.youtubeId}.json is not an auto chart (createdBy ${chart.provenance.createdBy})` };

  let beatsAnn: AnnotationBeat[] | null = null;
  if (song.beats) {
    const t = io.readAnnotation(folder, song.beats);
    if (t === null) return { ...row, status: 'error', reason: `beat file not found: ${folder}/${song.beats}` };
    beatsAnn = parseBeats(t);
  }
  const coverageEnd = chart.coverage.length ? Math.max(...chart.coverage.map((c) => c.toSec)) : null;
  const mediaDurationSec = upload.durationSec ?? coverageEnd;
  row.mediaDurationSec = mediaDurationSec;
  row.mediaDurationSource = upload.durationSec !== undefined ? 'uploads.json' : 'coverage';
  const span = chordSpan(segs);
  const method: AlignMethod = beatsAnn && beatsAnn.length ? 'beats' : 'chord-boundaries';
  const changesAnn = chordChangeLandmarks(segs);
  const alignment = alignAnnotation({
    method,
    landmarks: method === 'beats' ? beatsAnn!.map((b) => b.sec) : changesAnn,
    downbeatLandmarks: method === 'beats' ? beatsAnn!.filter((b) => b.position === 1).map((b) => b.sec) : changesAnn,
    annotationDurationSec,
    chordSpan: span,
    estimateBeats: chart.timing.beatTimes ?? [],
    estimateFirstDownbeatSec: Number.isFinite(chart.timing.firstDownbeatSec) ? chart.timing.firstDownbeatSec : null,
    estimateBeatsPerBar: chart.timing.beatsPerBar ?? null,
    mediaDurationSec,
  });
  if (row.mediaDurationSource === 'coverage') alignment.warnings.push('upload length taken from the auto chart coverage end');
  row.alignment = alignment;
  // The time map (offset and rate) is frozen here; scoring never changes it, and excluded songs are not scored.
  if (alignment.excluded) return { ...row, status: 'excluded', reason: alignment.excluded.reason };
  row.score = scoreSong(segs, beatsAnn?.map((b) => b.sec) ?? null, chart, alignment.offsetSec, mediaDurationSec, 1, alignment.rate);
  return { ...row, status: 'scored' };
}

/** Evaluates every song of the list (pilots included, reported apart from the totals). */
export function evaluateSongs(list: SongList, uploads: Record<string, UploadEntry>, io: EvalIo, opts: { sha256?: string | null; now?: Date } = {}): EvalResult {
  const songs = list.songs.map((s) => {
    try {
      return evaluateOne(s, list, uploads[s.id], io);
    } catch (e) {
      return { id: s.id, role: s.role, artist: s.artist, title: s.title, dataset: s.dataset, btcTraining: s.btcTraining, complexity: s.complexity, status: 'error' as const, reason: (e as Error).message };
    }
  });
  const evalRows = songs.filter((r) => r.role === 'eval');
  return {
    schema: RESULT_SCHEMA,
    generatedAt: (opts.now ?? new Date()).toISOString(),
    songList: { declaredAt: list.declaredAt, sha256: opts.sha256 ?? null, songs: list.songs.length },
    datasets: list.datasets,
    songs,
    totals: {
      all: groupTotals(evalRows),
      heldOut: groupTotals(evalRows.filter((r) => r.btcTraining === 'not-known')),
      trainingOverlap: groupTotals(evalRows.filter((r) => r.btcTraining === 'likely')),
    },
  };
}
