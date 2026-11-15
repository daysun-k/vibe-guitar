/**
 * Whole-song arrangement: per-event candidates (voicing changes + harmonic
 * substitutions) chosen jointly by dynamic programming over
 * static difficulty + transition cost, for a given capo; plus capo suggestion.
 */
import { shapeName } from '../music/key';
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

export interface WorkEvent extends ArrangeInputEvent {
  mergedFrom: string[];
  /** How many of mergedFrom sounded before the event's own chord (0: all merged chords came after it). */
  mergedBefore: number;
}

const GAP_EPS = 1e-6;
const BEAT_EPS = 1e-6;
/** 입문 short-chord rule: a chord this close to the minimum counts as long enough. */
const GROUP_TOLERANCE_BEATS = 0.02;

/**
 * Merge chords shorter than level.minChordBeats into the previous chord. Never merges
 * across a rest ("N") on either side, nor across a coverage gap. Used by every level
 * except 입문 (see groupShortEvents).
 */
export function mergeShortEvents(events: ArrangeInputEvent[], timing: Timing, minBeats: number): WorkEvent[] {
  const out: WorkEvent[] = [];
  for (const e of events) {
    const beats = beatsBetween(timing, e.startSec, e.endSec);
    const prev = out[out.length - 1];
    const mergeable =
      prev !== undefined &&
      minBeats > 0 &&
      beats < minBeats - BEAT_EPS &&
      !isNoChord(e.chord) &&
      !isNoChord(prev.chord) &&
      prev.endSec >= e.startSec - GAP_EPS;
    if (mergeable) {
      prev.endSec = e.endSec;
      prev.mergedFrom.push(e.chord);
      continue;
    }
    out.push({ ...e, mergedFrom: [], mergedBefore: 0 });
  }
  return out;
}

/**
 * The chord a level actually plays, for comparing neighbours: the level's mandatory
 * simplification with every slash bass dropped (Am/G and Am, Fmaj7 and F6 are the same
 * 입문 chord). A symbol that does not parse is its own key.
 */
export function levelChordKey(symbol: string, level: LevelConfig): string {
  try {
    return formatChord(reduceForLevel(parseChord(symbol), level, { prev: null, next: null }).chord);
  } catch {
    return symbol.trim();
  }
}

/** One or more consecutive input chords played as one event. */
interface Unit {
  members: ArrangeInputEvent[];
  /** Index of the member whose chord is played: the longest (the first on a tie). */
  rep: number;
  /** levelChordKey of the played chord. */
  key: string;
  beats: number;
}

/**
 * A unit as one event: the played member's chord over the whole span; the other members
 * (except repeats of that same symbol) are listed in mergedFrom.
 */
function unitToEvent(u: Unit): WorkEvent {
  const main = u.members[u.rep];
  // The played chord is heard from its first occurrence (C, G, C joined is played from the first C).
  const first = u.members.findIndex((m) => m.chord === main.chord);
  const merged = u.members.filter((m) => m.chord !== main.chord);
  return {
    startSec: u.members[0].startSec,
    endSec: u.members[u.members.length - 1].endSec,
    chord: main.chord,
    confidence: main.confidence,
    mergedFrom: merged.map((m) => m.chord),
    mergedBefore: u.members.slice(0, first).length,
  };
}

/**
 * 입문 short-chord rule. Short chords (under minBeats) are still combined so changes never
 * come faster than the level allows, but a run of them no longer disappears into the chord
 * before it (Let It Be: Am, Am/G, Fmaj7, F6 all became G). Inside each stretch without a
 * rest or a coverage gap:
 *   1. A short chord joins a neighbour that is the same 입문 chord (levelChordKey): Am + Am/G
 *      is one Am, Fmaj7 + F6 one F.
 *   2. A run of consecutive short chords that together last at least minBeats is cut, from its
 *      start, into groups of at least minBeats. Each group is played as its longest chord (the
 *      first on a tie), so the chords keep their order and only the shortest ones in a group
 *      are dropped. A remainder shorter than minBeats joins the last group, which keeps its chord.
 *   3. A run shorter than minBeats in total (a lone passing chord) joins the chord before it,
 *      as before, and when the chord after it is the same 입문 chord that one joins too
 *      (C, G for half a beat, C is one C); the chord before keeps playing. At the start of a
 *      stretch the run stays on its own.
 * Long chords are never combined with each other, so a long Am/G after a long Am keeps its
 * bass line. Lengths within GROUP_TOLERANCE_BEATS of minBeats count as long enough.
 */
export function groupShortEvents(events: ArrangeInputEvent[], timing: Timing, level: LevelConfig): WorkEvent[] {
  const minBeats = level.minChordBeats;
  // Chart times are rounded to milliseconds, so a chord on the grid can measure 1.9986 beats.
  const enough = (beats: number): boolean => beats >= minBeats - GROUP_TOLERANCE_BEATS;
  const isShort = (u: Unit): boolean => minBeats > 0 && !enough(u.beats);
  const span = (a: ArrangeInputEvent, b: ArrangeInputEvent): number => beatsBetween(timing, a.startSec, b.endSec);
  const unitOf = (members: ArrangeInputEvent[]): Unit => {
    let rep = 0;
    members.forEach((m, i) => {
      if (span(m, m) > span(members[rep], members[rep]) + BEAT_EPS) rep = i;
    });
    return { members, rep, key: levelChordKey(members[rep].chord, level), beats: span(members[0], members[members.length - 1]) };
  };
  /** Chords joining a unit that keeps playing its own chord. */
  const extend = (u: Unit, more: ArrangeInputEvent[]): Unit => {
    const members = [...u.members, ...more];
    return { ...u, members, beats: span(members[0], members[members.length - 1]) };
  };
  const out: WorkEvent[] = [];
  let stretch: ArrangeInputEvent[] = [];

  const flush = (): void => {
    if (!stretch.length) return;
    // Step 1: short chords join an equal neighbour.
    const units: Unit[] = [];
    for (const e of stretch) {
      const u = unitOf([e]);
      const prev = units[units.length - 1];
      if (prev && prev.key === u.key && (isShort(prev) || isShort(u))) {
        units[units.length - 1] = unitOf([...prev.members, e]);
      } else {
        units.push(u);
      }
    }
    // Steps 2 and 3: runs of short units.
    const result: Unit[] = [];
    let i = 0;
    while (i < units.length) {
      if (!isShort(units[i])) {
        result.push(units[i++]);
        continue;
      }
      let j = i;
      while (j < units.length && isShort(units[j])) j++;
      const run = units.slice(i, j);
      const total = span(run[0].members[0], run[run.length - 1].members.at(-1)!);
      if (!enough(total)) {
        const prev = result[result.length - 1];
        const members = run.flatMap((u) => u.members);
        if (prev) {
          const next = units[j];
          const joinNext = next !== undefined && next.key === prev.key;
          result[result.length - 1] = extend(prev, [...members, ...(joinNext ? next.members : [])]);
          if (joinNext) j++;
        } else {
          result.push(unitOf(members));
        }
      } else {
        let group: ArrangeInputEvent[] = [];
        for (const u of run) {
          group.push(...u.members);
          if (enough(span(group[0], group[group.length - 1]))) {
            result.push(unitOf(group));
            group = [];
          }
        }
        if (group.length) result[result.length - 1] = extend(result[result.length - 1], group);
      }
      i = j;
    }
    for (const u of result) out.push(unitToEvent(u));
    stretch = [];
  };

  for (const e of events) {
    const prev = stretch[stretch.length - 1];
    if (isNoChord(e.chord)) {
      flush();
      out.push({ ...e, mergedFrom: [], mergedBefore: 0 });
      continue;
    }
    if (prev && prev.endSec < e.startSec - GAP_EPS) flush();
    stretch.push(e);
  }
  flush();
  return out;
}

/** The level's short-chord rule: 입문 groups runs of short chords, the other levels merge into the previous chord. */
export function levelEvents(events: ArrangeInputEvent[], timing: Timing, level: LevelConfig): WorkEvent[] {
  return level.shortChords === 'group' ? groupShortEvents(events, timing, level) : mergeShortEvents(events, timing, level.minChordBeats);
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

const LEVEL_NAME: Record<Level, string> = { beginner: '입문', novice: '초급', intermediate: '중급', advanced: '상급' };

/** Fragments join the reason directly to the resulting shape name. */
const CHANGE_TEXT: Record<Exclude<ChangeCode, 'merge'>, string> = {
  relative: '같은 음 두 개를 나누는',
  'colour-seventh': '7음을 더한',
  sus2: '같은 근음의 sus2인',
  'sus-to-triad': 'sus 음을 3음으로 바꾼',
  'simplify-quality': '감·증화음을 같은 근음의 3화음으로 바꾼',
  'core-triad': '같은 근음의 기본 3화음인',
  'drop-seventh': '7음을 빼고',
  'drop-extension': '9·11·13 같은 텐션음을 빼고',
  'drop-slash': '베이스음 지정(/)을 빼고',
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

function changeRecord(original: Chord, sounding: Chord, stage: Stage, mergedFrom: string[], mergedBefore: number, capo: number, level: Level): ChangeRecord | null {
  const codes = changeCodes(original, sounding);
  if (mergedFrom.length) codes.push('merge');
  if (!codes.length) return null;
  const from = shapeName(formatChord(original), capo);
  const to = shapeName(formatChord(sounding), capo);
  const reasons = codes.filter((c): c is Exclude<ChangeCode, 'merge'> => c !== 'merge');
  const action = reasons.map((c) => c === 'drop-seventh' && original.seventh === '6' ? '6음을 빼고' : CHANGE_TEXT[c]).join(', ');
  const prefix = stage === 2 || stage === 3 ? `${from} 모양은 ${LEVEL_NAME[level]}에서 어려워서, ` : `${LEVEL_NAME[level]}이라 `;
  // 입문 may play a group as a later, longer chord: the merged chords then came before it.
  const into = mergedBefore > 0 ? '이 코드에' : '앞 코드에';
  const merge = mergedFrom.length ? `짧게 지나가는 코드(${mergedFrom.map((n) => shapeName(n, capo)).join(', ')})를 ${into} 합쳤어요` : '';
  const main = reasons.length ? `${prefix}${action} ${to} 모양으로 쳐요${codes.includes('relative') ? ' (근음이 바뀌어 멜로디와 어긋날 수 있어요)' : ''}` : '';
  return {
    original: formatChord(original),
    sounding: formatChord(sounding),
    code: codes[0],
    codes,
    text: [main, merge].filter(Boolean).join(' · '),
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
  // Stage 4: the stage-1 candidates (the chord after the level's mandatory simplification, plus
  // the kept-7th option) on their easiest out-of-level shape, counted hard. Example: beginner with
  // capo range 0 plays Bb7 as Bb xx3331, marked "drop 7th". A same-root change only when those
  // candidates have no shape at all; no shape anywhere: unplayable.
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

/** Events after the level's short-chord rule (levelEvents), parsed, with their context; plans cached per capo. */
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
  const events = levelEvents(input, timing, level);
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
      change: changeRecord(plan.original, c.sounding!, c.stage, e.mergedFrom, e.mergedBefore, capo, p.levelName),
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
