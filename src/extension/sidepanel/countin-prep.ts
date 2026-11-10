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
