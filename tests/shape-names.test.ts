import { capoReason, unplayableLine } from '../src/extension/sidepanel/play';
import { describe, expect, it } from 'vitest';
import { buildPlayModel, barsForHardChord, changeConcertLabel } from '../src/play/model';
import { computeLevelFits } from '../src/play/level-fit';
import { suitabilityLine } from '../src/arrange/suitability';
import { DEFAULT_PROFILE } from '../src/arrange/levels';
import { chordKey, parseChord } from '../src/arrange/chord';
import { buildChart, chartToSequenceText, parseChordSequence } from '../src/editor/core';
import { prettyChord, shapeName } from '../src/music/key';
import type { Chart } from '../src/chart/types';

function synthetic(): Chart {
  const chords = ['Eb', 'Bb', 'Eb', 'Ab', 'Eb', 'Abm', 'Cm', 'B', 'Eb', 'Db', 'Eb'];
  const starts = [0, 4, 8, 12, 16, 20, 24, 28, 32, 35.8, 36];
  return { schemaVersion: 1, recording: { source: 'youtube', id: 'SYNTHETIC-SHAPES', title: 'Synthetic shapes', artist: 'Test' },
    timing: { bpm: 120, beatsPerBar: 4, beatUnit: 4, firstDownbeatSec: 0 },
    events: chords.map((chord, i) => ({ chord, startSec: starts[i], confidence: 1, source: 'manual' })),
    coverage: [{ fromSec: 0, toSec: 40 }], provenance: { createdBy: 'manual', createdAt: '2026-11-11T00:00:00Z' } } as Chart;
}
const model = (capo: number) => buildPlayModel(synthetic(), { level: 'beginner', capo }, null);

describe('one shape name on every play surface', () => {
  it('uses shape names and optional secondary concert names in the unplayable line', () => {
    const a = { capo: 1, unplayable: ['Abm', 'B'] };
    expect(unplayableLine(a, false)).toBe('운지를 찾지 못함: Gm, B♭');
    expect(unplayableLine(a, true)).toBe('운지를 찾지 못함: Gm <small class="snd">실제 A♭m</small>, B♭ <small class="snd">실제 B</small>');
    expect(unplayableLine({ ...a, capo: 0 }, true)).toBe('운지를 찾지 못함: A♭m, B');
  });
  it('uses the spoken final digit for the capo particle', () => {
    expect(capoReason(1)).toBe('카포 1이라');
    expect(capoReason(2)).toBe('카포 2라');
    expect(capoReason(10)).toBe('카포 10이라');
    expect(capoReason(12)).toBe('카포 12라');
  });
  it('uses capo shapes for labels, badges, descriptions, hard list and merged chords', () => {
    const m = model(1);
    expect(m.key?.tonicName).toBe('Eb');
    const names = m.labels.flatMap((l) => [l.name, l.hint ?? '', l.change?.from ?? '', l.change?.to ?? '', l.change?.text ?? '']);
    names.push(...m.suitability.hardChords.map((h) => prettyChord(h.name)), suitabilityLine(m.suitability, '입문'));
    const text = names.join(' ');
    expect(text).not.toMatch(/A♭m|Cm|(?<![A-Za-z♭♯])B(?![a-zA-Z♭♯])/u);
    for (const n of ['Gm', 'B♭', 'Bm']) expect(text).toContain(n);
    expect(m.arrangement.events.some((e) => e.mergedFrom.length)).toBe(true);
    const merged = m.arrangement.events.find((e) => e.mergedFrom.length)!;
    for (const n of merged.mergedFrom) expect(merged.change!.text).toContain(shapeName(n, 1));
    expect(m.labels[m.arrangement.events.indexOf(merged)].change!.badge).toBe('C 합침');
    expect(merged.change!.text).toBe('짧게 지나가는 코드(C)를 앞 코드에 합쳤어요');
    for (const l of m.labels) expect((l.change?.text.match(/원래/g) ?? []).length).toBeLessThan(2);
    expect(suitabilityLine(m.suitability, '입문', prettyChord, true)).toContain('실제 A♭m');
    const badge = m.labels.find((l) => l.change?.from === 'Bm')!.change!;
    expect(badge.to).toBe('Bm7');
    expect(badge.badge).toBe('Bm→Bm7');
    expect(badge.text).toBe('Bm 모양은 입문에서 어려워서, 7음을 더한 Bm7 모양으로 쳐요');
    expect(badge.concert).toMatchObject({ from: 'Cm', to: 'Cm7' });
    expect(changeConcertLabel(badge, false)).toBe('');
    expect(changeConcertLabel(badge, true)).toBe('실제 Cm → Cm7');
    expect(changeConcertLabel(m.labels[m.arrangement.events.indexOf(merged)].change!, true)).toContain('D♭');
  });
  it('names several merges and keeps the arrow when a merge accompanies another change', () => {
    const chart = synthetic();
    chart.events[9].startSec = 35.6;
    chart.events.splice(10, 0, { chord: 'Ab', startSec: 35.8, source: 'manual', confidence: 1 });
    const merged = buildPlayModel(chart, { level: 'beginner', capo: 1 }, null).labels.find((l) => l.change?.badge.endsWith('합침'))!.change!;
    expect(merged.badge).toBe('C·G 합침');
    chart.events[8].chord = 'Cm';
    const m = buildPlayModel(chart, { level: 'beginner', capo: 1 }, null);
    const combined = m.labels.find((l) => l.change?.text.includes('짧게') && l.change.from === 'Bm')!.change!;
    expect(combined.badge).toBe('Bm→Bm7');
    expect(combined.text).toContain('7음을 더한 Bm7');
    expect(combined.text).toContain('코드(C, G)를 앞 코드에 합쳤어요');
    for (const l of m.labels) expect((l.change?.text.match(/원래/g) ?? []).length).toBeLessThan(2);
  });
  it('keeps reductions short and names the level and original shape once for root changes', () => {
    const chart = synthetic();
    chart.events = ['A', 'C#m', 'D', 'E', 'Gm7'].map((chord, i) => ({ chord, startSec: i * 4, source: 'manual', confidence: 1 }));
    chart.coverage[0].toSec = 20;
    const m = buildPlayModel(chart, { level: 'beginner', capo: 0, profile: { ...DEFAULT_PROFILE, capoMin: 0, capoMax: 0 }, allowRootChange: true }, null);
    const relative = m.labels.find((l) => l.change?.root)!.change!;
    expect(relative.text).toContain('C♯m 모양은 입문에서 어려워서, 같은 음 두 개를 나누는 E 모양으로 쳐요');
    expect(relative.text).toContain('멜로디와 어긋날 수 있어요');
    expect(m.labels.find((l) => l.change?.from === 'Gm7')!.change!.text).toBe('입문이라 7음을 빼고 Gm 모양으로 쳐요');
    for (const l of m.labels) expect((l.change?.text.match(/원래/g) ?? []).length).toBeLessThan(2);
  });
  it('keeps shape and concert identical at capo zero', () => {
    for (const l of model(0).labels) {
      expect(l.name).toBe(l.sounding);
      expect(l.change?.concert).toBeUndefined();
    }
  });
  it('names each level using that level’s own auto capo', () => {
    const fits = computeLevelFits({ chart: synthetic(), capo: 'auto', profile: DEFAULT_PROFILE, allowRootChange: false }, ['beginner', 'novice', 'intermediate', 'advanced']);
    expect(new Set(fits.map((f) => f.capo)).size).toBeGreaterThan(1);
    for (const f of fits) {
      expect(suitabilityLine(f, f.level)).toContain(f.capo ? `카포 ${f.capo}` : '카포 없음');
    }
    const manual = computeLevelFits({ chart: synthetic(), capo: 1, profile: DEFAULT_PROFILE, allowRootChange: false }, ['beginner', 'novice', 'intermediate', 'advanced']);
    expect(manual.flatMap((f) => f.hardChords).length).toBeGreaterThan(0);
    for (const f of [...fits, ...manual]) for (const h of f.hardChords) {
      expect(prettyChord(h.name)).toBe(shapeName(h.sounding, f.capo));
      expect(suitabilityLine(f, f.level)).toContain(prettyChord(h.name));
    }
  });
  it('finds exactly all occupied bars, including a sustained hard chord', () => {
    const m = model(1);
    for (const h of m.suitability.hardChords) {
      const events = m.arrangement.events.filter((e) => e.shape === h.shape);
      const expected = m.bars.flatMap((b, i) => events.some((e) => e.startSec < b.endSec && e.endSec > b.startSec) ? [i] : []);
      expect(barsForHardChord(m, h.shape)).toEqual(expected);
      expect(expected.length).toBeGreaterThan(0);
    }
    expect(barsForHardChord(m, 'UNUSED')).toEqual([]);
  });
});

describe('editor display only spelling', () => {
  it('round trips sharps, ASCII and Unicode flats and slash chords without changing storage', () => {
    const c = synthetic();
    c.events.push(...['G#m', 'Abm', 'A♭m', 'G#/D#', 'Ab/Eb', 'A♭/E♭'].map((chord, i) => ({ chord, startSec: 40 + i, source: 'manual' as const, confidence: 1 })));
    c.coverage[0].toSec = 46;
    const before = JSON.stringify(c);
    const display = chartToSequenceText(c);
    expect(display).toContain('A♭m');
    expect(display).not.toContain('G♯m');
    const parsed = parseChordSequence(display);
    expect(parsed.errors).toEqual([]);
    expect(parsed.chords.map((n) => chordKey(parseChord(n)))).toEqual(c.events.map((e) => chordKey(parseChord(e.chord))));
    const saved = buildChart({ recording: c.recording, timing: c.timing, chords: parsed.chords, stamps: c.events.map((e) => e.startSec), durationSec: 46 });
    expect(saved.events.map((e) => chordKey(parseChord(e.chord)))).toEqual(c.events.map((e) => chordKey(parseChord(e.chord))));
    expect(JSON.stringify(c)).toBe(before);
  });
});
