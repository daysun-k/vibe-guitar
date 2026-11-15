/**
 * VGT-19 quiet marks: the lane shows only a "?" (no outline, no line under the strip), the second
 * choice moves into 코드 고치기 as "대안: X" (a button on the replace tier), undo clears the status
 * line, and the temporary lane variant lv=2 keeps the lane cut only at chords.
 */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Chart, ChordEvent, UncertainSpan } from '../src/chart/types';
import { ChordFixer, fixAltHTML, fixAltIndex, type FixHost } from '../src/extension/sidepanel/fix';
import { laneSegmentHTML } from '../src/extension/sidepanel/play';
import { demoChart } from '../src/play/demo';
import { buildPlayModel, type PlayModel, type PlayOptions } from '../src/play/model';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const span = (fromSec: number, toSec: number, chord: string, alt: string, replace?: true): UncertainSpan => (replace ? { fromSec, toSec, chord, alt, replace } : { fromSec, toSec, chord, alt });

function chart(events: [number, string][], cover: number, uncertain: UncertainSpan[]): Chart {
  return {
    schemaVersion: 1,
    recording: { source: 'youtube', id: 'quietmark01', title: 'T', artist: 'A' },
    timing: { bpm: 120, beatsPerBar: 4, beatUnit: 4, firstDownbeatSec: 0 },
    events: events.map(([startSec, chord]): ChordEvent => ({ startSec, chord, confidence: 0.8, source: 'auto' })),
    coverage: [{ fromSec: 0, toSec: cover }],
    provenance: { createdBy: 'recognizer', createdAt: '2026-11-10T00:00:00.000Z' },
    uncertain,
  };
}

const demo = (o: Partial<PlayOptions> = {}) => buildPlayModel(demoChart(), { level: 'beginner', capo: 'auto', ...o }, null);
const flagged = (m: PlayModel) => m.bars.flatMap((b, k) => b.segments.filter((s) => s.flag >= 0).map((s) => [k, m.labels[s.event].name, s.flag]));
const noFlag = (m: PlayModel) => m.bars.map((b) => ({ ...b, segments: b.segments.map(({ flag: _f, ...s }) => s) }));

describe('lane: only a "?" marks an uncertain stretch', () => {
  it('a flagged segment renders the chord with "?" and no outline class; plain segments are unchanged', () => {
    const m = demo();
    const bar = m.bars.find((b) => b.segments.some((s) => s.flag === 0))!;
    const html = bar.segments.map((s) => laneSegmentHTML(m, s, false, false)).join('');
    expect(html).toContain('<i class="unc-q" aria-hidden="true">?</i>');
    expect(html).not.toMatch(/class="sg[^"]*\bunc\b/);
    expect(html).toContain('title="확실하지 않아요, 대안 G"');
    const plain = m.bars[0].segments.map((s) => laneSegmentHTML(m, s, false, false)).join('');
    expect(plain).not.toContain('?');
  });

  it('no dashed outline, no line under the strip and no 바꾸기 button are left in the panel', () => {
    const css = read('src/extension/static/sidepanel.css');
    expect(css).not.toMatch(/\.sg\.unc|unc-row|unc-btn|dashed var\(--unc\)/);
    expect(read('src/extension/static/sidepanel.html')).not.toContain('unc-row');
    const play = read('src/extension/sidepanel/play.ts');
    expect(play).not.toMatch(/unc-row|가능성이 더 커요|다른 후보|acceptAlt/);
  });
});

describe('코드 고치기: "대안: X" right of the origin note', () => {
  it('replace tier: a small button carrying the mark index; info tier: plain text', () => {
    expect(fixAltHTML({ alt: 'G', altSounding: 'A♭', replace: true }, 0, false)).toBe('<button class="fix-alt" data-u="0" aria-label="대안 G로 바꾸기">대안: G</button>');
    expect(fixAltHTML({ alt: 'Am', altSounding: 'B♭m', replace: true }, 2, false)).toContain('aria-label="대안 Am으로 바꾸기"');
    expect(fixAltHTML({ alt: 'D', altSounding: 'E♭', replace: false }, 1, false)).toBe('<small class="fix-alt">대안: D</small>');
    expect(fixAltHTML({ alt: 'Am', altSounding: 'B♭m', replace: false }, 3, true)).toBe('<small class="fix-alt">대안: Am <small class="snd">실제 B♭m</small></small>');
  });

  it('the stretch under the playhead in that event, else the event\'s first; none for another event', () => {
    // G 0–8 with stretches 1–2 (Em) and 5–6 (Am); C from 8.
    const m = buildPlayModel(chart([[0, 'G'], [8, 'C']], 12, [span(1, 2, 'G', 'Em'), span(5, 6, 'G', 'Am')]), { level: 'novice', capo: 0 }, null);
    expect(m.uncertain.map((u) => u.alt)).toEqual(['Em', 'Am']);
    expect(fixAltIndex(m.uncertain, 0, 5.5)).toBe(1);
    expect(fixAltIndex(m.uncertain, 0, 1.2)).toBe(0);
    expect(fixAltIndex(m.uncertain, 0, 3)).toBe(0);
    expect(fixAltIndex(m.uncertain, 8, 5.5)).toBe(-1);
  });
});

describe('코드 고치기 panel: tapping 대안 (fake DOM)', () => {
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
    /** A click whose target sits inside the element carrying data-u (or none). */
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
    els = {}; // a fresh panel per fixer
    const m = demo();
    const acceptAlt = vi.fn(async (_i: number) => {});
    const host: FixHost = { model: () => m, now: () => t, seek: () => {}, showSounding: () => false, mark: () => {}, save: async () => {}, acceptAlt };
    const fixer = new ChordFixer(host);
    fixer.open();
    const which = els['fix-which'];
    const u = /data-u="(\d+)"/.exec(which.innerHTML)?.[1] ?? null;
    return { m, fixer, which, u, acceptAlt };
  };
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it('demo verse Fm (replace tier): one tap accepts that stretch and closes the panel like a fix', async () => {
    const { m, fixer, which, u, acceptAlt } = open(12.4);
    expect(which.innerHTML).toBe('<time>0:11</time> <b>Em</b><small>자동으로 들은 코드 · 확실하지 않음</small><button class="fix-alt" data-u="0" aria-label="대안 G로 바꾸기">대안: G</button>');
    expect(m.uncertain[0]).toMatchObject({ fromSec: 11.6, toSec: 13.6, alt: 'G', replace: true });
    which.click(u);
    await flush();
    expect(acceptAlt).toHaveBeenCalledTimes(1);
    expect(acceptAlt).toHaveBeenCalledWith(0);
    expect(fixer.isOpen).toBe(false);
  });

  it('demo verse C♯ (info tier): "대안: D" is text and a tap does nothing', async () => {
    const { m, fixer, which, u, acceptAlt } = open(14.0);
    expect(which.innerHTML).toContain('<small class="fix-alt">대안: D</small>');
    expect(u).toBeNull();
    which.click(null);
    which.click('1'); // even an info index reaching the handler does not replace
    await flush();
    expect(m.uncertain[1].replace).toBe(false);
    expect(acceptAlt).not.toHaveBeenCalled();
    expect(fixer.isOpen).toBe(true);
  });

  it('a chord without a visible stretch shows no 대안; a failed replacement keeps the panel open', async () => {
    expect(open(1).which.innerHTML).not.toContain('fix-alt');
    const { fixer, which, u, acceptAlt } = open(12.4);
    acceptAlt.mockRejectedValueOnce(new Error('conflict'));
    which.click(u);
    await flush();
    expect(acceptAlt).toHaveBeenCalledTimes(1);
    expect(fixer.isOpen).toBe(true);
  });
});

describe('undo', () => {
  it('undoing a fix or a replacement clears the status line (no "되돌렸어요")', () => {
    const src = read('src/extension/sidepanel/sidepanel.ts');
    expect(src).not.toContain('되돌렸어요');
    expect(src).toMatch(/lastFix = null;\n\s*fixNote = null;/);
    expect(src).toContain('`바꿨어요: ${shown} → ${u.alt}`');
  });
});

describe('lane variant 2 (temporary lv=2): marks on whole chords', () => {
  it('bars equal the lane without stretches; each demo stretch puts one "?" on its chord', () => {
    const v2 = demo({ laneVariant: 2 });
    const off = demo({ showUncertain: false });
    expect(noFlag(v2)).toEqual(noFlag(off));
    expect(v2.uncertain).toEqual(demo().uncertain);
    expect(flagged(v2)).toEqual([
      [6, 'Em', 0], // capo 1: Fm is played as the Em shape
      [7, 'C', 1],
      [10, 'Em', 2],
      [14, 'C', 3],
    ]);
    // lv=1 cuts the C♯ bar at the stretch (two segments); lv=2 keeps one segment for the bar
    expect(demo().bars[7].segments).toHaveLength(2);
    expect(v2.bars[7].segments).toHaveLength(1);
  });

  it('a stretch spanning bars flags each bar\'s chord; a sliver under 0.1 s past a bar line flags nothing', () => {
    // G 0–8: stretch 1–2.05 → bar 1 only (bar 2 keeps its repeat sign without "?"); stretch 5–7 → bars 3 and 4.
    const c = chart([[0, 'G']], 8, [span(1, 2.05, 'G', 'Em'), span(5, 7, 'G', 'Am', true)]);
    const m = buildPlayModel(c, { level: 'novice', capo: 0, laneVariant: 2 }, null);
    expect(m.bars.map((b) => [b.repeat, b.segments.map((s) => s.flag)])).toEqual([
      [false, [0]],
      [true, [-1]],
      [true, [1]],
      [true, [1]],
    ]);
    // a repeat sign covering a stretch carries the "?"
    expect(laneSegmentHTML(m, m.bars[2].segments[0], true, false)).toContain('<i class="unc-q" aria-hidden="true">?</i>');
    expect(laneSegmentHTML(m, m.bars[1].segments[0], true, false)).not.toContain('unc-q');
  });

  it('another chord overlapping the stretch is not flagged', () => {
    // C 0–1, G 1–8 with a stretch on G 1–3: bar 1's C segment is not marked, its G segment is.
    const m = buildPlayModel(chart([[0, 'C'], [1, 'G']], 8, [span(1, 3, 'G', 'Em')]), { level: 'novice', capo: 0, laneVariant: 2 }, null);
    expect(m.bars[0].segments.map((s) => [m.labels[s.event].name, s.flag])).toEqual([
      ['C', -1],
      ['G', 0],
    ]);
    expect(m.bars[1].segments.map((s) => s.flag)).toEqual([0]);
  });

  it('the switch off and the default variant are unchanged', () => {
    expect(demo({ laneVariant: 2, showUncertain: false }).bars).toEqual(demo({ showUncertain: false }).bars);
    expect(demo({ laneVariant: 1 }).bars).toEqual(demo().bars);
  });
});
