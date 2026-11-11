/**
 * VGT-11: level vocabulary, staged substitution, change records, suitability and the
 * level-fit worker protocol. Synthetic chord sequences only.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PROFILE,
  LEVELS,
  RAW_LEVELS,
  SOURCES,
  allVoicings,
  arrangeChart,
  arrangeEvents,
  inLevel,
  parseChord,
  rawKey,
  rawVoicings,
  suggestCapo,
  voicingLevel,
  voicingsForChord,
  fretString,
  type ArrangeInputEvent,
  type Arrangement,
  type Level,
  type Profile,
} from '../src/arrange';
import { levelSuitability, summarizeArrangement, verdictFor } from '../src/arrange/suitability';
import type { Chart, Timing } from '../src/chart/types';
import { LevelFitController, levelFitKey, type LevelFitInput, type LevelFitWorkerRequest, type LevelFitWorkerResponse, type LevelWorkerLike } from '../src/play/level-fit';
import { buildLane, stripItems } from '../src/play/lane';
import { buildPlayModel, upcomingShapes } from '../src/play/model';
import { bigBeatInfo } from '../src/music/meter';

const timing: Timing = { bpm: 90, beatsPerBar: 4, beatUnit: 4, firstDownbeatSec: 0, feel: 'straight' };
const BEAT = 60 / 90;

/** [chord, beats] pairs, back to back from 0 ("N" = rest). */
function seq(items: [string, number][]): ArrangeInputEvent[] {
  let t = 0;
  return items.map(([chord, beats]) => {
    const e = { startSec: t, endSec: t + beats * BEAT, chord, confidence: 1 };
    t += beats * BEAT;
    return e;
  });
}
const bars = (chords: string[]): [string, number][] => chords.map((c) => [c, 4]);

function chartOf(items: [string, number][], id = 'SYNTHETIC'): Chart {
  const ev = seq(items);
  return {
    schemaVersion: 1,
    recording: { source: 'youtube', id, title: 'synthetic', artist: 'test' },
    timing,
    events: ev.map((e) => ({ startSec: e.startSec, chord: e.chord, confidence: 1, source: 'manual' })),
    coverage: [{ fromSec: 0, toSec: ev[ev.length - 1].endSec }],
    provenance: { createdBy: 'manual', createdAt: '2026-11-11T00:00:00Z', tool: 'test', note: 'synthetic', example: true },
  } as Chart;
}

const P = (o: Partial<Profile>): Profile => ({ ...DEFAULT_PROFILE, ...o });
const CAPO0: Profile = P({ capoMin: 0, capoMax: 0 });

describe('vocabulary: every voicing has a level and a basis', () => {
  it('every hand-listed row has an explicit entry with a basis and a note', () => {
    const missing = rawVoicings().filter((v) => !RAW_LEVELS[rawKey(v)]).map(rawKey);
    expect(missing).toEqual([]);
    for (const v of rawVoicings()) {
      const e = voicingLevel(v)!;
      expect(LEVELS).toContain(e.level);
      expect(e.basis === 'product' || e.basis in SOURCES).toBe(true);
      expect(e.note.length).toBeGreaterThan(5);
    }
    // No stale entries either.
    const keys = new Set(rawVoicings().map(rawKey));
    expect(Object.keys(RAW_LEVELS).filter((k) => !keys.has(k))).toEqual([]);
  });

  it('every template position and derived slash voicing gets a level from a rule', () => {
    for (const v of allVoicings()) expect(voicingLevel(v), v.id).not.toBeNull();
    for (const sym of ['C/B', 'G/B', 'D/F#', 'Am/G', 'F/C', 'Bb/D', 'E/G#']) {
      for (const v of voicingsForChord(parseChord(sym))) expect(voicingLevel(v), `${sym} ${v.id}`).not.toBeNull();
    }
  });

  it('assigns the required levels', () => {
    const lv = (chord: string, frets: string): Level => voicingLevel(voicingsForChord(parseChord(chord)).find((v) => fretString(v.frets) === frets)!)!.level;
    expect(lv('B7', 'x21202')).toBe('beginner');
    expect(lv('Bm', 'xx4432')).toBe('novice');
    for (const [c, f] of [['F', 'xx3211'], ['Fm', 'xx3111'], ['F#m', 'xx4222'], ['Gm', 'xx5333'], ['Bb', 'xx3331']]) expect(lv(c, f)).toBe('novice');
    for (const [c, f] of [['C', 'x32010'], ['G', '320003'], ['Am', 'x02210'], ['D', 'xx0232'], ['Em', '022000'], ['A', 'x02220'], ['E', '022100'], ['Dm', 'xx0231'], ['D7', 'xx0212']]) expect(lv(c, f)).toBe('beginner');
    for (const [c, f] of [['Am7', 'x02010'], ['Em7', '022030'], ['A7', 'x02020'], ['E7', '020100'], ['Cmaj7', 'x32000'], ['Fmaj7', 'xx3210'], ['Bm7', 'x20202'], ['F#m7', '2x2220']]) expect(lv(c, f)).toBe('beginner');
    const barreF = voicingsForChord(parseChord('F')).find((v) => v.kind === 'barre')!;
    expect(voicingLevel(barreF)!.level).toBe('intermediate');
    const dim7 = voicingsForChord(parseChord('Ebdim7')).find((v) => v.origin === 'template')!;
    expect(voicingLevel(dim7)!.level).toBe('advanced');
    // A derived slash voicing with a fretted bass is never below novice; an open bass keeps the base level.
    const derived = ['C/D', 'C/F', 'G/A', 'Am/C', 'Em/B'].flatMap((c) => voicingsForChord(parseChord(c)).filter((v) => v.origin === 'derived'));
    const fretted = derived.filter((v) => Number(/:(\d+)$/.exec(v.id)![1]) > 0);
    expect(fretted.length).toBeGreaterThan(0);
    for (const v of fretted) expect(inLevel(v, 'beginner'), v.id).toBe(false);
    for (const v of derived.filter((x) => !fretted.includes(x))) expect(voicingLevel(v)!.rule).toBe('derived-slash');
  });
});

describe('chord types per level', () => {
  it('novice keeps Cadd9 but drops C9 (to C7), and marks the change', () => {
    const a = arrangeEvents(seq(bars(['Cadd9', 'C9', 'F', 'G'])), timing, { level: 'novice', capo: 0 });
    expect(a.events[0].sounding).toBe('Cadd9');
    expect(a.events[0].change).toBeNull();
    expect(a.events[1].sounding).toBe('C7');
    expect(a.events[1].change).toMatchObject({ original: 'C9', sounding: 'C7', code: 'drop-extension', rootChanged: false });
  });
});

const D_LOOP = ['D', 'A', 'Bm', 'G', 'F#m', 'D', 'A', 'Bm', 'G', 'F#m'];

describe('synthetic D-major loop at beginner', () => {
  const chart = chartOf(bars(D_LOOP), 'SYNTHETIC-D-LOOP');

  it('setting off: no root changes; Bm and F#m are handled by a same-root change or counted hard', () => {
    for (const capo of [0, 1, 2, 3, 4, 5, 6, 7]) {
      const a = arrangeChart(chart, { level: 'beginner', capo });
      for (const e of a.events) {
        expect(e.change?.rootChanged ?? false).toBe(false);
        expect(parseChord(e.sounding!).root).toBe(parseChord(e.original).root);
        if (e.original === 'Bm' || e.original === 'F#m') expect(e.stage === 1 || e.stage === 2 || e.hard).toBe(true);
        if (e.stage === 2) expect(e.change?.text).toBeTruthy();
      }
    }
    // At capo 0 the closed Bm xx4432 and F#m xx4222 (novice) give way to Bm7 / F#m7 (marked).
    const a0 = arrangeChart(chart, { level: 'beginner', capo: 0 });
    expect(a0.events.find((e) => e.original === 'Bm')!.sounding).toBe('Bm7');
    expect(a0.events.find((e) => e.original === 'F#m')!.sounding).toBe('F#m7');
    expect(a0.events.find((e) => e.original === 'Bm')!.change).toMatchObject({ code: 'colour-seventh', rootChanged: false });
  });

  it('the verdict is consistent with the counts', () => {
    const s = levelSuitability(chart, 'beginner', { capo: 'auto' });
    expect(s.verdict).toBe(verdictFor(s.hardBeatShare, s.hardChords.length, s.missingShape.length));
    expect(s.rootChanged).toBe(0);
    if (s.hardChords.length === 0) expect(s.verdict).toBe('fit');
    // Novice plays the closed shapes as written.
    const n = arrangeChart(chart, { level: 'novice', capo: 0 });
    expect(n.events.find((e) => e.original === 'Bm')!.sounding).toBe('Bm');
    expect(n.events.every((e) => !e.hard)).toBe(true);
  });

  it('setting on: root changes happen only when stages 1-2 fail at every capo, and are marked', () => {
    for (const capo of [0, 2, 5]) {
      const a = arrangeChart(chart, { level: 'beginner', capo, allowRootChange: true });
      expect(a.events.some((e) => e.change?.rootChanged)).toBe(false); // Bm7 / F#m7 exist at every capo considered
    }
  });

  it('setting on, capo fixed at 0: C#m (no beginner shape, no same-root option) becomes E, marked with a reason', () => {
    const items = bars(['A', 'C#m', 'D', 'E']);
    const on = arrangeEvents(seq(items), timing, { level: 'beginner', capo: 0, profile: CAPO0, allowRootChange: true });
    const cs = on.events[1];
    expect(cs.sounding).toBe('E');
    expect(cs.stage).toBe(3);
    expect(cs.hard).toBe(false);
    expect(cs.change).toMatchObject({ original: 'C#m', sounding: 'E', code: 'relative', rootChanged: true });
    expect(cs.change!.text).toMatch(/근음/);
    // Every root change: stages 1-2 failed at every capo considered (setting off: hard there).
    for (const [i, e] of on.events.entries()) {
      if (!e.change?.rootChanged) continue;
      const off = arrangeEvents(seq(items), timing, { level: 'beginner', capo: 0, profile: CAPO0 });
      expect(off.events[i].stage).toBe(4);
    }
    const off = arrangeEvents(seq(items), timing, { level: 'beginner', capo: 0, profile: CAPO0 });
    expect(off.events[1].sounding).toBe('C#m');
    expect(off.events[1].hard).toBe(true);
  });

  it('a capo that would make C#m playable forbids the root change, even at a manual capo 0', () => {
    // Capo 4 turns C#m into an Am shape, so capo choice must not trigger a root change at capo 0.
    const a = arrangeEvents(seq(bars(['A', 'C#m', 'D', 'E'])), timing, { level: 'beginner', capo: 0, allowRootChange: true });
    expect(a.events[1].change?.rootChanged ?? false).toBe(false);
    expect(a.events[1].hard).toBe(true);
  });
});

/** A made-up Eb-major ballad (same fixture idea as tests/beginner.test.ts) with a borrowed iv (Abm). */
function balladChart(): Chart {
  const loop = ['Ebmaj7', 'Cm7', 'Fm7', 'Bb7', 'Abmaj7', 'Gm7', 'Cm7', 'C7', 'Fm7', 'Abm', 'Eb', 'Bb7'];
  return chartOf(bars([...loop, ...loop]), 'SYNTHETIC-EB-BALLAD');
}

describe('synthetic Eb ballad with a borrowed Abm', () => {
  it('never makes a parallel major/minor change: Abm stays an Ab minor chord or is hard', () => {
    const chart = balladChart();
    for (const level of LEVELS) {
      for (const allowRootChange of [false, true]) {
        const a = suggestCapo(chart, level, DEFAULT_PROFILE, { allowRootChange })[0].arrangement;
        for (const e of a.events) {
          const o = parseChord(e.original);
          const s = parseChord(e.sounding!);
          // No parallel change anywhere: same root never flips major <-> minor.
          if (o.root === s.root) expect(!(o.triad === 'min' && s.triad === 'maj') && !(o.triad === 'maj' && s.triad === 'min')).toBe(true);
          if (e.original === 'Abm') {
            expect(s.root).toBe(o.root);
            expect(s.triad).toBe('min');
            expect(e.sounding === 'Abm' || e.hard || e.change?.code === 'colour-seventh').toBe(true);
          }
        }
      }
    }
  });
});

describe('change markers survive the strip and repeat bars', () => {
  const big = bigBeatInfo(timing);
  for (const order of [['Fmaj7', 'F', 'C'], ['F', 'Fmaj7', 'C']]) {
    it(`${order.join(' ')}: each event keeps its own marker and the strip shows both`, () => {
      const a = arrangeEvents(seq(bars(order)), timing, { level: 'beginner', capo: 0 });
      const fEvent = order.indexOf('F');
      const fm7Event = order.indexOf('Fmaj7');
      expect(fretString(a.events[fEvent].voicing!.frets)).toBe('xx3210');
      expect(fretString(a.events[fm7Event].voicing!.frets)).toBe('xx3210');
      expect(a.events[fEvent].change).toMatchObject({ original: 'F', sounding: 'Fmaj7' });
      expect(a.events[fm7Event].change).toBeNull();
      const { items, keys } = stripItems(a);
      const fm7Items = items.filter((it) => it.shape === 'Fmaj7');
      expect(fm7Items).toHaveLength(2);
      expect(fm7Items.map((it) => it.event.change?.original ?? null).sort()).toEqual(['F', null].sort());
      expect(keys[fEvent]).not.toBe(keys[fm7Event]);
      const up = upcomingShapes({ arrangement: a, stripKeys: keys }, { event: 0, next: 1 });
      expect(up.slice(0, 2)).toEqual([0, 1]);
      const lane = buildLane(a, timing, big, a.events[2].endSec, (i) => keys[i], (i) => !!a.events[i].change);
      expect(lane.filter((b) => b.repeat)).toHaveLength(0);
    });
  }

  it('a changed event in the next bar is never drawn as a repeat of a different event', () => {
    const a = arrangeEvents(seq(bars(['F', 'F', 'C'])), timing, { level: 'beginner', capo: 0 });
    const keys = a.events.map(() => 'same');
    const lane = buildLane(a, timing, big, a.events[2].endSec, (i) => keys[i], (i) => !!a.events[i].change);
    expect(lane[1].repeat).toBe(false);
    // One event over two bars still repeats (its marker is on the first bar).
    const long = arrangeEvents(seq([['F', 8], ['C', 4]]), timing, { level: 'beginner', capo: 0 });
    const lane2 = buildLane(long, timing, big, long.events[1].endSec, () => 'k', (i) => !!long.events[i].change);
    expect(lane2[1].repeat).toBe(true);
  });
});

describe('hard sounding-beat share', () => {
  const beg = (items: [string, number][] | ArrangeInputEvent[]): Arrangement =>
    arrangeEvents(Array.isArray(items[0]) ? seq(items as [string, number][]) : (items as ArrangeInputEvent[]), timing, { level: 'beginner', capo: 0, profile: CAPO0 });

  it('a sustained hard chord weighs more than a short one with the same chord count', () => {
    // Bb (xx3331 novice, no beginner same-root option at capo 0) is the hard chord.
    const sustained = summarizeArrangement(beg([['C', 4], ['Bb', 4], ['G', 4], ['C', 4]]), timing, false);
    const short = summarizeArrangement(beg([['C', 6], ['Bb', 2], ['G', 4], ['C', 4]]), timing, false);
    expect(sustained.hardChords.map((h) => h.name)).toEqual(['Bb']);
    expect(short.hardChords.map((h) => h.name)).toEqual(['Bb']);
    expect(sustained.hardBeatShare).toBeCloseTo(4 / 16);
    expect(short.hardBeatShare).toBeCloseTo(2 / 16);
    expect(sustained.verdict).toBe('no-fit');
    expect(short.verdict).toBe('practice');
  });

  it('rests and coverage gaps are left out of the denominator', () => {
    const withRest = summarizeArrangement(beg([['C', 4], ['N', 8], ['Bb', 2], ['G', 6]]), timing, false);
    expect(withRest.hardBeatShare).toBeCloseTo(2 / 12);
    const gap: ArrangeInputEvent[] = [
      { startSec: 0, endSec: 4 * BEAT, chord: 'C', confidence: 1 },
      { startSec: 12 * BEAT, endSec: 14 * BEAT, chord: 'Bb', confidence: 1 }, // 8 unheard beats before it
      { startSec: 14 * BEAT, endSec: 20 * BEAT, chord: 'G', confidence: 1 },
    ];
    expect(summarizeArrangement(beg(gap), timing, false).hardBeatShare).toBeCloseTo(2 / 12);
    // Fractional beats count as they are.
    const frac = summarizeArrangement(beg([['C', 4], ['Bb', 2.5], ['G', 5.5]]), timing, false);
    expect(frac.hardBeatShare).toBeCloseTo(2.5 / 12);
  });

  it('only rests: data-insufficient', () => {
    const s = summarizeArrangement(beg([['N', 8]]), timing, false);
    expect(s.hardBeatShare).toBeNull();
    expect(s.verdict).toBe('data-insufficient');
  });

  it('counts changes and root changes separately, merges by name', () => {
    const merged = arrangeEvents(seq([['C', 4], ['G/B', 1], ['Am', 3], ['F', 4]]), timing, { level: 'beginner', capo: 0, profile: CAPO0 });
    const s = summarizeArrangement(merged, timing, false);
    expect(merged.events[0].mergedFrom).toEqual(['G/B']);
    expect(merged.events[0].change?.codes).toContain('merge');
    expect(s.changed).toBe(2); // the merged G/B and F -> Fmaj7
    expect(s.rootChanged).toBe(0);
  });
});

describe('capo choice', () => {
  // Ab - Eb - Fm - Db: hard at capo 0 for a beginner, easy at capo 1 (G - D - Em - C shapes).
  const chart = chartOf(bars(['Ab', 'Eb', 'Fm', 'Db', 'Ab', 'Eb', 'Fm', 'Db']), 'SYNTHETIC-AB');

  it('automatic capo ranks the least hard share first and reuses that arrangement', () => {
    const s = suggestCapo(chart, 'beginner');
    for (let i = 1; i < s.length; i++) expect(s[i].hardShare).toBeGreaterThanOrEqual(s[i - 1].hardShare - 1e-9);
    expect(s[0].hardShare).toBe(0);
    const auto = levelSuitability(chart, 'beginner', { capo: 'auto' });
    expect(auto.capoAuto).toBe(true);
    expect(auto.capo).toBe(s[0].capo);
    expect(auto.verdict).toBe('fit');
    const model = buildPlayModel(chart, { level: 'beginner', capo: 'auto' }, null);
    expect(model.arrangement).toBe(model.capoSuggestions[0].arrangement);
    expect(model.suitability.verdict).toBe('fit');
  });

  it('a manual capo is used as set, even when it is worse', () => {
    const manual = levelSuitability(chart, 'beginner', { capo: 0 });
    expect(manual.capo).toBe(0);
    expect(manual.capoAuto).toBe(false);
    expect(manual.hardChords.length).toBeGreaterThan(0);
    const model = buildPlayModel(chart, { level: 'beginner', capo: 0 }, null);
    expect(model.arrangement.capo).toBe(0);
    expect(model.suitability.hardChords.length).toBe(manual.hardChords.length);
  });
});

describe('level-fit worker protocol', () => {
  class FakeWorker implements LevelWorkerLike {
    sent: LevelFitWorkerRequest[] = [];
    private listeners: { message: ((e: MessageEvent<LevelFitWorkerResponse>) => void)[]; error: ((e: ErrorEvent) => void)[] } = { message: [], error: [] };
    postMessage(m: LevelFitWorkerRequest): void {
      this.sent.push(m);
    }
    addEventListener(type: 'message' | 'error', l: never): void {
      (this.listeners[type] as unknown[]).push(l);
    }
    terminate(): void {}
    reply(r: LevelFitWorkerResponse): void {
      for (const l of this.listeners.message) l({ data: r } as MessageEvent<LevelFitWorkerResponse>);
    }
    fail(): void {
      for (const l of this.listeners.error) l({ message: 'boom' } as ErrorEvent);
    }
  }
  const songA = chartOf(bars(['C', 'G', 'Am', 'F']), 'SYNTHETIC-A');
  const songB = chartOf(bars(['D', 'A', 'Bm', 'G']), 'SYNTHETIC-B');
  const input = (chart: Chart, o: Partial<LevelFitInput> = {}): LevelFitInput => ({ chart, capo: 'auto', profile: DEFAULT_PROFILE, allowRootChange: false, ...o });
  const fakeResult = (chart: Chart, level: Level) => levelSuitability(chart, level, { capo: 'auto' });

  it('discards a reply for an older song and applies the current one', () => {
    const w = new FakeWorker();
    const updates: string[] = [];
    const c = new LevelFitController({ createWorker: () => w, onUpdate: (st) => updates.push([...st].map(([l, s]) => `${l}:${s.status}`).join(',')), schedule: (fn) => fn() });
    c.update(input(songA), ['novice']);
    c.update(input(songB), ['novice']);
    expect(w.sent).toHaveLength(2);
    const before = updates.length;
    w.reply({ id: w.sent[0].id, ok: true, results: [fakeResult(songA, 'novice')], ms: 1 });
    expect(updates.length).toBe(before); // stale: ignored
    w.reply({ id: w.sent[1].id, ok: true, results: [fakeResult(songB, 'novice')], ms: 1 });
    expect(updates.at(-1)).toBe('novice:done');
    // Song A's stale result was not cached: asking for A again sends a new request.
    c.update(input(songA), ['novice']);
    expect(w.sent).toHaveLength(3);
    // Song B is cached now.
    c.update(input(songB), ['novice']);
    expect(w.sent).toHaveLength(3);
    expect(updates.at(-1)).toBe('novice:done');
  });

  it('the same song and settings again keep the request in flight', () => {
    const w = new FakeWorker();
    let last = '';
    const c = new LevelFitController({ createWorker: () => w, onUpdate: (st) => (last = [...st].map(([l, s]) => `${l}:${s.status}`).join(',')), schedule: (fn) => fn() });
    c.update(input(songA), ['novice']);
    c.update(input(songA), ['novice']);
    expect(w.sent).toHaveLength(1);
    w.reply({ id: w.sent[0].id, ok: true, results: [fakeResult(songA, 'novice')], ms: 1 });
    expect(last).toBe('novice:done');
  });

  it('a settings change also makes the pending reply stale, and keys cover every setting', () => {
    const w = new FakeWorker();
    const c = new LevelFitController({ createWorker: () => w, onUpdate: () => {}, schedule: (fn) => fn() });
    c.update(input(songA), ['novice']);
    c.update(input(songA, { allowRootChange: true }), ['novice']);
    w.reply({ id: w.sent[0].id, ok: true, results: [fakeResult(songA, 'novice')], ms: 1 });
    c.update(input(songA), ['novice']);
    expect(w.sent).toHaveLength(3); // the stale reply did not fill the cache
    const k = levelFitKey(input(songA), 'novice');
    expect(levelFitKey(input(songA, { allowRootChange: true }), 'novice')).not.toBe(k);
    expect(levelFitKey(input(songA, { capo: 2 }), 'novice')).not.toBe(k);
    expect(levelFitKey(input(songA, { profile: P({ canBarre: true }) }), 'novice')).not.toBe(k);
    expect(levelFitKey(input(songA), 'advanced')).not.toBe(k);
    expect(levelFitKey(input({ ...songA, timing: { ...timing, bpm: 91 } }), 'novice')).not.toBe(k);
    expect(levelFitKey(input({ ...songA, events: songA.events.map((e, i) => (i === 1 ? { ...e, chord: 'Em' } : e)) }), 'novice')).not.toBe(k);
  });

  it('without a worker: computes one level per task, and a newer song cancels the rest', () => {
    const tasks: (() => void)[] = [];
    const done: Level[] = [];
    const c = new LevelFitController({
      createWorker: () => {
        throw new Error('no worker on file://');
      },
      onUpdate: (st) => {
        done.splice(0, done.length, ...[...st].filter(([, s]) => s.status === 'done').map(([l]) => l));
      },
      schedule: (fn) => tasks.push(fn),
    });
    c.update(input(songA), ['novice', 'intermediate', 'advanced']);
    expect(c.usingFallback).toBe(true);
    expect(done).toEqual([]); // nothing before the first task runs
    tasks.shift()!();
    expect(done).toEqual(['novice']);
    c.update(input(songB), ['novice', 'intermediate']);
    tasks.shift()!(); // the old song's next task: superseded, does nothing
    expect(done).toEqual([]);
    while (tasks.length) tasks.shift()!();
    expect(done.sort()).toEqual(['intermediate', 'novice']);
  });

  it('a worker that fails falls back to the main thread', () => {
    const w = new FakeWorker();
    const tasks: (() => void)[] = [];
    let last = '';
    const c = new LevelFitController({ createWorker: () => w, onUpdate: (st) => (last = [...st].map(([l, s]) => `${l}:${s.status}`).join(',')), schedule: (fn) => tasks.push(fn) });
    c.update(input(songA), ['novice']);
    w.fail();
    while (tasks.length) tasks.shift()!();
    expect(last).toBe('novice:done');
  });
});
