/**
 * VGT-19 side panel: which uncertain spans show, playing a span as its second choice (stored and
 * undone like 코드 고치기), merging spans across auto analyses, names on the play screen and the
 * 불확실한 곳 표시 switch.
 */
import { describe, expect, it } from 'vitest';
import { mergeAutoCharts, mergeUncertain } from '../src/chart/merge';
import { chartStorageKey, type Chart, type ChordEvent, type Recording, type UncertainSpan } from '../src/chart/types';
import { validateChart } from '../src/chart/validate';
import { CorrectionConflict, acceptUncertainAlt, correctChordEvent, eventEndSec, uncertainSpanEvent } from '../src/editor/correct';
import { ChartStore, handleChartWrite, normalizeSettings, type StorageArea } from '../src/extension/storage';
import { demoChart } from '../src/play/demo';
import { flagsInBar } from '../src/play/lane';
import { buildPlayModel, frameAt } from '../src/play/model';
import { altNames, markAt, visibleSpans, withRo } from '../src/play/uncertain';

const rec: Recording = { source: 'youtube', id: 'uncflag0001', title: 'T', artist: 'A' };
const MAIN = chartStorageKey('youtube', rec.id);
const NOW = new Date('2026-11-14T10:00:00.000Z');

const span = (fromSec: number, toSec: number, chord: string, alt: string): UncertainSpan => ({ fromSec, toSec, chord, alt });
const rspan = (fromSec: number, toSec: number, chord: string, alt: string): UncertainSpan => ({ ...span(fromSec, toSec, chord, alt), replace: true });

function chart(events: [number, string, number?][], coverage: [number, number][], uncertain?: UncertainSpan[], createdAt = '2026-11-10T00:00:00.000Z'): Chart {
  const c: Chart = {
    schemaVersion: 1,
    recording: { ...rec },
    timing: { bpm: 120, beatsPerBar: 4, beatUnit: 4, firstDownbeatSec: 0 },
    events: events.map(([startSec, chord, confidence]): ChordEvent => ({ startSec, chord, confidence: confidence ?? 0.8, source: 'auto' })),
    coverage: coverage.map(([fromSec, toSec]) => ({ fromSec, toSec })),
    provenance: { createdBy: 'recognizer', createdAt },
  };
  if (uncertain) c.uncertain = uncertain;
  return c;
}

/** C 0–4, G 4–8 (heard to 10), Am 8–10; a gap; F 20–24. */
const base = (uncertain?: UncertainSpan[]): Chart =>
  chart(
    [
      [0, 'C', 0.9],
      [4, 'G', 0.45],
      [8, 'Am', 0.7],
      [20, 'F', 0.8],
    ],
    [
      [0, 10],
      [20, 24],
    ],
    uncertain,
  );

class MemArea implements StorageArea {
  data: Record<string, unknown> = {};
  async get(keys: string[] | null): Promise<Record<string, unknown>> {
    await new Promise((r) => setTimeout(r, 0));
    const out: Record<string, unknown> = {};
    for (const k of keys ?? Object.keys(this.data)) if (k in this.data) out[k] = structuredClone(this.data[k]);
    return out;
  }
  async set(items: Record<string, unknown>): Promise<void> {
    await new Promise((r) => setTimeout(r, 0));
    Object.assign(this.data, structuredClone(items));
  }
}

describe('mergeAutoCharts keeps uncertain spans where each chart was heard', () => {
  it('previous spans outside the new coverage stay, the new chart’s spans are taken', () => {
    const prev = base([span(1, 2, 'C', 'Am'), span(5, 6, 'G', 'Em'), span(21, 23, 'F', 'Dm')]);
    const next = chart([[4, 'G', 0.5], [8, 'Em', 0.6]], [[4, 12]], [span(8.5, 9.5, 'Em', 'G')], '2026-11-12T00:00:00.000Z');
    const out = mergeAutoCharts(prev, next);
    // 5–6 lay in the re-heard range 4–12 and is replaced by the newer chart's spans.
    expect(out.uncertain).toEqual([span(1, 2, 'C', 'Am'), span(8.5, 9.5, 'Em', 'G'), span(21, 23, 'F', 'Dm')]);
    expect(validateChart(out).ok).toBe(true);
  });

  it('a previous span reaching into the new coverage is dropped; overlaps are removed; output is sorted', () => {
    expect(mergeUncertain([span(2, 5, 'C', 'Am')], [], [{ fromSec: 0, toSec: 4 }])).toEqual([]);
    expect(mergeUncertain([span(1, 3, 'C', 'Am')], [span(0.5, 1.5, 'C', 'F'), span(6, 7, 'G', 'Em')], [{ fromSec: 0, toSec: 4 }])).toEqual([span(0.5, 1.5, 'C', 'F'), span(6, 7, 'G', 'Em')]);
  });

  it('charts without spans merge exactly as before (no uncertain key)', () => {
    const prev = base();
    const next = chart([[4, 'G'], [8, 'Em']], [[4, 12]], undefined, '2026-11-12T00:00:00.000Z');
    const out = mergeAutoCharts(prev, next);
    expect('uncertain' in out).toBe(false);
    expect(out.events.map((e) => [e.startSec, e.chord])).toEqual([[0, 'C'], [4, 'G'], [8, 'Em'], [20, 'F']]);
    // only one side with spans: the result still carries them
    expect(mergeAutoCharts(base([span(21, 22, 'F', 'Dm')]), next).uncertain).toEqual([span(21, 22, 'F', 'Dm')]);
  });
});

describe('visible spans', () => {
  it('shows spans inside one auto event that still has the span’s chord (any spelling)', () => {
    const c = base([span(4, 8, 'G', 'Em'), span(20.5, 21.5, 'F', 'Dm')]);
    expect(visibleSpans(c, true).map((v) => [v.span.fromSec, v.ref])).toEqual([
      [4, { startSec: 4, chord: 'G' }],
      [20.5, { startSec: 20, chord: 'F' }],
    ]);
    const sharp = chart([[0, 'G#']], [[0, 4]], [span(1, 2, 'Ab', 'Fm')]);
    expect(visibleSpans(sharp, true)).toHaveLength(1);
  });

  it('hides everything when the switch is off or the chart has no spans', () => {
    expect(visibleSpans(base([span(4, 8, 'G', 'Em')]), false)).toEqual([]);
    expect(visibleSpans(base(), true)).toEqual([]);
  });

  it('hides a span after a manual fix of its event, after a chord change, across events and outside heard ranges', () => {
    const c = base([span(4, 8, 'G', 'Em')]);
    const fixed = correctChordEvent(c, { startSec: 4, chord: 'G' }, 'G', NOW); // same chord, but manual now
    expect(visibleSpans(fixed, true)).toEqual([]);
    expect(visibleSpans(base([span(4, 8, 'D', 'Em')]), true)).toEqual([]);
    expect(visibleSpans(base([span(3, 5, 'C', 'Em')]), true)).toEqual([]); // crosses C → G
    expect(visibleSpans(base([span(9, 11, 'Am', 'C')]), true)).toEqual([]); // runs past the heard end at 10
    expect(uncertainSpanEvent(base(), span(12, 13, 'Am', 'C'))).toBe(-1);
  });

  it('event ends follow the next event and the heard range', () => {
    const c = base();
    expect([0, 1, 2, 3].map((i) => eventEndSec(c, i))).toEqual([4, 8, 10, 24]);
  });
});

describe('acceptUncertainAlt: one action, stored like a chord fix', () => {
  it('a span covering the whole event replaces it (no head, no tail)', () => {
    const before = base([rspan(4, 8, 'G', 'Em')]);
    const after = acceptUncertainAlt(before, { startSec: 4, chord: 'G' }, rspan(4, 8, 'G', 'Em'), NOW);
    expect(after.events.map((e) => [e.startSec, e.chord, e.confidence, e.source])).toEqual([
      [0, 'C', 0.9, 'auto'],
      [4, 'Em', 1, 'manual'],
      [8, 'Am', 0.7, 'auto'],
      [20, 'F', 0.8, 'auto'],
    ]);
    expect(after.uncertain).toEqual([]);
    expect(after.provenance).toMatchObject({ createdBy: 'edited', updatedAt: NOW.toISOString() });
    expect(after.coverage).toEqual(before.coverage);
    expect(validateChart(after).ok).toBe(true);
    expect(before.events[1]).toEqual({ startSec: 4, chord: 'G', confidence: 0.45, source: 'auto' }); // input untouched
  });

  it('a span inside the event splits it into head, second choice and tail (a missed change)', () => {
    const after = acceptUncertainAlt(base([rspan(5, 6, 'G', 'D')]), { startSec: 4, chord: 'G' }, rspan(5, 6, 'G', 'D'), NOW);
    expect(after.events.map((e) => [e.startSec, e.chord, e.confidence, e.source])).toEqual([
      [0, 'C', 0.9, 'auto'],
      [4, 'G', 0.45, 'auto'],
      [5, 'D', 1, 'manual'],
      [6, 'G', 0.45, 'auto'],
      [8, 'Am', 0.7, 'auto'],
      [20, 'F', 0.8, 'auto'],
    ]);
    expect(validateChart(after).ok).toBe(true);
  });

  it('no head at the event start, no tail at the event end or the heard end', () => {
    const atStart = acceptUncertainAlt(base([rspan(4, 6, 'G', 'D')]), { startSec: 4, chord: 'G' }, rspan(4, 6, 'G', 'D'), NOW);
    expect(atStart.events.slice(1, 4).map((e) => [e.startSec, e.chord])).toEqual([[4, 'D'], [6, 'G'], [8, 'Am']]);
    const atEnd = acceptUncertainAlt(base([rspan(6, 8, 'G', 'D')]), { startSec: 4, chord: 'G' }, rspan(6, 8, 'G', 'D'), NOW);
    expect(atEnd.events.slice(1, 4).map((e) => [e.startSec, e.chord])).toEqual([[4, 'G'], [6, 'D'], [8, 'Am']]);
    const lastHeard = acceptUncertainAlt(base([rspan(22, 24, 'F', 'Dm')]), { startSec: 20, chord: 'F' }, rspan(22, 24, 'F', 'Dm'), NOW);
    expect(lastHeard.events.slice(3).map((e) => [e.startSec, e.chord])).toEqual([[20, 'F'], [22, 'Dm']]);
    expect(validateChart(lastHeard).ok).toBe(true);
  });

  it('another span of the same event keeps showing on the untouched part', () => {
    const c = base([rspan(4, 5, 'G', 'Em'), rspan(6, 7, 'G', 'D')]);
    const after = acceptUncertainAlt(c, { startSec: 4, chord: 'G' }, rspan(4, 5, 'G', 'Em'), NOW);
    expect(after.uncertain).toEqual([rspan(6, 7, 'G', 'D')]);
    expect(visibleSpans(after, true).map((v) => v.ref)).toEqual([{ startSec: 5, chord: 'G' }]);
  });

  it('a hand-made chart stays manual', () => {
    const c = base([rspan(4, 8, 'G', 'Em')]);
    c.provenance.createdBy = 'manual';
    expect(acceptUncertainAlt(c, { startSec: 4, chord: 'G' }, rspan(4, 8, 'G', 'Em'), NOW).provenance.createdBy).toBe('manual');
  });

  it('a changed chart is a CorrectionConflict', () => {
    const c = base([rspan(4, 8, 'G', 'Em')]);
    expect(() => acceptUncertainAlt(c, { startSec: 4, chord: 'D' }, rspan(4, 8, 'G', 'Em'), NOW)).toThrow(CorrectionConflict); // event changed
    expect(() => acceptUncertainAlt(c, { startSec: 4, chord: 'G' }, rspan(4, 8, 'G', 'D'), NOW)).toThrow(CorrectionConflict); // span gone
    const fixed = correctChordEvent(c, { startSec: 4, chord: 'G' }, 'G', NOW);
    expect(() => acceptUncertainAlt(fixed, { startSec: 4, chord: 'G' }, rspan(4, 8, 'G', 'Em'), NOW)).toThrow(CorrectionConflict); // fixed by hand
    const done = acceptUncertainAlt(c, { startSec: 4, chord: 'G' }, rspan(4, 8, 'G', 'Em'), NOW);
    expect(() => acceptUncertainAlt(done, { startSec: 4, chord: 'G' }, rspan(4, 8, 'G', 'Em'), NOW)).toThrow(CorrectionConflict); // pressed twice
  });
});

describe('ChartStore: the second choice goes through the serialized writes and undoes like a fix', () => {
  it('stores, survives a later auto analysis as pending, and undo restores the auto chart', async () => {
    const area = new MemArea();
    const store = new ChartStore(area);
    await store.saveAuto(base([rspan(4, 8, 'G', 'Em')]));
    const r = await handleChartWrite(store, { type: 'chart-write', op: 'accept-alt', source: 'youtube', id: rec.id, event: { startSec: 4, chord: 'G' }, span: rspan(4, 8, 'G', 'Em'), at: NOW.toISOString() });
    expect(r.ok).toBe(true);
    const after = area.data[MAIN] as Chart;
    expect(after.events[1]).toEqual({ startSec: 4, chord: 'Em', confidence: 1, source: 'manual' });
    expect(await store.saveAuto(chart([[30, 'D']], [[30, 34]], undefined, '2026-11-14T11:00:00.000Z'))).toBe('pending');
    const before = (r as { before: Chart }).before;
    const restored = await store.undoCorrection('youtube', rec.id, before, after);
    expect(restored.events.map((e) => e.chord)).toEqual(['C', 'G', 'Am', 'F', 'D']);
    expect(restored.uncertain).toEqual([rspan(4, 8, 'G', 'Em')]);
  });

  it('a stale request is refused with the conflict message', async () => {
    const store = new ChartStore(new MemArea());
    await store.saveAuto(base([rspan(4, 8, 'G', 'Em')]));
    await store.acceptAlt('youtube', rec.id, { startSec: 4, chord: 'G' }, rspan(4, 8, 'G', 'Em'), NOW);
    const r = await handleChartWrite(store, { type: 'chart-write', op: 'accept-alt', source: 'youtube', id: rec.id, event: { startSec: 4, chord: 'G' }, span: rspan(4, 8, 'G', 'Em'), at: NOW.toISOString() });
    expect(r).toEqual({ ok: false, error: '코드표가 그 사이에 바뀌었어요. 다시 골라 주세요.' });
  });

  it('a request from the replace tier is refused after a new analysis made the stretch info-only (review r4 F4)', async () => {
    const area = new MemArea();
    const store = new ChartStore(area);
    await store.saveAuto(base([rspan(4, 8, 'G', 'Em')])); // the panel showed the button
    await store.saveAuto(base([span(4, 8, 'G', 'Em')])); // a new analysis: same stretch, info only
    const r = await handleChartWrite(store, { type: 'chart-write', op: 'accept-alt', source: 'youtube', id: rec.id, event: { startSec: 4, chord: 'G' }, span: rspan(4, 8, 'G', 'Em'), at: NOW.toISOString() });
    expect(r).toEqual({ ok: false, error: '코드표가 그 사이에 바뀌었어요. 다시 골라 주세요.' });
    const stored = area.data[MAIN] as Chart;
    expect(stored.events[1]).toMatchObject({ startSec: 4, chord: 'G', source: 'auto' });
    expect(stored.uncertain).toEqual([span(4, 8, 'G', 'Em')]);
    // an info-only stretch is never replaced, even when asked for it directly
    expect(() => acceptUncertainAlt(stored, { startSec: 4, chord: 'G' }, span(4, 8, 'G', 'Em'), NOW)).toThrow(CorrectionConflict);
  });
});

describe('names on the play screen', () => {
  const timing = { bpm: 120, beatsPerBar: 4, beatUnit: 4 as const, firstDownbeatSec: 0 };
  const at = { fromSec: 0, toSec: 2 };

  it('capo: shape name, concert name kept apart', () => {
    expect(altNames('A#m', null, timing, at, { level: 'novice', capo: 1 })).toEqual({ name: 'Am', sounding: 'A♯m' });
    expect(altNames('G', null, timing, at, { level: 'novice', capo: 0 })).toEqual({ name: 'G', sounding: 'G' });
  });

  it('level simplification applies (입문 drops the 7th)', () => {
    expect(altNames('G7', null, timing, at, { level: 'beginner', capo: 0 }).name).toBe('G');
    expect(altNames('G7', null, timing, at, { level: 'advanced', capo: 0 }).name).toBe('G7');
  });

  it('the particle before 바꾸기 follows the spoken name (the 대안 button label)', () => {
    expect(['Am', 'G', 'C7', 'B♭', 'F♯m', 'Cmaj7', 'Bdim', 'A6', 'D/F♯', 'Em/B'].map(withRo)).toEqual(['Am으로', 'G로', 'C7로', 'B♭으로', 'F♯m으로', 'Cmaj7로', 'Bdim으로', 'A6으로', 'D/F♯으로', 'Em/B로']);
  });
});

describe('play model marks and the 불확실한 곳 표시 switch', () => {
  it('the demo chart is valid and every synthetic span shows with capo shape names', () => {
    const c = demoChart();
    expect(validateChart(c).ok).toBe(true);
    const m = buildPlayModel(c, { level: 'beginner', capo: 'auto' }, null);
    expect(m.arrangement.capo).toBe(1);
    expect(m.uncertain.map((u) => [u.ref.chord, u.alt, u.altSounding])).toEqual([
      ['Fm', 'G', 'A♭'],
      ['C#', 'D', 'E♭'],
      ['Fm7', 'G', 'A♭'],
      ['C#', 'Am', 'B♭m'],
      ['N', 'G', 'A♭'],
    ]);
  });

  it('a stretch covering part of a bar is drawn at its own beats', () => {
    const m = buildPlayModel(demoChart(), { level: 'beginner', capo: 'auto' }, null);
    const part = m.uncertain[1];
    const bar = m.bars.find((b) => b.startSec <= part.fromSec && part.fromSec < b.endSec)!;
    expect(bar.segments.map((s) => [m.labels[s.event].name, s.flag, s.weight])).toEqual([
      ['C', -1, 1],
      ['C', 1, 1],
    ]);
    expect(bar.repeat).toBe(false);
    const f = frameAt(m, part.fromSec + 0.2);
    expect(f.uncertain).toBe(1);
    expect(frameAt(m, part.fromSec - 0.2).uncertain).toBe(-1);
    expect(markAt(m.uncertain, part.toSec)).toBe(-1);
  });

  it('switch off: no marks, no flagged segments; the first choice is unchanged', () => {
    const on = buildPlayModel(demoChart(), { level: 'beginner', capo: 'auto' }, null);
    const off = buildPlayModel(demoChart(), { level: 'beginner', capo: 'auto', showUncertain: false }, null);
    expect(off.uncertain).toEqual([]);
    expect(off.bars.flatMap((b) => b.segments).every((s) => s.flag === -1)).toBe(true);
    expect(off.labels).toEqual(on.labels);
  });

  it('a mark whose second choice reads like the shown chord is not offered', () => {
    // At 입문 Gmaj7 is played as G, so a second choice "G" would change nothing on screen.
    const c = chart([[0, 'Gmaj7']], [[0, 4]], [span(0, 4, 'Gmaj7', 'G')]);
    expect(buildPlayModel(c, { level: 'beginner', capo: 0 }, null).uncertain).toEqual([]);
    expect(buildPlayModel(c, { level: 'advanced', capo: 0 }, null).uncertain).toHaveLength(1);
  });

  it('the setting defaults on and keeps an explicit off', () => {
    expect(normalizeSettings(undefined).showUncertain).toBe(true);
    expect(normalizeSettings({ showUncertain: false }).showUncertain).toBe(false);
  });
});

describe('lane: a visible stretch is always drawn (review vgt19-flags-ui-r1 F1)', () => {
  // 120 BPM 4/4: bars of 2 s, beats (= big beats) of 0.5 s; one auto G 0–8 s.
  const g = (s: UncertainSpan): Chart => chart([[0, 'G']], [[0, 8]], [s]);
  const lane = (s: UncertainSpan) => {
    const m = buildPlayModel(g(s), { level: 'novice', capo: 0 }, null);
    expect(m.uncertain).toHaveLength(1);
    return { m, bars: m.bars.map((b) => b.segments.map((x) => [x.startSec, x.endSec, x.flag])) };
  };

  it('a bound within 0.1 s after the bar start snaps to it (G 0–8, Em at 0.05–1)', () => {
    const { m, bars } = lane(span(0.05, 1, 'G', 'Em'));
    expect(validateChart(g(span(0.05, 1, 'G', 'Em'))).ok).toBe(true);
    expect(frameAt(m, 0.5).uncertain).toBe(0);
    expect(bars[0]).toEqual([[0, 1, 0], [1, 2, -1]]);
  });

  it('a bound within 0.1 s before the bar end snaps to it', () => {
    expect(lane(span(2.5, 3.95, 'G', 'Em')).bars[1]).toEqual([[2, 2.5, -1], [2.5, 4, 0]]);
  });

  it('a stretch shorter than one big beat still gets its own flagged segment', () => {
    const { m, bars } = lane(span(5.2, 5.4, 'G', 'Em'));
    expect(bars[2]).toEqual([[4, 5.2, -1], [5.2, 5.4, 0], [5.4, 6, -1]]);
    expect(m.bars[2].segments[1].weight).toBeCloseTo(0.4);
  });

  it('a stretch covering a whole bar flags that bar, which is not drawn as a repeat', () => {
    const { m, bars } = lane(span(6, 8, 'G', 'Em'));
    expect(bars[3]).toEqual([[6, 8, 0]]);
    expect(m.bars[3].repeat).toBe(false);
    expect(bars.slice(0, 3).flat().every(([, , f]) => f === -1)).toBe(true);
  });

  it('a sliver under 0.1 s past a bar line is drawn only in the bar that holds the stretch', () => {
    const { bars } = lane(span(1, 2.05, 'G', 'Em'));
    expect(bars[0]).toEqual([[0, 1, -1], [1, 2, 0]]);
    expect(bars[1]).toEqual([[2, 4, -1]]);
  });
});

describe('lane: segment content by overlap (review vgt19-flags-ui-r2)', () => {
  const lane = (c: Chart, marks: number) => {
    const m = buildPlayModel(c, { level: 'novice', capo: 0 }, null);
    expect(validateChart(c).ok).toBe(true);
    expect(m.uncertain).toHaveLength(marks);
    return { m, bars: m.bars.map((b) => b.segments.map((x) => [x.startSec, x.endSec, x.flag, x.event])) };
  };

  it('F1: event and coverage from 0.05 s, stretch 0.05–1 s → the first bar has a flagged segment with the G event', () => {
    const c = chart([[0.05, 'G']], [[0.05, 8]], [span(0.05, 1, 'G', 'Em')]);
    const { m, bars } = lane(c, 1);
    expect(frameAt(m, 0.5).uncertain).toBe(0);
    const g = m.arrangement.events.findIndex((e) => e.original === 'G');
    expect(bars[0]).toEqual([[0, 1, 0, g], [1, 2, -1, g]]);
    expect(m.labels[g].name).toBe('G');
  });

  it('F2: a short later stretch is not hidden behind an earlier one mapped to the bar end', () => {
    const c = chart([[0, 'G']], [[0, 8]], [span(0.5, 1.95, 'G', 'Em'), span(1.95, 2, 'G', 'Am')]);
    const { m, bars } = lane(c, 2);
    // Em keeps 0.5–1.95; Am, 0.05 s long, is drawn as its own short segment at the bar end.
    expect(bars[0]).toEqual([[0, 0.5, -1, 0], [0.5, 1.95, 0, 0], [1.95, 2, 1, 0]]);
    expect(m.uncertain.map((u) => u.alt)).toEqual(['Em', 'Am']);
    expect(frameAt(m, 1.97).uncertain).toBe(1);
  });

  it('lane stretches never overlap; one clipped to zero width is not drawn in the lane', () => {
    expect(flagsInBar([{ fromSec: 0.5, toSec: 1.95 }, { fromSec: 1.95, toSec: 2 }], 0, 2)).toEqual([
      { index: 0, fromSec: 0.5, toSec: 1.95 },
      { index: 1, fromSec: 1.95, toSec: 2 },
    ]);
    // both map onto the bar start: the first collapses, the second keeps 0–1
    expect(flagsInBar([{ fromSec: 0, toSec: 0.04 }, { fromSec: 0.04, toSec: 1 }], 0, 2)).toEqual([{ index: 1, fromSec: 0, toSec: 1 }]);
  });

  it('a bar without a stretch keeps the drawing from before VGT-19 (C 0–0.05 s, then G → C)', () => {
    const c = chart([[0, 'C'], [0.05, 'G']], [[0, 8]]);
    const m = buildPlayModel(c, { level: 'novice', capo: 0 }, null);
    expect(m.bars[0].segments.map((x) => m.labels[x.event].name)).toEqual(['C']);
  });
});

describe('lane: unanalysed time competes as "no chord" (review vgt19-flags-ui-r3 F3)', () => {
  const firstBar = (c: Chart, showUncertain = true) => {
    const m = buildPlayModel(c, { level: 'novice', capo: 0, showUncertain }, null);
    return { m, segs: m.bars[0].segments.map((x) => [x.startSec, x.endSec, x.event < 0 ? 'empty' : m.labels[x.event].name, x.flag]) };
  };

  it('G and coverage 1.95–8 s, no stretches: the first bar stays empty, like frameAt', () => {
    const c = chart([[1.95, 'G']], [[1.95, 8]]);
    expect(validateChart(c).ok).toBe(true);
    const { m, segs } = firstBar(c);
    expect(segs).toEqual([[0, 2, 'empty', -1]]);
    expect(frameAt(m, 0.5).event).toBe(-1);
    expect(firstBar(c, false).segs).toEqual([[0, 2, 'empty', -1]]);
  });

  it('G and coverage 1.95–1.99 s: the first bar stays empty', () => {
    const c = chart([[1.95, 'G']], [[1.95, 1.99]]);
    expect(validateChart(c).ok).toBe(true);
    expect(firstBar(c).segs).toEqual([[0, 2, 'empty', -1]]);
    expect(firstBar(c, false).segs).toEqual([[0, 2, 'empty', -1]]);
  });

  it('in a bar with a stretch, mostly unheard time still draws as empty', () => {
    // G heard 1.5–8 s with a stretch 1.5–1.9 s: 0–1.5 s is unheard, the stretch keeps its own segment.
    const c = chart([[1.5, 'G']], [[1.5, 8]], [span(1.5, 1.9, 'G', 'Em')]);
    expect(firstBar(c).segs).toEqual([[0, 1.5, 'empty', -1], [1.5, 1.9, 'G', 0], [1.9, 2, 'G', -1]]);
  });
});

describe('two tiers on the panel (Amendment 1)', () => {
  it('replace is optional and only true is valid; merging keeps it', () => {
    expect(validateChart(base([{ ...span(4, 8, 'G', 'Em'), replace: true }])).ok).toBe(true);
    expect(validateChart(base([{ ...span(4, 8, 'G', 'Em'), replace: false } as unknown as UncertainSpan])).errors).toContain('uncertain[0].replace must be true when present');
    expect(validateChart(base([{ ...span(4, 8, 'G', 'Em'), replace: 'yes' } as unknown as UncertainSpan])).ok).toBe(false);
    const prev = base([{ ...span(21, 23, 'F', 'Dm'), replace: true }]);
    const next = chart([[4, 'G'], [8, 'Em']], [[4, 12]], [{ ...span(8.5, 9.5, 'Em', 'G'), replace: true }, span(10, 11, 'Em', 'C')], '2026-11-12T00:00:00.000Z');
    expect(mergeAutoCharts(prev, next).uncertain).toEqual([{ ...span(8.5, 9.5, 'Em', 'G'), replace: true }, span(10, 11, 'Em', 'C'), { ...span(21, 23, 'F', 'Dm'), replace: true }]);
  });

  it('every visible stretch is marked; the tier only decides the button', () => {
    const c = base([{ ...span(4, 6, 'G', 'Em'), replace: true }, span(20, 22, 'F', 'Dm')]);
    const m = buildPlayModel(c, { level: 'novice', capo: 0 }, null);
    expect(m.uncertain.map((u) => [u.alt, u.replace])).toEqual([['Em', true], ['Dm', false]]);
    expect(m.bars.flatMap((b) => b.segments).filter((s) => s.flag >= 0).map((s) => s.flag)).toEqual([0, 1]);
    // the replacement of a replace-tier stretch is stored like before
    const after = acceptUncertainAlt(c, m.uncertain[0].ref, m.uncertain[0].span, NOW);
    expect(after.events[1]).toEqual({ startSec: 4, chord: 'Em', confidence: 1, source: 'manual' });
    expect(after.uncertain).toEqual([span(20, 22, 'F', 'Dm')]);
  });

  it('demo: the verse Fm stretch (11.6–13.6 s) and the ringing end (89.6–90.6 s, no chord) are in the replace tier', () => {
    const m = buildPlayModel(demoChart(), { level: 'beginner', capo: 'auto' }, null);
    expect(m.uncertain.map((u) => [u.fromSec, u.toSec, u.replace])).toEqual([
      [11.6, 13.6, true],
      [14.6, 15.6, false],
      [19.6, 21.6, false],
      [27.6, 29.6, false],
      [89.6, 90.6, true],
    ]);
  });
});
