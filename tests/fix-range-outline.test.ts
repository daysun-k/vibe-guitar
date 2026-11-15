/**
 * 코드 고치기 shows the whole range of the chord event it fixes: the dashed outline covers every lane
 * bar that draws the event (following the lane's own cut rules), and the header names the event's time
 * range ("0:02~0:09"). The ‹ › arrows still step from event to event.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Chart, ChordEvent, CoverageRange } from '../src/chart/types';
import { ChordFixer, fixTimeText, type FixHost } from '../src/extension/sidepanel/fix';
import { PlayScreen, fixScrollTop } from '../src/extension/sidepanel/play';
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

describe('fixScrollTop: where the lane scrolls for the outlined rows', () => {
  // View 100–250, a 30 px sticky section header: rows show from 130 down.
  const g = { viewTop: 100, viewBottom: 250, scrollTop: 0, headSpace: 30 };
  it('rows that do not fit: the first row goes just under the header (start alignment)', () => {
    expect(fixScrollTop({ ...g, firstTop: 195, lastBottom: 320 })).toBe(65);
    expect(fixScrollTop({ ...g, scrollTop: 200, firstTop: -5, lastBottom: 120 })).toBe(65);
  });
  it('everything already visible: the lane stays', () => {
    expect(fixScrollTop({ ...g, firstTop: 130, lastBottom: 250 })).toBeNull();
    expect(fixScrollTop({ ...g, firstTop: 160, lastBottom: 220 })).toBeNull();
  });
  it('a first row hidden under the sticky header counts as not visible', () => {
    expect(fixScrollTop({ ...g, scrollTop: 50, firstTop: 110, lastBottom: 170 })).toBe(30);
  });
  it('a range taller than the view whose first row is already at the top: the lane stays', () => {
    expect(fixScrollTop({ ...g, firstTop: 130, lastBottom: 500 })).toBeNull();
  });
  it('never above the top of the lane', () => {
    expect(fixScrollTop({ ...g, scrollTop: 10, firstTop: 105, lastBottom: 400 })).toBe(0);
  });
});

describe('PlayScreen.markFix', () => {
  afterEach(() => vi.unstubAllGlobals());
  /**
   * Fake lane, one section: a 24 px sticky header with a 6 px gap, then rows of four bars, 60 px tall
   * every 65 px from content y 30. The view is client 100 to 100 + height.
   */
  const screen = (m: PlayModel, height: number) => {
    vi.stubGlobal('getComputedStyle', () => ({ marginBottom: '6px' }));
    const lane = { scrollTop: 0, getBoundingClientRect: () => ({ top: 100, bottom: 100 + height }) };
    const sec = { querySelector: () => ({ offsetHeight: 24 }) };
    const rows = Array.from({ length: Math.ceil(m.bars.length / 4) }, (_, r) => ({
      getBoundingClientRect: () => {
        const top = 100 + 30 + r * 65 - lane.scrollTop;
        return { top, bottom: top + 60 };
      },
    }));
    const barEls = m.bars.map((_, i) => {
      const on = new Set<string>();
      return {
        on,
        classList: { toggle: (c: string, v: boolean) => (v ? on.add(c) : on.delete(c)), contains: (c: string) => on.has(c) },
        closest: (sel: string) => (sel === '.row4' ? rows[Math.floor(i / 4)] : sel === '.sec' ? sec : null),
      };
    });
    const fol = { release: vi.fn(), reset: vi.fn() };
    const self = { m, barEls, fol, lane } as unknown as PlayScreen;
    const scrollToFix = (PlayScreen.prototype as unknown as { scrollToFix: () => void }).scrollToFix;
    Object.assign(self, { scrollToFix });
    const mark = (e: number | null) => PlayScreen.prototype.markFix.call(self, e);
    const outlined = () => barEls.flatMap((b, i) => (b.on.has('fix-at') ? [i] : []));
    // What the lane's ResizeObserver calls.
    const resized = () => (self as unknown as { scrollToFix: () => void }).scrollToFix();
    return { lane, fol, mark, outlined, resized };
  };
  // Heard 0–32 (16 bars, 4 rows): G 0–10.5, E 10.5–17.5 (bars 5–8: rows 1 and 2), C 17.5–32.
  const long = () => model([[0, 'G'], [10.5, 'E'], [17.5, 'C']], [{ fromSec: 0, toSec: 32 }]);

  it('outlines all bars of the event and puts the first outlined row at the top, under the section header', () => {
    const s = screen(long(), 150);
    s.mark(1);
    expect(s.outlined()).toEqual([5, 6, 7, 8]);
    // Row 1 starts at content y 95: scrolled so it sits 30 px (header + gap) below the view top.
    expect(s.lane.scrollTop).toBe(65);
    expect(s.fol.release).toHaveBeenCalled();
  });
  it('the same from a lane scrolled past the range (arrows going back)', () => {
    const s = screen(long(), 150);
    s.lane.scrollTop = 300;
    s.mark(1);
    expect(s.lane.scrollTop).toBe(65);
  });
  it('the whole range already in view: the lane does not move', () => {
    const s = screen(long(), 300);
    s.lane.scrollTop = 10;
    s.mark(1);
    expect(s.outlined()).toEqual([5, 6, 7, 8]);
    expect(s.lane.scrollTop).toBe(10);
  });
  it('null clears every outline and leaves the lane where it is', () => {
    const s = screen(long(), 150);
    s.mark(1);
    s.mark(null);
    expect(s.outlined()).toEqual([]);
    expect(s.fol.reset).toHaveBeenCalled();
    expect(s.lane.scrollTop).toBe(65);
  });
  it('a resize re-scrolls the outlined rows; without an outline it does nothing', () => {
    const s = screen(long(), 150);
    s.mark(2); // C: bars 8–15, rows 2–3
    expect(s.outlined()).toEqual([8, 9, 10, 11, 12, 13, 14, 15]);
    expect(s.lane.scrollTop).toBe(130);
    s.lane.scrollTop = 0; // the lane reflowed (the panel opened, lyrics or diagrams resized)
    s.resized();
    expect(s.lane.scrollTop).toBe(130);
    s.mark(null);
    s.lane.scrollTop = 0;
    s.resized();
    expect(s.lane.scrollTop).toBe(0);
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
