/**
 * Audio capture format shared by the dev-only audio dump build (src/extension/dump), the local
 * receiver (scripts/audio-dump-receiver.mjs) and the offline replay (src/replay/node.ts).
 *
 * One POST body per analysed auto chart:
 *   [uint32 LE: header byte length H][H bytes: UTF-8 JSON header, space-padded to a multiple of 4]
 *   [segment 0 samples][segment 1 samples]…  (little-endian Float32, 22 050 Hz, mono)
 * The header is a CaptureHeader: the capture metadata plus, per segment, its startSec and sample count.
 * On disk the receiver writes <key>/<captureId>/seg-<i>.f32 (the raw samples) and meta.json.
 */
import type { Chart, CoverageRange, Recording } from '../chart/types';

export const CAPTURE_SCHEMA = 'vibe-guitar-audio-capture/1';
/** Receiver port on 127.0.0.1 (the latency probe page uses 8790). */
export const AUDIO_DUMP_PORT = 8791;
export const CAPTURE_SAMPLE_RATE = 22050;

export interface CaptureSegmentInfo {
  /** Playback time of the first sample (the Segment's startSec, unrounded). */
  startSec: number;
  samples: number;
}

/** Everything the dump build knows about one analysis, except the audio. */
export interface CaptureMeta {
  schema: typeof CAPTURE_SCHEMA;
  /** `${source}:${id}` (recordingKeyOf in listen.ts). */
  recordingKey: string;
  recording: Recording;
  /** Session duration (media length) passed to buildAutoChart. */
  durationSec: number;
  /** ListeningSession.coverage() when the analysis started (all stored audio, unrounded). */
  sessionCoverage: CoverageRange[];
  /** The chart exactly as sent in the `auto-chart` message (its coverage is the analysed coverage). */
  chart: Chart;
  /** Build that produced the capture: git commit and whether the tree had local changes. */
  build: { commit: string; dirty: boolean };
  /** sha256 of the packaged model files, by file name (scripts/models.manifest.json). */
  models: Record<string, string>;
  /** ISO time the dump was sent. */
  capturedAt: string;
  sampleRate: number;
}

export interface CaptureHeader extends CaptureMeta {
  /** The closed-segment snapshot analyzeClosedSegments analysed, in order. */
  segments: CaptureSegmentInfo[];
}

/** meta.json as written by the receiver. */
export interface StoredCaptureMeta extends CaptureMeta {
  captureId: string;
  receivedAt: string;
  segments: (CaptureSegmentInfo & { file: string })[];
}

export interface CaptureSegment {
  startSec: number;
  samples: Float32Array;
}

const littleEndian = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

/** POST body parts (pass to `new Blob(parts)`); the sample arrays are referenced, not copied. */
export function encodeCaptureBody(meta: CaptureMeta, segments: CaptureSegment[]): Uint8Array[] {
  if (!littleEndian) throw new Error('audio dump: big-endian platform is not supported');
  const header: CaptureHeader = { ...meta, segments: segments.map((s) => ({ startSec: s.startSec, samples: s.samples.length })) };
  let json = JSON.stringify(header);
  let bytes = new TextEncoder().encode(json);
  if (bytes.length % 4) {
    json += ' '.repeat(4 - (bytes.length % 4));
    bytes = new TextEncoder().encode(json);
  }
  const len = new Uint8Array(4);
  new DataView(len.buffer).setUint32(0, bytes.length, true);
  return [len, bytes, ...segments.map((s) => new Uint8Array(s.samples.buffer, s.samples.byteOffset, s.samples.byteLength))];
}

export class CaptureFormatError extends Error {}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Checks the header fields replay and parity rely on. */
export function checkHeader(v: unknown): CaptureHeader {
  if (!isObj(v) || v.schema !== CAPTURE_SCHEMA) throw new CaptureFormatError(`capture: expected schema ${CAPTURE_SCHEMA}`);
  if (typeof v.recordingKey !== 'string' || !isObj(v.recording) || typeof v.recording.id !== 'string' || typeof v.recording.source !== 'string')
    throw new CaptureFormatError('capture: recordingKey and recording are required');
  if (!finite(v.durationSec) || !isObj(v.chart) || !Array.isArray(v.chart.events) || !Array.isArray(v.chart.coverage)) throw new CaptureFormatError('capture: durationSec and chart are required');
  if (v.sampleRate !== CAPTURE_SAMPLE_RATE) throw new CaptureFormatError(`capture: sampleRate must be ${CAPTURE_SAMPLE_RATE}`);
  if (!Array.isArray(v.segments) || !v.segments.length) throw new CaptureFormatError('capture: no segments');
  for (const s of v.segments as unknown[]) {
    if (!isObj(s) || !finite(s.startSec) || !Number.isInteger(s.samples) || (s.samples as number) <= 0) throw new CaptureFormatError('capture: every segment needs startSec and a positive sample count');
  }
  return v as unknown as CaptureHeader;
}

/** Splits a POST body into the header and per-segment raw sample bytes (little-endian Float32). */
export function decodeCaptureBody(body: Uint8Array): { header: CaptureHeader; segmentBytes: Uint8Array[] } {
  if (body.length < 4) throw new CaptureFormatError('capture: body too short');
  const h = new DataView(body.buffer, body.byteOffset, body.byteLength).getUint32(0, true);
  if (h % 4 || 4 + h > body.length) throw new CaptureFormatError('capture: bad header length');
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(body.subarray(4, 4 + h)));
  } catch {
    throw new CaptureFormatError('capture: header is not JSON');
  }
  const header = checkHeader(parsed);
  const segmentBytes: Uint8Array[] = [];
  let at = 4 + h;
  for (const s of header.segments) {
    const n = s.samples * 4;
    if (at + n > body.length) throw new CaptureFormatError('capture: body shorter than the declared segments');
    segmentBytes.push(body.subarray(at, at + n));
    at += n;
  }
  if (at !== body.length) throw new CaptureFormatError('capture: body longer than the declared segments');
  return { header, segmentBytes };
}

/** Raw little-endian Float32 bytes → samples (copied, so the result is aligned). */
export function samplesFromBytes(bytes: Uint8Array): Float32Array {
  if (bytes.byteLength % 4) throw new CaptureFormatError('capture: segment byte length is not a multiple of 4');
  const out = new Float32Array(bytes.byteLength / 4);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < out.length; i++) out[i] = dv.getFloat32(i * 4, true);
  return out;
}

/** Folder name for a recording: the YouTube id when it is one, otherwise a filesystem-safe key. */
export function captureFolderName(recording: Pick<Recording, 'source' | 'id'>): string {
  if (recording.source === 'youtube' && /^[A-Za-z0-9_-]{6,20}$/.test(recording.id)) return recording.id;
  return `${recording.source}_${recording.id}`.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80);
}
