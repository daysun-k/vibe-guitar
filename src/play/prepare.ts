/**
 * The chart every level is arranged from: key-aware spelling and bar-phase alignment.
 * Shared by the play view (current level) and the level-fit worker (other levels).
 */
import type { Chart, Timing } from '../chart/types';
import { respellChartForKey, type KeyEstimate } from '../music/key';
import { alignBarPhase, type PhaseEstimate } from '../music/meter';

function changeTimes(chart: Chart): number[] {
  const out: number[] = [];
  chart.events.forEach((e, i) => {
    if (i > 0 && e.chord !== chart.events[i - 1].chord) out.push(e.startSec);
  });
  return out;
}

export interface PreparedChart {
  /** Respelled for the key, with the bar-phase aligned timing. */
  chart: Chart;
  key: KeyEstimate | null;
  timing: Timing;
  phase: PhaseEstimate;
  phaseShifted: boolean;
  changes: number[];
}

/** Key-aware spelling and bar-phase alignment: the chart every level is arranged from. */
export function prepareChart(source: Chart): PreparedChart {
  const { chart: spelled, key } = respellChartForKey(source);
  const changes = changeTimes(spelled);
  const aligned = alignBarPhase(spelled.timing, changes);
  return { chart: { ...spelled, timing: aligned.timing }, key, timing: aligned.timing, phase: aligned.estimate, phaseShifted: aligned.shifted, changes };
}

