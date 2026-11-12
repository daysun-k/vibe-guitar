/**
 * VGT-13 휴대폰 악보대: the side panel publishes the shown song view and the playback position to
 * the local relay started by `npm run phone` (ws://127.0.0.1 only; the relay serves the phone).
 * Lives in the panel page, not the service worker, so it exists exactly while the panel is open.
 * Off by default; while off it never opens a socket.
 *
 * VGT-16: with control allowed (setControl), it tells the relay, mirrors the relay's list of phones
 * and their pairing codes, sends the panel's 승인 / 거절 / 승인 해제, and checks every forwarded
 * command again (switch, approved connection, song revision, duplicate id, rate, one at a time)
 * before handing it to `onCommand`. The outcome goes back only over the same socket.
 */
import {
  DEFAULT_PUBLISHER_PORT,
  HEARTBEAT_MS,
  RATE_MAX,
  RATE_MIN,
  TokenBucket,
  positionAt,
  songParts,
  validateRelayToPanel,
  type AnchorMessage,
  type CommandFailure,
  type CommandOutcome,
  type ForwardedCommand,
  type Loop,
  type PhoneCommand,
  type PhoneEntry,
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
  /** The relay's list of phones changed (empty while control is off or disconnected). */
  onPhones?: (list: PhoneEntry[]) => void;
  /**
   * Carries out a command from the approved phone (already checked here). `progress` sends an
   * intermediate outcome (the count-in started); the resolved outcome is the final one.
   */
  onCommand?: (cmd: PhoneCommand, progress: (o: CommandOutcome) => void) => Promise<CommandOutcome>;
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
  private control = false;
  private phones: PhoneEntry[] = [];
  /** Highest command id handled per phone connection. */
  private readonly seen = new Map<string, number>();
  private bucket: TokenBucket;
  private busy = false;
  private readonly o: Required<Omit<PhoneLinkOptions, 'port'>> & { url: string };

  constructor(opts: PhoneLinkOptions) {
    this.o = {
      onStatus: opts.onStatus,
      sample: opts.sample,
      onPhones: opts.onPhones ?? (() => {}),
      onCommand: opts.onCommand ?? (async () => ({ ok: false, code: 'failed' })),
      url: `ws://127.0.0.1:${opts.port ?? DEFAULT_PUBLISHER_PORT}/publish`,
      makeSocket: opts.makeSocket ?? ((url) => new WebSocket(url)),
      now: opts.now ?? Date.now,
      setTimer: opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms)),
      clearTimer: opts.clearTimer ?? ((id) => clearTimeout(id as ReturnType<typeof setTimeout>)),
    };
    this.bucket = new TokenBucket(undefined, undefined, this.o.now);
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

  get controlAllowed(): boolean {
    return this.control;
  }

  get phoneList(): readonly PhoneEntry[] {
    return this.phones;
  }

  /** 휴대폰에서 조작 허용. Any change revokes the approval (on the relay as well). */
  setControl(on: boolean): void {
    if (on === this.control) return;
    this.control = on;
    this.seen.clear();
    if (!on) this.setPhones([]);
    if (this.isOpen()) this.send({ t: 'control', on });
  }

  approve(id: string): void {
    const p = this.phones.find((x) => x.id === id);
    if (this.control && p && p.state !== 'approved') this.send({ t: 'approve', id, code: p.code });
  }

  reject(id: string): void {
    const p = this.phones.find((x) => x.id === id);
    if (this.control && p && p.state !== 'rejected') this.send({ t: 'reject', id, code: p.code });
  }

  /** 승인 해제. */
  revoke(): void {
    if (this.control) this.send({ t: 'revoke' });
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
      // A new relay session: nothing from an earlier one is replayed.
      this.seen.clear();
      if (this.control) this.send({ t: 'control', on: true });
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
      if (this.ws !== ws) return;
      const m = validateRelayToPanel(String(ev.data));
      if (!m) return; // ignore anything else
      if (m.t === 'viewers') this.setStatus({ kind: 'connected', viewers: m.n });
      else if (m.t === 'phones') this.setPhones(this.control ? m.list : []);
      else this.onCommand(m, ws);
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.o.clearTimer(this.heartbeat);
      this.heartbeat = null;
      this.setPhones([]);
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
    this.setPhones([]);
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = null;
      try {
        ws.close();
      } catch {
        /* already closed */
      }
    }
  }

  private setPhones(list: PhoneEntry[]): void {
    if (JSON.stringify(list) === JSON.stringify(this.phones)) return;
    this.phones = list;
    this.o.onPhones(list);
  }

  /** The panel's own checks of a command the relay forwarded; then carries it out. */
  private onCommand(m: ForwardedCommand, ws: SocketLike): void {
    const reply = (o: CommandOutcome) => {
      // Only over the socket the command came in on: never to a later connection.
      if (this.ws === ws) this.send({ t: 'result', to: m.from, id: m.id, ...o });
    };
    const fail = (code: CommandFailure) => reply({ ok: false, code });
    if (!this.control) return fail('off');
    if (this.phones.find((p) => p.state === 'approved')?.id !== m.from) return fail('not-approved');
    if (m.id <= (this.seen.get(m.from) ?? 0)) return fail('duplicate');
    this.seen.set(m.from, m.id);
    if (!this.bucket.take()) return fail('rate');
    // A song change waiting for its debounce is already what the panel shows.
    if (m.epoch !== this.epoch || m.rev !== this.rev || this.songTimer) return fail('stale');
    if (this.busy) return fail('busy');
    this.busy = true;
    let released = false;
    const release = () => {
      if (!released) this.busy = false;
      released = true;
    };
    this.o
      .onCommand(m.cmd, (o) => {
        // Once the count-in runs, the phone may send the next command (pause cancels it).
        release();
        reply(o);
      })
      .catch((): CommandOutcome => ({ ok: false, code: 'failed' }))
      .then((o) => {
        release();
        reply(o);
      });
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
