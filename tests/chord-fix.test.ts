/**
 * VGT-12: fixing one wrong chord of an automatic chart from the play view, and the editor
 * save that no longer erases an auto chart's uncertainty and unheard gaps.
 */
import { describe, expect, it } from 'vitest';
import { chartStorageKey, type Chart, type ChordEvent, type Recording } from '../src/chart/types';
import { buildChartDetailed, quantizeStamps } from '../src/editor/core';
import { CorrectionConflict, correctChordEvent, pickName, pickToConcert, splitPick } from '../src/editor/correct';
import { ChartStore, autoChartKey, type StorageArea } from '../src/extension/storage';
import { eventIndexAt, originNote, shownName } from '../src/extension/sidepanel/fix';
import { estimateKey, timedChordsOf } from '../src/music/key';

const rec: Recording = { source: 'youtube', id: 'fixfixfix01', title: 'T', artist: 'A' };
const MAIN = chartStorageKey('youtube', rec.id);
const AUTO = autoChartKey('youtube', rec.id);
const NOW = new Date('2026-11-12T10:00:00.000Z');

function chart(createdBy: Chart['provenance']['createdBy'], events: [number, string, number?][], coverage: [number, number][], createdAt = '2026-11-10T00:00:00.000Z'): Chart {
  return {
    schemaVersion: 1,
    recording: { ...rec },
    timing: { bpm: 120, beatsPerBar: 4, beatUnit: 4, firstDownbeatSec: 0 },
    events: events.map(([startSec, chord, confidence]): ChordEvent => ({ startSec, chord, confidence: confidence ?? 1, source: createdBy === 'recognizer' ? 'auto' : 'manual' })),
    coverage: coverage.map(([fromSec, toSec]) => ({ fromSec, toSec })),
    provenance: { createdBy, createdAt },
  };
}

/** A partly heard auto chart: two heard ranges with a gap, mixed confidences. */
const auto = (): Chart =>
  chart(
    'recognizer',
    [
      [0, 'C', 0.9],
      [2, 'G#', 0.4],
      [4, 'Am', 0.7],
      [20, 'F', 0.8],
    ],
    [
      [0, 6],
      [20, 24],
    ],
  );

class MemArea implements StorageArea {
  data: Record<string, unknown> = {};
  afterGet: { key: string; fn: () => void } | null = null;
  async get(keys: string[] | null): Promise<Record<string, unknown>> {
    await new Promise((r) => setTimeout(r, 0));
    const out: Record<string, unknown> = {};
    for (const k of keys ?? Object.keys(this.data)) if (k in this.data) out[k] = structuredClone(this.data[k]);
    const hook = this.afterGet;
    if (hook && keys?.includes(hook.key)) {
      this.afterGet = null;
      hook.fn();
    }
    return out;
  }
  async set(items: Record<string, unknown>): Promise<void> {
    await new Promise((r) => setTimeout(r, 0));
    Object.assign(this.data, structuredClone(items));
  }
}

describe('correctChordEvent: one event, nothing else', () => {
  it('changes only that chord; times, gaps, other confidences and createdAt stay', () => {
    const before = auto();
    const copy = structuredClone(before);
    // The panel shows key-respelled names ("A♭" for a stored "G#"): the event is still found.
    const after = correctChordEvent(before, { startSec: 2, chord: 'Ab' }, 'Em', NOW);
    expect(before).toEqual(copy); // not mutated
    expect(after.events[1]).toEqual({ startSec: 2, chord: 'Em', confidence: 1, source: 'manual' });
    expect([after.events[0], after.events[2], after.events[3]]).toEqual([before.events[0], before.events[2], before.events[3]]);
    expect(after.coverage).toEqual(before.coverage);
    expect(after.timing).toEqual(before.timing);
    expect(after.provenance).toMatchObject({ createdBy: 'edited', createdAt: before.provenance.createdAt, updatedAt: NOW.toISOString() });
  });

  it('a hand-made chart stays manual; no chord is stored as N; a changed chart is a conflict', () => {
    const manual = chart('manual', [[0, 'C'], [2, 'G']], [[0, 8]]);
    const fixed = correctChordEvent(manual, { startSec: 2, chord: 'G' }, 'N.C.', NOW);
    expect(fixed.provenance.createdBy).toBe('manual');
    expect(fixed.events[1].chord).toBe('N');
    expect(() => correctChordEvent(manual, { startSec: 2, chord: 'D' }, 'Em', NOW)).toThrow(CorrectionConflict);
    expect(() => correctChordEvent(manual, { startSec: 2.5, chord: 'G' }, 'Em', NOW)).toThrow(CorrectionConflict);
    expect(() => correctChordEvent(manual, { startSec: 2, chord: 'G' }, 'Hm', NOW)).toThrow();
  });
});

describe('pickToConcert: capo shape names to stored sounding chords', () => {
  const inAb = estimateKey(timedChordsOf(chart('manual', [[0, 'Ab'], [2, 'Db'], [4, 'Eb'], [6, 'Fm'], [8, 'Ab']], [[0, 10]])));
  const inE = estimateKey(timedChordsOf(chart('manual', [[0, 'E'], [2, 'A'], [4, 'B'], [6, 'C#m'], [8, 'E']], [[0, 10]])));

  it('moves the shape up by the capo and spells it for the key', () => {
    expect(inAb?.tonicName).toBe('Ab');
    expect(pickToConcert('G', 1, inAb)).toBe('Ab'); // not G#
    expect(pickToConcert('Em', 1, inAb)).toBe('Fm');
    expect(pickToConcert('D7', 1, inAb)).toBe('Eb7');
    expect(pickToConcert('C', 1, inAb)).toBe('Db');
    expect(pickToConcert('G#', 0, inAb)).toBe('Ab');
    expect(inE?.tonicName).toBe('E');
    expect(pickToConcert('D', 2, inE)).toBe('E');
    expect(pickToConcert('Ab', 2, inE)).toBe('A#'); // outside the scale: the sharp key's spelling
    expect(pickToConcert('N', 3, inE)).toBe('N');
    expect(pickToConcert('G', 1, null)).toBe('Ab'); // no key: guitar spelling
  });

  it('the picker starts at the shown shape and names choices like capo shapes', () => {
    expect(splitPick('A♭m7')).toEqual({ rootPc: 8, quality: 'm7' });
    expect(splitPick('C/B')).toEqual({ rootPc: 0, quality: '' });
    expect(splitPick('N.C.')).toBeNull();
    expect(pickName(8, 'm')).toBe('G#m');
    expect(pickName(8, '')).toBe('Ab');
    expect(shownName('Ab', 1)).toBe('G');
    expect(shownName('N', 1)).toBe('코드 없음');
    expect(eventIndexAt([{ startSec: 1 }, { startSec: 3 }, { startSec: 5 }], 0)).toBe(0);
    expect(eventIndexAt([{ startSec: 1 }, { startSec: 3 }, { startSec: 5 }], 4.2)).toBe(1);
    expect(originNote({ source: 'auto', confidence: 0.4 })).toContain('확실하지 않음');
    expect(originNote({ source: 'manual', confidence: 1 })).toBe('직접 고른 코드');
  });
});

describe('ChartStore: corrections go through the serialized writes', () => {
  it('the correction survives a later auto analysis and a reload', async () => {
    const area = new MemArea();
    const store = new ChartStore(area);
    await store.saveAuto(auto());
    const { before, after } = await store.correctEvent('youtube', rec.id, { startSec: 2, chord: 'G#' }, 'Em', NOW);
    expect(before.provenance.createdBy).toBe('recognizer');
    expect(after.events[1].chord).toBe('Em');
    const later = chart('recognizer', [[30, 'D']], [[30, 34]], '2026-11-12T11:00:00.000Z');
    expect(await store.saveAuto(later)).toBe('pending');
    const reloaded = await new ChartStore(area).load('youtube', rec.id);
    expect(reloaded).toEqual(after);
    expect((area.data[AUTO] as Chart).events.map((e) => e.chord)).toEqual(['C', 'G#', 'Am', 'F', 'D']);
  });

  it('a correction queued behind an auto save applies to the newly stored chart', async () => {
    const area = new MemArea();
    const store = new ChartStore(area);
    await store.saveAuto(auto());
    let fix: Promise<unknown> | null = null;
    area.afterGet = { key: MAIN, fn: () => (fix = store.correctEvent('youtube', rec.id, { startSec: 4, chord: 'Am' }, 'A', NOW)) };
    await store.saveAuto(chart('recognizer', [[30, 'D']], [[30, 34]], '2026-11-12T11:00:00.000Z'));
    await fix;
    const main = area.data[MAIN] as Chart;
    expect(main.events.map((e) => [e.startSec, e.chord, e.source])).toEqual([
      [0, 'C', 'auto'],
      [2, 'G#', 'auto'],
      [4, 'A', 'manual'],
      [20, 'F', 'auto'],
      [30, 'D', 'auto'],
    ]);
    expect(main.coverage).toEqual([{ fromSec: 0, toSec: 6 }, { fromSec: 20, toSec: 24 }, { fromSec: 30, toSec: 34 }]);
  });

  it('undo restores the previous chart, following later auto analyses for an auto chart', async () => {
    const area = new MemArea();
    const store = new ChartStore(area);
    await store.saveManual(chart('manual', [[0, 'C'], [2, 'G']], [[0, 8]]));
    const m = await store.correctEvent('youtube', rec.id, { startSec: 2, chord: 'G' }, 'Em', NOW);
    expect(await store.undoCorrection(m.before, m.after)).toEqual(m.before);
    expect(area.data[MAIN]).toEqual(m.before);

    const area2 = new MemArea();
    const store2 = new ChartStore(area2);
    await store2.saveAuto(auto());
    const a = await store2.correctEvent('youtube', rec.id, { startSec: 2, chord: 'G#' }, 'Em', NOW);
    await store2.saveAuto(chart('recognizer', [[30, 'D']], [[30, 34]], '2026-11-12T11:00:00.000Z'));
    const restored = await store2.undoCorrection(a.before, a.after);
    expect(restored.provenance.createdBy).toBe('recognizer');
    expect(restored.events.map((e) => e.chord)).toEqual(['C', 'G#', 'Am', 'F', 'D']);
  });

  it('undo is refused once the stored chart changed', async () => {
    const area = new MemArea();
    const store = new ChartStore(area);
    await store.saveManual(chart('manual', [[0, 'C'], [2, 'G']], [[0, 8]]));
    const m = await store.correctEvent('youtube', rec.id, { startSec: 2, chord: 'G' }, 'Em', NOW);
    await store.saveManual(chart('manual', [[0, 'D']], [[0, 8]]));
    await expect(store.undoCorrection(m.before, m.after)).rejects.toThrow(CorrectionConflict);
    expect((area.data[MAIN] as Chart).events[0].chord).toBe('D');
  });
});

describe('editor save of a loaded auto chart', () => {
  const timing = auto().timing;
  const base = { recording: rec, timing, durationSec: 30, now: NOW };

  it('unchanged: every event keeps its source/confidence and the coverage keeps its gap', () => {
    const existing = auto();
    // The editor reads the key-respelled sequence text ("A♭" for "G#").
    const r = buildChartDetailed({ ...base, chords: ['C', 'A♭', 'Am', 'F'], stamps: existing.events.map((e) => e.startSec), existing });
    expect(r.preservation).toBe('kept');
    expect(r.changed).toBe(0);
    expect(r.chart.events).toEqual(existing.events);
    expect(r.chart.coverage).toEqual(existing.coverage);
    expect(r.chart.provenance.createdBy).toBe('edited');
  });

  it('one chord changed: only that event becomes manual', () => {
    const existing = auto();
    const r = buildChartDetailed({ ...base, chords: ['C', 'Em', 'Am', 'F'], stamps: existing.events.map((e) => e.startSec), existing });
    expect(r.changed).toBe(1);
    expect(r.chart.events[1]).toEqual({ startSec: 2, chord: 'Em', confidence: 1, source: 'manual' });
    expect(r.chart.events[3]).toEqual(existing.events[3]);
    expect(r.chart.coverage).toEqual(existing.coverage);
  });

  it('re-stamped times: today’s behaviour, reported as lost', () => {
    const existing = auto();
    const r = buildChartDetailed({ ...base, chords: ['C', 'G#', 'Am', 'F'], stamps: [0, 2.5, 4, 20], existing });
    expect(r.preservation).toBe('lost');
    expect(r.chart.events.every((e) => e.source === 'manual' && e.confidence === 1)).toBe(true);
    expect(r.chart.coverage).toEqual([{ fromSec: 0, toSec: 30 }]);
  });

  it('quantizing leaves the loaded event times alone', () => {
    const t = { ...timing, firstDownbeatSec: 0.13 };
    expect(quantizeStamps([0.2, 2.07, 3.1], t, 2, new Set([2.07]))).toEqual([0.13, 2.07, 3.13]);
  });
});
