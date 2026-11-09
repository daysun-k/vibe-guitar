import { describe, expect, it } from 'vitest';
import { arrangeChart, arrangeEvents, chartToInputEvents, chordPitchClasses, formatChord, parseChord } from '../src/arrange';
import type { Chart, Recording, Timing } from '../src/chart/types';
import { validateChart } from '../src/chart/validate';
import { DraftBook, checkSaveTarget, emptyDraft, reattachDraft } from '../src/editor/drafts';
import { computePlayView } from '../src/extension/playview';

const songA: Recording = { source: 'youtube', id: 'AAAAAAAAAAA', title: 'Song A', artist: 'x' };
const songB: Recording = { source: 'youtube', id: 'BBBBBBBBBBB', title: 'Song B', artist: 'y' };

describe('finding 1: editor drafts are bound to their recording', () => {
  it('draft from song A is not saved under song B after navigation', () => {
    const draftA = { ...emptyDraft(songA), chords: ['C', 'G'], stamps: [1, 3], seqText: 'C G' };
    // The player navigated to B but the draft still belongs to A.
    const check = checkSaveTarget(draftA, songB);
    expect(check).toEqual({ ok: false, reason: 'recording-mismatch' });
    expect(checkSaveTarget(draftA, songA)).toMatchObject({ ok: true, recording: songA });
    expect(checkSaveTarget(emptyDraft(null), songA)).toEqual({ ok: false, reason: 'no-recording' });
  });

  it('navigation stores A, starts an empty draft for B, and restores A on return', () => {
    const book = new DraftBook();
    const draftA = { ...emptyDraft(songA), chords: ['C', 'G'], stamps: [1, 3], seqText: 'C G' };
    const onB = book.switchTo(draftA, songB);
    expect(onB.recordingKey).toBe('youtube:BBBBBBBBBBB');
    expect(onB.chords).toEqual([]);
    expect(onB.stamps).toEqual([]);
    const backOnA = book.switchTo(onB, songA);
    expect(backOnA).toEqual(draftA);
  });

  it('only an explicit reattach moves a draft to another recording', () => {
    const draftA = { ...emptyDraft(songA), chords: ['C'], stamps: [1] };
    const moved = reattachDraft(draftA, songB);
    expect(moved.recordingKey).toBe('youtube:BBBBBBBBBBB');
    expect(moved.stamps).toEqual([1]);
    expect(checkSaveTarget(moved, songB).ok).toBe(true);
  });
});

describe('finding 2: simplification never merges across rests', () => {
  const t120: Timing = { bpm: 120, beatsPerBar: 4, firstDownbeatSec: 0 };

  it('beginner: C[0-2], N[2-2.5], G[2.5-5] keeps the rest and C ends at 2 s', () => {
    const a = arrangeEvents(
      [
        { startSec: 0, endSec: 2, chord: 'C', confidence: 1 },
        { startSec: 2, endSec: 2.5, chord: 'N', confidence: 1 },
        { startSec: 2.5, endSec: 5, chord: 'G', confidence: 1 },
      ],
      t120,
      { level: 'beginner', capo: 0 },
    );
    expect(a.events.map((e) => [e.original, e.startSec, e.endSec])).toEqual([
      ['C', 0, 2],
      ['N', 2, 2.5],
      ['G', 2.5, 5],
    ]);
    expect(a.events[0].mergedFrom).toEqual([]);
  });

  it('beginner: N[0-2], C[2-2.5] does not absorb the short C into the rest', () => {
    const a = arrangeEvents(
      [
        { startSec: 0, endSec: 2, chord: 'N', confidence: 1 },
        { startSec: 2, endSec: 2.5, chord: 'C', confidence: 1 },
      ],
      t120,
      { level: 'beginner', capo: 0 },
    );
    expect(a.events.map((e) => [e.original, e.startSec, e.endSec])).toEqual([
      ['N', 0, 2],
      ['C', 2, 2.5],
    ]);
    expect(a.events[1].rest).toBe(false);
    expect(a.events[1].voicing).not.toBeNull();
  });
});

describe('finding 3: chords are bounded by coverage', () => {
  const chart: Chart = {
    schemaVersion: 1,
    recording: songA,
    timing: { bpm: 120, beatsPerBar: 4, firstDownbeatSec: 0 },
    events: [
      { startSec: 0, chord: 'C', confidence: 1, source: 'manual' },
      { startSec: 20, chord: 'G', confidence: 1, source: 'manual' },
    ],
    coverage: [
      { fromSec: 0, toSec: 5 },
      { fromSec: 20, toSec: 25 },
    ],
    provenance: { createdBy: 'manual', createdAt: '2026-11-09T00:00:00Z' },
  };
  const a = arrangeChart(chart, { level: 'novice', capo: 0 });
  const view = (t: number, bars = 1) => computePlayView(a, chart.timing, t, bars);

  it('ends each event at its coverage interval', () => {
    expect(chartToInputEvents(chart).map((e) => [e.chord, e.startSec, e.endSec])).toEqual([
      ['C', 0, 5],
      ['G', 20, 25],
    ]);
  });

  it('shows no chord inside a coverage gap (10 s) or after the end (100 s)', () => {
    expect(view(10).current).toBeNull();
    expect(view(100).current).toBeNull();
    expect(view(100).next).toBeNull();
  });

  it('treats coverage ends as exclusive and starts as inclusive', () => {
    expect(view(4.999).current?.sounding).toBe('C');
    expect(view(5).current).toBeNull();
    expect(view(20).current?.sounding).toBe('G');
    expect(view(24.999).current?.sounding).toBe('G');
    expect(view(25).current).toBeNull();
  });

  it('look-ahead does not jump a gap: no next chord while the last covered chord plays', () => {
    const v = view(4.5, 4);
    expect(v.current?.sounding).toBe('C');
    expect(v.next).toBeNull();
    expect(v.countdown).toBeNull();
    expect(v.endOfCoverage).toBe(5);
  });

  it('inside the gap the next covered chord is announced only within the look-ahead window', () => {
    expect(view(10, 1).inLookAhead).toBe(false);
    const near = view(19, 1); // 2 beats before G at 120 bpm
    expect(near.next?.sounding).toBe('G');
    expect(near.countdown).toBe(2);
    expect(near.countIn).toBe(3);
  });

  it('seeking past coverage and back works', () => {
    expect(view(100).current).toBeNull();
    expect(view(1).current?.sounding).toBe('C');
  });

  it('drops events outside every coverage range and warns in the validator', () => {
    const c = structuredClone(chart);
    c.events.splice(1, 0, { startSec: 10, chord: 'Am', confidence: 1, source: 'manual' });
    expect(chartToInputEvents(c).map((e) => e.chord)).toEqual(['C', 'G']);
    const v = validateChart(c);
    expect(v.ok).toBe(true);
    expect(v.warnings.join()).toMatch(/events\[1\] starts outside every coverage range/);
  });
});

describe('finding 5: augmented sevenths and extended chords round-trip', () => {
  it.each([
    ['Caug7', [0, 4, 8, 10]],
    ['C+7', [0, 4, 8, 10]],
    ['C7#5', [0, 4, 8, 10]],
    ['Caug9', [0, 2, 4, 8, 10]],
    ['Caugmaj7', [0, 4, 8, 11]],
    ['C+', [0, 4, 8]],
    ['C+5', [0, 4, 8]],
  ])('%s parses to the augmented pitch classes', (sym, pcs) => {
    expect(chordPitchClasses(parseChord(sym))).toEqual(pcs);
    expect(parseChord(sym).triad).toBe('aug');
  });

  it.each(['Caug7', 'C7#5', 'Caug9', 'Caugmaj7', 'C9', 'C11', 'C13', 'Cmaj9', 'Cm11', 'Cm13', 'C13b9', 'C9#11', 'C7b9', 'Cm9b5', 'Cmaj13', 'C9sus4'])(
    '%s round-trips through formatChord',
    (sym) => {
      const once = formatChord(parseChord(sym));
      expect(formatChord(parseChord(once))).toBe(once);
      expect(chordPitchClasses(parseChord(once))).toEqual(chordPitchClasses(parseChord(sym)));
    },
  );
});
