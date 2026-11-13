import { describe, expect, it } from 'vitest';
import {
  CAPTURE_OFF_STATUS,
  CAPTURED_TAB_HIDDEN,
  captureIsOff,
  capturedTabLabel,
  capturedTabOnReport,
  capturedTabOnUpdate,
  listenStatusText,
  type CapturedTab,
} from '../src/extension/sidepanel/capture-readout';

const recording = { analyzing: false, recordingAudio: true, idleReason: undefined };

describe('listening card once capture is off (캡처 중지)', () => {
  it('stopped and error are off; starting and running are on', () => {
    expect(captureIsOff('stopped')).toBe(true);
    expect(captureIsOff('error')).toBe(true);
    expect(captureIsOff('starting')).toBe(false);
    expect(captureIsOff('running')).toBe(false);
  });

  it('a stale "기록 중" or "분석 중" gives way to the capture-off status', () => {
    expect(listenStatusText(recording, true)).toBe(CAPTURE_OFF_STATUS);
    expect(listenStatusText({ ...recording, analyzing: true }, true)).toBe(CAPTURE_OFF_STATUS);
    expect(CAPTURE_OFF_STATUS).toBe('기록 멈춤: 캡처가 꺼졌어요 · 툴바 아이콘을 누르면 다시 켜져요');
  });

  it('while capturing, the status is what it was before', () => {
    expect(listenStatusText(recording, false)).toBe('기록 중');
    expect(listenStatusText({ ...recording, analyzing: true }, false)).toBe('분석 중… (곡 길이에 따라 수 초)');
    expect(listenStatusText({ analyzing: false, recordingAudio: false, idleReason: '일시정지' }, false)).toBe('기록 멈춤: 일시정지');
    expect(listenStatusText({ analyzing: false, recordingAudio: false }, false)).toBe('기록 멈춤: 오디오 대기');
  });
});

describe('captured tab address (대상 탭)', () => {
  const start = 'https://www.youtube.com/watch?v=aaaaaaaaaaa';
  const next = 'https://www.youtube.com/watch?v=bbbbbbbbbbb';

  it('takes the start address, then follows the tab to another video', () => {
    let t = capturedTabOnReport(null, { state: 'starting', tabId: 5, url: start });
    expect(capturedTabLabel(t)).toBe(start);
    t = capturedTabOnUpdate(t, 5, { url: next }, next);
    expect(capturedTabLabel(t)).toBe(next);
    // Stats and the stop report repeat the start address: they must not undo the update.
    t = capturedTabOnReport(t, { tabId: 5, url: start });
    t = capturedTabOnReport(t, { state: 'stopped', tabId: 5, url: start });
    expect(capturedTabLabel(t)).toBe(next);
  });

  it('a site the extension may not read shows a note instead of the old address', () => {
    const t = capturedTabOnUpdate({ id: 5, url: start }, 5, { status: 'loading' }, undefined);
    expect(capturedTabLabel(t)).toBe(CAPTURED_TAB_HIDDEN);
  });

  it('ignores other tabs and updates that are not navigation', () => {
    const t: CapturedTab = { id: 5, url: start };
    expect(capturedTabOnUpdate(t, 6, { url: next }, next)).toBe(t);
    expect(capturedTabOnUpdate(t, 5, { status: 'complete' }, start)).toBe(t);
    expect(capturedTabOnUpdate(t, 5, { status: 'loading' }, start)).toBe(t); // reload: same address
    expect(capturedTabOnUpdate(null, 5, { url: next }, next)).toBeNull();
  });

  it('a new capture (same tab or another) starts from its own start address', () => {
    const moved: CapturedTab = { id: 5, url: next };
    expect(capturedTabOnReport(moved, { state: 'starting', tabId: 5, url: start })).toEqual({ id: 5, url: start });
    expect(capturedTabOnReport(moved, { state: 'running', tabId: 9, url: 'https://music.youtube.com/' })).toEqual({ id: 9, url: 'https://music.youtube.com/' });
    expect(capturedTabOnReport(moved, { tabId: 9 })).toEqual({ id: 9, url: undefined }); // never another tab's address
  });

  it('a report without a tab keeps what is known', () => {
    const t: CapturedTab = { id: 5, url: start };
    expect(capturedTabOnReport(t, { state: 'error' })).toBe(t);
    expect(capturedTabLabel(null)).toBe('–');
  });
});
