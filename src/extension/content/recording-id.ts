/**
 * Which recording id to report for YouTube / YouTube Music.
 *
 * YouTube Music can play a different recording than the `v=` of its URL (e.g. the
 * song version "Perfect Duet" while the URL id is a lyric video). The page's own
 * player (`movie_player.getVideoData().video_id`, read in the MAIN world) knows
 * what is actually playing, so it wins when fresh; the URL id is a flagged fallback.
 */

export type RecordingIdSource = 'player' | 'url' | 'player-bar';

export interface PlayerVideoData {
  videoId: string;
  title: string;
  author: string;
  /** Date.now() when the MAIN-world script read it. */
  sampledAt: number;
}

export interface RecordingIdInput {
  urlId: string | null;
  playerBarId: string | null;
  player: PlayerVideoData | null;
  isAd: boolean;
  /** Id chosen on the previous tick (kept during ads). */
  previous: RecordingIdChoice | null;
  now: number;
}

export interface RecordingIdChoice {
  id: string;
  source: RecordingIdSource;
  /** The URL id when it differs from the id of what is playing. */
  urlIdMismatch?: string;
  /** Title/artist from the player when source is 'player'. */
  title?: string;
  artist?: string;
}

/** Player data older than this is ignored (MAIN script posts every 250 ms). */
export const PLAYER_DATA_MAX_AGE_MS = 2000;

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

export function isVideoId(id: unknown): id is string {
  return typeof id === 'string' && VIDEO_ID.test(id);
}

export function chooseRecordingId(input: RecordingIdInput): RecordingIdChoice | null {
  // During an ad the player may describe the ad video; keep the song we had.
  if (input.isAd && input.previous) return input.previous;
  const p = input.player;
  const fresh = p && input.now - p.sampledAt <= PLAYER_DATA_MAX_AGE_MS && isVideoId(p.videoId);
  if (fresh && p && !input.isAd) {
    const choice: RecordingIdChoice = { id: p.videoId, source: 'player', title: p.title, artist: p.author };
    if (input.urlId && input.urlId !== p.videoId) choice.urlIdMismatch = input.urlId;
    return choice;
  }
  if (input.urlId) return { id: input.urlId, source: 'url' };
  if (input.playerBarId) return { id: input.playerBarId, source: 'player-bar' };
  return null;
}
