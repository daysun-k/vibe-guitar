/**
 * Strumming / picking suggestions per level and meter. These are suggested
 * accompaniments, not a transcription of the original guitar part.
 */
import type { Timing } from '../chart/types';
import type { Level } from './levels';

export type Meter = '4/4' | '3/4' | '6/8';

/** D/U = down/up strum, '-' = no strum (hand keeps moving), p/i/m/a = thumb/index/middle/ring. */
export type StrumStep = 'D' | 'U' | '-' | 'p' | 'i' | 'm' | 'a';

export interface StrumSuggestion {
  id: string;
  level: Level;
  meter: Meter;
  feel: 'straight' | 'shuffle';
  style: 'strum' | 'fingerstyle';
  /** Steps per counted beat (2 = eighth notes in x/4; 1 = eighths in 6/8). */
  stepsPerBeat: number;
  steps: StrumStep[];
  /** Always true: label as "suggested accompaniment" in the UI. */
  suggested: true;
  /** True when the meter was not 4/4, 3/4 or 6/8 and a fallback was used. */
  meterFallback: boolean;
}

export function meterOf(t: Pick<Timing, 'beatsPerBar' | 'beatUnit'>): { meter: Meter; fallback: boolean } {
  const unit = t.beatUnit ?? 4;
  if (unit === 8 && t.beatsPerBar === 6) return { meter: '6/8', fallback: false };
  if (unit === 4 && t.beatsPerBar === 3) return { meter: '3/4', fallback: false };
  if (unit === 4 && t.beatsPerBar === 4) return { meter: '4/4', fallback: false };
  if (t.beatsPerBar % 3 === 0 && unit === 8) return { meter: '6/8', fallback: true };
  if (t.beatsPerBar === 3) return { meter: '3/4', fallback: true };
  return { meter: '4/4', fallback: true };
}

const S = (s: string): StrumStep[] => s.split(' ') as StrumStep[];

const PATTERNS: Record<Meter, Record<Level, { style: 'strum' | 'fingerstyle'; stepsPerBeat: number; steps: StrumStep[] }>> = {
  '4/4': {
    beginner: { style: 'strum', stepsPerBeat: 1, steps: S('D D D D') },
    novice: { style: 'strum', stepsPerBeat: 2, steps: S('D - D U D - D U') },
    intermediate: { style: 'strum', stepsPerBeat: 2, steps: S('D - D U - U D U') },
    advanced: { style: 'fingerstyle', stepsPerBeat: 2, steps: S('p m p i p m p i') },
  },
  '3/4': {
    beginner: { style: 'strum', stepsPerBeat: 1, steps: S('D D D') },
    novice: { style: 'strum', stepsPerBeat: 2, steps: S('D - D U D -') },
    intermediate: { style: 'strum', stepsPerBeat: 2, steps: S('D - D U D U') },
    advanced: { style: 'fingerstyle', stepsPerBeat: 2, steps: S('p i m a m i') },
  },
  '6/8': {
    beginner: { style: 'strum', stepsPerBeat: 1, steps: S('D - - D - -') },
    novice: { style: 'strum', stepsPerBeat: 1, steps: S('D - U D - U') },
    intermediate: { style: 'strum', stepsPerBeat: 1, steps: S('D D U D D U') },
    advanced: { style: 'fingerstyle', stepsPerBeat: 1, steps: S('p i m a m i') },
  },
};

export function suggestStrumming(level: Level, timing: Pick<Timing, 'beatsPerBar' | 'beatUnit' | 'feel'>): StrumSuggestion {
  const { meter, fallback } = meterOf(timing);
  const p = PATTERNS[meter][level];
  const feel = timing.feel ?? 'straight';
  return {
    id: `${level}-${meter}-${p.style}${feel === 'shuffle' && p.stepsPerBeat === 2 ? '-shuffle' : ''}`,
    level,
    meter,
    feel,
    style: p.style,
    stepsPerBeat: p.stepsPerBeat,
    steps: [...p.steps],
    suggested: true,
    meterFallback: fallback,
  };
}
