/**
 * Practice speed on www.youtube.com and music.youtube.com.
 *
 * YouTube's player keeps its own playback rate: setting only <video>.playbackRate plays at
 * the new speed, but the player (movie_player.getPlaybackRate(), the ⚙ menu) still says 1.
 * So the isolated content script asks the page (MAIN) world script to call the player's
 * setPlaybackRate, and sets the <video> rate itself only when that did not take effect.
 *
 * Messages are window.postMessage(…, location.origin) with the __vibeGuitar namespace.
 * The page world accepts only a practice rate and answers only ok and a fixed reason;
 * the isolated world treats that answer as untrusted (a page script can forge it), so it
 * checks the <video> rate itself before trusting it.
 * Pure logic (no DOM, no chrome APIs) so it can be unit-tested.
 */
import { isPracticeRate, type PracticeRate } from '../../play/practice';

export const RATE_REQUEST = 'yt-rate';
export const RATE_RESULT = 'yt-rate-result';
/** How long the isolated world waits for the page world (absent until the page reloads after an install). */
export const RATE_REPLY_TIMEOUT_MS = 300;

export interface RateRequest {
  __vibeGuitar: typeof RATE_REQUEST;
  seq: number;
  rate: PracticeRate;
}

export interface RateReply {
  __vibeGuitar: typeof RATE_RESULT;
  seq: number;
  ok: boolean;
  reason?: string;
}

/** The part of YouTube's player element this uses. */
export interface PagePlayer {
  setPlaybackRate?: (rate: number) => void;
}

/**
 * Page (MAIN) world: apply one request through the player's API.
 * Returns the reply to post, or null when the message is not a rate request (ignore it).
 */
export function handleRateRequest(data: unknown, findPlayer: () => PagePlayer | null): RateReply | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as { __vibeGuitar?: unknown; seq?: unknown; rate?: unknown };
  if (d.__vibeGuitar !== RATE_REQUEST || typeof d.seq !== 'number' || !Number.isSafeInteger(d.seq)) return null;
  const reply = (ok: boolean, reason?: string): RateReply => ({ __vibeGuitar: RATE_RESULT, seq: d.seq as number, ok, ...(reason ? { reason } : {}) });
  if (!isPracticeRate(d.rate)) return reply(false, 'unsupported rate');
  let player: PagePlayer | null = null;
  try {
    player = findPlayer();
  } catch {
    player = null;
  }
  if (!player || typeof player.setPlaybackRate !== 'function') return reply(false, 'player API not available');
  try {
    player.setPlaybackRate(d.rate);
  } catch {
    return reply(false, 'player API failed');
  }
  return reply(true);
}

/** Isolated world: read a reply from the page world. Only seq, ok and a short text reason are kept. */
export function parseRateReply(data: unknown): { seq: number; ok: boolean; reason?: string } | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as { __vibeGuitar?: unknown; seq?: unknown; ok?: unknown; reason?: unknown };
  if (d.__vibeGuitar !== RATE_RESULT || typeof d.seq !== 'number' || !Number.isSafeInteger(d.seq)) return null;
  const reason = typeof d.reason === 'string' ? d.reason.slice(0, 80) : undefined;
  return { seq: d.seq, ok: d.ok === true, ...(reason ? { reason } : {}) };
}

/**
 * Isolated world: set a practice rate. Asks the page's player first; when it did not answer
 * ok, or the <video> did not end up at the rate, sets the <video> rate directly.
 */
export async function applyPracticeRate(
  video: { playbackRate: number },
  rate: PracticeRate,
  viaPagePlayer: (rate: PracticeRate) => Promise<{ ok: boolean }>,
): Promise<'player-api' | 'video-element'> {
  let ok = false;
  try {
    ok = (await viaPagePlayer(rate)).ok;
  } catch {
    ok = false;
  }
  if (ok && Math.abs(video.playbackRate - rate) < 1e-3) return 'player-api';
  video.playbackRate = rate;
  return 'video-element';
}
