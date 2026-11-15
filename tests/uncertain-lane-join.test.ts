/**
 * VGT-19 Amendment 2: the lane draws uncertain marks of the same chord event naming the same chord
 * as one stretch when their gap is at most 0.5 s (left to right, so chains join). Only the drawing
 * changes: the marks, the playhead's mark and 코드 고치기 (대안 and its one-tap button) read the
 * original spans, and a joined gap has no 대안.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Chart, ChordEvent, UncertainSpan } from '../src/chart/types';
import { ChordFixer, fixAltIndex, type FixHost } from '../src/extension/sidepanel/fix';
import { laneSegmentHTML } from '../src/extension/sidepanel/play';
import { demoChart } from '../src/play/demo';
import { buildPlayModel, frameAt, type PlayModel } from '../src/play/model';
import { LANE_JOIN_GAP_SEC, inJoinedGap, laneStretches, type UncertainMark } from '../src/play/uncertain';

const span = (fromSec: number, toSec: number, chord: string, alt: string, replace?: true): UncertainSpan => (replace ? { fromSec, toSec, chord, alt, replace } : { fromSec, toSec, chord, alt });

/** 120 bpm 4/4 (a bar is 2 s), heard 0–12. */
function chart(events: [number, string][], uncertain: UncertainSpan[]): Chart {
  return {
    schemaVersion: 1,
    recording: { source: 'youtube', id: 'lanejoin001', title: 'T', artist: 'A' },
    timing: { bpm: 120, beatsPerBar: 4, beatUnit: 4, firstDownbeatSec: 0 },
    events: events.map(([startSec, chord]): ChordEvent => ({ startSec, chord, confidence: 0.7, source: 'auto' })),
    coverage: [{ fromSec: 0, toSec: 12 }],
    provenance: { createdBy: 'recognizer', createdAt: '2026-11-10T00:00:00.000Z' },
    uncertain,
  };
}
const model = (c: Chart, showUncertain = true) => buildPlayModel(c, { level: 'novice', capo: 0, showUncertain }, null);
/** G 0–8, C 8–12. */
const gc = (uncertain: UncertainSpan[]) => model(chart([[0, 'G'], [8, 'C']], uncertain));
const segs = (m: PlayModel, bar: number) => m.bars[bar].segments.map((s) => [s.event, s.flag, s.startSec, s.endSec]);
const stretches = (m: PlayModel) => laneStretches(m.uncertain).map((s) => [s.fromSec, s.toSec, s.parts]);
const qs = (m: PlayModel, bar: number) => m.bars[bar].segments.map((s) => laneSegmentHTML(m, s, false, false)).join('').split('class="unc-q"').length - 1;

describe('which marks join', () => {
  it('a gap of exactly 0.5 s joins; the drawn stretch covers the gap', () => {
    expect(LANE_JOIN_GAP_SEC).toBe(0.5);
    const m = gc([span(2, 2.5, 'G', 'Em'), span(3, 3.5, 'G', 'Am')]);
    expect(m.uncertain.map((u) => [u.fromSec, u.toSec, u.alt])).toEqual([[2, 2.5, 'Em'], [3, 3.5, 'Am']]);
    expect(stretches(m)).toEqual([[2, 3.5, [0, 1]]]);
  });

  it('a gap of 0.51 s does not join', () => {
    const m = gc([span(2, 2.49, 'G', 'Em'), span(3, 3.5, 'G', 'Am')]);
    expect(m.uncertain).toHaveLength(2);
    expect(stretches(m)).toEqual([[2, 2.49, [0]], [3, 3.5, [1]]]);
  });

  it('marks in different chord events do not join, even across a short gap', () => {
    const m = gc([span(7, 7.8, 'G', 'Em'), span(8, 8.5, 'C', 'Am')]);
    expect(m.uncertain).toHaveLength(2);
    expect(stretches(m)).toEqual([[7, 7.8, [0]], [8, 8.5, [1]]]);
  });

  it('pure rule: a different event start or a different chord keeps marks apart', () => {
    const mk = (fromSec: number, toSec: number, eventStart: number, chord: string): Pick<UncertainMark, 'fromSec' | 'toSec' | 'ref' | 'span' | 'noChord'> =>
      ({ fromSec, toSec, ref: { startSec: eventStart, chord }, span: span(fromSec, toSec, chord, 'Em'), noChord: false });
    expect(laneStretches([mk(1, 2, 0, 'G'), mk(2.2, 3, 2.1, 'G')]).map((s) => s.parts)).toEqual([[0], [1]]);
    expect(laneStretches([mk(1, 2, 0, 'G'), mk(2.2, 3, 0, 'G7')]).map((s) => s.parts)).toEqual([[0], [1]]);
    expect(laneStretches([mk(1, 2, 0, 'G'), mk(2.2, 3, 0, 'G')]).map((s) => s.parts)).toEqual([[0, 1]]);
    // input order does not matter: parts come out in time order
    expect(laneStretches([mk(2.2, 3, 0, 'G'), mk(1, 2, 0, 'G')]).map((s) => [s.fromSec, s.toSec, s.parts])).toEqual([[1, 3, [1, 0]]]);
  });

  it('a chain of three small gaps becomes one stretch', () => {
    const m = gc([span(1, 1.5, 'G', 'Em'), span(1.9, 2.4, 'G', 'Am'), span(2.8, 3.2, 'G', 'Em')]);
    expect(stretches(m)).toEqual([[1, 3.2, [0, 1, 2]]]);
  });

  it('no-chord marks join under the same rule within their N event', () => {
    // C 0–4, N 4–8, G 8–12
    const m = model(chart([[0, 'C'], [4, 'N'], [8, 'G']], [span(4.5, 5, 'N', 'Am', true), span(5.3, 5.8, 'N', 'Am', true)]));
    expect(m.uncertain.map((u) => u.noChord)).toEqual([true, true]);
    expect(laneStretches(m.uncertain).map((s) => [s.fromSec, s.toSec, s.noChord, s.parts])).toEqual([[4.5, 5.8, true, [0, 1]]]);
    expect(segs(m, 2)).toEqual([[-1, -1, 4, 4.5], [-1, 0, 4.5, 5.8], [-1, -1, 5.8, 6]]);
    expect(qs(m, 2)).toBe(1);
    expect(fixAltIndex(m.uncertain, 4, 5.1)).toBe(-1);
    expect(fixAltIndex(m.uncertain, 4, 5.5)).toBe(1);
  });
});

describe('the lane draws the joined stretch', () => {
  it('one segment and one "?" over the joined stretch, cut at its bounds', () => {
    const m = gc([span(2, 2.5, 'G', 'Em'), span(3, 3.5, 'G', 'Am')]);
    expect(segs(m, 1)).toEqual([[0, 0, 2, 3.5], [0, -1, 3.5, 4]]);
    expect(qs(m, 1)).toBe(1);
    // the segment names the stretch's first mark (tooltip and aria read its 대안)
    expect(laneSegmentHTML(m, m.bars[1].segments[0], false, false)).toContain('title="확실하지 않아요, 대안 Em"');
  });

  it('without the join (0.51 s) the two marks keep their own segments and "?"', () => {
    const m = gc([span(2, 2.49, 'G', 'Em'), span(3, 3.5, 'G', 'Am')]);
    expect(segs(m, 1)).toEqual([[0, 0, 2, 2.49], [0, -1, 2.49, 3], [0, 1, 3, 3.5], [0, -1, 3.5, 4]]);
    expect(qs(m, 1)).toBe(2);
  });

  it('a stretch crossing a bar line is cut there, one "?" per drawn segment', () => {
    const m = gc([span(3.4, 3.8, 'G', 'Em'), span(4.2, 4.6, 'G', 'Am')]);
    expect(stretches(m)).toEqual([[3.4, 4.6, [0, 1]]]);
    expect(segs(m, 1)).toEqual([[0, -1, 2, 3.4], [0, 0, 3.4, 4]]);
    expect(segs(m, 2)).toEqual([[0, 0, 4, 4.6], [0, -1, 4.6, 6]]);
    expect(qs(m, 1) + qs(m, 2)).toBe(2);
  });

  it('the switch off draws nothing', () => {
    const m = model(chart([[0, 'G'], [8, 'C']], [span(2, 2.5, 'G', 'Em'), span(3, 3.5, 'G', 'Am')]), false);
    expect(m.uncertain).toEqual([]);
    expect(m.bars.every((b) => b.segments.every((s) => s.flag === -1))).toBe(true);
  });

  it('the demo still renders every bar', () => {
    const m = buildPlayModel(demoChart(), { level: 'beginner', capo: 'auto' }, null);
    expect(m.uncertain.length).toBeGreaterThan(0);
    for (const b of m.bars) for (const s of b.segments) {
      if (s.flag >= 0) expect(m.uncertain[s.flag]).toBeDefined();
      expect(laneSegmentHTML(m, s, false, false)).toMatch(/^<span class="sg/);
    }
  });
});

describe('코드 고치기 reads the original spans', () => {
  it('the playhead finds each part; a joined gap has none', () => {
    const m = gc([span(2, 2.5, 'G', 'Em'), span(3, 3.5, 'G', 'Am', true)]);
    expect([frameAt(m, 2.2).uncertain, frameAt(m, 2.7).uncertain, frameAt(m, 3.2).uncertain]).toEqual([0, -1, 1]);
    expect(inJoinedGap(m.uncertain, 2.7)).toBe(true);
    expect([fixAltIndex(m.uncertain, 0, 2.2), fixAltIndex(m.uncertain, 0, 2.7), fixAltIndex(m.uncertain, 0, 3.2)]).toEqual([0, -1, 1]);
    // outside any stretch of the event the panel still falls back to the event's first mark
    expect(fixAltIndex(m.uncertain, 0, 6)).toBe(0);
  });

  it('a gap that is not joined keeps the earlier fallback (the event\'s first mark)', () => {
    const m = gc([span(2, 2.49, 'G', 'Em'), span(3, 3.5, 'G', 'Am')]);
    expect(inJoinedGap(m.uncertain, 2.7)).toBe(false);
    expect(fixAltIndex(m.uncertain, 0, 2.7)).toBe(0);
  });

  describe('fake DOM', () => {
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
      click(u: string | null) {
        for (const f of this.on) f({ target: { closest: () => (u === null ? null : { dataset: { u } }) } });
      }
    }
    let els: Record<string, El>;
    beforeEach(() => {
      els = {};
      vi.stubGlobal('document', { getElementById: (id: string) => (els[id] ??= new El()) });
    });
    afterEach(() => vi.unstubAllGlobals());

    const open = (t: number) => {
      els = {};
      const m = gc([span(2, 2.5, 'G', 'Em', true), span(3, 3.5, 'G', 'Am')]);
      const acceptAlt = vi.fn(async (_i: number) => {});
      const host: FixHost = { model: () => m, now: () => t, seek: () => {}, showSounding: () => false, mark: () => {}, save: async () => {}, acceptAlt, restore: async () => {} };
      const fixer = new ChordFixer(host);
      fixer.open();
      const which = els['fix-which'];
      return { fixer, which, acceptAlt, u: /data-u="(\d+)"/.exec(which.innerHTML)?.[1] ?? null };
    };
    const flush = () => new Promise((r) => setTimeout(r, 0));

    it('first part (replace tier): "대안: Em" button, one tap replaces that part', async () => {
      const { fixer, which, acceptAlt, u } = open(2.2);
      expect(which.innerHTML).toContain('<button class="fix-alt" data-u="0" aria-label="대안 Em으로 바꾸기">대안: Em</button>');
      which.click(u);
      await flush();
      expect(acceptAlt).toHaveBeenCalledWith(0);
      expect(fixer.isOpen).toBe(false);
    });

    it('second part (info tier): "대안: Am" text, no button', () => {
      const { which, u } = open(3.2);
      expect(which.innerHTML).toContain('<small class="fix-alt">대안: Am</small>');
      expect(u).toBeNull();
    });

    it('inside the joined gap: no 대안', () => {
      const { which } = open(2.7);
      expect(which.innerHTML).toContain('<b>G</b>');
      expect(which.innerHTML).not.toContain('fix-alt');
    });
  });
});
