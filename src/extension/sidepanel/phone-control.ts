/**
 * VGT-16: carrying out a command from the approved phone in the side panel.
 *
 * The phone's two commands go through the same handlers as the panel's own controls: play/pause is
 * the play button's togglePlay (count-in, loop start and pause-cancels-count-in included) and
 * "처음부터" is the same seek a bar click uses. The panel then waits until the player's reported
 * state shows the change (bounded by CONTROL_OBSERVE_MS) before it tells the phone, because the
 * content script answers before play/seek has actually happened, and a phone tap does not count as a
 * user gesture on the Mac's page: the browser's autoplay rule may keep the video paused.
 *
 * Context gate: one predicate, checked when the command starts and again immediately before every
 * player command and count-in start the command causes. It holds only while
 *   - the phone still holds the grant the command came with (else `cancelled`),
 *   - the command's song revision is still the one published to phones (else `stale`),
 *   - the panel's player target (song, tab, recording) is still the one that revision was published
 *     for, so a player that changed before the panel published the new song is never reached (else
 *     `stale`; at the start, no target at all is `no-target`),
 *   - no ad is playing (else `ad`).
 * Once it fails nothing further is sent, and the phone (if still connected) gets that code.
 */
import { CONTROL_OBSERVE_MS, type CommandFailure, type CommandOutcome, type PhoneCommand } from '../../phone/protocol';
import type { PlayerControlResult } from '../messages';
import type { TransportResult } from './play-toggle';

/** What the panel currently observes about its player (demo clock or the content script's reports). */
export interface ObservedPlayer {
  playing(): boolean;
  countingIn(): boolean;
  /** Song position in seconds (no sync offset). */
  position(): number;
  rate(): number;
  isAd(): boolean;
  /**
   * Which song and player commands would act on right now (demo, or tab + recording + chart), or null
   * when no song is shown or its player may not be controlled from this panel.
   */
  target(): string | null;
}

export type { TransportResult };

/** The panel's own handlers. */
export interface PanelTransport {
  /**
   * The play button. `onCountIn` runs when a count-in starts. `allowed` is checked immediately before
   * every player command and the count-in start; once false, nothing more is sent (`cancelled`).
   * Resolves when the handler is done.
   */
  toggle(onCountIn: () => void, allowed: () => boolean): Promise<TransportResult>;
  /** The bar-click seek (cancels a count-in). Sends synchronously: the caller checks the gate first. */
  seek(sec: number): Promise<PlayerControlResult>;
  /** Where 처음부터 goes, or null when there is nowhere to go. */
  restartTarget(): number | null;
  /** Cancels the count-in this command started (never one started from the panel), so it never plays. */
  cancelCountIn(): void;
}

/** What PhoneLink knows about a command it hands over: its grant and the song revision it was sent for. */
export interface CommandContext {
  /** `cancelled` once the grant the command came with ended, `stale` once its revision is no longer the one published; else null. */
  check(): CommandFailure | null;
  /** The player target the command's revision was published for (null: published with no song). */
  readonly target: string | null;
}

export interface RunOptions {
  /**
   * The command's grant and published revision. Without it (tests of the steps alone), the target seen
   * when the command starts is the one it is bound to.
   */
  context?: CommandContext;
  /** Progress before the final outcome (the count-in started). */
  progress?: (o: CommandOutcome) => void;
  /**
   * Aborted when the phone loses the right to control (switch off, 승인 해제, phone or relay gone, panel
   * replaced): a count-in this command started is cancelled and its play never happens.
   */
  signal?: AbortSignal;
  observeMs?: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const fail = (code: CommandFailure): CommandOutcome => ({ ok: false, code });

/** The AbortSignal reason PhoneLink uses when the song the phone saw changed. */
export const SONG_CHANGED: CommandFailure = 'stale';

/** A seek landed this close before its target counts (players round to frames). */
export const SEEK_EARLY_SEC = 0.35;
/** ... and at most this far after it (observed, never extrapolated from the rate). */
export const SEEK_LATE_SEC = 0.6;
/** Consecutive observations inside that window needed before 처음부터 counts as done. */
const LANDED_SAMPLES = 2;

/** Pauses the player if it plays (e.g. started on the Mac during a count-in) and reports what it shows. */
async function settlePaused(player: ObservedPlayer, transport: PanelTransport, g: Gate, observeMs: number, pollMs: number, now: () => number, sleep: (ms: number) => Promise<void>): Promise<CommandOutcome> {
  if (!player.playing()) return { ok: true, state: 'paused' };
  const r = await transport.toggle(() => {}, g.allowed);
  if (r.cancelled) return g.refused();
  if (!r.ok) return fail('failed');
  if (await waitUntil(() => g.moved() || !player.playing(), observeMs, pollMs, now, sleep)) return g.moved() ? fail('stale') : { ok: true, state: 'paused' };
  return fail('timeout');
}

interface Gate {
  /** Why the context gate (see the file comment) fails right now, or null while it holds. */
  why: () => CommandFailure | null;
  /** The gate holds. */
  allowed: () => boolean;
  /** The song or player target changed since the command started (what is observed is another song's). */
  moved: () => boolean;
  /** The failure to report once the gate failed. */
  refused: () => CommandOutcome;
  /** The target the command is bound to. */
  target: string | null;
}

function gate(player: ObservedPlayer, signal: AbortSignal | undefined, context: CommandContext | undefined): Gate {
  const target = context ? context.target : player.target();
  // A song or target change wins over a lost grant: what is observed now is another song's.
  const why = (): CommandFailure | null => {
    const c = context?.check() ?? null;
    if (c === 'stale' || (signal?.aborted && signal.reason === SONG_CHANGED) || player.target() !== target) return 'stale';
    if (c) return c;
    if (signal?.aborted) return 'cancelled';
    if (player.isAd()) return 'ad';
    return null;
  };
  return {
    why,
    allowed: () => why() === null,
    moved: () => why() === 'stale',
    refused: () => fail(why() ?? 'cancelled'),
    target,
  };
}

/** Polls `pred` until it holds or `ms` passed. */
export async function waitUntil(pred: () => boolean, ms: number, pollMs: number, now: () => number, sleep: (ms: number) => Promise<void>): Promise<boolean> {
  const end = now() + ms;
  for (;;) {
    if (pred()) return true;
    if (now() >= end) return false;
    await sleep(pollMs);
  }
}

/**
 * Where 처음부터 goes: the loop's A (`loopStartSec`, already the bar-click target) when a loop
 * exists, otherwise the start of the bar under `position` (0 before the first bar). Null without bars.
 */
export function restartTargetSec(loopStartSec: number | null, bars: readonly { startSec: number }[], position: number): number | null {
  if (loopStartSec !== null) return Math.max(0, loopStartSec);
  if (!bars.length) return null;
  let at = -1;
  for (let i = 0; i < bars.length; i++) if (bars[i]!.startSec <= position + 1e-6) at = i;
  return at >= 0 ? Math.max(0, bars[at]!.startSec) : 0;
}

export async function runPhoneCommand(cmd: PhoneCommand, player: ObservedPlayer, transport: PanelTransport, o: RunOptions = {}): Promise<CommandOutcome> {
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const observeMs = o.observeMs ?? CONTROL_OBSERVE_MS;
  const pollMs = o.pollMs ?? 50;
  const g = gate(player, o.signal, o.context);
  const { allowed } = g;
  if (!allowed()) return g.refused();
  if (g.target === null) return fail('no-target');

  if (cmd === 'toggle') {
    // Pause during a count-in cancels it. The player itself may still play (started on the Mac
    // meanwhile): then it is paused as well, and only an observed pause is reported.
    if (player.countingIn()) {
      await transport.toggle(() => {}, allowed);
      return settlePaused(player, transport, g, observeMs, pollMs, now, sleep);
    }
    const want = !player.playing();
    let countIn = false;
    const onAbort = () => {
      if (countIn) transport.cancelCountIn();
    };
    o.signal?.addEventListener('abort', onAbort, { once: true });
    let r: TransportResult;
    try {
      r = await transport.toggle(() => {
        countIn = true;
        // The gate passed just before the count-in started; checked again in case that changes.
        if (!allowed()) return transport.cancelCountIn();
        o.progress?.({ ok: true, state: 'countin' });
      }, allowed);
    } finally {
      o.signal?.removeEventListener('abort', onAbort);
    }
    if (r.cancelled) return allowed() ? { ok: true, state: player.playing() ? 'playing' : 'paused' } : g.refused();
    if (!r.ok) return fail('failed');
    if (await waitUntil(() => g.moved() || player.playing() === want, observeMs, pollMs, now, sleep)) return g.moved() ? fail('stale') : { ok: true, state: want ? 'playing' : 'paused' };
    return fail(want ? 'autoplay' : 'timeout');
  }

  const target = transport.restartTarget();
  if (target === null) return fail('no-target');
  // seek() sends synchronously, so this is the check immediately before the seek goes out.
  if (!allowed()) return g.refused();
  const r = await transport.seek(target);
  if (!r.ok) return fail('failed');
  const landed = landedAt(target, player);
  if (await waitUntil(() => g.moved() || landed(), observeMs, pollMs, now, sleep)) return g.moved() ? fail('stale') : { ok: true, state: player.playing() ? 'playing' : 'paused' };
  return fail('timeout');
}

/**
 * 처음부터 counts as done only once the observed position is inside [target - SEEK_EARLY_SEC,
 * target + SEEK_LATE_SEC] in LANDED_SAMPLES consecutive observations. Nothing is extrapolated from
 * the rate or the elapsed time, so a seek that was accepted but never applied (the old position keeps
 * moving away from the target) never counts. A rate change between observations starts the count
 * over from fresh observations.
 */
export function landedAt(target: number, player: Pick<ObservedPlayer, 'position' | 'rate'>): () => boolean {
  let streak = 0;
  let rate = player.rate();
  return () => {
    const r = player.rate();
    if (r !== rate) {
      rate = r;
      streak = 0;
      return false;
    }
    const p = player.position();
    streak = p >= target - SEEK_EARLY_SEC && p <= target + SEEK_LATE_SEC ? streak + 1 : 0;
    return streak >= LANDED_SAMPLES;
  };
}
