/**
 * VGT-16: carrying out a command from the approved phone in the side panel.
 *
 * The phone's two commands go through the same handlers as the panel's own controls: play/pause is
 * the play button's togglePlay (count-in, loop start and pause-cancels-count-in included) and
 * "처음부터" is the same seek a bar click uses. The panel then waits until the player's reported
 * state shows the change (bounded by CONTROL_OBSERVE_MS) before it tells the phone, because the
 * content script answers before play/seek has actually happened, and a phone tap does not count as a
 * user gesture on the Mac's page: the browser's autoplay rule may keep the video paused.
 */
import { CONTROL_OBSERVE_MS, type CommandFailure, type CommandOutcome, type PhoneCommand } from '../../phone/protocol';
import type { PlayerControlResult } from '../messages';

/** What the panel currently observes about its player (demo clock or the content script's reports). */
export interface ObservedPlayer {
  playing(): boolean;
  countingIn(): boolean;
  /** Song position in seconds (no sync offset). */
  position(): number;
  rate(): number;
  isAd(): boolean;
  /** A song is shown and the player it plays in may be controlled from this panel. */
  hasTarget(): boolean;
}

export type TransportResult = PlayerControlResult & { cancelled?: boolean };

/** The panel's own handlers. */
export interface PanelTransport {
  /** The play button. `onCountIn` runs when a count-in starts. Resolves when the handler is done. */
  toggle(onCountIn: () => void): Promise<TransportResult>;
  /** The bar-click seek (cancels a count-in). */
  seek(sec: number): Promise<PlayerControlResult>;
  /** Where 처음부터 goes, or null when there is nowhere to go. */
  restartTarget(): number | null;
  /** Cancels the count-in this command started (never one started from the panel), so it never plays. */
  cancelCountIn(): void;
}

export interface RunOptions {
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

/** A seek landed this close before its target counts (players round to frames). */
const SEEK_EARLY_SEC = 0.35;
/** ... and this far after it, plus what playback at the real rate covers meanwhile. */
const SEEK_LATE_SEC = 0.6;

/** Pauses the player if it plays (e.g. started on the Mac during a count-in) and reports what it shows. */
async function settlePaused(player: ObservedPlayer, transport: PanelTransport, observeMs: number, pollMs: number, now: () => number, sleep: (ms: number) => Promise<void>): Promise<CommandOutcome> {
  if (!player.playing()) return { ok: true, state: 'paused' };
  const r = await transport.toggle(() => {});
  if (!r.ok) return fail('failed');
  return (await waitUntil(() => !player.playing(), observeMs, pollMs, now, sleep)) ? { ok: true, state: 'paused' } : fail('timeout');
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
  if (player.isAd()) return fail('ad');
  if (!player.hasTarget()) return fail('no-target');

  if (cmd === 'toggle') {
    // Pause during a count-in cancels it. The player itself may still play (started on the Mac
    // meanwhile): then it is paused as well, and only an observed pause is reported.
    if (player.countingIn()) {
      await transport.toggle(() => {});
      return settlePaused(player, transport, observeMs, pollMs, now, sleep);
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
        // Lost the right to control while the count-in was being prepared: cancel it at once.
        if (o.signal?.aborted) return transport.cancelCountIn();
        o.progress?.({ ok: true, state: 'countin' });
      });
    } finally {
      o.signal?.removeEventListener('abort', onAbort);
    }
    if (r.cancelled) return { ok: true, state: player.playing() ? 'playing' : 'paused' };
    if (!r.ok) return fail('failed');
    if (await waitUntil(() => player.playing() === want, observeMs, pollMs, now, sleep)) return { ok: true, state: want ? 'playing' : 'paused' };
    return fail(want ? 'autoplay' : 'timeout');
  }

  const target = transport.restartTarget();
  if (target === null) return fail('no-target');
  const r = await transport.seek(target);
  if (!r.ok) return fail('failed');
  const t0 = now();
  // Landed: the position is near the target, allowing only for what playback at the real rate
  // covered since the seek. A seek that was accepted but never applied keeps the old position, which
  // moves at the same rate as this window and so never falls into it.
  const landed = () => {
    const p = player.position();
    const moved = player.playing() ? (Math.max(0, player.rate()) * (now() - t0)) / 1000 : 0;
    return p >= target - SEEK_EARLY_SEC && p <= target + SEEK_LATE_SEC + moved;
  };
  if (await waitUntil(landed, observeMs, pollMs, now, sleep)) return { ok: true, state: player.playing() ? 'playing' : 'paused' };
  return fail('timeout');
}
