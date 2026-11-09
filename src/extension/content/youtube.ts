/**
 * Player adapter for www.youtube.com and music.youtube.com (isolated world).
 * Reads the playing <video> element and page metadata, reports to the side panel,
 * and accepts play/pause/seek controls for the count-in.
 */
import type { Recording } from '../../chart/types';
import { sendQuietly, type ExtensionMessage, type PlayerStateMessage } from '../messages';

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

function videoIdFromPage(): string | null {
  const fromUrl = videoIdFromUrl(location.href);
  if (fromUrl) return fromUrl;
  if (adapter === 'ytmusic') {
    // Player bar link (when the URL is a playlist / home while a song plays).
    const a = document.querySelector<HTMLAnchorElement>('ytmusic-player-bar a[href*="watch?v="]');
    if (a) return videoIdFromUrl(a.href);
  }
  return null;
}

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
  const id = videoIdFromPage();
  const meta = metadata();
  const recording: Recording | null = id ? { source: adapter, id, title: meta.title, artist: meta.artist } : null;
  const msg: PlayerStateMessage = {
    type: 'player-state',
    adapter,
    via: video ? 'video-element' : 'unreachable',
    recording,
    currentTime: video?.currentTime ?? 0,
    duration: video && Number.isFinite(video.duration) ? video.duration : 0,
    paused: video ? video.paused : true,
    playbackRate: video?.playbackRate ?? 1,
    isAd: isAdShowing(),
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

// Media events do not bubble, but capture-phase listeners on document see them.
for (const ev of ['play', 'pause', 'seeked', 'ratechange', 'loadedmetadata', 'emptied']) {
  document.addEventListener(ev, (e) => {
    if (e.target instanceof HTMLVideoElement) report(ev);
  }, true);
}
// YouTube SPA navigation events.
for (const ev of ['yt-navigate-finish', 'yt-page-data-updated']) {
  window.addEventListener(ev, () => report('navigation'));
  document.addEventListener(ev, () => report('navigation'));
}

chrome.runtime.onMessage.addListener((msg: ExtensionMessage) => {
  if (msg.type !== 'player-control') return;
  const video = getVideo();
  if (!video) return;
  if (msg.action === 'seek' && typeof msg.time === 'number') video.currentTime = Math.max(0, msg.time);
  if (msg.action === 'pause') video.pause();
  if (msg.action === 'play') void video.play().catch(() => undefined);
  report(`control:${msg.action}`);
});

report('init');
