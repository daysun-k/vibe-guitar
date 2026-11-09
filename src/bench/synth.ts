/**
 * Synthetic labeled test set for the phase 0 benchmark: rendered chord progressions at
 * several tempos, meters, voicings and timbres, optionally with drums, bass and noise.
 * Deterministic (seeded). This is NOT real music: no vocals, no mixing, no reverb,
 * idealised tuning and timing. Accuracy on it is an upper-bound sanity check.
 */
import { chordPitchClasses, parseChord } from '../arrange/chord';

export type Timbre = 'piano' | 'guitar' | 'pad' | 'epiano';
export type Voicing = 'close' | 'inversion' | 'guitar';

export interface ClipSpec {
  id: string;
  seed: number;
  bpm: number;
  beatsPerBar: 3 | 4;
  bars: number;
  timbre: Timbre;
  voicing: Voicing;
  drums: boolean;
  bass: boolean;
  /** Signal-to-noise ratio in dB for added white noise; null = no noise. */
  snrDb: number | null;
  /** Chord changes on half bars sometimes (4/4 only). */
  halfBarChanges: boolean;
}

export interface Clip {
  spec: ClipSpec;
  sampleRate: number;
  audio: Float32Array;
  durationSec: number;
  /** Ground truth. */
  chords: { startSec: number; endSec: number; symbol: string }[];
  beats: number[];
  downbeats: number[];
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const midiHz = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

/** Roman-numeral progressions (degree semitones from the key root, quality suffix). */
const PROGRESSIONS: [number, string][][] = [
  [[0, ''], [7, ''], [9, 'm'], [5, '']], // I V vi IV
  [[0, ''], [9, 'm'], [5, ''], [7, '']], // I vi IV V
  [[2, 'm7'], [7, '7'], [0, 'maj7'], [0, 'maj7']], // ii7 V7 Imaj7
  [[9, 'm'], [5, ''], [0, ''], [7, '']], // vi IV I V
  [[0, ''], [5, ''], [7, 'sus4'], [7, '']], // I IV Vsus4 V
  [[0, 'maj7'], [9, 'm7'], [2, 'm7'], [7, '7']], // jazz-pop turnaround
  [[9, 'm'], [7, ''], [5, ''], [4, '7']], // Andalusian-ish with V7/vi
  [[0, ''], [2, 'sus2'], [5, ''], [0, '']],
  [[0, ''], [4, 'm'], [5, ''], [7, '7']],
  [[9, 'm7'], [2, 'm7'], [7, ''], [0, '']],
];

/** Pitches (MIDI) for one chord. */
function voice(symbol: string, voicing: Voicing, rnd: () => number): { notes: number[]; bass: number } {
  const c = parseChord(symbol);
  const pcs = chordPitchClasses(c);
  const root = c.root;
  const bass = 36 + ((root - 0 + 12) % 12) + (root < 4 ? 12 : 0); // E2..D#3 range
  if (voicing === 'guitar') {
    // Spread like an open/barre guitar shape: bass root, then chord tones stacked upward.
    const notes = [bass];
    let cur = bass;
    let i = 1;
    while (notes.length < 6) {
      const pc = pcs[i % pcs.length];
      let n = cur + 1;
      while (((n % 12) + 12) % 12 !== pc) n++;
      if (n - cur < 3 && notes.length < 5) {
        i++;
        continue;
      }
      notes.push(n);
      cur = n;
      i++;
    }
    return { notes: notes.filter((n) => n <= 76), bass };
  }
  // close position around C4..B4
  let notes = pcs.map((pc) => 60 + pc);
  notes.sort((a, b) => a - b);
  if (voicing === 'inversion') {
    const inv = Math.floor(rnd() * notes.length);
    for (let k = 0; k < inv; k++) notes = [...notes.slice(1), notes[0] + 12];
  } else {
    // root position: rotate so the root is lowest
    while (notes[0] % 12 !== root) notes = [...notes.slice(1), notes[0] + 12];
    if (notes[0] > 64) notes = notes.map((n) => n - 12);
  }
  return { notes: [bass + 12, ...notes], bass };
}

function addTone(buf: Float32Array, sr: number, start: number, dur: number, hz: number, timbre: Timbre, amp: number): void {
  const s0 = Math.max(0, Math.floor(start * sr));
  const release = timbre === 'pad' ? 0.25 : 0.08;
  const s1 = Math.min(buf.length, Math.floor((start + dur + release) * sr));
  const harmonics =
    timbre === 'piano' ? [1, 0.5, 0.3, 0.2, 0.12, 0.08] : timbre === 'guitar' ? [1, 0.7, 0.45, 0.3, 0.2, 0.12, 0.08] : timbre === 'pad' ? [1, 0.5, 0.33, 0.25, 0.2, 0.16] : [1, 0.25, 0.05];
  const decay = timbre === 'piano' ? 1.6 : timbre === 'guitar' ? 2.2 : timbre === 'epiano' ? 1.2 : 0;
  const attack = timbre === 'pad' ? 0.12 : 0.004;
  for (let i = s0; i < s1; i++) {
    const t = i / sr - start;
    if (t < 0) continue;
    let env = t < attack ? t / attack : Math.exp(-decay * (t - attack));
    if (t > dur) env *= Math.max(0, 1 - (t - dur) / release);
    let v = 0;
    for (let h = 0; h < harmonics.length; h++) {
      const f = hz * (h + 1);
      if (f > sr / 2.2) break;
      const hDecay = timbre === 'pad' ? 1 : Math.exp(-h * 0.8 * t);
      v += harmonics[h] * hDecay * Math.sin(2 * Math.PI * f * t + h);
    }
    buf[i] += amp * env * v;
  }
}

function addDrum(buf: Float32Array, sr: number, start: number, kind: 'kick' | 'snare' | 'hat', amp: number, rnd: () => number): void {
  const len = kind === 'kick' ? 0.25 : kind === 'snare' ? 0.18 : 0.05;
  const s0 = Math.floor(start * sr);
  let phase = 0;
  let lp = 0;
  for (let i = 0; i < len * sr && s0 + i < buf.length; i++) {
    const t = i / sr;
    let v = 0;
    if (kind === 'kick') {
      const f = 50 + 70 * Math.exp(-t * 30);
      phase += (2 * Math.PI * f) / sr;
      v = Math.sin(phase) * Math.exp(-t * 14);
    } else if (kind === 'snare') {
      v = (rnd() * 2 - 1) * 0.6 * Math.exp(-t * 22) + 0.4 * Math.sin(2 * Math.PI * 185 * t) * Math.exp(-t * 30);
    } else {
      const n = rnd() * 2 - 1;
      lp = 0.6 * lp + 0.4 * n;
      v = (n - lp) * Math.exp(-t * 70);
    }
    buf[s0 + i] += amp * v;
  }
}

export function renderClip(spec: ClipSpec, sampleRate = 48000): Clip {
  const rnd = mulberry32(spec.seed);
  const beat = 60 / spec.bpm;
  const lead = 0.5 + rnd() * 1.0; // silence/pickup before bar 1
  const bars = spec.bars;
  const durationSec = lead + bars * spec.beatsPerBar * beat + 1.0;
  const audio = new Float32Array(Math.ceil(durationSec * sampleRate));
  const key = Math.floor(rnd() * 12);
  const prog = PROGRESSIONS[Math.floor(rnd() * PROGRESSIONS.length)];

  // Chord timeline: one chord per bar, sometimes two per bar.
  const chords: Clip['chords'] = [];
  let step = 0;
  for (let b = 0; b < bars; b++) {
    const barStart = lead + b * spec.beatsPerBar * beat;
    const split = spec.halfBarChanges && spec.beatsPerBar === 4 && rnd() < 0.3;
    const parts = split ? 2 : 1;
    for (let p = 0; p < parts; p++) {
      const [deg, q] = prog[step % prog.length];
      step++;
      const symbol = `${NAMES[(key + deg) % 12]}${q}`;
      const s = barStart + (p * spec.beatsPerBar * beat) / parts;
      chords.push({ startSec: s, endSec: s + (spec.beatsPerBar * beat) / parts, symbol });
    }
  }

  const beats: number[] = [];
  const downbeats: number[] = [];
  for (let b = 0; b < bars; b++) {
    for (let k = 0; k < spec.beatsPerBar; k++) {
      const t = lead + (b * spec.beatsPerBar + k) * beat;
      beats.push(t);
      if (k === 0) downbeats.push(t);
    }
  }

  // Harmony
  for (const ch of chords) {
    const { notes, bass } = voice(ch.symbol, spec.voicing, rnd);
    const dur = ch.endSec - ch.startSec;
    if (spec.timbre === 'guitar') {
      // Strums on each beat (down) with an 8th-note up-strum on even beats.
      const nBeats = Math.round(dur / beat);
      for (let k = 0; k < nBeats; k++) {
        const t = ch.startSec + k * beat;
        notes.forEach((n, i) => addTone(audio, sampleRate, t + i * 0.012, beat * 0.95, midiHz(n), 'guitar', 0.05 * (k === 0 ? 1 : 0.75)));
        if (k % 2 === 1) notes.slice(2).reverse().forEach((n, i) => addTone(audio, sampleRate, t + beat / 2 + i * 0.01, beat * 0.45, midiHz(n), 'guitar', 0.03));
      }
    } else if (spec.timbre === 'pad') {
      for (const n of notes) addTone(audio, sampleRate, ch.startSec, dur, midiHz(n), 'pad', 0.05);
    } else {
      // Piano / e-piano: strike on the chord start and re-strike on later downbeat-halves.
      const hits = Math.max(1, Math.round(dur / (beat * 2)));
      for (let k = 0; k < hits; k++) {
        const t = ch.startSec + k * beat * 2;
        for (const n of notes) addTone(audio, sampleRate, t, Math.min(beat * 2, ch.endSec - t), midiHz(n), spec.timbre, 0.06);
      }
    }
    if (spec.bass) {
      const nBeats = Math.round(dur / beat);
      for (let k = 0; k < nBeats; k += 2) addTone(audio, sampleRate, ch.startSec + k * beat, beat * 1.8, midiHz(bass - 12 >= 28 ? bass - 12 : bass), 'piano', 0.12);
    }
  }

  // Drums
  if (spec.drums) {
    beats.forEach((t, i) => {
      const k = i % spec.beatsPerBar;
      if (k === 0) addDrum(audio, sampleRate, t, 'kick', 0.5, rnd);
      else if (spec.beatsPerBar === 4 && k === 2) addDrum(audio, sampleRate, t, 'kick', 0.35, rnd);
      if ((spec.beatsPerBar === 4 && (k === 1 || k === 3)) || (spec.beatsPerBar === 3 && k > 0)) addDrum(audio, sampleRate, t, 'snare', 0.3, rnd);
      addDrum(audio, sampleRate, t, 'hat', 0.12, rnd);
      addDrum(audio, sampleRate, t + beat / 2, 'hat', 0.08, rnd);
    });
  }

  // Normalise to -3 dBFS peak, then add noise at the requested SNR.
  let peak = 0;
  let energy = 0;
  for (const v of audio) {
    peak = Math.max(peak, Math.abs(v));
    energy += v * v;
  }
  const g = peak > 0 ? 0.7 / peak : 1;
  for (let i = 0; i < audio.length; i++) audio[i] *= g;
  if (spec.snrDb !== null) {
    const sigRms = Math.sqrt((energy * g * g) / audio.length);
    const noiseRms = sigRms / Math.pow(10, spec.snrDb / 20);
    for (let i = 0; i < audio.length; i++) {
      // approx. Gaussian
      const n = (rnd() + rnd() + rnd() + rnd() - 2) * Math.sqrt(3);
      audio[i] += noiseRms * n;
    }
  }
  return { spec, sampleRate, audio, durationSec, chords, beats, downbeats };
}

/** The default benchmark set: 24 clips, ~25–45 s each. */
export function defaultSpecs(): ClipSpec[] {
  const tempos = [72, 96, 120, 150];
  const timbres: Timbre[] = ['piano', 'guitar', 'pad', 'epiano'];
  const voicings: Voicing[] = ['close', 'inversion', 'guitar'];
  const specs: ClipSpec[] = [];
  for (let i = 0; i < 24; i++) {
    const bpm = tempos[i % 4];
    const beatsPerBar: 3 | 4 = i % 6 === 5 ? 3 : 4;
    specs.push({
      id: `syn${String(i + 1).padStart(2, '0')}`,
      seed: 1000 + i * 7919,
      bpm,
      beatsPerBar,
      bars: Math.max(8, Math.round((32 * bpm) / 60 / beatsPerBar)),
      timbre: timbres[Math.floor(i / 4) % 4],
      voicing: voicings[i % 3],
      drums: i % 2 === 0,
      bass: i % 3 !== 2,
      snrDb: i % 4 === 3 ? 10 : i % 4 === 1 ? 20 : null,
      halfBarChanges: i % 5 === 0,
    });
  }
  return specs;
}
