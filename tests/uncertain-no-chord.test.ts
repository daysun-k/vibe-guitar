/**
 * VGT-19 follow-up: uncertain spans on auto no-chord ("N") events show like any other span: a "?"
 * on the empty lane segment, "대안: X" in 코드 고치기 (a button on the replace tier) and the one-tap
 * replacement through acceptUncertainAlt, whose head and tail stay no chord.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Chart, ChordEvent, UncertainSpan } from '../src/chart/types';
import { validateChart } from '../src/chart/validate';
import { CorrectionConflict, acceptUncertainAlt, correctChordEvent, uncertainSpanEvent } from '../src/editor/correct';
import { ChordFixer, fixAltIndex, type FixHost } from '../src/extension/sidepanel/fix';
import { laneSegmentHTML } from '../src/extension/sidepanel/play';
import { demoChart } from '../src/play/demo';
import { buildPlayModel, frameAt } from '../src/play/model';
import { visibleSpans } from '../src/play/uncertain';

const NOW = new Date('2026-11-15T10:00:00.000Z');
const span = (fromSec: number, toSec: number, chord: string, alt: string, replace?: true): UncertainSpan => (replace ? { fromSec, toSec, chord, alt, replace } : { fromSec, toSec, chord, alt });

/** C 0–4, N 4–8, G 8–12 (heard to 12). */
function chart(uncertain: UncertainSpan[]): Chart {
  const ev = (startSec: number, chord: string): ChordEvent => ({ startSec, chord, confidence: 0.7, source: 'auto' });
  return {
    schemaVersion: 1,
    recording: { source: 'youtube', id: 'nochord0001', title: 'T', artist: 'A' },
    timing: { bpm: 120, beatsPerBar: 4, beatUnit: 4, firstDownbeatSec: 0 },
    events: [ev(0, 'C'), ev(4, 'N'), ev(8, 'G')],
    coverage: [{ fromSec: 0, toSec: 12 }],
    provenance: { createdBy: 'recognizer', createdAt: '2026-11-10T00:00:00.000Z' },
    uncertain,
  };
}
const model = (c: Chart, showUncertain = true) => buildPlayModel(c, { level: 'novice', capo: 0, showUncertain }, null);

describe('no-chord spans are visible', () => {
  it('a span on an auto N event applies to it; a manual N or a chord there hides it', () => {
    const c = chart([span(5, 7, 'N', 'Am', true)]);
    expect(uncertainSpanEvent(c, c.uncertain![0])).toBe(1);
    expect(visibleSpans(c, true).map((v) => v.ref)).toEqual([{ startSec: 4, chord: 'N' }]);
    const manual = correctChordEvent(c, { startSec: 4, chord: 'N' }, 'Am', NOW);
    expect(uncertainSpanEvent(manual, c.uncertain![0])).toBe(-1);
    // a chord span never applies to the N event, nor an N span to a chord event
    expect(uncertainSpanEvent(c, span(5, 7, 'C', 'Am'))).toBe(-1);
    expect(uncertainSpanEvent(c, span(1, 2, 'N', 'Am'))).toBe(-1);
  });

  it('the mark is drawn as "?" on the empty lane segment, cut at the span bounds; switch off draws none', () => {
    const m = model(chart([span(5, 7, 'N', 'Am', true)]));
    expect(m.uncertain.map((u) => [u.fromSec, u.toSec, u.alt, u.noChord, u.replace])).toEqual([[5, 7, 'Am', true, true]]);
    // 120 bpm 4/4: bar 2 is 4–6, bar 3 is 6–8
    const segs = m.bars.slice(2, 4).map((b) => b.segments.map((s) => [s.event, s.flag, s.startSec, s.endSec]));
    expect(segs).toEqual([
      [[-1, -1, 4, 5], [-1, 0, 5, 6]],
      [[-1, 0, 6, 7], [-1, -1, 7, 8]],
    ]);
    const flagged = m.bars[2].segments[1];
    const html = laneSegmentHTML(m, flagged, false, false);
    expect(html).toContain('<span class="cn muted">—</span><i class="unc-q" aria-hidden="true">?</i>');
    expect(html).toContain('title="확실하지 않아요, 대안 Am"');
    expect(laneSegmentHTML(m, m.bars[2].segments[0], false, false)).toBe('<span class="sg" style="flex:2 1 0"><span class="cn muted">—</span></span>');
    expect(frameAt(m, 5.5).uncertain).toBe(0);
    expect(frameAt(m, 4.5).uncertain).toBe(-1);
    const off = model(chart([span(5, 7, 'N', 'Am', true)]), false);
    expect(off.uncertain).toEqual([]);
    expect(off.bars.flatMap((b) => b.segments).every((s) => s.flag < 0)).toBe(true);
  });

  it('an N flag never marks a chord segment, nor a chord flag an empty one', () => {
    const m = model(chart([span(5, 7, 'N', 'Am'), span(9, 10, 'G', 'Em')]));
    const flagged = m.bars.flatMap((b) => b.segments).filter((s) => s.flag >= 0);
    expect(flagged.map((s) => [s.event >= 0, m.uncertain[s.flag].noChord])).toEqual([[false, true], [false, true], [true, false]]);
  });

  it('demo: the ringing end (89.6–90.6 s) is an N stretch drawn with "?" and named G (capo 1) in 코드 고치기', () => {
    const m = buildPlayModel(demoChart(), { level: 'beginner', capo: 'auto' }, null);
    const k = m.uncertain.findIndex((u) => u.noChord);
    expect(m.uncertain[k]).toMatchObject({ fromSec: 89.6, toSec: 90.6, alt: 'G', altSounding: 'A♭', replace: true, ref: { startSec: 89.6, chord: 'N' } });
    expect(fixAltIndex(m.uncertain, 89.6, 90)).toBe(k);
    expect(frameAt(m, 90).uncertain).toBe(k);
  });
});

describe('acceptUncertainAlt on a no-chord event', () => {
  it('the span becomes the second choice; head and tail stay N with their confidence', () => {
    const c = chart([span(5, 7, 'N', 'Am', true)]);
    const out = acceptUncertainAlt(c, { startSec: 4, chord: 'N' }, c.uncertain![0], NOW);
    expect(out.events).toEqual([
      { startSec: 0, chord: 'C', confidence: 0.7, source: 'auto' },
      { startSec: 4, chord: 'N', confidence: 0.7, source: 'auto' },
      { startSec: 5, chord: 'Am', confidence: 1, source: 'manual', auto: { chord: 'N', confidence: 0.7, span: span(5, 7, 'N', 'Am', true) } },
      { startSec: 7, chord: 'N', confidence: 0.7, source: 'auto' },
      { startSec: 8, chord: 'G', confidence: 0.7, source: 'auto' },
    ]);
    expect(out.uncertain).toEqual([]);
    expect(out.provenance.createdBy).toBe('edited');
    expect(validateChart(out).ok).toBe(true);
  });

  it('the info tier and a changed event are refused', () => {
    const info = chart([span(5, 7, 'N', 'Am')]);
    expect(() => acceptUncertainAlt(info, { startSec: 4, chord: 'N' }, info.uncertain![0], NOW)).toThrow(CorrectionConflict);
    const c = chart([span(5, 7, 'N', 'Am', true)]);
    const fixed = correctChordEvent(c, { startSec: 4, chord: 'N' }, 'F', NOW);
    expect(() => acceptUncertainAlt(fixed, { startSec: 4, chord: 'N' }, c.uncertain![0], NOW)).toThrow(CorrectionConflict);
  });
});

describe('코드 고치기 on a no-chord event (fake DOM)', () => {
  class El {
    hidden = true;
    disabled = false;
    innerHTML = '';
    addEventListener() {}
    setAttribute() {}
    querySelector() {
      return null;
    }
    focus() {}
  }
  let els: Record<string, El>;
  beforeEach(() => {
    els = {};
    vi.stubGlobal('document', { getElementById: (id: string) => (els[id] ??= new El()) });
  });
  afterEach(() => vi.unstubAllGlobals());

  const whichAt = (c: Chart, t: number) => {
    els = {};
    const m = model(c);
    const host: FixHost = { model: () => m, now: () => t, seek: () => {}, showSounding: () => false, mark: () => {}, save: async () => {}, acceptAlt: async () => {}, restore: async () => {} };
    new ChordFixer(host).open();
    return els['fix-which'].innerHTML;
  };

  it('replace tier: "대안: Am" is a button; info tier: plain text', () => {
    expect(whichAt(chart([span(5, 7, 'N', 'Am', true)]), 5.5)).toBe('<time>0:04</time> <b>코드 없음</b><small>자동으로 들은 코드</small><button class="fix-alt" data-u="0" aria-label="대안 Am으로 바꾸기">대안: Am</button>');
    expect(whichAt(chart([span(5, 7, 'N', 'Am')]), 5.5)).toContain('<small class="fix-alt">대안: Am</small>');
  });
});
