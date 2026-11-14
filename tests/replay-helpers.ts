/** Shared fixtures for tests/audio-dump.test.ts, tests/replay.test.ts and tests/baseline-analysis.test.ts. */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { MODEL_SAMPLE_RATE } from '../src/audio/features';
import { CAPTURE_SAMPLE_RATE, CAPTURE_SCHEMA } from '../src/replay/capture';
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

/**
 * Writes a capture folder as the audio-dump receiver does: <audio>/<youtubeId>/<captureId>/meta.json +
 * seg-<i>.f32 (little-endian Float32 at the capture rate).
 */
export function writeCaptureFolder(audioDir: string, youtubeId: string, segments: { startSec: number; samples: Float32Array }[], durationSec: number, captureId = '2026-11-14T00-00-00-000Z'): string {
  const dir = path.join(audioDir, youtubeId, captureId);
  mkdirSync(dir, { recursive: true });
  const recording = { source: 'youtube' as const, id: youtubeId, title: youtubeId, artist: 'synthetic' };
  segments.forEach((s, i) => writeFileSync(path.join(dir, `seg-${i}.f32`), Buffer.from(s.samples.buffer, s.samples.byteOffset, s.samples.byteLength)));
  const meta = {
    schema: CAPTURE_SCHEMA,
    recordingKey: `youtube:${youtubeId}`,
    recording,
    durationSec,
    sessionCoverage: [],
    chart: { schemaVersion: 1, recording, timing: { bpm: 120, beatsPerBar: 4, beatUnit: 4, firstDownbeatSec: 0 }, events: [], coverage: [], provenance: { createdBy: 'recognizer', createdAt: '1970-01-01T00:00:00.000Z' } },
    build: { commit: 'test', dirty: false },
    models: {},
    capturedAt: '2026-11-14T00:00:00.000Z',
    sampleRate: CAPTURE_SAMPLE_RATE,
    captureId,
    receivedAt: '2026-11-14T00:00:00.000Z',
    segments: segments.map((s, i) => ({ startSec: s.startSec, samples: s.samples.length, file: `seg-${i}.f32` })),
  };
  writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta));
  return dir;
}
