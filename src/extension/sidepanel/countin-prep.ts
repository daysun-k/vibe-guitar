/**
 * Count-in preparation: pause the player, then seek to the bar start. Either step can be
 * cancelled while its reply is pending (tab switch, recording change, the user pressing
 * the button again). After every await the run must still be current, or nothing else may
 * happen: no further player command and no count-in overlay.
 */
import type { PlayerControlMessage, PlayerControlResult } from '../messages';

export type CountInPrep = { kind: 'ready' } | { kind: 'cancelled' } | { kind: 'failed'; step: 'pause' | 'seek'; reason?: string };

export async function prepareCountIn(
  send: (msg: PlayerControlMessage) => Promise<PlayerControlResult>,
  isCurrent: () => boolean,
  targetSec: number,
): Promise<CountInPrep> {
  const paused = await send({ type: 'player-control', action: 'pause' });
  if (!isCurrent()) return { kind: 'cancelled' };
  if (!paused.ok) return { kind: 'failed', step: 'pause', reason: paused.reason };
  const seek = await send({ type: 'player-control', action: 'seek', time: targetSec });
  if (!isCurrent()) return { kind: 'cancelled' };
  if (!seek.ok) return { kind: 'failed', step: 'seek', reason: seek.reason };
  return { kind: 'ready' };
}

export type CountInRun = { kind: 'played'; result: PlayerControlResult } | { kind: 'cancelled' } | { kind: 'rate-changed' };

/**
 * The count-in beats, then play. A speed change (the panel or the site's own menu) cancels it: the
 * beats were timed for the old rate. The rate and the run are checked before every beat and again
 * after the last wait, so a change reported during the last beat never lets the play command go out.
 */
export async function runCountIn(o: {
  beats: number;
  stepMs: number;
  startRate: number;
  rate: () => number;
  isCurrent: () => boolean;
  onBeat: (left: number, index: number) => void;
  play: () => Promise<PlayerControlResult>;
  wait?: (ms: number) => Promise<void>;
}): Promise<CountInRun> {
  const wait = o.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const stop = (): CountInRun | null => (!o.isCurrent() ? { kind: 'cancelled' } : o.rate() !== o.startRate ? { kind: 'rate-changed' } : null);
  for (let k = 0; k < o.beats; k++) {
    const s = stop();
    if (s) return s;
    o.onBeat(o.beats - k, k);
    await wait(o.stepMs);
  }
  const s = stop();
  if (s) return s;
  return { kind: 'played', result: await o.play() };
}
