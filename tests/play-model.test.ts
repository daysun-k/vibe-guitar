import { describe, expect, it } from 'vitest';
import { demoChart, demoLyrics, DemoClock } from '../src/play/demo';
import { buildPlayModel, frameAt, upcomingShapes, type PlayModel } from '../src/play/model';
import { simpleShape } from '../src/play/lane';
import { normalizeSettings } from '../src/extension/storage';
import { voicingsForChord, parseChord } from '../src/arrange';
import { renderShapeDiagram, shapeDiagramHeight } from '../src/extension/sidepanel/diagram';

describe('play model on the synthetic demo song', () => {
  const chart = demoChart();

  it('spells for A-flat, fixes the bar phase and counts big beats in 6/8', () => {
    const m = buildPlayModel(chart, { level: 'novice', capo: 0 }, null);
    expect(m.key?.tonicName).toBe('Ab');
    expect(new Set(m.labels.filter((l) => l.name !== 'N.C.').map((l) => l.name.replace(/(7|maj7)$/, '')))).toEqual(new Set(['A♭', 'Fm', 'D♭', 'E♭']));
    expect(m.phaseShifted).toBe(true);
    expect(m.phase.phase).toBe(3);
    expect(m.big).toMatchObject({ compound: true, bigPerBar: 2 });
    // every chord change sits on a bar start
    const starts = new Set(m.bars.map((b) => b.startSec.toFixed(3)));
    for (const e of m.arrangement.events.slice(1)) expect(starts.has(e.startSec.toFixed(3))).toBe(true);
    // one chord per bar (a bar may still be cut at a synthetic uncertain stretch, VGT-19)
    expect(m.bars.slice(0, -1).every((b) => new Set(b.segments.map((s) => s.event)).size === 1)).toBe(true);
    expect(m.bars.slice(0, -1).filter((b) => b.segments.length > 1)).toHaveLength(1);
    // the last bar runs past the end of coverage (90.6 s): that tail is drawn empty
    const last = m.bars[m.bars.length - 1];
    expect(last.segments.map((s) => [s.event >= 0, s.endSec])).toEqual([[true, 90.6], [false, last.endSec]]);
    expect(m.bars.some((b) => b.repeat)).toBe(true);
  });

  it('builds sections from lyrics and anchors chords to words after the offset', () => {
    const m = buildPlayModel(chart, { level: 'novice', capo: 0 }, demoLyrics(0.4));
    expect(m.lyricOffset?.confident).toBe(true);
    expect(m.lyricOffset?.offsetSec).toBeCloseTo(0.4, 2);
    expect(m.sections.map((s) => s.name)).toEqual(['인트로', '1절', '후렴', '간주', '2절', '후렴', '아웃트로']);
    expect(m.placed.every((p) => p.fallback === null)).toBe(true);
    expect(m.placed[0].anchors[0]).not.toBeNull(); // the bar-start chord lands on the first word
    const f = frameAt(m, m.lyrics!.lines[0].words[2].startSec + 0.01);
    expect(f.line).toBe(0);
    expect(m.sections[f.section].name).toBe('1절');
  });

  it('counts down in big beats to the next change and finds the bar under the playhead', () => {
    const m = buildPlayModel(chart, { level: 'novice', capo: 0 }, null);
    const ev = m.arrangement.events;
    const k = ev.findIndex((e) => !e.rest && e.endSec - e.startSec < 2.5);
    const f = frameAt(m, ev[k].startSec + 0.05);
    expect(f.event).toBe(k);
    expect(f.next).toBe(k + 1);
    expect(f.bigLeft).toBe(2);
    expect(m.bars[f.bar].startSec).toBeCloseTo(ev[k].startSec, 3);
    expect(f.bigInBar).toBe(0);
    expect(frameAt(m, ev[k].startSec + 1.1).bigLeft).toBe(1);
    expect(frameAt(m, ev[k].startSec + 1.1).bigInBar).toBe(1);
  });

  it('beginner drops 7ths (superscript) and intermediate offers an easier shape for uncertain 7ths', () => {
    const beg = buildPlayModel(chart, { level: 'beginner', capo: 0 }, null);
    const reduced = beg.arrangement.events.findIndex((e) => e.original === 'Fm7');
    expect(beg.labels[reduced]).toMatchObject({ name: 'Fm', had7: true });
    const mid = buildPlayModel(chart, { level: 'intermediate', capo: 0 }, null);
    const hinted = mid.labels.filter((l) => l.hint);
    expect(hinted.length).toBeGreaterThan(0);
    expect(hinted[0].hint).toMatch(/도 돼요$/);
    expect(simpleShape('Em7')).toBe('Em');
    expect(simpleShape('Cmaj7')).toBe('C');
  });

  it('with a capo shows shapes and keeps the sounding names', () => {
    const m = buildPlayModel(chart, { level: 'novice', capo: 1 }, null);
    const first = m.labels.find((l) => l.name !== 'N.C.')!;
    expect(first.name).toBe('G');
    expect(first.sounding).toBe('A♭');
    expect(m.strip.map((s) => s.shape).slice(0, 4)).toEqual(['G', 'D', 'Em', 'C']);
  });
});

describe('demo clock', () => {
  it('advances while playing at the chosen rate and clamps to the duration', () => {
    const c = new DemoClock(10, 2);
    c.tick(0);
    c.play(0);
    expect(c.tick(1000)).toBeCloseTo(3, 6);
    c.rate = 0.5;
    expect(c.tick(3000)).toBeCloseTo(4, 6);
    c.seek(9.9);
    c.tick(4000);
    expect(c.tick(5000)).toBe(10);
    expect(c.playing).toBe(false);
  });
});

describe('settings migration', () => {
  it('maps the old count-in flag and fills new defaults', () => {
    expect(normalizeSettings({ countIn: false }).countInBars).toBe(0);
    expect(normalizeSettings({ countIn: true }).countInBars).toBe(1);
    const d = normalizeSettings(undefined);
    expect(d).toMatchObject({ countInBars: 1, showSounding: false, fetchLyrics: true, theme: 'auto' });
    expect('countIn' in d).toBe(false);
  });
});

describe('play-view diagram', () => {
  it('draws finger numbers, open/muted marks and scales to 120 px', () => {
    const c = voicingsForChord(parseChord('C')).find((v) => v.frets.join() === [null, 3, 2, 0, 1, 0].join())!;
    const svg = renderShapeDiagram(c, 120);
    expect(svg).toContain('width="120"');
    expect(svg.match(/class="d-num"/g)).toHaveLength(3);
    expect(svg.match(/class="d-open"/g)).toHaveLength(2);
    expect(svg.match(/class="d-x"/g)).toHaveLength(1);
    const f = voicingsForChord(parseChord('F')).find((v) => v.frets.join() === [1, 3, 3, 2, 1, 1].join())!;
    expect(renderShapeDiagram(f)).toContain('d-barre');
  });

  it('reports the viewBox height the strip reserves for the tallest shape', () => {
    const all = ['C', 'G', 'D', 'Em', 'Am', 'F', 'Bm', 'B', 'F#m', 'Bb', 'Gm', 'C#m', 'Ab', 'Eb', 'Fmaj7'].flatMap((n) => voicingsForChord(parseChord(n)));
    const heights = new Set<number>();
    for (const v of all) {
      const h = shapeDiagramHeight(v);
      expect(renderShapeDiagram(v)).toContain(`viewBox="0 0 100 ${h}"`);
      heights.add(h);
    }
    expect([...heights]).toEqual([128]);
    // a stretch over five frets gets the fifth row
    const wide = { ...all[0], frets: [null, 5, 7, 7, 9, 5] };
    expect(shapeDiagramHeight(wide)).toBe(152);
    expect(renderShapeDiagram(wide)).toContain('viewBox="0 0 100 152"');
  });
});

describe('sections without lyrics', () => {
  it('groups bars by 8 when there are no lyrics', async () => {
    const { buildSections } = await import('../src/play/lane');
    const bars = Array.from({ length: 20 }, (_, i) => ({ startSec: i * 2, endSec: i * 2 + 2 }));
    expect(buildSections(bars, null).map((s) => [s.name, s.firstBar])).toEqual([
      ['1–8마디', 0],
      ['9–16마디', 8],
      ['17–20마디', 16],
    ]);
  });
});

describe('sections from lyrics', () => {
  it('keeps a short once-sung tail with the chorus and numbers verses after gaps', async () => {
    const { buildSections } = await import('../src/play/lane');
    const bars = Array.from({ length: 40 }, (_, i) => ({ startSec: i * 2, endSec: i * 2 + 2 }));
    let t = 4;
    const line = (text: string, gapAfter = 0.3) => {
      const l = { startSec: t, endSec: t + 1.7, text, words: [], wordTimed: false };
      t += 2 + gapAfter;
      return l;
    };
    const lines = [
      line('v1 a'), line('v1 b'), line('v1 c'), line('v1 d'),
      line('ch a'), line('ch b'), line('tail x'), line('tail y', 8),
      line('v2 a'), line('v2 b'), line('v2 c'), line('v2 d'),
      line('ch a'), line('ch b'),
    ];
    expect(buildSections(bars, lines).map((s) => s.name)).toEqual(['인트로', '1절', '후렴', '간주', '2절', '후렴', '아웃트로']);
  });
});

describe('three-up shape strip', () => {
  // events: G, G (same shape), rest, D, Em, C | coverage gap | A
  const spans: [number, number, string][] = [[0, 2, 'G'], [2, 4, 'G'], [4, 5, ''], [5, 7, 'D'], [7, 9, 'Em'], [9, 11, 'C'], [20, 22, 'A']];
  const m = {
    arrangement: { events: spans.map(([startSec, endSec, k]) => ({ startSec, endSec, rest: !k })) },
    stripKeys: spans.map(([, , k]) => (k ? `${k}|v` : '')),
  } as unknown as Pick<PlayModel, 'arrangement' | 'stripKeys'>;

  it('shows the current shape and the next two changes, skipping rests and repeats', () => {
    expect(upcomingShapes(m, { event: 0, next: 1 })).toEqual([0, 3, 4]);
    expect(upcomingShapes(m, { event: 1, next: 3 })).toEqual([1, 3, 4]);
    expect(upcomingShapes(m, { event: 3, next: 4 })).toEqual([3, 4, 5]);
  });

  it('starts from the coming chord during a rest and stops at a coverage gap', () => {
    expect(upcomingShapes(m, { event: -1, next: 3 })).toEqual([3, 4, 5]);
    expect(upcomingShapes(m, { event: 4, next: 5 })).toEqual([4, 5]);
    expect(upcomingShapes(m, { event: 5, next: -1 })).toEqual([5]);
    expect(upcomingShapes(m, { event: -1, next: 6 })).toEqual([6]);
    expect(upcomingShapes(m, { event: -1, next: -1 })).toEqual([]);
  });

  it('never shows more than three shapes on the demo song', () => {
    const d = buildPlayModel(demoChart(), { level: 'novice', capo: 0 }, null);
    expect(d.strip.length).toBeGreaterThan(3);
    for (const e of d.arrangement.events) {
      const f = frameAt(d, e.startSec + 0.05);
      const up = upcomingShapes(d, f);
      expect(up.length).toBeLessThanOrEqual(3);
      if (f.event >= 0) expect(up[0]).toBe(f.event);
      const keys = up.map((i) => d.stripKeys[i]);
      keys.slice(1).forEach((k, i) => expect(k).not.toBe(keys[i]));
    }
  });
});
