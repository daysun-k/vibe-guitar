/**
 * Readouts of the 듣기·캡처 tab that depend on whether tab-audio capture is on, and the
 * captured tab's address. Pure logic (no DOM, no chrome APIs) so it can be unit-tested.
 */
import type { CaptureState, ListenStateMessage } from '../messages';

/** Listening card status once capture is off (stop button, tab closed, error). */
export const CAPTURE_OFF_STATUS = '기록 멈춤: 캡처가 꺼졌어요 · 툴바 아이콘을 누르면 다시 켜져요';
/** "오디오 수신" once capture is off. */
export const CAPTURE_OFF_RECEIVED = '아니요 (캡처 꺼짐)';
/** "대상 탭" when the captured tab moved to a site whose address the extension may not read. */
export const CAPTURED_TAB_HIDDEN = '다른 사이트 (권한 밖이라 주소는 표시하지 않아요)';

export function captureIsOff(state: CaptureState): boolean {
  return state === 'stopped' || state === 'error';
}

/** Status line of the listening card. */
export function listenStatusText(l: Pick<ListenStateMessage, 'analyzing' | 'recordingAudio' | 'idleReason'>, captureOff: boolean): string {
  if (captureOff) return CAPTURE_OFF_STATUS;
  if (l.analyzing) return '분석 중… (곡 길이에 따라 수 초)';
  return l.recordingAudio ? '기록 중' : `기록 멈춤: ${l.idleReason ?? '오디오 대기'}`;
}

/** The captured tab and its latest known address (undefined: not readable). */
export interface CapturedTab {
  id: number;
  url: string | undefined;
}

/**
 * After a capture-status or capture-stats report. A capture that starts (or runs) takes the
 * address it was started with; later reports of the same tab keep the address a tab update
 * refreshed, since the reports repeat the start address.
 */
export function capturedTabOnReport(prev: CapturedTab | null, msg: { state?: CaptureState; tabId?: number; url?: string }): CapturedTab | null {
  if (typeof msg.tabId !== 'number' || msg.tabId < 0) return prev;
  const starts = msg.state === 'starting' || msg.state === 'running';
  if (prev && prev.id === msg.tabId && !starts) return prev;
  return { id: msg.tabId, url: msg.url ?? (prev?.id === msg.tabId ? prev.url : undefined) };
}

/** After chrome.tabs.onUpdated: follow the captured tab to its new address. */
export function capturedTabOnUpdate(
  prev: CapturedTab | null,
  tabId: number,
  change: { url?: string; status?: string },
  tabUrl: string | undefined,
): CapturedTab | null {
  if (!prev || tabId !== prev.id) return prev;
  if (change.url === undefined && change.status !== 'loading') return prev;
  const url = change.url ?? tabUrl;
  return url === prev.url ? prev : { id: prev.id, url };
}

export function capturedTabLabel(tab: CapturedTab | null): string {
  if (!tab) return '–';
  return tab.url ?? CAPTURED_TAB_HIDDEN;
}
