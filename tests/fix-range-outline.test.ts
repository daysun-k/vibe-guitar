/**
 * 코드 고치기 shows the whole range of the chord event it fixes: the dashed outline covers every lane
 * bar that draws the event (following the lane's own cut rules), and the header names the event's time
 * range ("0:02~0:09"). The ‹ › arrows still step from event to event.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Chart, ChordEvent, CoverageRange } from '../src/chart/types';
import { ChordFixer, fixTimeText, type FixHost } from '../src/extension/sidepanel/fix';
import { PlayScreen } from '../src/extension/sidepanel/play';
import { barsForChartEvent, buildPlayModel, chartEventRange, type PlayModel } from '../src/play/model';

/** 120 bpm 4/4 (a bar is 2 s), heard 0–12 unless `coverage` says otherwise. */
function chart(events: [number, string][], coverage: CoverageRange[] = [{ fromSec: 0, toSec: 12 }]): Chart {
  return {
    schemaVersion: 1,
    recording: { source: 'youtube', id: 'fixrange001', title: 'T', artist: 'A' },
    timing: { bpm: 120, beatsPerBar: 4, beatUnit: 4, firstDownbeatSec: 0 },
    events: events.map(([startSec, chord]): ChordEvent => ({ startSec, chord, confidence: 0.9, source: 'auto' })),
    coverage,
    provenance: { createdBy: 'recognizer', createdAt: '2026-11-15T00:00:00.000Z' },
  };
}
const model = (events: [number, string][], coverage?: CoverageRange[]) => buildPlayModel(chart(events, coverage), { level: 'novice', capo: 0, showUncertain: true }, null);
const segs = (m: PlayModel, bar: number) => m.bars[bar].segments.map((s) => [s.event, s.startSec, s.endSec]);

describe('chartEventRange: start to the next event, the last one to the end of its heard range', () => {
  const c = chart([[0, 'G'], [2.5, 'E'], [9.5, 'C']]);
  it('a middle event ends at the next start; the last one at the heard range end', () => {
    expect(chartEventRange(c, 0)).toEqual({ startSec: 0, endSec: 2.5 });
    expect(chartEventRange(c, 1)).toEqual({ startSec: 2.5, endSec: 9.5 });
    expect(chartEventRange(c, 2)).toEqual({ startSec: 9.5, endSec: 12 });
  });
  it('an event before a gap in the heard ranges ends where hearing stops', () => {
    const g = chart([[0, 'G'], [8, 'C']], [{ fromSec: 0, toSec: 5 }, { fromSec: 7, toSec: 12 }]);
    expect(chartEventRange(g, 0)).toEqual({ startSec: 0, endSec: 5 });
    expect(chartEventRange(g, 1)).toEqual({ startSec: 8, endSec: 12 });
  });
  it('no heard ranges at all: the last event lasts one bar (like the arrangement)', () => {
    expect(chartEventRange(chart([[0, 'G'], [3, 'C']], []), 1)).toEqual({ startSec: 3, endSec: 5 });
  });
});

describe('fixTimeText', () => {
  it('"start~end" in m:ss', () => {
    expect(fixTimeText(6.5, 13.2)).toBe('0:06~0:13');
    expect(fixTimeText(59.9, 61)).toBe('0:59~1:01');
  });
  it('one time when both ends show the same m:ss', () => {
    expect(fixTimeText(6.2, 6.9)).toBe('0:06');
  });
});

describe('barsForChartEvent: the bars the lane draws the event in', () => {
  it('a multi-bar event outlines every bar it is drawn in and only those', () => {
    // G 0–2.5, E 2.5–9.5, C 9.5–12; bars are [0,2) [2,4) … [10,12).
    const m = model([[0, 'G'], [2.5, 'E'], [9.5, 'C']]);
    expect(m.bars).toHaveLength(6);
    expect(barsForChartEvent(m, 1)).toEqual([1, 2, 3, 4]);
    expect(barsForChartEvent(m, 0)).toEqual([0, 1]);
  });
  it('the last event: its range ends at the heard range end', () => {
    const m = model([[0, 'G'], [2.5, 'E'], [9.5, 'C']]);
    expect(barsForChartEvent(m, 2)).toEqual([4, 5]);
  });
  it('a single-bar event and a part-bar event', () => {
    // m: G 0–4, Am 4–6.5 (bar 2 and the start of bar 3), D 6.5–8 (the rest of bar 3), C 8–12.
    // m2: Am 4–6 fills exactly one bar.
    const m = model([[0, 'G'], [4, 'Am'], [6.5, 'D'], [8, 'C']]);
    expect(barsForChartEvent(m, 1)).toEqual([2, 3]);
    const m2 = model([[0, 'G'], [4, 'Am'], [6, 'D'], [8, 'C']]);
    expect(barsForChartEvent(m2, 1)).toEqual([2]);
    expect(barsForChartEvent(m2, 0)).toEqual([0, 1]);
    // D 6.5–8 sits in bar 3 only, next to Am in the same bar.
    expect(segs(m, 3).map((s) => s[1])).toEqual([6, 6.5]);
    expect(barsForChartEvent(m, 2)).toEqual([3]);
  });
  it('a sliver the lane leaves out of a bar (under 0.1 s) is not outlined there', () => {
    // E starts 0.05 s before bar 1: bar 0 is drawn as G only.
    const m = model([[0, 'G'], [1.95, 'E'], [8, 'C']]);
    expect(segs(m, 0)).toEqual([[0, 0, 2]]);
    expect(barsForChartEvent(m, 1)).toEqual([1, 2, 3]);
    expect(barsForChartEvent(m, 0)).toEqual([0]);
  });
  it('a sliver of the previous chord drawn over a whole bar counts for the chord the lane shows', () => {
    // C starts 0.05 s into bar 4: the lane draws bar 4 as E, so C is outlined in bar 5 only.
    const m = model([[0, 'G'], [2, 'E'], [8.05, 'C']]);
    expect(segs(m, 4)).toEqual([[1, 8, 10]]);
    expect(barsForChartEvent(m, 1)).toEqual([1, 2, 3, 4]);
    expect(barsForChartEvent(m, 2)).toEqual([5]);
  });
  it('a short chord merged into the previous one counts only where its own time is drawn', () => {
    // novice merges D 3.0–3.4 (0.8 beats, under its 1 beat) into G: the lane draws G 0–3.4, then E.
    const m = model([[0, 'G'], [3, 'D'], [3.4, 'E']]);
    expect(m.arrangement.events[0]).toMatchObject({ startSec: 0, endSec: 3.4, mergedFrom: ['D'] });
    expect(barsForChartEvent(m, 1)).toEqual([1]);
    expect(barsForChartEvent(m, 0)).toEqual([0, 1]);
    expect(barsForChartEvent(m, 2)).toEqual([1, 2, 3, 4, 5]);
  });
  it('a rest (N) outlines the bars drawn empty in its range', () => {
    const m = model([[0, 'C'], [4, 'N'], [8, 'G']]);
    expect(barsForChartEvent(m, 1)).toEqual([2, 3]);
  });
});

describe('PlayScreen.markFix', () => {
  const fakeBars = (n: number) =>
    Array.from({ length: n }, () => {
      const on = new Set<string>();
      return {
        on,
        classList: { toggle: (c: string, v: boolean) => (v ? on.add(c) : on.delete(c)) },
        scrollIntoView: vi.fn(),
      };
    });
  const screen = (m: PlayModel) => {
    const barEls = fakeBars(m.bars.length);
    const fol = { release: vi.fn(), reset: vi.fn() };
    const self = { m, barEls, fol };
    const mark = (e: number | null) => PlayScreen.prototype.markFix.call(self as unknown as PlayScreen, e);
    const outlined = () => barEls.flatMap((b, i) => (b.on.has('fix-at') ? [i] : []));
    return { barEls, fol, mark, outlined };
  };

  it('outlines all bars of the event, scrolls the first into view; null clears every outline', () => {
    const m = model([[0, 'G'], [2.5, 'E'], [9.5, 'C']]);
    const s = screen(m);
    s.mark(1);
    expect(s.outlined()).toEqual([1, 2, 3, 4]);
    expect(s.barEls[1].scrollIntoView).toHaveBeenCalledTimes(1);
    expect(s.barEls.filter((b) => b.scrollIntoView.mock.calls.length).length).toBe(1);
    expect(s.fol.release).toHaveBeenCalled();
    s.mark(2);
    expect(s.outlined()).toEqual([4, 5]);
    s.mark(null);
    expect(s.outlined()).toEqual([]);
    expect(s.fol.reset).toHaveBeenCalled();
  });
});

describe('코드 고치기 panel (fake DOM)', () => {
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
    click() {
      for (const f of this.on) f({ target: { closest: () => null } });
    }
  }
  let els: Record<string, El>;
  beforeEach(() => {
    els = {};
    vi.stubGlobal('document', { getElementById: (id: string) => (els[id] ??= new El()) });
  });
  afterEach(() => vi.unstubAllGlobals());

  const open = (m: PlayModel, t: number) => {
    let now = t;
    const mark = vi.fn((_e: number | null) => {});
    const seek = vi.fn((sec: number) => {
      now = sec;
    });
    const host: FixHost = { model: () => m, now: () => now, seek, showSounding: () => false, mark, save: async () => {}, acceptAlt: async () => {}, restore: async () => {} };
    const fixer = new ChordFixer(host);
    fixer.open();
    const time = () => /<time>([^<]*)<\/time>/.exec(els['fix-which'].innerHTML)?.[1];
    return { fixer, mark, seek, time };
  };

  it('the header names the event range; the arrows still move event to event; closing clears the outline', () => {
    const m = model([[0, 'G'], [2.5, 'E'], [9.5, 'C']]);
    const { fixer, mark, seek, time } = open(m, 5);
    expect(mark).toHaveBeenLastCalledWith(1);
    expect(time()).toBe('0:02~0:09');
    expect(els['fix-which'].innerHTML).toContain('<b>E</b>');
    els['fix-next'].click();
    expect(seek).toHaveBeenLastCalledWith(9.51);
    expect(mark).toHaveBeenLastCalledWith(2);
    expect(time()).toBe('0:09~0:12');
    els['fix-prev'].click();
    els['fix-prev'].click();
    expect(seek).toHaveBeenLastCalledWith(0.01);
    expect(mark).toHaveBeenLastCalledWith(0);
    expect(time()).toBe('0:00~0:02');
    fixer.close();
    expect(mark).toHaveBeenLastCalledWith(null);
  });

  it('an event inside one second shows one time', () => {
    const m = model([[0, 'G'], [6.1, 'D'], [6.9, 'C']]); // D 6.1–6.9
    const { time } = open(m, 6.5);
    expect(time()).toBe('0:06');
  });
});
