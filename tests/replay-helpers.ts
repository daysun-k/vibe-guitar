/** Shared fixtures for tests/audio-dump.test.ts and tests/replay.test.ts. */
import { MODEL_SAMPLE_RATE } from '../src/audio/features';
import { ListeningSession } from '../src/recognize/session';

/** Deterministic noise-plus-tone audio (non-trivial features). */
export function testAudio(sec: number, seed = 1): Float32Array {
  const n = Math.round(sec * MODEL_SAMPLE_RATE);
  const out = new Float32Array(n);
  let s = seed;
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) >>> 0;
    out[i] = 0.2 * Math.sin((2 * Math.PI * 220 * i) / MODEL_SAMPLE_RATE) + 0.05 * ((s / 2 ** 32) * 2 - 1);
  }
  return out;
}

/** A session filled the way the placer fills it: odd block sizes, a seek, a short stretch, an open segment. */
export function liveLikeSession(): ListeningSession {
  const s = new ListeningSession('youtube:abcdefghijk', 30);
  const stretches = [
    { audio: testAudio(3.3, 1), pos0: 0.0371 },
    { audio: testAudio(0.6, 2), pos0: 9.5 }, // under 1 s: not analysed
    { audio: testAudio(2.2, 3), pos0: 12.25 },
  ];
  let k = 0;
  for (const st of stretches) {
    s.breakSegment();
    let at = 0;
    while (at < st.audio.length) {
      const n = Math.min(st.audio.length - at, k++ % 2 ? 1881 : 1882);
      at += n;
      s.append(st.audio.slice(at - n, at), st.pos0 + at / MODEL_SAMPLE_RATE);
      if (k % 3 === 0) s.extractReady(48);
    }
  }
  return s; // the last stretch is still the open segment
}
