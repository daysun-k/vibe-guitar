/**
 * Service worker: opens the side panel and starts the tab-capture spike on the
 * action click; relays keyboard commands to the side panel.
 */
import type { AutoChartSavedMessage, CaptureStartMessage, CaptureStatusMessage, CommandMessage, ExtensionMessage } from './messages';
import { handleChartWrite, serviceWorkerChartStore } from './storage';
import { reinjectContentScripts } from './reinject';
import { LyricsService } from './lyrics-service';

const OFFSCREEN_URL = 'offscreen.html';

// Lyrics: the only off-device request. Sends title, artist and duration to lrclib.net,
// once per recording, and only when the side panel's "가사 가져오기" setting is on.
const lyricsService = new LyricsService(
  {
    get: (keys) => chrome.storage.local.get(keys) as Promise<Record<string, unknown>>,
    set: (items) => chrome.storage.local.set(items),
  },
  (url, init) => fetch(url, { ...init, credentials: 'omit', cache: 'no-store' }),
  () => new Date(),
  // Re-read the setting right before every request: the panel's flag may be stale.
  async () => {
    const r = await chrome.storage.local.get('settings');
    return (r.settings as { fetchLyrics?: boolean } | undefined)?.fetchLyrics !== false;
  },
);
chrome.storage.onChanged.addListener((changes, area) => {
  const next = changes.settings?.newValue as { fetchLyrics?: boolean } | undefined;
  if (area === 'local' && changes.settings && next?.fetchLyrics === false) lyricsService.abortAll();
});

chrome.runtime.onInstalled.addListener((details) => {
  // We open the panel ourselves so that action.onClicked still fires (needed for tabCapture).
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => undefined);
  // Reconnect tabs that were already open when the extension was installed or reloaded.
  void reinjectContentScripts(details.reason).catch((e: unknown) => console.warn('reinject failed', e));
});

function broadcast(msg: ExtensionMessage): void {
  chrome.runtime.sendMessage(msg).catch(() => undefined);
}

async function ensureOffscreen(): Promise<void> {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)],
  });
  if (contexts.length > 0) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: [chrome.offscreen.Reason.USER_MEDIA],
    justification: 'Play captured tab audio back to the speakers and measure level/chroma locally (no audio leaves the browser).',
  });
}

/** The offscreen listener may not be registered the instant createDocument resolves; retry briefly. */
async function sendToOffscreen(msg: CaptureStartMessage): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      await chrome.runtime.sendMessage(msg);
      return;
    } catch (e) {
      lastError = e;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function startCapture(tab: chrome.tabs.Tab): Promise<void> {
  if (tab.id === undefined) return;
  const status: CaptureStatusMessage = { type: 'capture-status', state: 'starting', tabId: tab.id, url: tab.url };
  broadcast(status);
  try {
    // Only valid right after the user invoked the extension on this tab.
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
    await ensureOffscreen();
    const start: CaptureStartMessage = { type: 'capture-start', target: 'offscreen', streamId, tabId: tab.id, url: tab.url };
    await sendToOffscreen(start);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    broadcast({ type: 'capture-status', state: 'error', tabId: tab.id, url: tab.url, error: msg });
  }
}

chrome.action.onClicked.addListener((tab) => {
  // sidePanel.open must run synchronously inside the user gesture.
  if (tab.windowId !== undefined) {
    chrome.sidePanel.open({ windowId: tab.windowId }).catch((e: unknown) => console.warn('sidePanel.open failed', e));
  }
  void startCapture(tab);
});

chrome.commands.onCommand.addListener((command) => {
  if (command === 'stamp-chord' || command === 'tap-tempo') {
    const msg: CommandMessage = { type: 'command', command };
    broadcast(msg);
  }
});

// Every chart write runs here, one at a time (ChartStore): manual saves and adoption from
// the side panel, auto charts from listening mode (the offscreen document cannot use
// chrome.storage).
chrome.runtime.onMessage.addListener((msg: ExtensionMessage, _sender, sendResponse) => {
  if (msg.type === 'lyrics-get') {
    void lyricsService.get(msg).then(sendResponse);
    return true;
  }
  if (msg.type === 'chart-write') {
    void handleChartWrite(serviceWorkerChartStore(), msg).then(sendResponse);
    return true; // reply asynchronously
  }
  if (msg.type !== 'auto-chart') return;
  const recordingKey = `${msg.chart.recording.source}:${msg.chart.recording.id}`;
  serviceWorkerChartStore()
    .saveAuto(msg.chart)
    .then((savedAs) => broadcast({ type: 'auto-chart-saved', recordingKey, savedAs } satisfies AutoChartSavedMessage))
    .catch((e: unknown) => broadcast({ type: 'auto-chart-saved', recordingKey, savedAs: 'pending', error: e instanceof Error ? e.message : String(e) }));
});
