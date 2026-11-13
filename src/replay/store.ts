/**
 * Reads captures written by scripts/audio-dump-receiver.mjs (Node only):
 *   <audio>/<key>/<captureId>/meta.json + seg-<i>.f32
 * When a key holds several captures, the latest captureId (they sort by time) is used and the
 * others are listed as skipped, so a re-run over the same folder always picks the same captures.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { checkHeader, samplesFromBytes, type CaptureSegment, type StoredCaptureMeta } from './capture';

export interface StoredCapture {
  key: string;
  captureId: string;
  dir: string;
  meta: StoredCaptureMeta;
}

export interface CaptureSelection {
  captures: StoredCapture[];
  /** Older captures of the same key, not used. */
  skipped: { key: string; captureId: string }[];
}

function readMeta(dir: string): StoredCaptureMeta {
  const v = JSON.parse(readFileSync(path.join(dir, 'meta.json'), 'utf8')) as StoredCaptureMeta;
  checkHeader(v);
  if (typeof v.captureId !== 'string' || !v.segments.every((s) => typeof s.file === 'string' && /^seg-\d+\.f32$/.test(s.file))) throw new Error(`${dir}: meta.json lacks captureId or segment files`);
  return v;
}

/** The latest capture per key, optionally only the given keys (an unknown key is an error). */
export function selectCaptures(audioDir: string, ids?: string[]): CaptureSelection {
  if (!existsSync(audioDir)) throw new Error(`--audio ${audioDir} does not exist`);
  const keys = readdirSync(audioDir).filter((k) => !k.startsWith('.') && statSync(path.join(audioDir, k)).isDirectory()).sort();
  if (ids) {
    const missing = ids.filter((id) => !keys.includes(id));
    if (missing.length) throw new Error(`no capture for: ${missing.join(', ')}`);
  }
  const captures: StoredCapture[] = [];
  const skipped: CaptureSelection['skipped'] = [];
  for (const key of ids ? keys.filter((k) => ids.includes(k)) : keys) {
    const ids2 = readdirSync(path.join(audioDir, key))
      .filter((c) => !c.startsWith('.') && existsSync(path.join(audioDir, key, c, 'meta.json')))
      .sort();
    if (!ids2.length) continue;
    const captureId = ids2[ids2.length - 1];
    const dir = path.join(audioDir, key, captureId);
    captures.push({ key, captureId, dir, meta: readMeta(dir) });
    for (const c of ids2.slice(0, -1)) skipped.push({ key, captureId: c });
  }
  return { captures, skipped };
}

export function readSegments(c: StoredCapture): CaptureSegment[] {
  return c.meta.segments.map((s) => {
    const buf = readFileSync(path.join(c.dir, s.file));
    const samples = samplesFromBytes(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
    if (samples.length !== s.samples) throw new Error(`${c.dir}/${s.file}: ${samples.length} samples, meta.json says ${s.samples}`);
    return { startSec: s.startSec, samples };
  });
}
