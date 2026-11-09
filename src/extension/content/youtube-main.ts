/**
 * YouTube Music page (MAIN) world part: reports what the page's own player is
 * playing (movie_player.getVideoData()) to the isolated content script, because the
 * URL `v=` can name a different recording than the one playing.
 */

interface VideoData {
  video_id?: string;
  title?: string;
  author?: string;
}
interface YtPlayer {
  getVideoData?: () => VideoData | undefined;
}

function readPlayer(): VideoData | null {
  const candidates = [document.getElementById('movie_player'), document.querySelector('.html5-video-player')];
  for (const el of candidates) {
    const p = el as unknown as YtPlayer | null;
    if (p && typeof p.getVideoData === 'function') {
      try {
        const d = p.getVideoData();
        if (d && d.video_id) return d;
      } catch {
        // player not ready
      }
    }
  }
  return null;
}

setInterval(() => {
  const d = readPlayer();
  window.postMessage(
    {
      __vibeGuitar: 'yt-video-data',
      payload: d ? { videoId: String(d.video_id), title: String(d.title ?? ''), author: String(d.author ?? ''), sampledAt: Date.now() } : null,
    },
    location.origin,
  );
}, 250);
