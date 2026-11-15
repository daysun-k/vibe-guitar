import { slashChordHTML } from '../extension/sidepanel/chord-name';
import type { CommandFailure, CommandOutcome } from './protocol';

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

/** Screen-reader wording of the phone's "?" (the stand never names the second choice). */
export const UNCERTAIN_LABEL = '확실하지 않아요';

/**
 * A chord name as the stand draws it: the slash bass smaller and, for a chord holding an uncertain
 * stretch (VGT-19), a small quiet "?" after it, as the side panel's lane does. The "?" sits inside the
 * name so fitting the name to its box shrinks it too.
 */
export function chordNameHTML(name: string, uncertain: boolean): string {
  return slashChordHTML(name) + (uncertain ? `<i class="unc-q" role="img" aria-label="${UNCERTAIN_LABEL}">?</i>` : '');
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

/**
 * What the status line says for a failed command. It may wrap to three lines on a narrow phone; where
 * the reader has something to do, that comes first, so it is read even if the rest is cut.
 */
export const FAILURE_TEXT: Record<CommandFailure, string> = {
  off: 'Mac 패널에서 휴대폰 조작이 꺼져 있어요',
  'not-approved': 'Mac 패널에서 이 휴대폰을 먼저 승인해 주세요',
  stale: '곡이 바뀌었어요 · 다시 눌러 주세요',
  duplicate: '이미 보낸 요청이에요',
  rate: '잠시 뒤에 다시 눌러 주세요 · 너무 빨리 눌렀어요',
  ad: '광고 중에는 조작할 수 없어요',
  'no-target': 'Mac에서 조작할 곡이나 플레이어를 찾지 못했어요',
  busy: 'Mac이 앞 요청을 처리하는 중이에요',
  autoplay: '맥에서 한 번 재생을 눌러 주세요 · Mac 브라우저가 재생을 막았어요',
  timeout: 'Mac 화면을 확인해 주세요 · 바뀐 것을 확인하지 못했어요',
  failed: 'Mac에서 실행하지 못했어요',
  cancelled: '조작 권한이 바뀌어서 취소했어요',
  'last-bar': '마지막 마디예요 · 더 갈 마디가 없어요',
  'no-panel': 'Mac 패널이 연결되어 있지 않아요',
};

export const LOOP_LAST_BAR_TEXT = '구간 반복의 마지막 마디예요';
export const COUNTIN_TEXT = '카운트인 뒤에 재생해요 · 한 번 더 누르면 멈춰요';

/**
 * Korean message for an outcome, or '' when there is nothing to say: a success shows on the stand
 * itself (the play button's icon, the bar's progress), so only failures and the count-in are said.
 * `loop`: an A/B loop is set (the last bar is then the loop's).
 */
export function outcomeText(o: CommandOutcome, loop: boolean): string {
  if (!o.ok && o.code === 'last-bar' && loop) return LOOP_LAST_BAR_TEXT;
  if (!o.ok) return FAILURE_TEXT[o.code];
  if (o.state === 'countin') return COUNTIN_TEXT;
  return '';
}
