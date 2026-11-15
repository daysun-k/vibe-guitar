/**
 * 처음 코드로 되돌리기: a fixed auto event remembers its first recognized chord (ChordEvent.auto), keeps
 * the first one across later fixes, and one tap brings it back; a 2순위로 바꾸기 split is merged back
 * and its span returned, so the chart equals the one before the replacement. Events fixed before the
 * field get the stored auto chart's chord. Stored and undone through the serialized ChartStore.
 */
import Ajv from 'ajv';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../src/chart/chart.schema.json';
import { autoChartKey, ChartStore, handleChartWrite, type StorageArea } from '../src/extension/storage';
import { chartStorageKey, type Chart, type ChordEvent, type UncertainSpan } from '../src/chart/types';
import { validateChart } from '../src/chart/validate';
import { CorrectionConflict, acceptUncertainAlt, autoChordAt, correctChordEvent, firstHeard, restoreAutoChord } from '../src/editor/correct';
import { ChordFixer, fixFirstHTML, type FixHost } from '../src/extension/sidepanel/fix';
import { demoChart } from '../src/play/demo';
import { buildPlayModel } from '../src/play/model';

const NOW = new Date('2026-11-15T12:00:00.000Z');
const schemaValidate = new Ajv({ allErrors: true }).compile(schema);
const rspan = (fromSec: number, toSec: number, chord: string, alt: string): UncertainSpan => ({ fromSec, toSec, chord, alt, replace: true });
const ID = 'restore0001';

/** C 0–4 (0.9), G 4–8 (0.45), Am 8–10 (0.7), heard 0–10. */
function base(uncertain?: UncertainSpan[]): Chart {
  const ev = (startSec: number, chord: string, confidence: number): ChordEvent => ({ startSec, chord, confidence, source: 'auto' });
  const c: Chart = {
    schemaVersion: 1,
    recording: { source: 'youtube', id: ID, title: 'T', artist: 'A' },
    timing: { bpm: 120, beatsPerBar: 4, beatUnit: 4, firstDownbeatSec: 0 },
    events: [ev(0, 'C', 0.9), ev(4, 'G', 0.45), ev(8, 'Am', 0.7)],
    coverage: [{ fromSec: 0, toSec: 10 }],
    provenance: { createdBy: 'recognizer', createdAt: '2026-11-10T00:00:00.000Z' },
  };
  if (uncertain) c.uncertain = uncertain;
  return c;
}
const sameContent = (a: Chart, b: Chart) => {
  expect(a.events).toEqual(b.events);
  expect(a.uncertain).toEqual(b.uncertain);
};

describe('the first recognized chord is remembered', () => {
  it('a fix stores it; a second fix keeps the first one', () => {
    const once = correctChordEvent(base(), { startSec: 4, chord: 'G' }, 'Em', NOW);
    expect(once.events[1]).toEqual({ startSec: 4, chord: 'Em', confidence: 1, source: 'manual', auto: { chord: 'G', confidence: 0.45 } });
    const twice = correctChordEvent(once, { startSec: 4, chord: 'Em' }, 'D', NOW);
    expect(twice.events[1]).toEqual({ startSec: 4, chord: 'D', confidence: 1, source: 'manual', auto: { chord: 'G', confidence: 0.45 } });
    // a hand-made event has no first recognized chord
    const manual: Chart = { ...base(), events: base().events.map((e) => ({ ...e, source: 'manual' as const, confidence: 1 })), provenance: { createdBy: 'manual', createdAt: 'x' } };
    expect(correctChordEvent(manual, { startSec: 4, chord: 'G' }, 'Em', NOW).events[1].auto).toBeUndefined();
  });

  it('2순위로 바꾸기 stores the chord and the consumed span on the replaced part', () => {
    const c = base([rspan(5, 6, 'G', 'Em')]);
    const out = acceptUncertainAlt(c, { startSec: 4, chord: 'G' }, c.uncertain![0], NOW);
    expect(out.events[2]).toEqual({ startSec: 5, chord: 'Em', confidence: 1, source: 'manual', auto: { chord: 'G', confidence: 0.45, span: rspan(5, 6, 'G', 'Em'), split: { startSec: 4, head: true, tail: true } } });
    // fixing that part again keeps the record, span included
    const again = correctChordEvent(out, { startSec: 5, chord: 'Em' }, 'D', NOW);
    expect(again.events[2].auto).toEqual({ chord: 'G', confidence: 0.45, span: rspan(5, 6, 'G', 'Em'), split: { startSec: 4, head: true, tail: true } });
  });
});

describe('restoreAutoChord', () => {
  it('after a plain fix: the auto event comes back exactly', () => {
    const before = base();
    const fixed = correctChordEvent(before, { startSec: 4, chord: 'G' }, 'Em', NOW);
    const back = restoreAutoChord(fixed, { startSec: 4, chord: 'Em' }, null, NOW);
    sameContent(back, before);
    expect(back.provenance.createdBy).toBe('edited');
    expect(validateChart(back).ok).toBe(true);
  });

  it('after 2순위로 바꾸기 (head, part, tail): merged back and the span returned, equal to the chart before', () => {
    for (const s of [rspan(5, 6, 'G', 'Em'), rspan(4, 6, 'G', 'Em'), rspan(6, 8, 'G', 'Em'), rspan(4, 8, 'G', 'Em')]) {
      const before = base([s]);
      const replaced = acceptUncertainAlt(before, { startSec: 4, chord: 'G' }, s, NOW);
      const part = replaced.events.find((e) => e.source === 'manual')!;
      const back = restoreAutoChord(replaced, { startSec: part.startSec, chord: part.chord }, null, NOW);
      sameContent(back, before);
      expect(validateChart(back).ok).toBe(true);
    }
  });

  it('after a replacement and a later fix of that part: still merged back to the original', () => {
    const before = base([rspan(5, 6, 'G', 'Em')]);
    const replaced = acceptUncertainAlt(before, { startSec: 4, chord: 'G' }, before.uncertain![0], NOW);
    const fixed = correctChordEvent(replaced, { startSec: 5, chord: 'Em' }, 'D', NOW);
    sameContent(restoreAutoChord(fixed, { startSec: 5, chord: 'D' }, null, NOW), before);
  });

  it('a recorded fragment changed meanwhile: only the chord comes back (no merge, no span); an overlapping span is not duplicated', () => {
    const before = base([rspan(5, 6, 'G', 'Em')]);
    const replaced = acceptUncertainAlt(before, { startSec: 4, chord: 'G' }, before.uncertain![0], NOW);
    const headFixed = correctChordEvent(replaced, { startSec: 4, chord: 'G' }, 'Bm', NOW);
    const back = restoreAutoChord(headFixed, { startSec: 5, chord: 'Em' }, null, NOW);
    expect(back.events.map((e) => [e.startSec, e.chord, e.source])).toEqual([[0, 'C', 'auto'], [4, 'Bm', 'manual'], [5, 'G', 'auto'], [6, 'G', 'auto'], [8, 'Am', 'auto']]);
    expect(back.uncertain).toEqual([]);
    // the same when the tail changed
    const tailFixed = correctChordEvent(replaced, { startSec: 6, chord: 'G' }, 'D', NOW);
    expect(restoreAutoChord(tailFixed, { startSec: 5, chord: 'Em' }, null, NOW).events.map((e) => [e.startSec, e.chord])).toEqual([[0, 'C'], [4, 'G'], [5, 'G'], [6, 'D'], [8, 'Am']]);
    // a record without `split` (incomplete) is not guessed at
    const noSplit: Chart = { ...replaced, events: replaced.events.map((e) => (e.auto ? { ...e, auto: { chord: e.auto.chord, confidence: e.auto.confidence, span: e.auto.span } } : e)) };
    expect(restoreAutoChord(noSplit, { startSec: 5, chord: 'Em' }, null, NOW).events).toHaveLength(5);
    const overlapped: Chart = { ...replaced, uncertain: [rspan(5.5, 7, 'G', 'D')] };
    expect(restoreAutoChord(overlapped, { startSec: 5, chord: 'Em' }, null, NOW).uncertain).toEqual([rspan(5.5, 7, 'G', 'D')]);
  });

  it('review r1 F1: a pre-existing auto neighbour with the same chord and confidence is never merged', () => {
    const cs = (coverage: [number, number][], starts: number[], uncertain: UncertainSpan[]): Chart => ({
      ...base(uncertain),
      events: starts.map((startSec): ChordEvent => ({ startSec, chord: 'C', confidence: 0.7, source: 'auto' })),
      coverage: coverage.map(([fromSec, toSec]) => ({ fromSec, toSec })),
    });
    // the reviewer's counterexample: C@0 heard to 2, C@4 heard 4–8, span 4–6 C→Am
    // then the same with abutting coverage (C@4 a separate event right after C@0's range), and a C after the event
    const cases: [Chart, number][] = [
      [cs([[0, 2], [4, 8]], [0, 4], [rspan(4, 6, 'C', 'Am')]), 4],
      [cs([[0, 8]], [0, 4], [rspan(4, 6, 'C', 'Am')]), 4],
      [cs([[0, 12]], [0, 4, 8], [rspan(6, 8, 'C', 'Am')]), 6],
    ];
    for (const [before, at] of cases) {
      const replaced = acceptUncertainAlt(before, { startSec: 4, chord: 'C' }, before.uncertain![0], NOW);
      const back = restoreAutoChord(replaced, { startSec: at, chord: 'Am' }, null, NOW);
      sameContent(back, before); // C@4 and the 4–8 s chord stay
      expect(back.events.map((e) => e.startSec)).toContain(4);
      expect(validateChart(back).ok).toBe(true);
    }
  });

  it('a no-chord stretch replaced by its second choice comes back as no chord', () => {
    const c: Chart = { ...base([rspan(8.5, 9.5, 'N', 'F')]), events: [...base().events.slice(0, 2), { startSec: 8, chord: 'N', confidence: 0.5, source: 'auto' }] };
    const replaced = acceptUncertainAlt(c, { startSec: 8, chord: 'N' }, c.uncertain![0], NOW);
    sameContent(restoreAutoChord(replaced, { startSec: 8.5, chord: 'F' }, null, NOW), c);
  });

  it('conflicts: a changed event, an auto event, nothing remembered', () => {
    const fixed = correctChordEvent(base(), { startSec: 4, chord: 'G' }, 'Em', NOW);
    expect(() => restoreAutoChord(fixed, { startSec: 4, chord: 'G' }, null, NOW)).toThrow(CorrectionConflict); // the panel saw the old chord
    expect(() => restoreAutoChord(base(), { startSec: 4, chord: 'G' }, null, NOW)).toThrow(CorrectionConflict);
    const old: Chart = { ...fixed, events: fixed.events.map(({ auto: _, ...e }) => e) };
    expect(() => restoreAutoChord(old, { startSec: 4, chord: 'Em' }, null, NOW)).toThrow(/처음 들은 코드/);
  });
});

describe('events fixed before ChordEvent.auto: the stored auto chart', () => {
  const oldFix = (): Chart => {
    const f = correctChordEvent(base(), { startSec: 4, chord: 'G' }, 'Em', NOW);
    return { ...f, events: f.events.map(({ auto: _, ...e }) => e) };
  };

  it('autoChordAt and firstHeard: the auto chord sounding there, only when it differs', () => {
    expect(autoChordAt(base(), 4)).toEqual({ chord: 'G', confidence: 0.45 });
    expect(autoChordAt(base(), 6.5)).toEqual({ chord: 'G', confidence: 0.45 });
    expect(autoChordAt(base(), 12)).toBeNull(); // not heard there
    const e = oldFix().events[1];
    expect(firstHeard(e, autoChordAt(base(), e.startSec))).toEqual({ chord: 'G', confidence: 0.45 });
    expect(firstHeard({ ...e, chord: 'G' }, autoChordAt(base(), e.startSec))).toBeNull();
    expect(firstHeard(base().events[1], { chord: 'D', confidence: 1 })).toBeNull(); // an auto event
    expect(firstHeard({ ...e, auto: { chord: 'C', confidence: 0.2 } }, { chord: 'D', confidence: 1 })).toEqual({ chord: 'C', confidence: 0.2 });
  });

  class MemArea implements StorageArea {
    data: Record<string, unknown> = {};
    async get(keys: string[] | null): Promise<Record<string, unknown>> {
      const out: Record<string, unknown> = {};
      for (const k of keys ?? Object.keys(this.data)) if (k in this.data) out[k] = structuredClone(this.data[k]);
      return out;
    }
    async set(items: Record<string, unknown>): Promise<void> {
      Object.assign(this.data, structuredClone(items));
    }
  }
  const MAIN = chartStorageKey('youtube', ID);
  const msg = (chord: string) => ({ type: 'chart-write' as const, op: 'restore-auto' as const, source: 'youtube' as const, id: ID, event: { startSec: 4, chord }, at: NOW.toISOString() });

  it('the store restores from the stored auto chart (no span) and undo brings the fix back', async () => {
    const area = new MemArea();
    area.data[autoChartKey('youtube', ID)] = base();
    area.data[MAIN] = oldFix();
    const store = new ChartStore(area);
    const r = await handleChartWrite(store, msg('Em'));
    expect(r.ok).toBe(true);
    const after = area.data[MAIN] as Chart;
    expect(after.events).toEqual(base().events);
    expect(after.uncertain).toBeUndefined();
    const undone = await store.undoCorrection('youtube', ID, (r as { before: Chart }).before, after);
    expect(undone.events[1]).toMatchObject({ chord: 'Em', source: 'manual' });
  });

  it('without a stored auto chart, or after the chart changed, the store refuses', async () => {
    const area = new MemArea();
    area.data[MAIN] = oldFix();
    const store = new ChartStore(area);
    const none = await handleChartWrite(store, msg('Em'));
    expect(none).toMatchObject({ ok: false });
    area.data[autoChartKey('youtube', ID)] = base();
    expect(await handleChartWrite(store, msg('D'))).toMatchObject({ ok: false }); // the panel saw another chord
    expect(area.data[MAIN]).toEqual(oldFix());
  });
});

describe('chart format', () => {
  it('auto is optional, manual-only and strictly shaped (validate and schema agree)', () => {
    const ok = correctChordEvent(base(), { startSec: 4, chord: 'G' }, 'Em', NOW);
    const replaced = acceptUncertainAlt(base([rspan(5, 6, 'G', 'Em')]), { startSec: 4, chord: 'G' }, rspan(5, 6, 'G', 'Em'), NOW);
    for (const c of [base(), ok, replaced]) {
      expect(validateChart(c).ok).toBe(true);
      expect(schemaValidate(c), JSON.stringify(schemaValidate.errors)).toBe(true);
    }
    const withEvent = (e: Partial<ChordEvent> & Record<string, unknown>): Chart => ({ ...ok, events: [ok.events[0], { ...ok.events[1], ...e } as ChordEvent, ok.events[2]] });
    const bad = [
      withEvent({ source: 'auto' }), // auto events carry no record
      withEvent({ auto: { chord: 'G' } as never }),
      withEvent({ auto: { chord: 'G', confidence: 2 } }),
      withEvent({ auto: { chord: 'H#', confidence: 0.4 } }),
      withEvent({ auto: { chord: 'G', confidence: 0.4, extra: 1 } as never }),
      withEvent({ auto: { chord: 'G', confidence: 0.4, span: { fromSec: 6, toSec: 5, chord: 'G', alt: 'Em' } } }),
      withEvent({ auto: { chord: 'G', confidence: 0.4, span: { fromSec: 5, toSec: 6, chord: 'G', alt: 'Em', replace: false } as never } }),
      withEvent({ auto: { chord: 'G', confidence: 0.4, span: rspan(5, 6, 'G', 'Em') } }), // span without split
      withEvent({ auto: { chord: 'G', confidence: 0.4, split: { startSec: 4, head: true, tail: false } } }), // split without span
      withEvent({ auto: { chord: 'G', confidence: 0.4, span: rspan(5, 6, 'G', 'Em'), split: { startSec: 4, head: 1 } as never } }),
    ];
    for (const c of bad) expect(validateChart(c).ok, JSON.stringify(c.events[1])).toBe(false);
    // the schema checks the same shape (it cannot compare span bounds)
    for (const c of [bad[0], bad[1], bad[2], bad[4], bad[6], bad[7], bad[8], bad[9]]) expect(schemaValidate(c), JSON.stringify(c.events[1])).toBe(false);
  });
});

describe('코드 고치기: "처음 들은 코드: X" and 처음 코드로 되돌리기 (fake DOM)', () => {
  class El {
    hidden = true;
    disabled = false;
    innerHTML = '';
    private on: ((e: unknown) => void)[] = [];
    addEventListener(type: string, f: (e: unknown) => void) {
      if (type === 'click') this.on.push(f);
    }
    setAttribute() {}
    querySelector() {
      return null;
    }
    focus() {}
    /** A click on the restore button. */
    clickRestore() {
      for (const f of this.on) f({ target: { closest: (sel: string) => (sel === '[data-restore]' ? {} : null) } });
    }
  }
  let els: Record<string, El>;
  beforeEach(() => {
    els = {};
    vi.stubGlobal('document', { getElementById: (id: string) => (els[id] ??= new El()) });
  });
  afterEach(() => vi.unstubAllGlobals());

  const open = (c: Chart, t: number, storedAutoAt?: FixHost['storedAutoAt']) => {
    els = {};
    const m = buildPlayModel(c, { level: 'beginner', capo: 'auto' }, null);
    const restore = vi.fn(async () => {});
    const host: FixHost = { model: () => m, now: () => t, seek: () => {}, showSounding: () => false, mark: () => {}, save: async () => {}, acceptAlt: async () => {}, restore, storedAutoAt };
    const fixer = new ChordFixer(host);
    fixer.open();
    return { fixer, which: els['fix-which'], restore };
  };
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it('demo verse Fm after 대안 G: the first chord is named as a capo shape (Em) and one tap restores it', async () => {
    const d = demoChart();
    const replaced = acceptUncertainAlt(d, { startSec: 11.6, chord: 'Fm' }, d.uncertain![0], NOW);
    const { fixer, which, restore } = open(replaced, 12.4);
    expect(which.innerHTML).toBe(`<time>0:11~0:13</time> <b>G</b><small>직접 고른 코드</small>${fixFirstHTML('Em')}`);
    expect(fixFirstHTML('Em')).toBe('<span class="fix-first">처음 들은 코드: Em <button class="fix-restore" data-restore="1">처음 코드로 되돌리기</button></span>');
    which.clickRestore();
    await flush();
    expect(restore).toHaveBeenCalledWith({ startSec: 11.6, chord: 'Ab' }, { from: 'G', to: 'Em' });
    expect(fixer.isOpen).toBe(false);
    // the stored chart after that tap is the demo chart again
    sameContent(restoreAutoChord(replaced, { startSec: 11.6, chord: 'Ab' }, null, NOW), d); // the panel's key-respelled name finds it
  });

  it('an auto event shows nothing; an event fixed earlier shows the stored auto chart\'s chord', () => {
    expect(open(demoChart(), 12.4).which.innerHTML).not.toContain('fix-first');
    const d = demoChart();
    const fixed = correctChordEvent(d, { startSec: 11.6, chord: 'Fm' }, 'D', NOW);
    const old: Chart = { ...fixed, events: fixed.events.map(({ auto: _, ...e }) => e) };
    expect(open(old, 12.4).which.innerHTML).not.toContain('fix-first'); // no stored auto chart
    const { which } = open(old, 12.4, (sec) => autoChordAt(d, sec));
    expect(which.innerHTML).toContain(fixFirstHTML('Em'));
  });
});
