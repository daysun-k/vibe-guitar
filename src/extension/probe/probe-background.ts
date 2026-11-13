/**
 * Latency-probe build only: 'recapture' from the probe page stops tab capture and starts a
 * fresh one (new AudioContext, new placer) on the same tab, so several capture sessions
 * can be measured after one toolbar click. Relies on the activeTab grant from that click,
 * which lasts until the tab navigates; if Chrome refuses, the reply says so and a new
 * toolbar click starts the next session instead.
 */
import type { ProbeReply, ProbeRequestMessage } from './messages';

export function installLatencyProbeBackground(startCapture: (tab: chrome.tabs.Tab) => Promise<string | null>): void {
  chrome.runtime.onMessage.addListener((msg: ProbeRequestMessage, sender, sendResponse) => {
    if (msg?.type !== 'probe-request' || msg.target !== 'background' || msg.op !== 'recapture') return;
    const tab = sender.tab;
    if (!tab?.id) {
      sendResponse({ ok: false, error: 'recapture must come from the probe tab' } satisfies ProbeReply);
      return;
    }
    void (async () => {
      await chrome.runtime.sendMessage({ type: 'capture-stop', target: 'offscreen' }).catch(() => undefined);
      // The offscreen document stops its tracks asynchronously; a tab with a live capture
      // cannot be captured again.
      await new Promise((r) => setTimeout(r, 500));
      const error = await startCapture(tab);
      sendResponse((error ? { ok: false, error } : { ok: true, data: { tabId: tab.id } }) satisfies ProbeReply);
    })();
    return true;
  });
}
