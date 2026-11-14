/**
 * Demo playback: a simulated clock and a synthetic song (chart + lyrics) so the play view
 * can be checked without a live player. The synthetic song is made up: a 6/8 progression in
 * A-flat spelled with sharps the way the recognizer names roots, a beat grid whose first
 * beat is not a downbeat, and placeholder lyrics ("라", "라라") sung 0.4 s early.
 */
import type { Chart, ChordEvent, UncertainSpan } from '../chart/types';
import type { Lyrics, LyricLine } from '../lyrics/types';

export class DemoClock {
  t: number;
  playing = false;
  rate = 1;
  private last = 0;

  constructor(
    readonly durationSec: number,
    startSec = 0,
  ) {
    this.t = Math.max(0, Math.min(durationSec, startSec));
  }

  /** Advance to `nowMs` (performance.now()); stops at the end. */
  tick(nowMs: number): number {
    if (this.playing) {
      this.t += ((nowMs - this.last) / 1000) * this.rate;
      if (this.t >= this.durationSec) {
        this.t = this.durationSec;
        this.playing = false;
      }
    }
    this.last = nowMs;
    return this.t;
  }

  play(nowMs: number): void {
    if (this.t >= this.durationSec - 0.5) this.t = 0;
    this.last = nowMs;
    this.playing = true;
  }

  pause(): void {
    this.playing = false;
  }

  seek(sec: number): void {
    this.t = Math.max(0, Math.min(this.durationSec, sec));
  }
}

export const DEMO_RECORDING = { source: 'youtube' as const, id: 'vibe-guitar-demo', title: '데모 곡 (합성 데이터)', artist: 'Vibe Guitar' };

const BEAT = 60 / 180; // 180 tracker beats per minute = 60 dotted quarters
const BPB = 6;
const LEAD_BEATS = 3; // the tracker's first beat sits mid-bar
const T0 = 0.6;

/** [chord, bars] per section; chords change on bar starts. */
const FORM: { name: string; lyric: boolean; chords: [string, number][] }[] = [
  { name: 'intro', lyric: false, chords: [['G#', 2], ['D#', 2]] },
  { name: 'verse', lyric: true, chords: [['G#', 1], ['Fm', 1], ['C#', 1], ['D#', 1], ['G#', 1], ['Fm7', 1], ['C#', 1], ['D#', 1]] },
  { name: 'chorus', lyric: true, chords: [['Fm', 1], ['C#', 1], ['G#', 1], ['D#', 1], ['Fm', 1], ['C#maj7', 1], ['G#', 1], ['D#', 1]] },
  { name: 'break', lyric: false, chords: [['G#', 2], ['D#', 2]] },
  { name: 'verse', lyric: true, chords: [['G#', 1], ['Fm', 1], ['C#', 1], ['D#', 1], ['G#', 1], ['Fm7', 1], ['C#', 1], ['D#', 1]] },
  { name: 'chorus', lyric: true, chords: [['Fm', 1], ['C#', 1], ['G#', 1], ['D#', 1], ['Fm', 1], ['C#maj7', 1], ['G#', 1], ['D#', 1]] },
  { name: 'outro', lyric: false, chords: [['C#', 1], ['D#', 1], ['G#', 2]] },
];

const totalBars = FORM.reduce((a, s) => a + s.chords.reduce((b, [, n]) => b + n, 0), 0);
const barStart = (bar: number) => T0 + (LEAD_BEATS + bar * BPB) * BEAT;
const r3 = (x: number) => Math.round(x * 1000) / 1000;

/**
 * Synthetic uncertain stretches (VGT-19) so every visual variant has something to show: a whole
 * event (verse Fm, second choice the relative major), part of an event as if a change were missed
 * (the second half of verse C♯), a low-confidence 7th that also carries the "Em도 돼요" hint at
 * 중급/상급, and one whose second choice reads differently as a capo shape (chorus C♯ → A♯m, shape
 * Am with capo 1, concert B♭m).
 */
export const DEMO_UNCERTAIN_BARS: { bar: number; fromBeat: number; toBeat: number; chord: string; alt: string }[] = [
  { bar: 5, fromBeat: 0, toBeat: BPB, chord: 'Fm', alt: 'G#' },
  { bar: 6, fromBeat: 3, toBeat: BPB, chord: 'C#', alt: 'D#' },
  { bar: 9, fromBeat: 0, toBeat: BPB, chord: 'Fm7', alt: 'G#' },
  { bar: 13, fromBeat: 0, toBeat: BPB, chord: 'C#', alt: 'A#m' },
];

function demoUncertain(): UncertainSpan[] {
  return DEMO_UNCERTAIN_BARS.map((u) => ({ fromSec: r3(barStart(u.bar) + u.fromBeat * BEAT), toSec: r3(barStart(u.bar) + u.toBeat * BEAT), chord: u.chord, alt: u.alt }));
}

export function demoChart(): Chart {
  const beatTimes: number[] = [];
  for (let i = 0; i < LEAD_BEATS + totalBars * BPB + 1; i++) beatTimes.push(Math.round((T0 + i * BEAT) * 1000) / 1000);
  const events: ChordEvent[] = [{ startSec: 0, chord: 'N', confidence: 1, source: 'auto' }];
  let bar = 0;
  let n = 0;
  for (const s of FORM) {
    for (const [chord, bars] of s.chords) {
      // a few low-confidence events so the "Em도 돼요"-style hint has something to show
      const confidence = chord.endsWith('7') ? 0.42 : n % 7 === 3 ? 0.55 : 0.85;
      events.push({ startSec: Math.round(barStart(bar) * 1000) / 1000, chord, confidence, source: 'auto' });
      bar += bars;
      n++;
    }
  }
  const end = Math.round((barStart(totalBars) + 1) * 1000) / 1000;
  return {
    schemaVersion: 1,
    recording: { ...DEMO_RECORDING },
    timing: { bpm: 180, beatsPerBar: BPB, beatUnit: 4, firstDownbeatSec: T0, beatTimes },
    events,
    coverage: [{ fromSec: 0, toSec: end }],
    provenance: { createdBy: 'recognizer', createdAt: '2026-11-10T00:00:00.000Z', tool: 'synthetic demo', note: 'Synthetic demo data (not a real song).' },
    uncertain: demoUncertain(),
  };
}

const SYLLABLES = ['라', '랄라', '라라', '나', '날라', '루', '라라라', '나나'];
const CHORUS = ['오', '예', '워어', '오오', '예이', '우', '워', '예에', '오우', '라이'];

/** Placeholder lyrics: one line per two bars in sung sections, word onsets 0.4 s before chart time. */
export function demoLyrics(earlySec = 0.4): Lyrics {
  const lines: LyricLine[] = [];
  let bar = 0;
  let w = 0;
  for (const s of FORM) {
    const bars = s.chords.reduce((a, [, n]) => a + n, 0);
    if (s.lyric) {
      for (let b = 0; b < bars; b += 2) {
        const start = barStart(bar + b);
        // Chorus lines repeat word for word (so the section finder can label them); verses do not.
        const pick = (i: number) => (s.name === 'chorus' ? CHORUS[(b * 7 + i) % CHORUS.length] : SYLLABLES[w++ % SYLLABLES.length]);
        const words = [0, 1, 2.5, 4, 6, 9, 10.5].map((beat, i) => ({ text: pick(i), startSec: Math.round((start + beat * BEAT - earlySec) * 1000) / 1000 }));
        lines.push({ startSec: words[0].startSec, endSec: Math.round((start + 11.5 * BEAT - earlySec) * 1000) / 1000, text: words.map((x) => x.text).join(' '), words, wordTimed: true });
      }
    }
    bar += bars;
  }
  return { kind: 'words', lines };
}
