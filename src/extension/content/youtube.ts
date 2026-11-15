/**
 * Player adapter for www.youtube.com and music.youtube.com (isolated world).
 * Reads the playing <video> element and page metadata, reports to the side panel,
 * and accepts play/pause/seek controls (count-in, practice loop) and the practice speed.
 */
import type { Recording } from '../../chart/types';
import { isPracticeRate } from '../../play/practice';
import { sendQuietly, type ExtensionMessage, type PlayerControlResult, type PlayerStateMessage } from '../messages';
import { chooseRecordingId, isVideoId, type PlayerVideoData, type RecordingIdChoice } from './recording-id';
import { claimInstance, onRuntimeMessage } from './instance';
import { applyPracticeRate, createRateBridge } from './yt-rate';

const instanceSignal = claimInstance('__vibeGuitarYouTube');

const adapter: 'youtube' | 'ytmusic' = location.hostname === 'music.youtube.com' ? 'ytmusic' : 'youtube';
const TICK_MS = 250;

function getVideo(): HTMLVideoElement | null {
  const main = document.querySelector<HTMLVideoElement>('video.html5-main-video');
  if (main) return main;
  const all = [...document.querySelectorAll<HTMLVideoElement>('video')];
  return all.find((v) => !v.paused) ?? all[0] ?? null;
}

export function videoIdFromUrl(href: string): string | null {
  const u = new URL(href);
  const v = u.searchParams.get('v');
  if (v) return v;
  const m = /^\/(shorts|embed|live)\/([\w-]{6,})/.exec(u.pathname);
  return m ? m[2] : null;
}

/** Player bar link (when the URL is a playlist / home while a song plays). */
function playerBarId(): string | null {
  if (adapter !== 'ytmusic') return null;
  const a = document.querySelector<HTMLAnchorElement>('ytmusic-player-bar a[href*="watch?v="]');
  return a ? videoIdFromUrl(a.href) : null;
}

/** Latest report of the page's own player (MAIN world, YouTube Music only). */
let playerData: PlayerVideoData | null = null;
let lastChoice: RecordingIdChoice | null = null;

window.addEventListener('message', (e: MessageEvent) => {
  if (e.source !== window || e.origin !== location.origin) return;
  const d = e.data as { __vibeGuitar?: string; payload?: Partial<PlayerVideoData> | null };
  if (d?.__vibeGuitar !== 'yt-video-data') return;
  const p = d.payload;
  playerData =
    p && isVideoId(p.videoId)
      ? { videoId: p.videoId, title: String(p.title ?? ''), author: String(p.author ?? ''), sampledAt: Number(p.sampledAt) || Date.now() }
      : null;
}, { signal: instanceSignal });

/** Practice speed through the page's own player (MAIN world, ./youtube-main.ts); see ./yt-rate.ts. */
const rateViaPagePlayer = createRateBridge({
  win: window,
  origin: location.origin,
  signal: instanceSignal,
  setTimeout: (fn, ms) => setTimeout(fn, ms),
});

function text(sel: string): string {
  return document.querySelector(sel)?.textContent?.trim() ?? '';
}

function metadata(): { title: string; artist: string } {
  const ms = navigator.mediaSession?.metadata;
  if (ms && ms.title) return { title: ms.title, artist: ms.artist ?? '' };
  if (adapter === 'ytmusic') {
    const byline = text('ytmusic-player-bar .byline');
    return { title: text('ytmusic-player-bar .title'), artist: byline.split('•')[0]?.trim() ?? '' };
  }
  const title = text('h1.ytd-watch-metadata yt-formatted-string') || document.title.replace(/ - YouTube$/, '');
  const artist = text('ytd-watch-metadata ytd-channel-name a') || text('#owner #channel-name a');
  return { title, artist };
}

function isAdShowing(): boolean {
  const player = document.querySelector('#movie_player, .html5-video-player');
  if (player?.classList.contains('ad-showing') || player?.classList.contains('ad-interrupting')) return true;
  return !!document.querySelector('.ytp-ad-player-overlay, .ytp-ad-player-overlay-layout, .ytp-ad-preview-container');
}

let stopped = false;
let lastHref = location.href;

function report(note?: string): void {
  if (stopped) return;
  const video = getVideo();
  const isAd = isAdShowing();
  const choice = chooseRecordingId({
    urlId: videoIdFromUrl(location.href),
    playerBarId: playerBarId(),
    player: playerData,
    isAd,
    previous: lastChoice,
    now: Date.now(),
  });
  if (!isAd) lastChoice = choice;
  const meta = metadata();
  const title = meta.title || choice?.title || '';
  const artist = meta.artist || choice?.artist || '';
  const recording: Recording | null = choice ? { source: adapter, id: choice.id, title, artist } : null;
  const msg: PlayerStateMessage = {
    type: 'player-state',
    adapter,
    via: video ? 'video-element' : 'unreachable',
    recording,
    idSource: choice?.source,
    urlIdMismatch: choice?.urlIdMismatch,
    currentTime: video?.currentTime ?? 0,
    duration: video && Number.isFinite(video.duration) ? video.duration : 0,
    paused: video ? video.paused : true,
    playbackRate: video?.playbackRate ?? 1,
    isAd,
    sampledAt: Date.now(),
    url: location.href,
    note,
  };
  try {
    sendQuietly(msg);
  } catch {
    stopped = true; // extension was reloaded; this script is orphaned
    clearInterval(timer);
  }
}

const timer = setInterval(() => {
  if (location.href !== lastHref) {
    lastHref = location.href;
    report('navigation');
    return;
  }
  report();
}, TICK_MS);
instanceSignal.addEventListener('abort', () => {
  stopped = true;
  clearInterval(timer);
});

// Media events do not bubble, but capture-phase listeners on document see them.
for (const ev of ['play', 'pause', 'seeked', 'ratechange', 'loadedmetadata', 'emptied']) {
  document.addEventListener(ev, (e) => {
    if (e.target instanceof HTMLVideoElement) report(ev);
  }, { capture: true, signal: instanceSignal });
}
// YouTube SPA navigation events.
for (const ev of ['yt-navigate-finish', 'yt-page-data-updated']) {
  window.addEventListener(ev, () => report('navigation'), { signal: instanceSignal });
  document.addEventListener(ev, () => report('navigation'), { signal: instanceSignal });
}

onRuntimeMessage(instanceSignal, (msg: ExtensionMessage, _sender, sendResponse) => {
  if (msg.type !== 'player-control') return;
  const video = getVideo();
  if (!video) {
    sendResponse({ ok: false, reason: 'no video element on this page' } satisfies PlayerControlResult);
    return;
  }
  if (msg.action === 'rate') {
    if (!isPracticeRate(msg.rate)) {
      sendResponse({ ok: false, reason: `unsupported rate ${String(msg.rate)}` } satisfies PlayerControlResult);
      return;
    }
    // Through the page's player so its ⚙ menu shows the same rate; the <video> ratechange report updates the panel.
    void applyPracticeRate(video, msg.rate, rateViaPagePlayer, instanceSignal).then(() => {
      report('control:rate');
      sendResponse({ ok: true } satisfies PlayerControlResult);
    });
    return true; // async response
  }
  if (msg.action === 'seek' && typeof msg.time === 'number') video.currentTime = Math.max(0, msg.time);
  if (msg.action === 'pause') video.pause();
  if (msg.action === 'play') void video.play().catch(() => undefined);
  report(`control:${msg.action}`);
  sendResponse({ ok: true } satisfies PlayerControlResult);
});

report('init');
