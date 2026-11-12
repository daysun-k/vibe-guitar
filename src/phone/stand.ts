/**
 * Phone music stand page, the parts of its view that are plain rules (no DOM), so they are unit tested:
 * the current bar's beat segments (as the side panel's lane cell draws them), the single status line
 * that is shown only when something needs attention, and the play/pause button's look.
 */

/**
 * Beat segments of the current bar: one per big beat (`bigPerBar`, as the lane cell's ticks), filled up
 * to and including the big beat under the playhead (the lane cell's `i <= bigInBar`). Outside every bar
 * (`bar < 0`) none is filled.
 */
export function beatSegments(bigPerBar: number, bar: number, bigInBar: number): { total: number; filled: number } {
  const total = Math.max(1, Math.min(16, Math.round(bigPerBar) || 1));
  const filled = bar < 0 ? 0 : Math.max(0, Math.min(total, Math.floor(bigInBar) + 1));
  return { total, filled };
}

export interface StatusInput {
  /** The stand shows a song (connected, panel on, chart present); otherwise the waiting screen says why. */
  ready: boolean;
  /** Position anchors arrive and the clock is measured. */
  live: boolean;
  ad: boolean;
  /** Latest command message still within its few seconds (empty text: none). */
  message: { text: string; alert: boolean };
}

export const AD_TEXT = '광고 중 · 광고가 끝나면 이어서 보여 줘요';
export const NO_POSITION_TEXT = '재생 위치를 받는 중';

/**
 * The status line, or null to hide it. In the normal connected state it is hidden: no song title,
 * no "Mac과 연결됨", no 일시정지 (the play button shows that). It appears for a recent command message
 * (a failure, the count-in, a revoked approval), during an ad, and while no position arrives. Not ready
 * (connecting, reconnecting, panel off, no song) is said by the waiting screen instead.
 */
export function statusLine(i: StatusInput): { text: string; alert: boolean } | null {
  if (!i.ready) return null;
  if (i.message.text) return { text: i.message.text, alert: i.message.alert };
  if (i.ad) return { text: AD_TEXT, alert: true };
  if (!i.live) return { text: NO_POSITION_TEXT, alert: false };
  return null;
}

/**
 * The play/pause button: the pause icon while the song plays or a count-in runs (tapping stops it), the
 * play icon otherwise. Its label says what a tap does.
 */
export function toggleLook(playing: boolean, countin: boolean): { pause: boolean; label: string } {
  const pause = playing || countin;
  return { pause, label: pause ? '일시정지' : '재생' };
}
