/**
 * Listening session for one recording: keeps the heard audio as contiguous segments on
 * the playback timeline, extracts features incrementally while audio arrives, caches
 * Beat This! chunks as soon as their 30 s window is complete, and tracks coverage.
 * Pure logic (no browser APIs) so it can be unit-tested and reused by the bench page.
 */
import { CQT, CqtExtractor, MEL, MelExtractor, MODEL_SAMPLE_RATE } from '../audio/features';
import { normalizeCoverage } from '../chart/coverage';
import type { CoverageRange } from '../chart/types';
import { BEAT_BORDER, BEAT_CHUNK, chunkStarts, type BeatLogits } from './beats';
import type { ModelRunner } from './runner';

/** A new segment starts when the reported position differs from the expected one by more than this. */
export const CONTINUITY_TOLERANCE_SEC = 0.35;
/** Upper bound on stored audio per session (memory guard): 20 minutes. */
export const MAX_SESSION_SEC = 20 * 60;

class Growable {
  data: Float32Array;
  length = 0;
  constructor(initial = MODEL_SAMPLE_RATE * 30) {
    this.data = new Float32Array(initial);
  }
  push(x: ArrayLike<number>): void {
    if (this.length + x.length > this.data.length) {
      const next = new Float32Array(Math.max(this.data.length * 2, this.length + x.length));
      next.set(this.data.subarray(0, this.length));
      this.data = next;
    }
    this.data.set(x as Float32Array, this.length);
    this.length += x.length;
  }
  view(): Float32Array {
    return this.data.subarray(0, this.length);
  }
}

export class Segment {
  readonly audio = new Growable();
  readonly mel = new Growable(MEL.nMels * 1500);
  readonly cqt = new Growable(CQT.nBins * 300);
  melFrames = 0;
  cqtFrames = 0;
  /** Beat model outputs keyed by chunk start frame (only full, final-position chunks). */
  readonly beatChunks = new Map<number, BeatLogits>();
  /** Set when the segment was closed; a closed segment never grows again. */
  closed = false;
  constructor(readonly startSec: number) {}

  get durationSec(): number {
    return this.audio.length / MODEL_SAMPLE_RATE;
  }
  get endSec(): number {
    return this.startSec + this.durationSec;
  }
}

const melEx = new MelExtractor();
const cqtEx = new CqtExtractor();

export class ListeningSession {
  readonly segments: Segment[] = [];
  private current: Segment | null = null;
  /** True once the audio cap was reached; further audio is ignored. */
  full = false;

  constructor(
    readonly key: string,
    public durationSec = 0,
  ) {}

  get currentSegment(): Segment | null {
    return this.current;
  }

  get storedSec(): number {
    return this.segments.reduce((s, g) => s + g.durationSec, 0);
  }

  /**
   * Adds 22.05 kHz samples whose last sample plays at `positionAtEndSec`.
   * Starts a new segment after a break or when the timeline jumped (seek).
   */
  append(samples: Float32Array, positionAtEndSec: number): void {
    if (!samples.length) return;
    if (this.storedSec + samples.length / MODEL_SAMPLE_RATE > MAX_SESSION_SEC) {
      this.full = true;
      return;
    }
    const dur = samples.length / MODEL_SAMPLE_RATE;
    const cur = this.current;
    if (!cur || Math.abs(cur.endSec + dur - positionAtEndSec) > CONTINUITY_TOLERANCE_SEC) {
      if (cur) cur.closed = true;
      const start = Math.max(0, positionAtEndSec - dur);
      this.current = new Segment(start);
      this.segments.push(this.current);
    }
    this.current!.audio.push(samples);
  }

  /** Pause, seek, ad, rate change, recording change: the next audio opens a new segment. */
  breakSegment(): void {
    if (this.current) this.current.closed = true;
    this.current = null;
  }

  /** Extracts features that became computable; at most `maxFrames` CQT frames per call. */
  extractReady(maxCqtFrames = 64, final = false): number {
    let done = 0;
    for (const seg of this.segments) {
      const len = seg.audio.length;
      const x = seg.audio.data;
      const isOpen = seg === this.current && !final;
      const melTarget = isOpen ? MelExtractor.readyFrameCount(len) : MelExtractor.frameCount(len);
      if (melTarget > seg.melFrames) {
        const add = new Float32Array((melTarget - seg.melFrames) * MEL.nMels);
        for (let m = seg.melFrames; m < melTarget; m++) melEx.frame(x, len, m, add, (m - seg.melFrames) * MEL.nMels);
        seg.mel.push(add);
        seg.melFrames = melTarget;
      }
      const cqtTarget = Math.min(isOpen ? CqtExtractor.readyFrameCount(len) : CqtExtractor.frameCount(len), seg.cqtFrames + (maxCqtFrames - done));
      if (cqtTarget > seg.cqtFrames) {
        const add = new Float32Array((cqtTarget - seg.cqtFrames) * CQT.nBins);
        for (let m = seg.cqtFrames; m < cqtTarget; m++) cqtEx.frame(x, len, m, add, (m - seg.cqtFrames) * CQT.nBins);
        seg.cqt.push(add);
        done += cqtTarget - seg.cqtFrames;
        seg.cqtFrames = cqtTarget;
      }
      if (done >= maxCqtFrames) break;
    }
    return done;
  }

  /**
   * Runs the beat model on chunks of the open segment whose 1500-frame window is complete
   * and whose start will not move (all but the final chunk). Returns chunks computed.
   */
  async precomputeBeatChunks(runner: ModelRunner, maxChunks = 1): Promise<number> {
    const seg = this.current;
    if (!seg) return 0;
    let n = 0;
    // Regular chunk starts are -6, 1482, 2970, … independent of the final length.
    for (let s = -BEAT_BORDER; s + BEAT_CHUNK <= seg.melFrames && n < maxChunks; s += BEAT_CHUNK - 2 * BEAT_BORDER) {
      if (seg.beatChunks.has(s)) continue;
      seg.beatChunks.set(s, await runBeatChunk(runner, seg.mel.data, seg.melFrames, s));
      n++;
    }
    return n;
  }

  coverage(): CoverageRange[] {
    return normalizeCoverage(this.segments.filter((s) => s.durationSec > 0).map((s) => ({ fromSec: s.startSec, toSec: s.endSec })));
  }

  coveredFraction(): number {
    if (!(this.durationSec > 0)) return 0;
    const heard = this.coverage().reduce((s, r) => s + Math.min(r.toSec, this.durationSec) - Math.max(0, r.fromSec), 0);
    return Math.max(0, Math.min(1, heard / this.durationSec));
  }
}

/**
 * Analyses what was heard so far: closes the open segment, then analyses a snapshot of
 * the segments that are closed at this moment. Audio that arrives during the awaits goes
 * to new segments, which this call neither iterates nor caches. Only closed (immutable)
 * segments are cached, so a cached result always covers its whole segment.
 */
export async function analyzeClosedSegments<T>(
  session: ListeningSession,
  cache: WeakMap<Segment, T>,
  analyze: (seg: Segment) => Promise<T>,
  minSec = 1,
): Promise<T[]> {
  session.breakSegment();
  session.extractReady(Number.MAX_SAFE_INTEGER, true);
  const snapshot = session.segments.filter((seg) => seg.closed && seg.durationSec >= minSec);
  const out: T[] = [];
  for (const seg of snapshot) {
    let a = cache.get(seg);
    if (!a) {
      a = await analyze(seg);
      cache.set(seg, a);
    }
    out.push(a);
  }
  return out;
}

/** One Beat This! chunk starting at frame `start` (may be negative), with border padding. */
export async function runBeatChunk(runner: ModelRunner, mel: Float32Array, frames: number, start: number): Promise<BeatLogits> {
  const nMels = MEL.nMels;
  const from = Math.max(start, 0);
  const to = Math.min(start + BEAT_CHUNK, frames);
  const left = Math.max(0, -start);
  const right = Math.max(0, Math.min(BEAT_BORDER, start + BEAT_CHUNK - frames));
  const len = left + (to - from) + right;
  const input = new Float32Array(len * nMels);
  input.set(mel.subarray(from * nMels, to * nMels), left * nMels);
  const out = await runner.run('spect', input, [1, len, nMels]);
  return { beat: out.beat, downbeat: out.downbeat };
}

/** Beat logits for a whole segment, reusing cached chunks (identical to a batch run). */
export async function segmentBeatLogits(runner: ModelRunner, seg: Segment): Promise<BeatLogits> {
  const frames = seg.melFrames;
  const beat = new Float32Array(frames).fill(-1000);
  const downbeat = new Float32Array(frames).fill(-1000);
  const starts = chunkStarts(frames);
  const results: { start: number; r: BeatLogits }[] = [];
  for (const start of starts) {
    const cached = seg.beatChunks.get(start);
    const full = start + BEAT_CHUNK <= frames;
    results.push({ start, r: cached && full ? cached : await runBeatChunk(runner, seg.mel.data, frames, start) });
  }
  for (let i = results.length - 1; i >= 0; i--) {
    const { start, r } = results[i];
    const inner = r.beat.length - 2 * BEAT_BORDER;
    for (let j = 0; j < inner; j++) {
      const f = start + BEAT_BORDER + j;
      if (f < 0 || f >= frames) continue;
      beat[f] = r.beat[BEAT_BORDER + j];
      downbeat[f] = r.downbeat[BEAT_BORDER + j];
    }
  }
  return { beat, downbeat };
}
