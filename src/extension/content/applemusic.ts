/**
 * EXPERIMENTAL Apple Music adapter, isolated-world part. Best effort:
 *   1. MusicKit state relayed by applemusic-main.ts (page world), else
 *   2. an <audio>/<video> element found in the DOM (including open shadow roots), else
 *   3. reports "unreachable" so the side panel can show that result.
 */
import type { Recording } from '../../chart/types';
import { sendQuietly, type AdapterVia, type ExtensionMessage, type PlayerStateMessage } from '../messages';

interface MainPayload {
  via: string;
  currentTime?: number;
  duration?: number;
  paused?: boolean;
  playbackRate?: number;
  id?: string | null;
  title?: string;
  artist?: string;
  error?: string;
}

let lastMain: { payload: MainPayload; at: number; sampledAt: number } | null = null;

window.addEventListener('message', (e: MessageEvent) => {
  if (e.source !== window || e.origin !== location.origin) return;
  const d = e.data as { __vibeGuitar?: string; payload?: MainPayload | null; sampledAt?: number };
  if (d?.__vibeGuitar !== 'am-state' || !d.payload) return;
  lastMain = { payload: d.payload, at: Date.now(), sampledAt: d.sampledAt ?? Date.now() };
});

function deepQueryMedia(root: Document | ShadowRoot): HTMLMediaElement | null {
  const direct = root.querySelector<HTMLMediaElement>('audio, video');
  if (direct) return direct;
  for (const el of root.querySelectorAll('*')) {
    if (el.shadowRoot) {
      const found = deepQueryMedia(el.shadowRoot);
      if (found) return found;
    }
  }
  return null;
}

function idFromUrl(): string | null {
  const u = new URL(location.href);
  return u.searchParams.get('i') ?? /\/song\/[^/]+\/(\d+)/.exec(u.pathname)?.[1] ?? null;
}

let stopped = false;
let media: HTMLMediaElement | null = null;
let lastDeepQuery = 0;

function report(): void {
  if (stopped) return;
  const now = Date.now();
  let via: AdapterVia = 'unreachable';
  let currentTime = 0;
  let duration = 0;
  let paused = true;
  let playbackRate = 1;
  let sampledAt = now;
  let recording: Recording | null = null;
  let note: string | undefined;

  const main = lastMain && now - lastMain.at < 1500 ? lastMain.payload : null;
  if (main && main.via === 'musickit') {
    via = 'musickit';
    currentTime = main.currentTime ?? 0;
    duration = main.duration ?? 0;
    paused = !!main.paused;
    playbackRate = main.playbackRate ?? 1;
    sampledAt = lastMain!.sampledAt;
    const id = main.id ?? idFromUrl();
    if (id) recording = { source: 'applemusic', id: String(id), title: main.title ?? '', artist: main.artist ?? '' };
  } else {
    if (!media?.isConnected && now - lastDeepQuery > 2000) {
      lastDeepQuery = now;
      media = deepQueryMedia(document);
    }
    if (media) {
      via = 'media-element';
      currentTime = media.currentTime;
      duration = Number.isFinite(media.duration) ? media.duration : 0;
      paused = media.paused;
      playbackRate = media.playbackRate;
      const ms = navigator.mediaSession?.metadata;
      const id = idFromUrl();
      if (id) recording = { source: 'applemusic', id, title: ms?.title ?? document.title, artist: ms?.artist ?? '' };
      else note = 'media element found but no song id in URL';
    } else {
      note = main?.error ? `MusicKit error: ${main.error}` : 'neither MusicKit nor a media element is reachable from the extension';
    }
  }

  const msg: PlayerStateMessage = {
    type: 'player-state',
    adapter: 'applemusic',
    via,
    recording,
    currentTime,
    duration,
    paused,
    playbackRate,
    isAd: false,
    sampledAt,
    url: location.href,
    note,
  };
  try {
    sendQuietly(msg);
  } catch {
    stopped = true;
    clearInterval(timer);
  }
}

const timer = setInterval(report, 250);

chrome.runtime.onMessage.addListener((msg: ExtensionMessage) => {
  if (msg.type !== 'player-control' || !media) return;
  if (msg.action === 'seek' && typeof msg.time === 'number') media.currentTime = msg.time;
  if (msg.action === 'pause') media.pause();
  if (msg.action === 'play') void media.play().catch(() => undefined);
});
