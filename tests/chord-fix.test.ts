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
    // the first recognized chord is remembered for 처음 코드로 되돌리기
    expect(after.events[1]).toEqual({ startSec: 2, chord: 'Em', confidence: 1, source: 'manual', auto: { chord: before.events[1].chord, confidence: before.events[1].confidence } });
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
    expect(splitPick('A♭m7')).toEqual({ rootPc: 8, quality: 'm7', bassPc: null });
    expect(splitPick('C/B')).toEqual({ rootPc: 0, quality: '', bassPc: 11 });
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

describe('chord fix keeps a slash bass', () => {
  const inAb = estimateKey(timedChordsOf(chart('manual', [[0, 'Ab'], [2, 'Db'], [4, 'Eb'], [6, 'Fm'], [8, 'Ab']], [[0, 10]])));
  const inE = estimateKey(timedChordsOf(chart('manual', [[0, 'E'], [2, 'A'], [4, 'B'], [6, 'C#m'], [8, 'E']], [[0, 10]])));

  it('the picker starts at the original bass, also when shown with ♭/♯', () => {
    expect(splitPick('Am/G')).toEqual({ rootPc: 9, quality: 'm', bassPc: 7 });
    expect(splitPick('A♭/E♭')).toEqual({ rootPc: 8, quality: '', bassPc: 3 });
    expect(splitPick('F♯m7/C♯')).toEqual({ rootPc: 6, quality: 'm7', bassPc: 1 });
    expect(splitPick('C')?.bassPc).toBeNull(); // 베이스 없음 preselected
  });

  it('changing the root or kind keeps the bass; removing it drops the slash', () => {
    const p = splitPick('C/B')!;
    expect(pickName(9, 'm', p.bassPc)).toBe('Am/B'); // C/B -> pick Am -> Am/B
    expect(pickName(p.rootPc, 'maj7', p.bassPc)).toBe('Cmaj7/B');
    expect(pickName(9, 'm', null)).toBe('Am'); // 베이스 없음
    expect(pickToConcert(pickName(9, 'm', p.bassPc), 0, null)).toBe('Am/B');
    const fixed = correctChordEvent(chart('recognizer', [[0, 'C'], [2, 'C/B'], [4, 'Am']], [[0, 6]]), { startSec: 2, chord: 'C/B' }, 'Am/B', NOW);
    expect(fixed.events.map((e) => e.chord)).toEqual(['C', 'Am/B', 'Am']);
  });

  it('a bass equal to the root is not written as a slash', () => {
    expect(pickName(0, '', 0)).toBe('C');
    expect(pickName(9, 'm7', 9)).toBe('Am7');
    expect(pickToConcert('C/C', 0, null)).toBe('C');
    expect(pickToConcert('G/G', 1, inAb)).toBe('Ab');
  });

  it('capo shape names move root and bass up and spell both for the key', () => {
    expect(pickName(9, 'm', 0)).toBe('Am/C'); // shape names like capo shapes
    expect(pickName(0, '', 1)).toBe('C/C#');
    expect(pickName(0, '', 3)).toBe('C/Eb');
    expect(pickToConcert('Am/C', 1, inAb)).toBe('Bbm/Db'); // not Bbm/C#
    expect(pickToConcert('Am/C', 1, null)).toBe('Bbm/C#'); // no key: guitar spelling
    expect(pickToConcert('G/F#', 1, inAb)).toBe('Ab/G');
    expect(pickToConcert('C/B', 2, inE)).toBe('D/C#');
    expect(pickToConcert('B/Eb', 0, inE)).toBe('B/D#'); // sharp key respells the bass
    expect(shownName('Bbm/Db', 1)).toBe('Am/C'); // shown back as the same shape
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
    expect(await store.undoCorrection('youtube', rec.id, m.before, m.after)).toEqual(m.before);
    expect(area.data[MAIN]).toEqual(m.before);

    const area2 = new MemArea();
    const store2 = new ChartStore(area2);
    await store2.saveAuto(auto());
    const a = await store2.correctEvent('youtube', rec.id, { startSec: 2, chord: 'G#' }, 'Em', NOW);
    await store2.saveAuto(chart('recognizer', [[30, 'D']], [[30, 34]], '2026-11-12T11:00:00.000Z'));
    const restored = await store2.undoCorrection('youtube', rec.id, a.before, a.after);
    expect(restored.provenance.createdBy).toBe('recognizer');
    expect(restored.events.map((e) => e.chord)).toEqual(['C', 'G#', 'Am', 'F', 'D']);
  });

  it('undo is refused once the stored chart changed', async () => {
    const area = new MemArea();
    const store = new ChartStore(area);
    await store.saveManual(chart('manual', [[0, 'C'], [2, 'G']], [[0, 8]]));
    const m = await store.correctEvent('youtube', rec.id, { startSec: 2, chord: 'G' }, 'Em', NOW);
    await store.saveManual(chart('manual', [[0, 'D']], [[0, 8]]));
    await expect(store.undoCorrection('youtube', rec.id, m.before, m.after)).rejects.toThrow(CorrectionConflict);
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
    // it remembers the first recognized chord like 코드 고치기
    expect(r.chart.events[1]).toEqual({ startSec: 2, chord: 'Em', confidence: 1, source: 'manual', auto: { chord: existing.events[1].chord, confidence: existing.events[1].confidence } });
    expect(r.chart.events[3]).toEqual(existing.events[3]);
    expect(r.chart.coverage).toEqual(existing.coverage);
  });

  it('unchanged or one chord changed: the "?" stretches stay stored (first-session check F10)', () => {
    const existing: Chart = { ...auto(), uncertain: [{ fromSec: 2.5, toSec: 3.5, chord: 'G#', alt: 'E', replace: true }, { fromSec: 20.5, toSec: 21, chord: 'F', alt: 'Dm' }] };
    const same = buildChartDetailed({ ...base, chords: ['C', 'A♭', 'Am', 'F'], stamps: existing.events.map((e) => e.startSec), existing });
    expect(same.chart.uncertain).toEqual(existing.uncertain);
    const one = buildChartDetailed({ ...base, chords: ['C', 'Em', 'Am', 'F'], stamps: existing.events.map((e) => e.startSec), existing });
    expect(one.chart.uncertain).toEqual(existing.uncertain);
    const restamped = buildChartDetailed({ ...base, chords: ['C', 'G#', 'Am', 'F'], stamps: [0, 2.5, 4, 20], existing });
    expect(restamped.chart.uncertain).toBeUndefined();
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

describe('review vgt12-r1 regressions', () => {
  it('F1: undo is refused after an import that changed timing and coverage but not events or updatedAt', async () => {
    const area = new MemArea();
    const store = new ChartStore(area);
    await store.saveManual(chart('manual', [[0, 'C'], [2, 'G']], [[0, 8]]));
    const m = await store.correctEvent('youtube', rec.id, { startSec: 2, chord: 'G' }, 'Em', NOW);
    const imported: Chart = { ...structuredClone(m.after), timing: { ...m.after.timing, bpm: 96 }, coverage: [{ fromSec: 0, toSec: 30 }] };
    await store.saveManual(imported);
    await expect(store.undoCorrection('youtube', rec.id, m.before, m.after)).rejects.toThrow(CorrectionConflict);
    expect(area.data[MAIN]).toEqual(imported);
  });

  it('F1: a stored chart equal in content but with another key order still undoes', async () => {
    const area = new MemArea();
    const store = new ChartStore(area);
    await store.saveManual(chart('manual', [[0, 'C'], [2, 'G']], [[0, 8]]));
    const m = await store.correctEvent('youtube', rec.id, { startSec: 2, chord: 'G' }, 'Em', NOW);
    const reordered = Object.fromEntries(Object.entries(area.data[MAIN] as Chart).reverse());
    area.data[MAIN] = reordered;
    await expect(store.undoCorrection('youtube', rec.id, m.before, m.after)).resolves.toMatchObject({ events: m.before.events });
  });

  it('F2: through the YouTube Music fallback, undo restores the newer YouTube analysis', async () => {
    const area = new MemArea();
    const store = new ChartStore(area);
    const ytm = { ...auto(), recording: { ...rec, source: 'ytmusic' as const } };
    area.data[chartStorageKey('ytmusic', rec.id)] = ytm;
    area.data[autoChartKey('ytmusic', rec.id)] = ytm;
    const fix = await store.correctEvent('youtube', rec.id, { startSec: 2, chord: 'G#' }, 'Em', NOW);
    expect(fix.after.recording.source).toBe('youtube');
    expect(area.data[MAIN]).toEqual(fix.after);
    const newer = chart('recognizer', [[30, 'D']], [[30, 34]], '2026-11-12T11:00:00.000Z');
    expect(await store.saveAuto(newer)).toBe('pending');
    const restored = await store.undoCorrection('youtube', rec.id, fix.before, fix.after);
    expect(restored.recording.source).toBe('youtube');
    expect(restored.events.map((e) => e.chord)).toEqual(['C', 'G#', 'Am', 'F', 'D']);
    expect(restored.coverage).toEqual([{ fromSec: 0, toSec: 6 }, { fromSec: 20, toSec: 24 }, { fromSec: 30, toSec: 34 }]);
    expect(await store.load('youtube', rec.id)).toEqual(restored);
  });
});
