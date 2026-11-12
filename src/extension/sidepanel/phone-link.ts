/**
 * VGT-13 휴대폰 악보대: the side panel publishes the shown song view and the playback position to
 * the local relay started by `npm run phone` (ws://127.0.0.1 only; the relay serves the phone).
 * Lives in the panel page, not the service worker, so it exists exactly while the panel is open.
 * Off by default; while off it never opens a socket.
 */
import {
  DEFAULT_PUBLISHER_PORT,
  HEARTBEAT_MS,
  RATE_MAX,
  RATE_MIN,
  positionAt,
  songParts,
  type AnchorMessage,
  type Loop,
  type SongPartMessage,
} from '../../phone/protocol';
import type { SongView } from '../../phone/song-view';

export type PhoneStatus =
  | { kind: 'off' }
  | { kind: 'disconnected' }
  | { kind: 'connected'; viewers: number }
  /** Another panel (another Chrome window) took over; this one waits for focus or a retry. */
  | { kind: 'replaced' };

export interface PlaybackSample {
  position: number;
  rate: number;
  paused: boolean;
  ad: boolean;
  loop: Loop | null;
}

/** The parts of WebSocket this class uses (a fake in tests). */
export interface SocketLike {
  readonly readyState: number;
  onopen: ((ev: Event) => unknown) | null;
  onmessage: ((ev: MessageEvent) => unknown) | null;
  onclose: ((ev: CloseEvent) => unknown) | null;
  onerror: ((ev: Event) => unknown) | null;
  send(text: string): void;
  close(): void;
}

export interface PhoneLinkOptions {
  onStatus: (s: PhoneStatus) => void;
  /** Current playback, or null when no song is shown. */
  sample: () => PlaybackSample | null;
  port?: number;
  makeSocket?: (url: string) => SocketLike;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (id: unknown) => void;
}

const OPEN = 1;
const FIRST_RETRY_MS = 1000;
const MAX_RETRY_MS = 15000;
const SONG_DEBOUNCE_MS = 250;
/** A position this far from the last anchor's extrapolation is a seek or a loop jump. */
const JUMP_SEC = 0.15;
/** Close code the relay uses when a newer publisher connects. */
const REPLACED = 4000;

export function newEpoch(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => (b % 36).toString(36)).join('');
}

/** Song view shown when the panel has no song: the phone waits for one. */
export const EMPTY_SONG: SongView = {
  v: 1,
  title: '',
  artist: '',
  capo: 0,
  showSounding: false,
  durationSec: 0,
  timing: { bpm: 120, beatsPerBar: 4, beatUnit: 4, firstDownbeatSec: 0 },
  shapes: [],
  events: [],
  bars: [],
  sections: [],
};

export class PhoneLink {
  private enabled = false;
  private ws: SocketLike | null = null;
  private retryMs = FIRST_RETRY_MS;
  private retryTimer: unknown = null;
  private songTimer: unknown = null;
  private heartbeat: unknown = null;
  private status: PhoneStatus = { kind: 'off' };
  private readonly epoch = newEpoch();
  private rev = 0;
  private seq = 0;
  private songJson = '';
  private parts: SongPartMessage[] = [];
  private lastAnchor: AnchorMessage | null = null;
  private readonly o: Required<Omit<PhoneLinkOptions, 'port'>> & { url: string };

  constructor(opts: PhoneLinkOptions) {
    this.o = {
      onStatus: opts.onStatus,
      sample: opts.sample,
      url: `ws://127.0.0.1:${opts.port ?? DEFAULT_PUBLISHER_PORT}/publish`,
      makeSocket: opts.makeSocket ?? ((url) => new WebSocket(url)),
      now: opts.now ?? Date.now,
      setTimer: opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms)),
      clearTimer: opts.clearTimer ?? ((id) => clearTimeout(id as ReturnType<typeof setTimeout>)),
    };
  }

  get state(): PhoneStatus {
    return this.status;
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(on: boolean): void {
    if (on === this.enabled) return;
    this.enabled = on;
    if (on) {
      this.retryMs = FIRST_RETRY_MS;
      this.setStatus({ kind: 'disconnected' });
      this.connect();
    } else {
      this.drop();
      this.setStatus({ kind: 'off' });
    }
  }

  /** Reconnect now instead of waiting for the backoff (sheet opened, window focused). */
  retryNow(): void {
    if (!this.enabled || this.ws) return;
    this.retryMs = FIRST_RETRY_MS;
    this.connect();
  }

  /** The song the panel shows (null: none). Sent once its JSON changes, debounced. */
  setSong(view: SongView | null): void {
    const json = JSON.stringify(view ?? EMPTY_SONG);
    if (json === this.songJson) return;
    this.songJson = json;
    this.o.clearTimer(this.songTimer);
    this.songTimer = this.o.setTimer(() => {
      this.songTimer = null;
      this.publishSong(view ?? EMPTY_SONG);
    }, SONG_DEBOUNCE_MS);
  }

  /** Called every frame: sends an anchor at once on play/pause, rate, ad, loop changes and jumps. */
  tick(): void {
    if (!this.isOpen()) return;
    const s = this.o.sample();
    if (!s) return;
    const a = this.lastAnchor;
    const t = this.o.now();
    const loopKey = (l: Loop | null) => (l ? `${l.a}|${l.b}` : '');
    if (
      !a ||
      a.paused !== s.paused ||
      a.ad !== s.ad ||
      a.rate !== clampRate(s.rate) ||
      loopKey(a.loop) !== loopKey(s.loop) ||
      Math.abs(positionAt(a, Infinity, t) - Math.max(0, s.position)) > JUMP_SEC
    )
      this.sendAnchor(s, t);
  }

  private isOpen(): boolean {
    return !!this.ws && this.ws.readyState === OPEN && this.status.kind === 'connected';
  }

  private sendAnchor(s: PlaybackSample, t: number): void {
    const loop = s.loop && s.loop.b - s.loop.a >= 0.25 && s.loop.a >= 0 ? { a: s.loop.a, b: s.loop.b } : null;
    const m: AnchorMessage = {
      t: 'anchor',
      epoch: this.epoch,
      seq: ++this.seq,
      sampledAt: t,
      position: Math.max(0, s.position),
      rate: clampRate(s.rate),
      paused: s.paused,
      ad: s.ad,
      loop,
    };
    this.lastAnchor = m;
    this.send(m);
  }

  private publishSong(view: SongView): void {
    this.rev++;
    this.parts = songParts(view, this.epoch, this.rev) ?? songParts(EMPTY_SONG, this.epoch, this.rev)!;
    if (this.isOpen()) for (const p of this.parts) this.send(p);
  }

  private send(m: unknown): void {
    try {
      if (this.ws && this.ws.readyState === OPEN) this.ws.send(JSON.stringify(m));
    } catch {
      /* the close handler reconnects */
    }
  }

  private connect(): void {
    this.o.clearTimer(this.retryTimer);
    this.retryTimer = null;
    let ws: SocketLike;
    try {
      ws = this.o.makeSocket(this.o.url);
    } catch {
      return this.scheduleRetry();
    }
    this.ws = ws;
    ws.onerror = () => {}; // the close event follows; Chrome itself notes the failed attempt once
    ws.onopen = () => {
      this.retryMs = FIRST_RETRY_MS;
      this.setStatus({ kind: 'connected', viewers: 0 });
      if (!this.parts.length) this.publishSong(this.songJson ? (JSON.parse(this.songJson) as SongView) : EMPTY_SONG);
      else for (const p of this.parts) this.send(p);
      this.lastAnchor = null;
      this.tick();
      this.o.clearTimer(this.heartbeat);
      const beat = () => {
        this.heartbeat = this.o.setTimer(beat, HEARTBEAT_MS);
        const s = this.isOpen() ? this.o.sample() : null;
        if (s) this.sendAnchor(s, this.o.now());
      };
      this.heartbeat = this.o.setTimer(beat, HEARTBEAT_MS);
    };
    ws.onmessage = (ev) => {
      try {
        const m = JSON.parse(String(ev.data)) as { t?: unknown; n?: unknown };
        if (m.t === 'viewers' && typeof m.n === 'number' && Number.isInteger(m.n) && m.n >= 0) this.setStatus({ kind: 'connected', viewers: m.n });
      } catch {
        /* ignore anything else */
      }
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.o.clearTimer(this.heartbeat);
      this.heartbeat = null;
      if (!this.enabled) return;
      if (ev?.code === REPLACED) return this.setStatus({ kind: 'replaced' });
      this.setStatus({ kind: 'disconnected' });
      this.scheduleRetry();
    };
  }

  private scheduleRetry(): void {
    if (!this.enabled) return;
    this.o.clearTimer(this.retryTimer);
    this.retryTimer = this.o.setTimer(() => this.connect(), this.retryMs);
    this.retryMs = Math.min(MAX_RETRY_MS, this.retryMs * 2);
  }

  private drop(): void {
    for (const id of [this.retryTimer, this.songTimer, this.heartbeat]) this.o.clearTimer(id);
    this.retryTimer = this.heartbeat = null;
    // A pending song is published on the next connect.
    if (this.songTimer) {
      this.songTimer = null;
      this.parts = [];
    }
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = null;
      try {
        ws.close();
      } catch {
        /* already closed */
      }
    }
  }

  private setStatus(s: PhoneStatus): void {
    const same = s.kind === this.status.kind && (s.kind !== 'connected' || this.status.kind !== 'connected' || s.viewers === this.status.viewers);
    this.status = s;
    if (!same) this.o.onStatus(s);
  }
}

function clampRate(r: number): number {
  return Number.isFinite(r) ? Math.min(RATE_MAX, Math.max(RATE_MIN, r)) : 1;
}

/** One status line for the settings sheet. */
export function phoneStatusText(s: PhoneStatus): string {
  switch (s.kind) {
    case 'off':
      return '';
    case 'disconnected':
      return '연결 안 됨';
    case 'replaced':
      return '연결 안 됨 · 다른 창의 패널이 휴대폰에 보내고 있어요';
    case 'connected':
      return s.viewers > 0 ? `연결됨 · 휴대폰 ${s.viewers}대` : '연결됨 · 휴대폰 0대';
  }
}
