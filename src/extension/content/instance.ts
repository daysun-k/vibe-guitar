/**
 * A content script can be injected twice into the same document: once by the manifest
 * and once by the reinjection sweep after an install or reload (see ../reinject.ts),
 * or again after a reload while the old copy is orphaned. The newest copy wins: it
 * aborts the previous copy, whose timers and listeners are tied to the returned signal.
 */
export function claimInstance(key: string, scope: Record<string, unknown> = globalThis as unknown as Record<string, unknown>): AbortSignal {
  const prev = scope[key];
  if (prev instanceof AbortController) prev.abort();
  const controller = new AbortController();
  scope[key] = controller;
  return controller.signal;
}

/** chrome.runtime.onMessage listener that is removed when the signal aborts. */
export function onRuntimeMessage(
  signal: AbortSignal,
  listener: (msg: never, sender: chrome.runtime.MessageSender, sendResponse: (r?: unknown) => void) => boolean | void,
): void {
  const l = listener as Parameters<typeof chrome.runtime.onMessage.addListener>[0];
  try {
    chrome.runtime.onMessage.addListener(l);
  } catch {
    return; // orphaned context
  }
  signal.addEventListener('abort', () => {
    try {
      chrome.runtime.onMessage.removeListener(l);
    } catch {
      // orphaned context: nothing to remove
    }
  });
}
