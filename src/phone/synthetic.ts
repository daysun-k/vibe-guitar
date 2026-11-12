/** Synthetic chord chart for the VGT-13 probe: no real song data, 90 BPM, 4/4, 20 bars (about 53 s). */
import type { Song } from './protocol';

const BPM = 90;
const BEAT = 60 / BPM;
// [chord, beats]: mixes 4-beat and 2-beat changes so short gaps are tested too.
const PLAN: [string, number][] = [
  ['C', 4], ['G', 4], ['Am', 4], ['F', 4],
  ['C', 2], ['G', 2], ['Am', 2], ['Em', 2], ['F', 4], ['G', 4],
  ['Dm', 4], ['G', 4], ['C', 2], ['F', 2], ['C', 4],
  ['Am', 4], ['Em', 4], ['F', 2], ['G', 2], ['C', 4],
  ['F', 4], ['G', 4], ['Em', 4], ['Am', 4],
];

export function syntheticSong(): Song {
  const chords: Song['chords'] = [];
  let beat = 0;
  for (const [name, beats] of PLAN) {
    chords.push({ at: Math.round(beat * BEAT * 1000) / 1000, name });
    beat += beats;
  }
  return { bpm: BPM, beatsPerBar: 4, duration: Math.round(beat * BEAT * 1000) / 1000, chords };
}
