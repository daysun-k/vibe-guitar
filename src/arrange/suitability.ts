/**
 * Shape suitability estimate per level: how much of a song's sounding time falls on shapes
 * above the level, which chords those are, and how many chords the arrangement changed.
 * It judges shapes only (no tempo or chord-change speed): never "playable", only a fit
 * estimate. Thresholds are provisional (docs/level-vocabulary.md).
 */
import type { Chart, Timing } from '../chart/types';
import { arrangeChart, hardBeats, suggestCapo, type Arrangement } from './arrange';
import { fretString } from './guitar';
import { DEFAULT_PROFILE, type Level, type Profile } from './levels';

export type Verdict = 'fit' | 'practice' | 'no-fit' | 'missing-shape' | 'data-insufficient';

export const VERDICT_TEXT: Record<Verdict, string> = {
  fit: '맞음',
  practice: '연습하면 가능',
  'no-fit': '맞지 않음',
  'missing-shape': '운지 없음',
  'data-insufficient': '판단할 코드 부족',
};

/** Provisional: at most this many distinct hard chords … */
export const PRACTICE_MAX_CHORDS = 2;
/** … covering at most this share of the sounding beats still counts as "연습하면 가능". */
export const PRACTICE_MAX_SHARE = 0.15;

export interface HardChord {
  /** Sounding chord name. */
  name: string;
  /** Shape name relative to the capo. */
  shape: string;
  /** Fret string of the chosen shape, null when there is none. */
  frets: string | null;
  shapeLevel: Level | null;
}

export interface LevelSuitability {
  level: Level;
  capo: number;
  /** The capo was ranked automatically (else it is the manual setting). */
  capoAuto: boolean;
  rootChange: boolean;
  verdict: Verdict;
  /** Hard sounding beats / non-rest sounding beats inside coverage; null without any. */
  hardBeatShare: number | null;
  hardChords: HardChord[];
  /** Changed chords (each merged short chord counts once) and, separately, root changes. */
  changed: number;
  rootChanged: number;
  missingShape: string[];
  /** Root-change setting off: distinct hard chords it would leave when on, if that is fewer. */
  hardChordsWithRootChange: number | null;
}

export function verdictFor(hardBeatShare: number | null, hardChordCount: number, missing: number): Verdict {
  if (hardBeatShare === null) return 'data-insufficient';
  if (missing > 0) return 'missing-shape';
  if (hardChordCount === 0) return 'fit';
  if (hardChordCount <= PRACTICE_MAX_CHORDS && hardBeatShare <= PRACTICE_MAX_SHARE + 1e-9) return 'practice';
  return 'no-fit';
}

export function summarizeArrangement(a: Arrangement, timing: Timing, capoAuto: boolean): LevelSuitability {
  const { hard, total } = hardBeats(a, timing);
  const hardChords: HardChord[] = [];
  let changed = 0;
  let rootChanged = 0;
  for (const e of a.events) {
    if (e.rest) continue;
    if (e.change) {
      if (e.change.codes.some((c) => c !== 'merge')) changed++;
      if (e.change.rootChanged) rootChanged++;
    }
    changed += e.mergedFrom.length;
    if (e.hard && e.sounding && !hardChords.some((h) => h.name === e.sounding)) {
      hardChords.push({ name: e.sounding, shape: e.shape ?? e.sounding, frets: e.voicing ? fretString(e.voicing.frets) : null, shapeLevel: e.shapeLevel });
    }
  }
  const share = total > 0 ? hard / total : null;
  return {
    level: a.level,
    capo: a.capo,
    capoAuto,
    rootChange: a.rootChange,
    verdict: verdictFor(share, hardChords.length, a.unplayable.length),
    hardBeatShare: share,
    hardChords,
    changed,
    rootChanged,
    missingShape: [...a.unplayable],
    hardChordsWithRootChange: null,
  };
}

export interface SuitabilityOptions {
  capo: 'auto' | number;
  profile?: Profile;
  allowRootChange?: boolean;
}

/** The arrangement a level would show: the best-ranked capo (reused, not recomputed) or the manual one. */
export function arrangeForLevel(chart: Chart, level: Level, o: SuitabilityOptions): Arrangement {
  const profile = o.profile ?? DEFAULT_PROFILE;
  if (o.capo === 'auto') return suggestCapo(chart, level, profile, { allowRootChange: o.allowRootChange })[0].arrangement;
  return arrangeChart(chart, { level, capo: o.capo, profile, allowRootChange: o.allowRootChange });
}

/** Adds the "with root changes" hard-chord count when the setting is off and it would help. */
export function withRootChangeHint(s: LevelSuitability, chart: Chart, o: SuitabilityOptions): LevelSuitability {
  if (o.allowRootChange || s.hardChords.length === 0) return s;
  const alt = summarizeArrangement(arrangeForLevel(chart, s.level, { ...o, allowRootChange: true }), chart.timing, o.capo === 'auto');
  return alt.hardChords.length < s.hardChords.length ? { ...s, hardChordsWithRootChange: alt.hardChords.length } : s;
}

/** Full estimate for one level; `chart` is the prepared chart (respelled, bar-phase aligned). */
export function levelSuitability(chart: Chart, level: Level, o: SuitabilityOptions): LevelSuitability {
  const s = summarizeArrangement(arrangeForLevel(chart, level, o), chart.timing, o.capo === 'auto');
  return withRootChangeHint(s, chart, o);
}

/** One line per level, e.g. "입문 · 카포 1 · 어려운 코드 1개(A♭m) · 연습하면 가능". */
export function suitabilityLine(s: LevelSuitability, levelLabel: string, pretty: (name: string) => string = (x) => x): string {
  const parts = [levelLabel, s.capo === 0 ? '카포 없음' : `카포 ${s.capo}`];
  if (s.missingShape.length) parts.push(`운지 없는 코드 ${s.missingShape.length}개(${s.missingShape.map(pretty).join(', ')})`);
  else if (s.hardChords.length) parts.push(`어려운 코드 ${s.hardChords.length}개(${s.hardChords.map((h) => pretty(h.name)).join(', ')})`);
  parts.push(VERDICT_TEXT[s.verdict]);
  return parts.join(' · ');
}
