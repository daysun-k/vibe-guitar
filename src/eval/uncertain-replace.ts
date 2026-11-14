/**
 * A chart's uncertain spans (VGT-19) taken as replacements: every span shows its second choice
 * (`alt`) instead of the event's chord. Used offline for the protocol's "blind replacement" and
 * "net sequence recovery" numbers (docs/uncertainty-protocol.md); the shown chart never changes.
 */
import type { Chart, ChordEvent } from '../chart/types';
import { chartIntervals } from './metrics';

/** The chart with every uncertain span replaced by its second choice (for scoring only: no `uncertain` key, events inside coverage, confidence 0). */
export function chartWithSecondChoices(chart: Chart): Chart {
  const spans = [...(chart.uncertain ?? [])].sort((a, b) => a.fromSec - b.fromSec);
  const events: ChordEvent[] = [];
  const push = (startSec: number, chord: string) => events.push({ startSec, chord, confidence: 0, source: 'auto' });
  for (const i of chartIntervals(chart.events, chart.coverage)) {
    let cursor = i.startSec;
    for (const s of spans) {
      if (s.toSec <= i.startSec || s.fromSec >= i.endSec) continue;
      if (s.chord !== i.symbol) throw new Error(`uncertain span ${s.fromSec}-${s.toSec} names ${s.chord}, the chart shows ${i.symbol} there`);
      const from = Math.max(s.fromSec, i.startSec);
      if (from > cursor) push(cursor, i.symbol);
      push(from, s.alt);
      cursor = Math.min(s.toSec, i.endSec);
    }
    if (cursor < i.endSec) push(cursor, i.symbol);
  }
  const { uncertain: _uncertain, ...rest } = chart;
  return { ...rest, events };
}

/** Chord changes inside coverage: touching consecutive intervals with different chords. */
export function chordChanges(chart: Chart): number {
  const ints = chartIntervals(chart.events, chart.coverage);
  let n = 0;
  for (let k = 1; k < ints.length; k++) if (Math.abs(ints[k].startSec - ints[k - 1].endSec) < 1e-9 && ints[k].symbol !== ints[k - 1].symbol) n++;
  return n;
}
