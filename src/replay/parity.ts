/**
 * Parity of an offline replay chart with the live chart stored in a capture's meta.json
 * (docs/recognition-replay.md). Identical means: coverage identical; the same chord events with
 * startSec equal after rounding to 1 ms; beat times, first downbeat, beats per bar and bpm equal
 * (times after 1 ms rounding). Confidence is reported apart (max absolute difference) and never
 * fails parity. Provenance (creation time, tool, note) and recording metadata are ignored.
 */
import type { Chart } from '../chart/types';

export interface ParityResult {
  ok: boolean;
  /** Human-readable differences, in chart order (empty when ok). */
  diffs: string[];
  /** Largest |confidence difference| over events that match; null when no event matched. */
  maxConfidenceDiff: number | null;
  events: { live: number; offline: number };
}

const ms = (t: number): number => Math.round(t * 1000);
const fmt = (t: number | undefined): string => (t === undefined ? '∅' : t.toFixed(3));

function compareTimes(name: string, a: number[], b: number[], diffs: string[]): void {
  if (a.length !== b.length) diffs.push(`${name}: ${a.length} live vs ${b.length} offline`);
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] === undefined || b[i] === undefined || ms(a[i]) !== ms(b[i])) diffs.push(`${name}[${i}]: live ${fmt(a[i])} vs offline ${fmt(b[i])}`);
  }
}

export function compareParity(live: Chart, offline: Chart): ParityResult {
  const diffs: string[] = [];
  const lc = live.coverage;
  const oc = offline.coverage;
  if (lc.length !== oc.length || lc.some((r, i) => r.fromSec !== oc[i].fromSec || r.toSec !== oc[i].toSec))
    diffs.push(`coverage: live ${JSON.stringify(lc)} vs offline ${JSON.stringify(oc)}`);

  let maxConf: number | null = null;
  const le = live.events;
  const oe = offline.events;
  if (le.length !== oe.length) diffs.push(`events: ${le.length} live vs ${oe.length} offline`);
  for (let i = 0; i < Math.max(le.length, oe.length); i++) {
    const a = le[i];
    const b = oe[i];
    if (!a || !b || a.chord !== b.chord || ms(a.startSec) !== ms(b.startSec)) {
      diffs.push(`event[${i}]: live ${a ? `${a.chord}@${fmt(a.startSec)}` : '∅'} vs offline ${b ? `${b.chord}@${fmt(b.startSec)}` : '∅'}`);
      continue;
    }
    if (typeof a.confidence === 'number' && typeof b.confidence === 'number') maxConf = Math.max(maxConf ?? 0, Math.abs(a.confidence - b.confidence));
  }

  const lt = live.timing;
  const ot = offline.timing;
  compareTimes('beatTimes', lt.beatTimes ?? [], ot.beatTimes ?? [], diffs);
  if (ms(lt.firstDownbeatSec) !== ms(ot.firstDownbeatSec)) diffs.push(`firstDownbeatSec: live ${fmt(lt.firstDownbeatSec)} vs offline ${fmt(ot.firstDownbeatSec)}`);
  if (lt.beatsPerBar !== ot.beatsPerBar) diffs.push(`beatsPerBar: live ${lt.beatsPerBar} vs offline ${ot.beatsPerBar}`);
  if (lt.bpm !== ot.bpm) diffs.push(`bpm: live ${lt.bpm} vs offline ${ot.bpm}`);
  return { ok: diffs.length === 0, diffs, maxConfidenceDiff: maxConf, events: { live: le.length, offline: oe.length } };
}
