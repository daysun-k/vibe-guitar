/**
 * Whole-song arrangement: per-event candidates (voicing changes + harmonic
 * substitutions) chosen jointly by dynamic programming over
 * static difficulty + transition cost, for a given capo; plus capo suggestion.
 */
import { coverageRangeAt, normalizeCoverage } from '../chart/coverage';
import { beatsBetween, barSeconds } from '../chart/timing';
import type { Chart, Timing } from '../chart/types';
import { chordKey, formatChord, isNoChord, parseChord, transposeChord, withChanges, type Chord } from './chord';
import { inLevel, voicingLevel } from './curriculum';
import { PENALTY, timePressure, transitionCost, voicingCost } from './cost';
import { fretString, type Voicing } from './guitar';
import { DEFAULT_PROFILE, LEVEL_CONFIGS, type Level, type LevelConfig, type Profile } from './levels';
import { mod12, spellPitchClass } from './notes';
import { reduceForLevel, substitutionCandidates, type ChordContext, type Reduction, type SubstitutionReason } from './transform';
import { voicingsForChord } from './voicings';

export interface ArrangeInputEvent {
  startSec: number;
  endSec: number;
  chord: string;
  confidence: number;
}

export type TransformationKind = 'voicing' | 'substitution' | 'merge';

export interface Transformation {
  kind: TransformationKind;
  from: string;
  to: string;
  reason: SubstitutionReason | 'relative' | 'easier-shape' | 'short-chord';
  detail?: string;
}

export interface ArrangedEvent {
  startSec: number;
  endSec: number;
  original: string;
  rest: boolean;
  /** Sounding chord after level simplification / substitution. */
  sounding: string | null;
  /** Shape name relative to the capo (equals sounding when capo = 0). */
  shape: string | null;
  voicing: Voicing | null;
  /** True when the sounding chord differs from the original (show a badge). */
  substitution: boolean;
  transformations: Transformation[];
  confidence: number;
  uncertain: boolean;
  /** Short passing chords absorbed into this event. */
  mergedFrom: string[];
  cost: number;
  /** Stage that produced the chord (null for rests). */
  stage: Stage | null;
  /** The chosen shape is above the level, or there is none. */
  hard: boolean;
  /** Minimum level of the chosen shape. */
  shapeLevel: Level | null;
  /** What differs from the original and why; null when nothing does. */
  change: ChangeRecord | null;
}

export interface Arrangement {
  level: Level;
  capo: number;
  /** Arranged with the relative major/minor (root-changing) stage allowed. */
  rootChange: boolean;
  events: ArrangedEvent[];
  totalCost: number;
  meanCost: number;
  unplayable: string[];
}

export interface ArrangeOptions {
  level: Level;
  capo: number;
  profile?: Profile;
  /** Allow stage 3 (relative major/minor triad, changes the root). Default off. */
  allowRootChange?: boolean;
}

const UNPLAYABLE_COST = 50;
const UNCERTAIN_BELOW = 0.5;

/**
 * Chart events → events with end times. Each event ends at the next event or at the
 * end of the (normalized, merged) coverage interval it starts in, whichever comes first (the last event of an
 * interval lasts to the interval end); events that start outside every coverage interval
 * are dropped. With no coverage at all, the last event lasts one bar.
 */
export function chartToInputEvents(chart: Chart): ArrangeInputEvent[] {
  const cov = normalizeCoverage(chart.coverage);
  const out: ArrangeInputEvent[] = [];
  chart.events.forEach((e, i) => {
    const next = chart.events[i + 1];
    let end: number;
    if (cov.length) {
      const range = coverageRangeAt(cov, e.startSec);
      if (!range) return;
      end = next ? Math.min(next.startSec, range.toSec) : range.toSec;
    } else {
      end = next ? next.startSec : e.startSec + barSeconds(chart.timing);
    }
    out.push({ startSec: e.startSec, endSec: end, chord: e.chord, confidence: e.confidence });
  });
  return out;
}

interface WorkEvent extends ArrangeInputEvent {
  mergedFrom: string[];
}

const GAP_EPS = 1e-6;

/**
 * Merge chords shorter than level.minChordBeats into the previous chord. Never merges
 * across a rest ("N") on either side, nor across a coverage gap.
 */
export function mergeShortEvents(events: ArrangeInputEvent[], timing: Timing, minBeats: number): WorkEvent[] {
  const out: WorkEvent[] = [];
  for (const e of events) {
    const beats = beatsBetween(timing, e.startSec, e.endSec);
    const prev = out[out.length - 1];
    const mergeable =
      prev !== undefined &&
      minBeats > 0 &&
      beats < minBeats - 1e-6 &&
      !isNoChord(e.chord) &&
      !isNoChord(prev.chord) &&
      prev.endSec >= e.startSec - GAP_EPS;
    if (mergeable) {
      prev.endSec = e.endSec;
      prev.mergedFrom.push(e.chord);
      continue;
    }
    out.push({ ...e, mergedFrom: [] });
  }
  return out;
}

/** 1 original (after reduction), 2 same-root change, 3 relative major/minor (opt-in), 4 original kept, hard. */
export type Stage = 1 | 2 | 3 | 4;

export type ChangeCode =
  | 'relative' // root changed: relative major/minor triad (stage 3)
  | 'colour-seventh' // X -> Xmaj7, Xm -> Xm7
  | 'sus2' // X -> Xsus2
  | 'sus-to-triad'
  | 'simplify-quality' // dim/aug -> plain triad
  | 'core-triad' // last same-root fallback
  | 'drop-seventh'
  | 'drop-extension'
  | 'drop-slash'
  | 'merge'; // a short chord merged into this one

export interface ChangeRecord {
  original: string;
  sounding: string;
  /** Most significant change first. */
  code: ChangeCode;
  codes: ChangeCode[];
  /** Short Korean explanation for the panel. */
  text: string;
  /** Sounding root differs from the original root (both before capo transposition). */
  rootChanged: boolean;
}

const CHANGE_ORDER: ChangeCode[] = ['relative', 'colour-seventh', 'sus2', 'sus-to-triad', 'simplify-quality', 'core-triad', 'drop-seventh', 'drop-extension', 'drop-slash', 'merge'];

const CHANGE_TEXT: Record<ChangeCode, string> = {
  relative: '근음이 바뀌어요. 관계 장·단조 3화음이라 구성음 2개가 같아요. 멜로디와 어긋날 수 있어요',
  'colour-seventh': '같은 근음에 7음을 더한 코드예요',
  sus2: '같은 근음의 sus2 코드예요',
  'sus-to-triad': 'sus 음을 3음으로 바꿨어요',
  'simplify-quality': '감·증화음을 같은 근음의 3화음으로 바꿨어요',
  'core-triad': '같은 근음의 기본 3화음으로 바꿨어요',
  'drop-seventh': '7음(6음)을 빼고 3화음으로 쳐요',
  'drop-extension': '9·11·13 같은 텐션음을 뺐어요',
  'drop-slash': '베이스음 지정(/)을 뺐어요',
  merge: '짧게 지나가는 코드를 앞 코드에 합쳤어요',
};

function hasTensions(c: Chord): boolean {
  return c.extension !== null || c.adds.length > 0 || c.alterations.length > 0;
}

/** What changed from the original to the sounding chord (sounding pitch space, before capo). */
export function changeCodes(original: Chord, sounding: Chord): ChangeCode[] {
  const out = new Set<ChangeCode>();
  if (original.root !== sounding.root) out.add('relative');
  else {
    if (original.bass !== null && sounding.bass === null) out.add('drop-slash');
    const lostTension =
      (original.extension !== null && sounding.extension === null) ||
      original.adds.some((a) => !sounding.adds.includes(a)) ||
      original.alterations.some((a) => !sounding.alterations.includes(a));
    if (lostTension) out.add('drop-extension');
    if (original.seventh !== 'none' && sounding.seventh === 'none') out.add('drop-seventh');
    if (original.seventh === 'none' && (sounding.seventh === 'b7' || sounding.seventh === 'maj7')) out.add('colour-seventh');
    if (original.triad !== sounding.triad) {
      if (original.triad === 'sus2' || original.triad === 'sus4') out.add('sus-to-triad');
      else if (original.triad === 'maj' && sounding.triad === 'sus2') out.add('sus2');
      else if (original.triad === 'dim' || original.triad === 'aug') out.add('simplify-quality');
      else out.add('core-triad');
    }
    if (out.size === 0 && chordKey(original) !== chordKey(sounding)) out.add(hasTensions(original) ? 'drop-extension' : 'core-triad');
  }
  return CHANGE_ORDER.filter((c) => out.has(c));
}

function changeRecord(original: Chord, sounding: Chord, stage: Stage, mergedFrom: string[]): ChangeRecord | null {
  const codes = changeCodes(original, sounding);
  if (mergedFrom.length) codes.push('merge');
  if (!codes.length) return null;
  const texts = codes.map((c) => (c === 'merge' ? `짧게 지나가는 ${mergedFrom.join(', ')}을(를) 앞 코드에 합쳤어요` : CHANGE_TEXT[c]));
  const why = stage === 2 || stage === 3 ? '원래 코드는 이 난이도에서 잡을 운지가 없어요. ' : '';
  return {
    original: formatChord(original),
    sounding: formatChord(sounding),
    code: codes[0],
    codes,
    text: why + texts.join(' · '),
    rootChanged: original.root !== sounding.root,
  };
}

interface Candidate {
  /** null for rests ("N"). */
  sounding: Chord | null;
  shape: Chord | null;
  voicing: Voicing | null;
  cost: number;
  substitutionReason: SubstitutionReason | 'relative' | null;
  /** The level reduction this candidate starts from, and the steps that produced it. */
  base: Chord | null;
  baseSteps: string[];
  stage: Stage;
}

interface EventPlan {
  original: Chord | null;
  /** In-level candidates of stages 1-3, and every shape of the kept original (stage 4). */
  stages: [Candidate[], Candidate[], Candidate[], Candidate[]];
}

function standardVoicing(list: Voicing[]): Voicing | null {
  return list.find((v) => v.kind === 'open') ?? list.find((v) => v.kind === 'barre') ?? list[0] ?? null;
}

/** Relative major/minor triad of a plain major or minor triad (never for anything else). */
export function relativeTriad(c: Chord): Chord | null {
  const plain = c.seventh === 'none' && !hasTensions(c) && c.bass === null;
  if (!plain || (c.triad !== 'maj' && c.triad !== 'min')) return null;
  const root = mod12(c.triad === 'maj' ? c.root - 3 : c.root + 3);
  const pref = c.rootName.includes('b') ? 'flat' : c.rootName.includes('#') ? 'sharp' : c.triad === 'maj' ? 'guitar-minor' : 'guitar-major';
  return withChanges(c, { root, rootName: spellPitchClass(root, pref), triad: c.triad === 'maj' ? 'min' : 'maj' });
}

type Option = { chord: Chord; penalty: number; reason: SubstitutionReason | 'relative' | null; base: Reduction };

function planEvent(original: Chord | null, ctx: ChordContext, level: LevelConfig, profile: Profile, capo: number): EventPlan {
  if (!original) {
    const rest: Candidate = { sounding: null, shape: null, voicing: null, cost: 0, substitutionReason: null, base: null, baseSteps: [], stage: 1 };
    return { original: null, stages: [[rest], [], [], []] };
  }
  const red = reduceForLevel(original, level, ctx);
  const first: Option[] = [{ chord: red.chord, penalty: 0, reason: red.changed ? 'level-simplify' : null, base: red }];
  if (!level.allowSevenths) {
    // Dropping the 7th is a preference, not a rule: the original 7th (Fmaj7 xx3210, Am7, A7)
    // stays available at a small cost and wins when its shape is easier than the triad.
    const keep = reduceForLevel(original, { ...level, allowSevenths: true }, ctx);
    if (chordKey(keep.chord) !== chordKey(red.chord)) first.push({ chord: keep.chord, penalty: PENALTY.keepSeventh, reason: keep.changed ? 'level-simplify' : null, base: keep });
  }
  const firstKeys = new Set(first.map((o) => chordKey(o.chord)));
  // One option per chord, at its lowest penalty; a stage-1 chord is never a stage-2 option.
  const second = new Map<string, Option>();
  for (const s of substitutionCandidates(red.chord, ctx, original)) {
    const k = chordKey(s.chord);
    if (firstKeys.has(k)) continue;
    const o: Option = { chord: s.chord, penalty: s.weight * level.substitutionWeight * PENALTY.substitution, reason: s.reason, base: red };
    const had = second.get(k);
    if (!had || o.penalty < had.penalty) second.set(k, o);
  }
  const rel = relativeTriad(original);
  const third: Option[] = rel && !firstKeys.has(chordKey(rel)) ? [{ chord: rel, penalty: PENALTY.substitution * level.substitutionWeight, reason: 'relative', base: red }] : [];

  const expand = (opts: Option[], stage: Stage, onlyInLevel: boolean): Candidate[] => {
    const out: Candidate[] = [];
    for (const opt of opts) {
      const shape = transposeChord(opt.chord, -capo);
      for (const v of voicingsForChord(shape)) {
        if (onlyInLevel !== inLevel(v, level.level)) continue;
        out.push({
          sounding: opt.chord,
          shape,
          voicing: v,
          cost: voicingCost(v, shape.root, level, profile) + opt.penalty,
          substitutionReason: opt.reason,
          base: opt.base.chord,
          baseSteps: opt.base.steps,
          stage,
        });
      }
    }
    return out;
  };
  const s1 = expand(first, 1, true);
  const s2 = s1.length ? [] : expand([...second.values()], 2, true);
  const s3 = s1.length || s2.length ? [] : expand(third, 3, true);
  // Stage 4: the original on its easiest out-of-level shape; a same-root change only when the
  // original has no shape at all; no shape anywhere: unplayable.
  let s4: Candidate[] = [];
  if (!s1.length && !s2.length) {
    s4 = expand(first, 4, false);
    if (!s4.length) s4 = expand([...second.values()], 4, false);
    if (!s4.length) {
      const shape = transposeChord(red.chord, -capo);
      s4 = [{ sounding: red.chord, shape, voicing: null, cost: UNPLAYABLE_COST, substitutionReason: red.changed ? 'level-simplify' : null, base: red.chord, baseSteps: red.steps, stage: 4 }];
    }
  }
  return { original, stages: [s1, s2, s3, s4] };
}

function parseOrNull(sym: string): Chord | null {
  if (isNoChord(sym)) return null;
  return parseChord(sym);
}

/** Events after the level's short-chord merge, parsed, with their context; plans cached per capo. */
interface Prepared {
  levelName: Level;
  level: LevelConfig;
  profile: Profile;
  timing: Timing;
  events: WorkEvent[];
  chords: (Chord | null)[];
  plans: Map<number, EventPlan[]>;
}

function prepare(input: ArrangeInputEvent[], timing: Timing, levelName: Level, profile: Profile): Prepared {
  const level = LEVEL_CONFIGS[levelName];
  const events = mergeShortEvents(input, timing, level.minChordBeats);
  return { levelName, level, profile, timing, events, chords: events.map((e) => parseOrNull(e.chord)), plans: new Map() };
}

function plansAt(p: Prepared, capo: number): EventPlan[] {
  let plans = p.plans.get(capo);
  if (plans) return plans;
  const memo = new Map<string, EventPlan>();
  plans = p.events.map((e, i) => {
    const prev = p.events[i - 1]?.chord ?? '';
    const next = p.events[i + 1]?.chord ?? '';
    const k = `${e.chord}|${prev}|${next}`;
    let plan = memo.get(k);
    if (!plan) {
      const ctx: ChordContext = { prev: p.chords[i - 1] ?? null, next: p.chords[i + 1] ?? null };
      plan = planEvent(p.chords[i], ctx, p.level, p.profile, capo);
      memo.set(k, plan);
    }
    return plan;
  });
  p.plans.set(capo, plans);
  return plans;
}

function capoRange(profile: Profile, extra?: number): number[] {
  const out: number[] = [];
  for (let c = profile.capoMin; c <= profile.capoMax; c++) out.push(c);
  if (extra !== undefined && !out.includes(extra)) out.push(extra);
  return out;
}

/**
 * Events that may change root (stage 3): a plain triad with no in-level shape for the original
 * or a same-root change at any capo considered, so the capo choice never triggers a root change.
 */
function rootChangeMask(p: Prepared, capos: number[]): boolean[] {
  const all = capos.map((c) => plansAt(p, c));
  return p.events.map((_, i) => {
    if (!p.chords[i] || !relativeTriad(p.chords[i]!)) return false;
    return all.every((plans) => plans[i].stages[0].length === 0 && plans[i].stages[1].length === 0);
  });
}

function eligible(plan: EventPlan, rootChange: boolean): Candidate[] {
  const [s1, s2, s3, s4] = plan.stages;
  if (s1.length) return s1;
  if (s2.length) return s2;
  if (rootChange && s3.length) return s3;
  return s4;
}

function solve(p: Prepared, capo: number, mask: boolean[] | null): Arrangement {
  const { events, profile } = p;
  const plans = plansAt(p, capo);
  const cands = plans.map((plan, i) => eligible(plan, !!mask?.[i]));

  // Viterbi over the eligible candidates of each event.
  const n = plans.length;
  const best: number[][] = [];
  const back: number[][] = [];
  for (let i = 0; i < n; i++) {
    const cs = cands[i];
    best[i] = new Array(cs.length).fill(Infinity);
    back[i] = new Array(cs.length).fill(-1);
    for (let j = 0; j < cs.length; j++) {
      if (i === 0) {
        best[i][j] = cs[j].cost;
        continue;
      }
      const prevCands = cands[i - 1];
      const pressure = timePressure(events[i - 1].endSec - events[i - 1].startSec, profile);
      const gap = events[i - 1].endSec < events[i].startSec - GAP_EPS;
      for (let k = 0; k < prevCands.length; k++) {
        const t = gap ? 0 : transitionCost(prevCands[k].voicing, cs[j].voicing) * pressure;
        const total = best[i - 1][k] + t + cs[j].cost;
        if (total < best[i][j]) {
          best[i][j] = total;
          back[i][j] = k;
        }
      }
    }
  }

  const choice: number[] = new Array(n).fill(0);
  let totalCost = 0;
  if (n > 0) {
    let j = best[n - 1].indexOf(Math.min(...best[n - 1]));
    totalCost = best[n - 1][j];
    for (let i = n - 1; i >= 0; i--) {
      choice[i] = j;
      j = back[i][j];
    }
  }

  const unplayable = new Set<string>();
  const arranged: ArrangedEvent[] = events.map((e, i) => {
    const plan = plans[i];
    const c = cands[i][choice[i]];
    const base = {
      startSec: e.startSec,
      endSec: e.endSec,
      original: e.chord,
      confidence: e.confidence,
      uncertain: e.confidence < UNCERTAIN_BELOW,
      mergedFrom: e.mergedFrom,
      cost: c.cost,
    };
    const transformations: Transformation[] = e.mergedFrom.map((m) => ({ kind: 'merge', from: m, to: e.chord, reason: 'short-chord' }));
    if (!plan.original) {
      return { ...base, rest: true, sounding: null, shape: null, voicing: null, substitution: false, transformations, stage: null, hard: false, shapeLevel: null, change: null };
    }
    const originalName = formatChord(plan.original);
    // History of the chosen candidate only: a kept 7th has no "drop 7th" step.
    const reducedName = formatChord(c.base!);
    const soundingName = formatChord(c.sounding!);
    if (reducedName !== originalName) {
      transformations.push({ kind: 'substitution', from: e.chord, to: reducedName, reason: 'level-simplify', detail: c.baseSteps.join('; ') });
    }
    if (soundingName !== reducedName) {
      transformations.push({ kind: 'substitution', from: reducedName, to: soundingName, reason: c.substitutionReason === 'relative' ? 'relative' : (c.substitutionReason ?? 'fallback') });
    }
    if (c.voicing) {
      const std = standardVoicing(voicingsForChord(c.shape!));
      if (std && std.id !== c.voicing.id && c.voicing.kind !== std.kind) {
        transformations.push({
          kind: 'voicing',
          from: `${std.kind} ${fretString(std.frets)}`,
          to: `${c.voicing.kind} ${fretString(c.voicing.frets)}`,
          reason: 'easier-shape',
        });
      }
    } else {
      unplayable.add(soundingName);
    }
    const shapeLevel = c.voicing ? (voicingLevel(c.voicing)?.level ?? null) : null;
    return {
      ...base,
      rest: false,
      sounding: soundingName,
      shape: formatChord(c.shape!),
      voicing: c.voicing,
      substitution: chordKey(c.sounding!) !== chordKey(plan.original),
      transformations,
      stage: c.stage,
      hard: c.stage === 4 || !c.voicing || !inLevel(c.voicing, p.levelName),
      shapeLevel,
      change: changeRecord(plan.original, c.sounding!, c.stage, e.mergedFrom),
    };
  });

  return {
    level: p.levelName,
    capo,
    rootChange: mask !== null,
    events: arranged,
    totalCost,
    meanCost: n ? totalCost / n : 0,
    unplayable: [...unplayable],
  };
}

export function arrangeEvents(input: ArrangeInputEvent[], timing: Timing, opts: ArrangeOptions): Arrangement {
  const profile = opts.profile ?? DEFAULT_PROFILE;
  const p = prepare(input, timing, opts.level, profile);
  const mask = opts.allowRootChange ? rootChangeMask(p, capoRange(profile, opts.capo)) : null;
  return solve(p, opts.capo, mask);
}

export function arrangeChart(chart: Chart, opts: ArrangeOptions): Arrangement {
  return arrangeEvents(chartToInputEvents(chart), chart.timing, opts);
}

/** Beats of non-rest events, and of those that are hard for the arrangement's level (fractional). */
export function hardBeats(a: Arrangement, timing: Timing): { hard: number; total: number } {
  let hard = 0;
  let total = 0;
  for (const e of a.events) {
    if (e.rest) continue;
    const b = Math.max(0, beatsBetween(timing, e.startSec, e.endSec));
    total += b;
    if (e.hard) hard += b;
  }
  return { hard, total };
}

export interface CapoSuggestion {
  capo: number;
  score: number;
  /** Unique shapes played, in order of first appearance. */
  shapes: string[];
  substitutions: number;
  /** Hard sounding beats / all non-rest sounding beats (0 when there are none). */
  hardShare: number;
  /** The arrangement at this capo (reused by the play view instead of arranging again). */
  arrangement: Arrangement;
}

export interface CapoOptions {
  allowRootChange?: boolean;
  /** A manual capo: also counts as a capo where the original may be playable. */
  extraCapo?: number;
}

const SHARE_EPS = 1e-9;

/**
 * Rank capo positions (the sounding key always stays the same): least hard sounding-beat
 * share first, then the arranged cost.
 */
export function suggestCapo(chart: Chart, level: Level, profile: Profile = DEFAULT_PROFILE, opts: CapoOptions = {}): CapoSuggestion[] {
  const p = prepare(chartToInputEvents(chart), chart.timing, level, profile);
  const mask = opts.allowRootChange ? rootChangeMask(p, capoRange(profile, opts.extraCapo)) : null;
  const out: CapoSuggestion[] = [];
  for (const capo of capoRange(profile)) {
    const a = solve(p, capo, mask);
    const shapes: string[] = [];
    for (const e of a.events) if (e.shape && !shapes.includes(e.shape)) shapes.push(e.shape);
    const score = a.meanCost + 0.1 * capo + (capo >= 5 ? 0.5 : 0);
    const hb = hardBeats(a, chart.timing);
    out.push({
      capo,
      score: Math.round(score * 100) / 100,
      shapes,
      substitutions: a.events.filter((e) => e.substitution).length,
      hardShare: hb.total > 0 ? hb.hard / hb.total : 0,
      arrangement: a,
    });
  }
  return out.sort((x, y) => (Math.abs(x.hardShare - y.hardShare) > SHARE_EPS ? x.hardShare - y.hardShare : 0) || x.score - y.score || x.capo - y.capo);
}

/** Unique voicings of an arrangement, for the "chords in this song" preview. */
export function uniqueVoicings(a: Arrangement): { shape: string; sounding: string; voicing: Voicing | null; substitution: boolean }[] {
  const seen = new Set<string>();
  const out: { shape: string; sounding: string; voicing: Voicing | null; substitution: boolean }[] = [];
  for (const e of a.events) {
    if (e.rest || !e.shape) continue;
    const key = `${e.shape}|${e.voicing?.id ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ shape: e.shape, sounding: e.sounding!, voicing: e.voicing, substitution: e.substitution });
  }
  return out;
}
