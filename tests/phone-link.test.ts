// VGT-13 휴대폰 악보대 in the side panel: off by default, never connects while off, reconnects
// with backoff, and sends anchors on play/pause/rate/ad/loop changes and jumps (plus heartbeats).
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, normalizeSettings } from '../src/extension/storage';
import { PhoneLink, phoneStatusText, type PhoneStatus, type PlaybackSample, type SocketLike } from '../src/extension/sidepanel/phone-link';
import { HEARTBEAT_MS, validatePublisherMessage, type AnchorMessage } from '../src/phone/protocol';
import { buildSongView } from '../src/phone/song-view';
import { buildPlayModel } from '../src/play/model';
import { demoChart } from '../src/play/demo';

class FakeSocket implements SocketLike {
  readyState = 0;
  sent: string[] = [];
  closed = false;
  onopen: SocketLike['onopen'] = null;
  onmessage: SocketLike['onmessage'] = null;
  onclose: SocketLike['onclose'] = null;
  onerror: SocketLike['onerror'] = null;
  constructor(readonly url: string) {}
  send(text: string) {
    this.sent.push(text);
  }
  close() {
    this.closed = true;
  }
  open() {
    this.readyState = 1;
    this.onopen?.(new Event('open'));
  }
  drop(code = 1006) {
    this.readyState = 3;
    this.onclose?.({ code } as CloseEvent);
  }
}

function harness(sample: PlaybackSample | null = { position: 10, rate: 1, paused: false, ad: false, loop: null }) {
  let now = 1_000_000;
  const timers: { at: number; fn: () => void; id: number }[] = [];
  let nextId = 1;
  const sockets: FakeSocket[] = [];
  const statuses: PhoneStatus[] = [];
  const h = {
    sample,
    link: null as unknown as PhoneLink,
    sockets,
    statuses,
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const t = timers[0];
        if (!t || t.at > end) break;
        timers.shift();
        now = t.at;
        t.fn();
      }
      now = end;
    },
    get now() {
      return now;
    },
    anchors(s = sockets.at(-1)!) {
      return s.sent.map((x) => validatePublisherMessage(x)).filter((m): m is AnchorMessage => m?.t === 'anchor');
    },
  };
  h.link = new PhoneLink({
    onStatus: (s) => statuses.push(s),
    sample: () => h.sample,
    makeSocket: (url) => {
      const s = new FakeSocket(url);
      sockets.push(s);
      return s;
    },
    now: () => now,
    setTimer: (fn, ms) => {
      const id = nextId++;
      timers.push({ at: now + ms, fn, id });
      return id;
    },
    clearTimer: (id) => {
      const i = timers.findIndex((t) => t.id === id);
      if (i >= 0) timers.splice(i, 1);
    },
  });
  return h;
}

describe('휴대폰 악보대 setting', () => {
  it('is off by default and only a stored true turns it on', () => {
    expect(DEFAULT_SETTINGS.phoneStand).toBe(false);
    expect(normalizeSettings(undefined).phoneStand).toBe(false);
    expect(normalizeSettings({ level: 'novice' }).phoneStand).toBe(false);
    expect(normalizeSettings({ phoneStand: 'yes' }).phoneStand).toBe(false);
    expect(normalizeSettings({ phoneStand: true }).phoneStand).toBe(true);
  });
});

describe('PhoneLink', () => {
  it('never opens a socket while off, whatever else happens', () => {
    const h = harness();
    h.link.setSong(null);
    h.link.tick();
    h.link.retryNow();
    h.advance(60_000);
    expect(h.sockets).toHaveLength(0);
    expect(h.link.state.kind).toBe('off');
  });

  it('connects to the loopback relay only, and closes when turned off', () => {
    const h = harness();
    h.link.setEnabled(true);
    expect(h.sockets.map((s) => s.url)).toEqual(['ws://127.0.0.1:47821/publish']);
    h.sockets[0]!.open();
    h.sockets[0]!.onmessage?.({ data: JSON.stringify({ t: 'viewers', n: 2 }) } as MessageEvent);
    expect(phoneStatusText(h.link.state)).toBe('연결됨 · 휴대폰 2대');
    h.link.setEnabled(false);
    expect(h.sockets[0]!.closed).toBe(true);
    expect(h.statuses.map((s) => s.kind)).toEqual(['disconnected', 'connected', 'connected', 'off']);
    h.advance(60_000);
    expect(h.sockets).toHaveLength(1);
  });

  it('retries with growing backoff while the relay is not running (capped at 15 s)', () => {
    const h = harness();
    h.link.setEnabled(true);
    const gaps: number[] = [];
    let last = h.now;
    for (let i = 0; i < 7; i++) {
      h.sockets.at(-1)!.drop();
      const before = h.sockets.length;
      while (h.sockets.length === before) h.advance(250);
      gaps.push(h.now - last);
      last = h.now;
    }
    expect(gaps).toEqual([1000, 2000, 4000, 8000, 15000, 15000, 15000]);
    expect(phoneStatusText(h.link.state)).toBe('연결 안 됨');
  });

  it('stops retrying when another panel took over, until asked again', () => {
    const h = harness();
    h.link.setEnabled(true);
    h.sockets[0]!.open();
    h.sockets[0]!.drop(4000);
    h.advance(60_000);
    expect(h.sockets).toHaveLength(1);
    expect(h.link.state.kind).toBe('replaced');
    h.link.retryNow();
    expect(h.sockets).toHaveLength(2);
  });

  it('sends the song once it changes (debounced) and again after reconnecting', () => {
    const h = harness();
    const m = buildPlayModel(demoChart(), { level: 'beginner', capo: 0 }, null);
    const view = buildSongView(m, { title: 'x', artist: '', showSounding: false })!;
    h.link.setEnabled(true);
    h.sockets[0]!.open();
    h.link.setSong(view);
    h.link.setSong(view);
    h.advance(300);
    const songs = (s: FakeSocket) => s.sent.map((x) => validatePublisherMessage(x)).filter((x) => x?.t === 'song');
    expect(songs(h.sockets[0]!).map((p) => p!.t === 'song' && p.rev)).toEqual([1, 2]); // empty song on open, then the view
    h.sockets[0]!.drop();
    h.advance(1000);
    h.sockets[1]!.open();
    expect(songs(h.sockets[1]!)).toHaveLength(1);
    expect(JSON.stringify(h.sockets[1]!.sent)).not.toContain('lyrics');
  });

  it('sends anchors on changes and jumps, and a heartbeat every second', () => {
    const h = harness();
    h.link.setEnabled(true);
    h.sockets[0]!.open();
    expect(h.anchors()).toHaveLength(1);
    // smooth playback: no extra anchors between heartbeats
    for (let i = 0; i < 9; i++) {
      h.advance(100);
      h.sample = { ...h.sample!, position: h.sample!.position + 0.1 };
      h.link.tick();
    }
    expect(h.anchors()).toHaveLength(1);
    h.advance(HEARTBEAT_MS - 900);
    expect(h.anchors()).toHaveLength(2);
    for (const change of [{ paused: true }, { paused: false, rate: 0.75 }, { ad: true }, { ad: false, loop: { a: 4, b: 12 } }, { position: 4.01 }]) {
      const n = h.anchors().length;
      h.sample = { ...h.sample!, ...change };
      h.link.tick();
      expect(h.anchors()).toHaveLength(n + 1);
    }
    const last = h.anchors().at(-1)!;
    expect(last).toMatchObject({ position: 4.01, rate: 0.75, paused: false, ad: false, loop: { a: 4, b: 12 }, sampledAt: h.now });
    const seqs = h.anchors().map((a) => a.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  });

  it('sends no anchor without a song, and clamps odd rates', () => {
    const h = harness(null);
    h.link.setEnabled(true);
    h.sockets[0]!.open();
    h.advance(3000);
    expect(h.anchors()).toHaveLength(0);
    h.sample = { position: -0.2, rate: 16, paused: false, ad: false, loop: { a: 3, b: 3.1 } };
    h.link.tick();
    expect(h.anchors()[0]).toMatchObject({ position: 0, rate: 4, loop: null });
  });
});
