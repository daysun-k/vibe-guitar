/**
 * Latency-probe build only: player adapter for the local probe page (scripts/latency-probe.mjs).
 * Reports the page's <audio id="vg-probe-audio"> exactly like the YouTube adapter reports
 * its <video>: currentTime, paused and playbackRate read from the element, stamped with
 * Date.now() of the read, every 250 ms and on media events. Also relays the page's
 * requests (status, dump, recapture) to the extension, so after the one toolbar click the
 * whole measurement can be driven from page JavaScript.
 * Inert on any other 127.0.0.1 page (needs <meta name="vibe-guitar-latency-probe">).
 */
import { claimInstance } from '../content/instance';
import { PAGE_CHANNEL, type PageRequest, type PageResponse, type ProbePlayerStateMessage, type ProbeReply, type ProbeRequestMessage } from './messages';

const TICK_MS = 250;

function start(): void {
  const signal = claimInstance('__vibeGuitarLatencyProbe');
  let stopped = false;
  const audio = () => document.querySelector<HTMLAudioElement>('#vg-probe-audio');

  function report(note?: string): void {
    if (stopped) return;
    const a = audio();
    const msg: ProbePlayerStateMessage = {
      type: 'probe-player-state',
      via: a ? 'media-element' : 'unreachable',
      sessionId: a?.dataset.session || null,
      currentTime: a?.currentTime ?? 0,
      // Duration 0: listening mode then never builds or saves an auto chart of the probe.
      duration: 0,
      paused: a ? a.paused : true,
      playbackRate: a?.playbackRate ?? 1,
      isAd: false,
      sampledAt: Date.now(),
      url: location.origin + location.pathname,
      note,
    };
    try {
      chrome.runtime.sendMessage(msg).catch(() => undefined);
    } catch {
      stopped = true; // extension reloaded: this copy is orphaned
      clearInterval(timer);
    }
  }

  const timer = setInterval(() => report(), TICK_MS);
  signal.addEventListener('abort', () => {
    stopped = true;
    clearInterval(timer);
  });
  for (const ev of ['play', 'pause', 'seeked', 'ratechange', 'loadedmetadata', 'emptied']) {
    document.addEventListener(ev, (e) => {
      if (e.target instanceof HTMLAudioElement) report(ev);
    }, { capture: true, signal });
  }
  // The page changes the session id right before it starts a session.
  document.addEventListener('vg-probe-session', () => report('session'), { signal });

  window.addEventListener('message', (e: MessageEvent) => {
    if (e.source !== window || e.origin !== location.origin) return;
    const d = e.data as Partial<PageRequest>;
    if (d?.[PAGE_CHANNEL] !== 'request' || typeof d.id !== 'number') return;
    const id = d.id;
    const op = d.op;
    if (op !== 'status' && op !== 'dump' && op !== 'recapture') return;
    const req: ProbeRequestMessage = { type: 'probe-request', target: op === 'recapture' ? 'background' : 'offscreen', op, sessionId: d.sessionId };
    const respond = (reply: ProbeReply) => window.postMessage({ [PAGE_CHANNEL]: 'response', id, reply } satisfies PageResponse, location.origin);
    try {
      chrome.runtime
        .sendMessage(req)
        .then((r: ProbeReply | undefined) => respond(r ?? { ok: false, error: 'no reply (is tab capture running? click the toolbar button once)' }))
        .catch((err: unknown) => respond({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    } catch (err) {
      respond({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }, { signal });

  // Lets the page know the probe build is installed (the DOM is shared with the page).
  document.documentElement.dataset.vgLatencyProbe = 'ready';
  report('init');
}

if (document.querySelector('meta[name="vibe-guitar-latency-probe"]')) start();
