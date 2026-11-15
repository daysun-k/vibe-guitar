/**
 * 코드 고치기 ‹ › stop at every chord change and at every "?" stretch the lane draws inside a chord
 * (joined marks once, a stretch covering its whole event not separately, only while 불확실한 곳 표시
 * is on). At a "?" stop the header names the stretch, only its bars are outlined, and a fix changes only
 * that stretch: the event is split at the stretch bounds and 처음 코드로 되돌리기 merges it back exactly.
 */
import Ajv from 'ajv';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../src/chart/chart.schema.json';
import { chartStorageKey, type Chart, type ChordEvent, type UncertainSpan } from '../src/chart/types';
import { validateChart } from '../src/chart/validate';
import { CorrectionConflict, correctChordEvent, correctChordStretch, restoreAutoChord, stretchIsCurrent, type FixStretch } from '../src/editor/correct';
import { ChartStore, handleChartWrite, type StorageArea } from '../src/extension/storage';
import { ChordFixer, fixStops, type FixHost } from '../src/extension/sidepanel/fix';
import { PlayScreen } from '../src/extension/sidepanel/play';
import { barsForUncertainStretch, buildPlayModel, type PlayModel } from '../src/play/model';

const NOW = new Date('2026-11-15T12:00:00.000Z');
const ID = 'fixstops001';
const schemaValidate = new Ajv({ allErrors: true }).compile(schema);
const span = (fromSec: number, toSec: number, chord: string, alt: string): UncertainSpan => ({ fromSec, toSec, chord, alt, replace: true });

/** 120 bpm 4/4 (a bar is 2 s), heard 0–12. */
function chart(events: [number, string][], uncertain: UncertainSpan[]): Chart {
  return {
    schemaVersion: 1,
    recording: { source: 'youtube', id: ID, title: 'T', artist: 'A' },
    timing: { bpm: 120, beatsPerBar: 4, beatUnit: 4, firstDownbeatSec: 0 },
    events: events.map(([startSec, chord]): ChordEvent => ({ startSec, chord, confidence: 0.7, source: 'auto' })),
    coverage: [{ fromSec: 0, toSec: 12 }],
    provenance: { createdBy: 'recognizer', createdAt: '2026-11-10T00:00:00.000Z' },
    uncertain,
  };
}
const model = (c: Chart, showUncertain = true) => buildPlayModel(c, { level: 'novice', capo: 0, showUncertain }, null);
/**
 * G 0–8 with "?" at 2–2.5 and 3–3.5 (joined over the 0.5 s gap: one drawn stretch 2–3.5) and at 5–6;
 * C 8–12 with one "?" covering the whole event.
 */
const SPANS = [span(2, 2.5, 'G', 'Em'), span(3, 3.5, 'G', 'Em'), span(5, 6, 'G', 'Em'), span(8, 12, 'C', 'Am')];
const gc = () => chart([[0, 'G'], [8, 'C']], SPANS);
const stops = (m: PlayModel) => fixStops(m).map((s) => (s.stretch ? [s.event, s.stretch.fromSec, s.stretch.toSec] : [s.event]));
/** A "?" stretch as the panel sends it: its bounds and the stored spans it was drawn from. */
const st = (fromSec: number, toSec: number, parts: [number, number][] = [[fromSec, toSec]]): FixStretch => ({ fromSec, toSec, parts: parts.map(([a, b]) => ({ fromSec: a, toSec: b })) });
/** The joined stretch 2–3.5 of gc(). */
const J23 = st(2, 3.5, [[2, 2.5], [3, 3.5]]);
const sameContent = (a: Chart, b: Chart) => {
  expect(a.events).toEqual(b.events);
  expect(a.uncertain).toEqual(b.uncertain);
};

describe('fixStops: event starts and the drawn "?" stretches, in time order', () => {
  it('each event, then its drawn stretches (joined marks once); a whole-event stretch is no stop', () => {
    const m = model(gc());
    expect(m.uncertain.map((u) => [u.fromSec, u.toSec])).toEqual([[2, 2.5], [3, 3.5], [5, 6], [8, 12]]);
    expect(stops(m)).toEqual([[0], [0, 2, 3.5], [0, 5, 6], [1]]);
    // a stretch names its first mark (the lane's flag)
    expect(fixStops(m).map((s) => s.stretch?.mark ?? null)).toEqual([null, 0, 2, null]);
  });
  it('불확실한 곳 표시 off: only the events', () => {
    expect(stops(model(gc(), false))).toEqual([[0], [1]]);
  });
  it('a stretch starting at its event start is its own stop (it does not cover the whole event)', () => {
    const m = model(chart([[0, 'G'], [8, 'C']], [span(0, 1, 'G', 'Em'), span(10, 12, 'C', 'Am')]));
    expect(stops(m)).toEqual([[0], [0, 0, 1], [1], [1, 10, 12]]);
  });
  it('a manually fixed event shows no "?", so it has no stretch stops', () => {
    const fixed = correctChordEvent(gc(), { startSec: 0, chord: 'G' }, 'D', NOW);
    expect(stops(model(fixed))).toEqual([[0], [1]]);
  });
});

describe('the outline at a "?" stop', () => {
  it('barsForUncertainStretch: only the bars the stretch is drawn in', () => {
    const m = model(gc());
    expect(barsForUncertainStretch(m, 0)).toEqual([1]); // 2–3.5 in bar [2,4)
    expect(barsForUncertainStretch(m, 2)).toEqual([2]); // 5–6 in bar [4,6)
    expect(barsForUncertainStretch(m, 99)).toEqual([]);
  });
  it('PlayScreen.markFix with a stretch outlines those bars, without it the whole event', () => {
    const m = model(gc());
    const barEls = m.bars.map(() => {
      const on = new Set<string>();
      return { on, classList: { toggle: (c: string, v: boolean) => (v ? on.add(c) : on.delete(c)), contains: (c: string) => on.has(c) } };
    });
    const self = { m, barEls, fol: { release: () => {}, reset: () => {} }, scrollToFix: () => {} } as unknown as PlayScreen;
    const outlined = () => barEls.flatMap((b, i) => (b.on.has('fix-at') ? [i] : []));
    PlayScreen.prototype.markFix.call(self, 0, 2);
    expect(outlined()).toEqual([2]);
    PlayScreen.prototype.markFix.call(self, 0);
    expect(outlined()).toEqual([0, 1, 2, 3]);
  });
});

describe('correctChordStretch: a fix at a "?" stop changes only the stretch', () => {
  it('splits the event at the stretch bounds; the head and tail keep the auto chord', () => {
    const before = gc();
    const after = correctChordStretch(before, { startSec: 0, chord: 'G' }, J23, 'D', NOW);
    expect(after.events).toEqual([
      { startSec: 0, chord: 'G', confidence: 0.7, source: 'auto' },
      { startSec: 2, chord: 'D', confidence: 1, source: 'manual', auto: { chord: 'G', confidence: 0.7, split: { startSec: 0, head: true, tail: true, fromSec: 2, toSec: 3.5 } } },
      { startSec: 3.5, chord: 'G', confidence: 0.7, source: 'auto' },
      { startSec: 8, chord: 'C', confidence: 0.7, source: 'auto' },
    ]);
    // the spans stay stored: hidden inside the fixed stretch, shown elsewhere
    expect(after.uncertain).toEqual(before.uncertain);
    expect(model(after).uncertain.map((u) => [u.fromSec, u.toSec])).toEqual([[5, 6], [8, 12]]);
    expect(after.provenance.createdBy).toBe('edited');
    expect(validateChart(after).ok).toBe(true);
    expect(schemaValidate(after), JSON.stringify(schemaValidate.errors)).toBe(true);
  });
  it('처음 코드로 되돌리기 returns the exact chart before the fix (spans included)', () => {
    const before = gc();
    const after = correctChordStretch(before, { startSec: 0, chord: 'G' }, st(5, 6), 'Am', NOW);
    const back = restoreAutoChord(after, { startSec: 5, chord: 'Am' }, null, NOW);
    sameContent(back, before);
    expect(stops(model(back))).toEqual(stops(model(before)));
  });
  it('no head when the stretch starts at the event start, no tail when it ends at the event end; both restore exactly', () => {
    const before = chart([[0, 'G'], [8, 'C']], [span(0, 1, 'G', 'Em'), span(6, 8, 'G', 'Em')]);
    const noHead = correctChordStretch(before, { startSec: 0, chord: 'G' }, st(0, 1), 'D', NOW);
    expect(noHead.events.map((e) => [e.startSec, e.chord, e.source])).toEqual([[0, 'D', 'manual'], [1, 'G', 'auto'], [8, 'C', 'auto']]);
    sameContent(restoreAutoChord(noHead, { startSec: 0, chord: 'D' }, null, NOW), before);
    const noTail = correctChordStretch(before, { startSec: 0, chord: 'G' }, st(6, 8), 'D', NOW);
    expect(noTail.events.map((e) => [e.startSec, e.chord, e.source])).toEqual([[0, 'G', 'auto'], [6, 'D', 'manual'], [8, 'C', 'auto']]);
    sameContent(restoreAutoChord(noTail, { startSec: 6, chord: 'D' }, null, NOW), before);
  });
  it('fixing the stretch again keeps the first record, so restore still merges back', () => {
    const before = gc();
    const once = correctChordStretch(before, { startSec: 0, chord: 'G' }, J23, 'D', NOW);
    const twice = correctChordEvent(once, { startSec: 2, chord: 'D' }, 'Em', NOW);
    sameContent(restoreAutoChord(twice, { startSec: 2, chord: 'Em' }, null, NOW), before);
  });
  it('a changed head fragment: only the chord comes back (no merge)', () => {
    const once = correctChordStretch(gc(), { startSec: 0, chord: 'G' }, J23, 'D', NOW);
    const headFixed = correctChordEvent(once, { startSec: 0, chord: 'G' }, 'Bm', NOW);
    const back = restoreAutoChord(headFixed, { startSec: 2, chord: 'D' }, null, NOW);
    expect(back.events.map((e) => [e.startSec, e.chord, e.source])).toEqual([[0, 'Bm', 'manual'], [2, 'G', 'auto'], [3.5, 'G', 'auto'], [8, 'C', 'auto']]);
  });
  it('stale charts are refused', () => {
    const c = gc();
    const fix = (ch: Chart, ref = { startSec: 0, chord: 'G' }, st = J23) => () => correctChordStretch(ch, ref, st, 'D', NOW);
    expect(fix(c, { startSec: 0, chord: 'Em' })).toThrow(CorrectionConflict); // another chord
    expect(fix(c, { startSec: 1, chord: 'G' })).toThrow(CorrectionConflict); // no event there
    expect(fix(correctChordEvent(c, { startSec: 0, chord: 'G' }, 'G', NOW))).toThrow(CorrectionConflict); // fixed by hand meanwhile
    expect(fix({ ...c, uncertain: [span(5, 6, 'G', 'Em')] })).toThrow(CorrectionConflict); // the spans changed
    expect(fix(c, undefined, st(2, 2.5))).not.toThrow(); // a stretch drawn from that one span (e.g. when its neighbour is no mark at this level) is still current
    expect(fix(c, undefined, st(2, 9))).toThrow(CorrectionConflict); // past the event
  });
  it('stale: a joined stretch whose middle span disappeared before the save is refused (review r1 F1)', () => {
    // 2–2.5, 3–3.5, 4–4.5 were drawn as one stretch 2–4.5; then 3–3.5 went away: now 2–2.5 and 4–4.5 apart.
    const three = chart([[0, 'G'], [8, 'C']], [span(2, 2.5, 'G', 'Em'), span(3, 3.5, 'G', 'Em'), span(4, 4.5, 'G', 'Em')]);
    const seen = fixStops(model(three)).find((s) => s.stretch)!.stretch!;
    expect([seen.fromSec, seen.toSec, seen.parts.length]).toEqual([2, 4.5, 3]);
    const now = { ...three, uncertain: [span(2, 2.5, 'G', 'Em'), span(4, 4.5, 'G', 'Em')] };
    expect(stops(model(now))).toEqual([[0], [0, 2, 2.5], [0, 4, 4.5], [1]]);
    expect(stretchIsCurrent(now, { startSec: 0, chord: 'G' }, seen)).toBe(false);
    expect(() => correctChordStretch(now, { startSec: 0, chord: 'G' }, seen, 'D', NOW)).toThrow(CorrectionConflict);
    // claiming only the ends does not help: the chain 2–2.5 → 4–4.5 has a 1.5 s gap
    expect(stretchIsCurrent(now, { startSec: 0, chord: 'G' }, st(2, 4.5, [[2, 2.5], [4, 4.5]]))).toBe(false);
    // still valid: accepted
    expect(stretchIsCurrent(three, { startSec: 0, chord: 'G' }, seen)).toBe(true);
    expect(correctChordStretch(three, { startSec: 0, chord: 'G' }, seen, 'D', NOW).events.map((e) => [e.startSec, e.chord])).toEqual([[0, 'G'], [2, 'D'], [4.5, 'G'], [8, 'C']]);
  });
  it('stale: the event changed chord meanwhile (a new analysis) is refused', () => {
    const now = { ...gc(), events: gc().events.map((e) => (e.startSec === 0 ? { ...e, chord: 'Em' } : e)), uncertain: [span(2, 2.5, 'Em', 'G'), span(3, 3.5, 'Em', 'G')] };
    expect(stretchIsCurrent(now, { startSec: 0, chord: 'G' }, J23)).toBe(false);
    expect(() => correctChordStretch(now, { startSec: 0, chord: 'G' }, J23, 'D', NOW)).toThrow(CorrectionConflict);
  });
  it('stale: parts out of order, a moved part or bounds that do not match the parts are refused', () => {
    const ref = { startSec: 0, chord: 'G' };
    expect(stretchIsCurrent(gc(), ref, st(2, 3.5, [[3, 3.5], [2, 2.5]]))).toBe(false);
    expect(stretchIsCurrent(gc(), ref, st(2, 3.5, [[2, 2.5], [3, 3.6]]))).toBe(false);
    expect(stretchIsCurrent(gc(), ref, st(2, 3.6, [[2, 2.5], [3, 3.5]]))).toBe(false);
    expect(stretchIsCurrent(gc(), ref, st(2, 3.5, []))).toBe(false);
    expect(stretchIsCurrent(gc(), ref, J23)).toBe(true);
  });
  it('a fix at an event stop is unchanged: the whole event', () => {
    const after = correctChordEvent(gc(), { startSec: 0, chord: 'G' }, 'D', NOW);
    expect(after.events).toHaveLength(2);
    expect(after.events[0]).toEqual({ startSec: 0, chord: 'D', confidence: 1, source: 'manual', auto: { chord: 'G', confidence: 0.7 } });
  });
});

describe('chart format: a "?" stretch split record', () => {
  const fixed = () => correctChordStretch(gc(), { startSec: 0, chord: 'G' }, J23, 'D', NOW);
  const withAuto = (auto: unknown): Chart => {
    const c = fixed();
    return { ...c, events: c.events.map((e, i) => (i === 1 ? ({ ...e, auto } as ChordEvent) : e)) };
  };
  it('split with its own bounds and no span is valid; with a span the bounds are not allowed; without either it is not', () => {
    const sp = { startSec: 0, head: true, tail: true };
    const bad = [
      withAuto({ chord: 'G', confidence: 0.7, split: sp }),
      withAuto({ chord: 'G', confidence: 0.7, split: { ...sp, fromSec: 2 } }),
      withAuto({ chord: 'G', confidence: 0.7, span: span(2, 3.5, 'G', 'Em'), split: { ...sp, fromSec: 2, toSec: 3.5 } }),
    ];
    for (const c of bad) {
      expect(validateChart(c).ok, JSON.stringify(c.events[1])).toBe(false);
      expect(schemaValidate(c), JSON.stringify(c.events[1])).toBe(false);
    }
    expect(validateChart(withAuto({ chord: 'G', confidence: 0.7, split: { ...sp, fromSec: 3.5, toSec: 2 } })).ok).toBe(false);
  });
});

describe('the serialized store path', () => {
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
  const base = { type: 'chart-write' as const, source: 'youtube' as const, id: ID, at: NOW.toISOString() };

  it('correct-event with a stretch splits only the stretch; restore-auto brings the stored chart back exactly', async () => {
    const area = new MemArea();
    area.data[MAIN] = gc();
    const store = new ChartStore(area);
    const r = await handleChartWrite(store, { ...base, op: 'correct-event', event: { startSec: 0, chord: 'G' }, chord: 'D', stretch: J23 });
    expect(r.ok).toBe(true);
    expect((area.data[MAIN] as Chart).events.map((e) => [e.startSec, e.chord])).toEqual([[0, 'G'], [2, 'D'], [3.5, 'G'], [8, 'C']]);
    const back = await handleChartWrite(store, { ...base, op: 'restore-auto', event: { startSec: 2, chord: 'D' } });
    expect(back.ok).toBe(true);
    sameContent(area.data[MAIN] as Chart, gc());
  });
  it('the reviewer\'s counterexample through the store: the middle span went away before the save, nothing is stored', async () => {
    const three = chart([[0, 'G'], [8, 'C']], [span(2, 2.5, 'G', 'Em'), span(3, 3.5, 'G', 'Em'), span(4, 4.5, 'G', 'Em')]);
    const seen = fixStops(model(three)).find((s) => s.stretch)!.stretch!;
    const stored = { ...three, uncertain: [span(2, 2.5, 'G', 'Em'), span(4, 4.5, 'G', 'Em')] };
    const area = new MemArea();
    area.data[MAIN] = stored;
    const store = new ChartStore(area);
    const r = await handleChartWrite(store, { ...base, op: 'correct-event', event: { startSec: 0, chord: 'G' }, chord: 'D', stretch: { fromSec: seen.fromSec, toSec: seen.toSec, parts: seen.parts } });
    expect(r).toMatchObject({ ok: false, error: '코드표가 그 사이에 바뀌었어요. 다시 골라 주세요.' });
    expect(area.data[MAIN]).toEqual(stored);
  });
  it('a stale stretch is refused and the stored chart stays', async () => {
    const area = new MemArea();
    area.data[MAIN] = gc();
    const store = new ChartStore(area);
    const r = await handleChartWrite(store, { ...base, op: 'correct-event', event: { startSec: 0, chord: 'G' }, chord: 'D', stretch: st(2.2, 3.5, [[2.2, 2.5], [3, 3.5]]) });
    expect(r).toMatchObject({ ok: false });
    expect(area.data[MAIN]).toEqual(gc());
  });
});

describe('코드 고치기 panel at "?" stops (fake DOM)', () => {
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
    click(target: unknown = { closest: () => null }) {
      for (const f of this.on) f({ target });
    }
  }
  let els: Record<string, El>;
  beforeEach(() => {
    els = {};
    vi.stubGlobal('document', { getElementById: (id: string) => (els[id] ??= new El()) });
  });
  afterEach(() => vi.unstubAllGlobals());

  const open = (c: Chart, t: number) => {
    let m = model(c);
    let now = t;
    const mark = vi.fn((_e: number | null, _s?: number) => {});
    const seek = vi.fn((sec: number) => {
      now = sec;
    });
    const save = vi.fn(async (..._args: unknown[]) => {});
    const host: FixHost = { model: () => m, now: () => now, seek, showSounding: () => false, mark, save, acceptAlt: async () => {}, restore: async () => {} };
    const fixer = new ChordFixer(host);
    fixer.open();
    const time = () => /<time>([^<]*)<\/time>/.exec(els['fix-which'].innerHTML)?.[1];
    const rebuild = (next: Chart) => {
      m = model(next);
      fixer.onModel();
    };
    return { fixer, mark, seek, save, time, rebuild, setModel: (next: PlayModel) => (m = next) };
  };
  /** Picks root D (pc 2), major, in the picker. */
  const pickD = () => {
    els['fix-roots'].click({ closest: () => ({ dataset: { pc: '2' } }) });
    els['fix-kinds'].click({ closest: () => ({ dataset: { q: '' } }) });
  };

  it('› walks event, "?" stretches, next event; ‹ walks back; the ends disable the arrows', () => {
    const { mark, seek, time } = open(gc(), 1);
    expect(mark).toHaveBeenLastCalledWith(0);
    expect(time()).toBe('0:00~0:08');
    expect(els['fix-prev'].disabled).toBe(true);
    els['fix-next'].click();
    expect(seek).toHaveBeenLastCalledWith(2.01);
    expect(mark).toHaveBeenLastCalledWith(0, 0);
    expect(time()).toBe('0:02~0:03');
    expect(els['fix-which'].innerHTML).toContain('자동으로 들은 코드 · 확실하지 않음');
    expect(els['fix-which'].innerHTML).toContain('대안: Em');
    els['fix-next'].click();
    expect(seek).toHaveBeenLastCalledWith(5.01);
    expect(mark).toHaveBeenLastCalledWith(0, 2);
    expect(time()).toBe('0:05~0:06');
    els['fix-next'].click();
    expect(seek).toHaveBeenLastCalledWith(8.01);
    expect(mark).toHaveBeenLastCalledWith(1);
    expect(time()).toBe('0:08~0:12');
    expect(els['fix-next'].disabled).toBe(true);
    els['fix-prev'].click();
    expect(mark).toHaveBeenLastCalledWith(0, 2);
    els['fix-prev'].click();
    expect(mark).toHaveBeenLastCalledWith(0, 0);
    els['fix-prev'].click();
    expect(mark).toHaveBeenLastCalledWith(0);
    expect(seek).toHaveBeenLastCalledWith(0.01);
    expect(els['fix-prev'].disabled).toBe(true);
  });

  it('with 불확실한 곳 표시 off the arrows move event to event', () => {
    const { mark, setModel, fixer } = open(gc(), 1);
    setModel(model(gc(), false));
    fixer.onModel();
    els['fix-next'].click();
    expect(mark).toHaveBeenLastCalledWith(1);
  });

  it('a fix at a "?" stop saves only the stretch; at an event stop the call is unchanged', async () => {
    const { save } = open(gc(), 1);
    els['fix-next'].click();
    pickD();
    els['fix-save'].click();
    await Promise.resolve();
    expect(save).toHaveBeenLastCalledWith({ startSec: 0, chord: 'G' }, 'D', { from: 'G', to: 'D' }, J23);
    const e = open(gc(), 1);
    pickD();
    els['fix-save'].click();
    await Promise.resolve();
    expect(e.save.mock.calls.at(-1)).toEqual([{ startSec: 0, chord: 'G' }, 'D', { from: 'G', to: 'D' }]);
  });

  it('while the fix is stored the selection moves to the new stretch event, then the panel closes as before', async () => {
    const h = open(gc(), 1);
    els['fix-next'].click();
    els['fix-next'].click(); // 5–6
    pickD();
    h.save.mockImplementation(async () => h.rebuild(correctChordStretch(gc(), { startSec: 0, chord: 'G' }, st(5, 6), 'D', NOW)));
    els['fix-save'].click();
    await new Promise((r) => setTimeout(r, 0));
    // the rebuilt model selected event 1 (D 5–6) as an event stop, then close cleared the outline
    expect(h.mark.mock.calls.slice(-2)).toEqual([[1], [null]]);
  });

  it('a model rebuild keeps the same "?" stop selected', () => {
    const h = open(gc(), 1);
    els['fix-next'].click();
    els['fix-next'].click();
    h.rebuild(gc());
    expect(h.mark).toHaveBeenLastCalledWith(0, 2);
    expect(h.time()).toBe('0:05~0:06');
  });
});
