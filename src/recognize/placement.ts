/**
 * Places captured audio blocks on the playback timeline by sample time, not by the time a
 * block message happened to arrive. The capture worklet stamps each block with the
 * AudioContext frame of its last sample; player reports are converted to AudioContext
 * time when they arrive (anchors). A block is placed with the anchor that was in effect
 * when it was captured, so late or bunched delivery does not move it, and pause, seek,
 * ad and track-change boundaries apply at the right block.
 * Pure logic (no browser APIs) so it can be unit-tested.
 */
import { MODEL_SAMPLE_RATE } from '../audio/features';
import { StreamingResampler } from '../audio/resample';
import { CONTINUITY_TOLERANCE_SEC, type ListeningSession } from './session';

/** A player report mapped to AudioContext time. */
export interface PlayerAnchor {
  /** AudioContext time (s) at which the player was at `position`. */
  ctxTime: number;
  /** "source:id" of the recording, or null when unknown. */
  key: string | null;
  position: number;
  paused: boolean;
  rate: number;
  isAd: boolean;
}

/** The fields of a player report that placement needs (PlayerStateMessage has them). */
export interface PlayerReport {
  currentTime: number;
  paused: boolean;
  playbackRate: number;
  isAd: boolean;
  /** Date.now() when currentTime was read. */
  sampledAt: number;
}

/**
 * Maps a player report to AudioContext time. `clock` is an AudioContext time and a
 * Date.now() read together when the report arrived, so a late report keeps its own time.
 */
export function anchorFromPlayerState(p: PlayerReport, key: string | null, clock: { ctxTime: number; epochMs: number }): PlayerAnchor {
  return {
    ctxTime: clock.ctxTime - (clock.epochMs - p.sampledAt) / 1000,
    key,
    position: p.currentTime,
    paused: p.paused,
    rate: p.playbackRate,
    isAd: p.isAd,
  };
}

/** Audio is not stored when the latest player report is older than this. */
export const STALE_ANCHOR_SEC = 3;
/** A block waits at most this long for a player report that may cover its time. */
export const HOLD_SEC = 0.5;
const MAX_ANCHORS = 2000;

export const WAITING_FOR_PLAYER = '플레이어 정보를 기다리는 중';

/** Why audio captured at `atCtx` should not be stored under this anchor (null = store it). */
export function anchorIdleReason(a: PlayerAnchor | null, atCtx: number): string | null {
  if (!a) return WAITING_FOR_PLAYER;
  if (!a.key) return '곡 ID를 찾지 못함';
  if (atCtx - a.ctxTime > STALE_ANCHOR_SEC) return '플레이어 정보가 끊김';
  if (a.isAd) return '광고 중';
  if (a.paused) return '일시정지';
  if (a.rate !== 1) return `재생 속도 ${a.rate}x (1x에서만 기록)`;
  return null;
}

/** Player position at AudioContext time `ctxTime`, extrapolated from the anchor. */
export function anchorPosition(a: PlayerAnchor, ctxTime: number): number {
  return a.paused ? a.position : a.position + (ctxTime - a.ctxTime) * a.rate;
}

interface Block {
  samples: Float32Array;
  /** Capture sample rate (= AudioContext rate). */
  rate: number;
  /** AudioContext frame just after the block's last sample. */
  endFrame: number;
}

export class AudioPlacer {
  private anchors: PlayerAnchor[] = [];
  private queue: Block[] = [];
  private resampler: StreamingResampler | null = null;
  private lastEndFrame = -1;
  private lastRate = 0;
  private lastSession: ListeningSession | null = null;
  /** Why the most recent block was not stored (null = it was stored). */
  idleReason: string | null = WAITING_FOR_PLAYER;

  constructor(private readonly latencySec: number) {}

  addAnchor(a: PlayerAnchor): void {
    let i = this.anchors.length;
    while (i > 0 && this.anchors[i - 1].ctxTime > a.ctxTime) i--;
    this.anchors.splice(i, 0, a);
    if (this.anchors.length > MAX_ANCHORS) this.anchors.splice(0, this.anchors.length - MAX_ANCHORS);
  }

  pushBlock(samples: Float32Array, rate: number, endFrame: number): void {
    this.queue.push({ samples, rate, endFrame });
  }

  get pendingBlocks(): number {
    return this.queue.length;
  }

  /**
   * Places queued blocks, in capture order, once their player state is known: when a
   * report at or after the block's end exists, or the block is older than HOLD_SEC at
   * AudioContext time `nowCtx`. `sessionFor` returns the session for a recording key, or
   * null when that recording has no session (the block is dropped).
   */
  drain(nowCtx: number, sessionFor: (key: string) => ListeningSession | null): void {
    const newest = this.anchors.length ? this.anchors[this.anchors.length - 1].ctxTime : -Infinity;
    while (this.queue.length) {
      const b = this.queue[0];
      const end = b.endFrame / b.rate;
      if (end > newest && end > nowCtx - HOLD_SEC) break;
      this.queue.shift();
      this.place(b, sessionFor);
    }
    this.prune();
  }

  /** Drops queued audio and the resampler state (capture stopped). */
  reset(): void {
    this.queue = [];
    this.anchors = [];
    this.breakRun();
    this.lastEndFrame = -1;
    this.lastRate = 0;
    this.lastSession = null;
    this.idleReason = WAITING_FOR_PLAYER;
  }

  private anchorAt(ctxTime: number): PlayerAnchor | null {
    let found: PlayerAnchor | null = null;
    for (const a of this.anchors) {
      if (a.ctxTime <= ctxTime + 1e-9) found = a;
      else break;
    }
    return found;
  }

  private breakRun(): void {
    this.lastSession?.breakSegment();
    this.resampler = null;
  }

  private place(b: Block, sessionFor: (key: string) => ListeningSession | null): void {
    const startFrame = b.endFrame - b.samples.length;
    const contiguous = startFrame === this.lastEndFrame;
    this.lastEndFrame = b.endFrame;
    this.lastRate = b.rate;
    const start = startFrame / b.rate;
    const end = b.endFrame / b.rate;
    const a0 = this.anchorAt(start);
    const a1 = this.anchorAt(end);
    let reason = anchorIdleReason(a1, end) ?? anchorIdleReason(a0, start);
    if (!reason && a0!.key !== a1!.key) reason = '곡이 바뀌는 중';
    // A seek inside the block: the two reports disagree about where the block ends.
    if (!reason && Math.abs(anchorPosition(a0!, end) - anchorPosition(a1!, end)) > CONTINUITY_TOLERANCE_SEC) reason = '재생 위치 이동 중';
    const session = reason ? null : sessionFor(a1!.key!);
    if (!reason && !session) reason = '곡이 바뀌는 중';
    if (reason || !session) {
      this.idleReason = reason;
      this.breakRun();
      return;
    }
    if (session !== this.lastSession || !contiguous || !this.resampler || this.resampler.fromRate !== b.rate) {
      this.breakRun();
      session.breakSegment();
      this.resampler = new StreamingResampler(b.rate, MODEL_SAMPLE_RATE);
      this.lastSession = session;
    }
    session.append(this.resampler.push(b.samples), anchorPosition(a1!, end) - this.latencySec);
    this.idleReason = session.full ? '저장 한도(20분)에 도달' : null;
  }

  /** Keeps the anchors still needed to place queued (or future) blocks. */
  private prune(): void {
    const b = this.queue[0];
    const need = b ? (b.endFrame - b.samples.length) / b.rate : this.lastRate ? this.lastEndFrame / this.lastRate : -Infinity;
    while (this.anchors.length > 1 && this.anchors[1].ctxTime <= need) this.anchors.shift();
  }
}
