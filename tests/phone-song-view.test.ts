// VGT-13 휴대폰 악보대: the song view must show exactly what the play view shows, carry no lyrics
// and fit the relay's 8 KiB frames even for a long song.
import { describe, expect, it } from 'vitest';
import type { Chart } from '../src/chart/types';
import { demoChart, demoLyrics } from '../src/play/demo';
import { buildPlayModel, frameAt, upcomingShapes, type PlayModel } from '../src/play/model';
import { bigBeatsUntil } from '../src/music/meter';
import { MAX_MESSAGE_BYTES, MAX_SONG_PARTS, SongAssembler, songParts, utf8Length, validatePublisherMessage } from '../src/phone/protocol';
import { NO_SHAPE, REST, buildSongView, phoneFrame, readSongView, shapeVoicing, validateSongView, type SongView } from '../src/phone/song-view';

const opts = { title: '데모 곡 (합성 데이터)', artist: 'Vibe Guitar', showSounding: false };

/** About 6 minutes of 4/4 at 140 bpm with a tracked beat grid and a chord every two beats. */
function longChart(): Chart {
  const beat = 60 / 140;
  const beatTimes = Array.from({ length: 841 }, (_, i) => Math.round((0.5 + i * beat + (i % 3) * 0.004) * 1000) / 1000);
  const names = ['C', 'G', 'Am', 'F', 'Dm7', 'E7', 'Bb', 'C/B', 'Fmaj7', 'G7sus4', 'Ebmaj7', 'Ab'];
  const events: Chart['events'] = [{ startSec: 0, chord: 'N', confidence: 1, source: 'auto' }];
  for (let i = 0; i < 420; i++) events.push({ startSec: beatTimes[i * 2]!, chord: names[(i * 5) % names.length]!, confidence: 0.9, source: 'auto' });
  return {
    schemaVersion: 1,
    recording: { source: 'youtube', id: 'long-song-test', title: '아주 긴 시험 곡 '.repeat(4), artist: '시험' },
    timing: { bpm: 140, beatsPerBar: 4, beatUnit: 4, firstDownbeatSec: 0.5, beatTimes },
    events,
    coverage: [{ fromSec: 0, toSec: beatTimes[840]! }],
    provenance: { createdBy: 'recognizer', createdAt: '2026-11-12T00:00:00.000Z', tool: 'test' },
  };
}

function viewOf(m: PlayModel, showSounding = false): SongView {
  const v = buildSongView(m, { ...opts, showSounding });
  expect(v).not.toBeNull();
  return v!;
}

describe('song view builder', () => {
  it('uses the play view names and diagram voicings for every arranged event', () => {
    for (const capo of [0, 2] as const) {
      const m = buildPlayModel(demoChart(), { level: 'beginner', capo }, null);
      const v = viewOf(m);
      expect(v.capo).toBe(m.arrangement.capo);
      expect(v.events.length / 3).toBe(m.arrangement.events.length);
      m.arrangement.events.forEach((e, i) => {
        const s = v.events[i * 3 + 2]!;
        if (e.rest) return expect(s).toBe(REST);
        if (!m.stripKeys[i]) return expect(s).toBe(NO_SHAPE);
        const shape = v.shapes[s]!;
        expect(shape.name).toBe(m.labels[i]!.name);
        expect(shape.sounding).toBe(m.labels[i]!.sounding);
        expect(shape.frets).toEqual(e.voicing?.frets ?? null);
        expect(shape.fingers).toEqual(e.voicing?.fingers ?? null);
        expect(shapeVoicing(shape)?.frets ?? null).toEqual(e.voicing?.frets ?? null);
      });
    }
  });

  it('capo 2: shape names with their sounding names, and the 실제 음 이름 보기 switch', () => {
    const m = buildPlayModel(demoChart(), { level: 'beginner', capo: 2 }, null);
    const off = viewOf(m, false);
    const on = viewOf(m, true);
    expect(off.capo).toBe(2);
    expect(off.showSounding).toBe(false);
    expect(on.showSounding).toBe(true);
    // A♭ sounds with capo 2 from a G♭ shape: names are shapes, sounding names are the real chords.
    expect(off.shapes.some((s) => s.name !== s.sounding)).toBe(true);
    expect(off.shapes.map((s) => s.sounding)).toContain('A♭');
    expect(off.shapes.map((s) => s.name)).not.toContain('A♭');
    const m0 = buildPlayModel(demoChart(), { level: 'beginner', capo: 0 }, null);
    expect(viewOf(m0).shapes.every((s) => s.name === s.sounding)).toBe(true);
  });

  it('never carries lyrics, even when the play model has them', () => {
    const lyrics = demoLyrics(0.4);
    const m = buildPlayModel(demoChart(), { level: 'novice', capo: 0 }, lyrics);
    expect(m.lyrics).not.toBeNull();
    const json = JSON.stringify(viewOf(m));
    for (const line of lyrics.lines) for (const w of line.words) expect(json).not.toContain(w.text);
    // `uncertain`: event indices of the demo's flagged chords (a yes/no per chord, no second choice)
    expect(Object.keys(viewOf(m)).sort()).toEqual(['artist', 'bars', 'capo', 'durationSec', 'events', 'sections', 'shapes', 'showSounding', 'timing', 'title', 'uncertain', 'v']);
    // section names come from the lyric structure ("1절", "후렴"), not from lyric text
    expect(viewOf(m).sections.map((s) => s[0])).toContain('후렴');
  });

  it('phoneFrame matches frameAt + upcomingShapes of the play view', () => {
    for (const lyrics of [null, demoLyrics(0.4)]) {
      const m = buildPlayModel(demoChart(), { level: 'beginner', capo: 'auto' }, lyrics);
      const s = readSongView(viewOf(m));
      expect(s.big).toEqual(m.big);
      for (let t = -0.3; t < m.durationSec + 1; t += 0.137) {
        const f = frameAt(m, t);
        const up = upcomingShapes(m, f, 2);
        const p = phoneFrame(s, t);
        const now = f.event >= 0 && up[0] === f.event ? f.event : -1;
        expect(p.nowEvent).toBe(now);
        expect(p.nextEvent).toBe((now >= 0 ? up[1] : up[0]) ?? -1);
        expect(p.bar).toBe(f.bar);
        expect(p.section).toBe(f.section);
        // The phone's bar card draws the lane cell's playhead and filled ticks from these.
        expect(p.bigInBar).toBe(f.bigInBar);
        expect(p.barFraction).toBeCloseTo(f.barFraction, 3);
        expect(p.beatsLeft).toBe(p.nextEvent >= 0 ? bigBeatsUntil(m.timing, m.big, t, m.arrangement.events[p.nextEvent]!.startSec) : 0);
      }
    }
  });

  it('counts big beats: 6/8 demo counts dotted quarters, two per bar', () => {
    const m = buildPlayModel(demoChart(), { level: 'beginner', capo: 0 }, null);
    const s = readSongView(viewOf(m));
    const bar = s.bars[5]!;
    const f = phoneFrame(s, bar.startSec + 0.01);
    expect(s.big.bigPerBar).toBe(2);
    expect(f.beatsLeft).toBe(2);
    // Bar card: the first big beat of the bar, the playhead at its very start.
    expect(f.bar).toBe(5);
    expect(f.bigInBar).toBe(0);
    expect(f.barFraction).toBeLessThan(0.05);
    // Past the middle of the bar: the second big beat, the playhead past halfway.
    const later = phoneFrame(s, bar.startSec + (bar.endSec - bar.startSec) * 0.6);
    expect(later.bigInBar).toBe(1);
    expect(later.barFraction).toBeCloseTo(0.6, 2);
  });
});

describe('song view on the wire', () => {
  it('a long song splits into frames under 8 KiB and reassembles exactly', () => {
    const m = buildPlayModel(longChart(), { level: 'intermediate', capo: 'auto' }, null);
    const v = viewOf(m);
    expect(v.events.length / 3).toBeGreaterThan(400);
    expect(v.timing.beatTimes?.length).toBe(841);
    const parts = songParts(v, 'abcd1234', 7)!;
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.length).toBeLessThanOrEqual(MAX_SONG_PARTS);
    const a = new SongAssembler();
    let got: unknown = null;
    for (const p of parts) {
      const text = JSON.stringify(p);
      expect(utf8Length(text)).toBeLessThanOrEqual(MAX_MESSAGE_BYTES);
      const valid = validatePublisherMessage(text);
      expect(valid).not.toBeNull();
      got = a.add(valid as typeof p);
    }
    expect(got).toEqual(v);
  });

  it('splits multi-byte titles without breaking characters', () => {
    const v: SongView = { ...viewOf(buildPlayModel(demoChart(), { level: 'beginner', capo: 0 }, null)), title: '가'.repeat(120), artist: '😀'.repeat(60) };
    const parts = songParts(v, 'abcd1234', 1, 400)!;
    for (const p of parts) expect(utf8Length(JSON.stringify(p))).toBeLessThanOrEqual(400);
    expect(JSON.parse(parts.map((p) => p.d).join(''))).toEqual(v);
  });

  it('rejects malformed song views', () => {
    const v = viewOf(buildPlayModel(demoChart(), { level: 'beginner', capo: 0 }, null));
    const bad: unknown[] = [
      { ...v, lyrics: [] },
      { ...v, v: 2 },
      { ...v, capo: 13 },
      { ...v, title: 'a\u0000b' },
      { ...v, shapes: [{ ...v.shapes[0]!, name: '<img src=x>' }, ...v.shapes.slice(1)] },
      { ...v, shapes: [{ ...v.shapes[0]!, frets: [0, 1, 2] }, ...v.shapes.slice(1)] },
      { ...v, events: [...v.events, 999] },
      { ...v, events: [5, 6, 0, 1, 2, 0] },
      { ...v, events: [0, 1, v.shapes.length] },
      { ...v, bars: [2, 1] },
      { ...v, sections: [['a', 99999, 0]] },
      { ...v, timing: { ...v.timing, bpm: 0 } },
      { ...v, timing: { ...v.timing, beatTimes: [2, 1] } },
    ];
    for (const b of bad) expect(validateSongView(b)).toBeNull();
    expect(validateSongView(JSON.parse(JSON.stringify(v)))).toEqual(v);
  });

  it('assembler ignores stale revisions and reports a broken one', () => {
    const v = viewOf(buildPlayModel(demoChart(), { level: 'beginner', capo: 0 }, null));
    const a = new SongAssembler();
    const [p2] = songParts(v, 'abcd1234', 2)!;
    expect(a.add(p2!)).toEqual(v);
    expect(a.add(songParts(v, 'abcd1234', 1)![0]!)).toBe('stale');
    expect(a.add({ ...p2!, rev: 3, d: '{"v":1}' })).toBe('invalid');
    expect(a.current?.rev).toBe(2);
    // a new epoch (the panel was reopened) starts over at any revision
    expect(a.add(songParts(v, 'zzzz9999', 1)![0]!)).toEqual(v);
  });
});
