/**
 * VGT-13 휴대폰 악보대: the side panel publishes the shown song view and the playback position to
 * the local relay started by `npm run phone` (ws://127.0.0.1 only; the relay serves the phone).
 * Lives in the panel page, not the service worker, so it exists exactly while the panel is open.
 * Off by default; while off it never opens a socket.
 *
 * VGT-16: with control allowed (setControl), it tells the relay, mirrors the relay's list of phones
 * and their pairing codes, sends the panel's 승인 / 거절 / 승인 해제, and checks every forwarded
 * command again (switch, grant, song revision, duplicate id, rate, one at a time) before handing it
 * to `onCommand`. The outcome goes back only over the same socket. A song change while a command runs
 * aborts it with SONG_CHANGED, so it sends nothing further to the player (the phone hears `stale`).
 *
 * Each published song revision is bound to the player target the panel gave with it (setSong). The
 * command's CommandContext tells runPhoneCommand that target and whether the grant and the revision
 * still hold. songChanging() (the panel's player, recording, chart or demo changed) clears the
 * published revision at once: until the panel sets the new song and it is published, every command is
 * `stale`.
 *
 * The panel alone decides who may control: it holds one grant {connection, number}, set only by its
 * own 승인 (with a new number) and cleared at once by every way control ends. The relay stamps each
 * forwarded command with the number it was given at approval; a command runs only when its sender and
 * number match the current grant. The relay's phone list is for display and never grants anything; it
 * can only end the grant, once a list has shown the relay holding it and a later one no longer does
 * (the phone disconnected). Lists from before the relay saw the approval are ignored for this.
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
import { withoutUncertain, type SongView } from '../../phone/song-view';
import { SONG_CHANGED, type CommandContext } from './phone-control';

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
   * intermediate outcome (the count-in started); the resolved outcome is the final one. `context`
   * goes to runPhoneCommand.
   */
  onCommand?: (cmd: PhoneCommand, progress: (o: CommandOutcome) => void, signal: AbortSignal, context: CommandContext) => Promise<CommandOutcome>;
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
/** songTarget after songChanging(): the next setSong always counts as a change. */
const NOT_READY: unique symbol = Symbol('not ready');
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
  /** The player target the song in songJson was set for; NOT_READY after songChanging(). */
  private songTarget: string | null | typeof NOT_READY = null;
  /** The revision phones have and the player target it was published for; null while none may be acted on. */
  private published: { rev: number; target: string | null } | null = null;
  private parts: SongPartMessage[] = [];
  /** The whole view `parts` were made from (with its "?" marks even when they were left out). */
  private partsView: SongView | null = null;
  /** `parts` carry the "?" marks (VGT-19). */
  private partsUncertain = false;
  /** The connected relay announced it takes the "?" marks (caps); reset on every new connection. */
  private relayUncertain = false;
  private lastAnchor: AnchorMessage | null = null;
  private control = false;
  /** The phone list shown: the relay's, with 'approved' only for the phone holding the grant. */
  private phones: PhoneEntry[] = [];
  /** The relay's last phone list. */
  private relayPhones: PhoneEntry[] = [];
  /** The only permission to control (see the file comment). */
  private grant: { id: string; seq: number; confirmed: boolean } | null = null;
  /** Last grant number given out (never reused within this panel session). */
  private grantSeq = 0;
  /** Highest command id handled per phone connection. */
  private readonly seen = new Map<string, number>();
  private bucket: TokenBucket;
  private busy = false;
  /** Commands still running, by the phone connection they came from: aborted when it loses control. */
  private readonly running = new Set<{ grant: number; ctl: AbortController }>();
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
    // The relay revokes on any change of the switch.
    this.setGrant(null);
    if (!on) this.setPhones([]);
    if (this.isOpen()) this.send({ t: 'control', on });
  }

  /** 승인: this phone gets a new grant (replacing any other) before the relay hears of it. */
  approve(id: string): void {
    const p = this.phones.find((x) => x.id === id);
    if (!this.control || !p || this.grant?.id === id) return;
    const seq = ++this.grantSeq;
    this.setGrant({ id, seq, confirmed: false });
    this.send({ t: 'approve', id, code: p.code, grant: seq });
  }

  reject(id: string): void {
    const p = this.phones.find((x) => x.id === id);
    if (!this.control || !p || p.state === 'rejected') return;
    if (this.grant?.id === id) this.setGrant(null);
    this.send({ t: 'reject', id, code: p.code });
  }

  /** 승인 해제: the grant ends here first, then the relay is told. */
  revoke(): void {
    this.setGrant(null);
    if (this.control) this.send({ t: 'revoke' });
  }

  /** Replaces the grant; commands running under any other grant are aborted at once. */
  private setGrant(g: { id: string; seq: number; confirmed: boolean } | null): void {
    this.grant = g;
    for (const r of [...this.running]) {
      if (g && r.grant === g.seq) continue;
      this.running.delete(r);
      r.ctl.abort();
    }
    this.setPhones(this.relayPhones);
  }

  /** Reconnect now instead of waiting for the backoff (sheet opened, window focused). */
  retryNow(): void {
    if (!this.enabled || this.ws) return;
    this.retryMs = FIRST_RETRY_MS;
    this.connect();
  }

  /**
   * The song the panel shows (null: none) and the player target commands for it would act on (null:
   * none). Sent once either changes, debounced; commands are `stale` until it is published.
   */
  setSong(view: SongView | null, target: string | null = null): void {
    const json = JSON.stringify(view ?? EMPTY_SONG);
    if (json === this.songJson && target === this.songTarget) return;
    this.songJson = json;
    this.songTarget = target;
    this.unpublish();
    this.songTimer = this.o.setTimer(() => {
      this.songTimer = null;
      this.publishSong(view ?? EMPTY_SONG, target);
    }, SONG_DEBOUNCE_MS);
  }

  /**
   * The panel's player, recording, chart or demo is changing: from now on no command acts until the
   * panel sets the song again (setSong) and it is published. Called synchronously before anything else
   * runs, so no command can reach the new player with the previous song's revision.
   */
  songChanging(): void {
    this.songTarget = NOT_READY;
    this.unpublish();
  }

  /** No revision may be acted on; commands for the previous one are stopped. */
  private unpublish(): void {
    this.published = null;
    this.o.clearTimer(this.songTimer);
    this.songTimer = null;
    // A command started for the previous song must not act on the next one.
    for (const r of [...this.running]) {
      this.running.delete(r);
      r.ctl.abort(SONG_CHANGED);
    }
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

  private publishSong(view: SongView, target: string | null | typeof NOT_READY): void {
    this.rev++;
    this.published = target === NOT_READY ? null : { rev: this.rev, target };
    this.makeParts(view);
    if (this.isOpen()) for (const p of this.parts) this.send(p);
  }

  /**
   * The same song again as a new revision because the relay's caps changed what may be sent (the "?"
   * marks). The published binding keeps its target and follows the new revision in place, so a
   * command already running for this song is not cut off.
   */
  private republish(): void {
    if (!this.partsView) return;
    this.rev++;
    if (this.published) this.published.rev = this.rev;
    this.makeParts(this.partsView);
    if (this.isOpen()) for (const p of this.parts) this.send(p);
  }

  /** Parts of `view` at this.rev; its "?" marks only for a relay that announced them (old relays reject them). */
  private makeParts(view: SongView): void {
    const sent = this.relayUncertain ? view : withoutUncertain(view);
    this.partsView = view;
    this.partsUncertain = sent.uncertain !== undefined;
    this.parts = songParts(sent, this.epoch, this.rev) ?? songParts(EMPTY_SONG, this.epoch, this.rev)!;
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
      // A new relay session: nothing from an earlier one is replayed, and nothing is approved yet.
      this.seen.clear();
      this.setGrant(null);
      if (this.control) this.send({ t: 'control', on: true });
      // Until this relay announces the "?" marks it may be one that rejects them.
      this.relayUncertain = false;
      if (!this.parts.length) this.publishSong(this.songJson ? (JSON.parse(this.songJson) as SongView) : EMPTY_SONG, this.songTarget);
      else if (this.partsUncertain) this.republish();
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
      else if (m.t === 'caps') {
        const had = this.relayUncertain;
        this.relayUncertain = m.uncertain;
        // The song went out without its marks: send it again with them (a pending song gets them anyway).
        if (!had && m.uncertain && !this.songTimer && this.partsView?.uncertain && !this.partsUncertain) this.republish();
      } else if (m.t === 'phones') this.relayList(this.control ? m.list : []);
      else this.onCommand(m, ws);
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.o.clearTimer(this.heartbeat);
      this.heartbeat = null;
      this.relayPhones = [];
      this.setGrant(null);
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
    this.relayPhones = [];
    this.setGrant(null);
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = null;
      try {
        ws.close();
      } catch {
        /* already closed */
      }
    }
  }

  /**
   * A phone list from the relay: display only. It never grants; it ends the grant only after an earlier
   * list showed the relay holding exactly this grant and this one no longer does (lists are in order).
   */
  private relayList(list: PhoneEntry[]): void {
    const g = this.grant;
    const holds = !!g && list.some((p) => p.id === g.id && p.state === 'approved' && p.grant === g.seq);
    if (g && holds) g.confirmed = true;
    if (g && g.confirmed && !holds) this.setGrant(null);
    this.setPhones(list);
  }

  private setPhones(relayList: PhoneEntry[]): void {
    this.relayPhones = relayList;
    const g = this.grant;
    const list = relayList.map(({ id, code, state }): PhoneEntry => ({ id, code, state: state === 'approved' && id !== g?.id ? 'pending' : state }));
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
    const g = this.grant;
    if (!g || g.id !== m.from || g.seq !== m.grant) return fail('not-approved');
    if (m.id <= (this.seen.get(m.from) ?? 0)) return fail('duplicate');
    this.seen.set(m.from, m.id);
    if (!this.bucket.take()) return fail('rate');
    // A song change waiting for its debounce (or for the panel to set it) is already what the panel shows.
    const pub = this.published;
    if (!pub || m.epoch !== this.epoch || m.rev !== pub.rev) return fail('stale');
    if (this.busy) return fail('busy');
    this.busy = true;
    let released = false;
    const release = () => {
      if (!released) this.busy = false;
      released = true;
    };
    const run = { grant: g.seq, ctl: new AbortController() };
    this.running.add(run);
    const context: CommandContext = {
      // The same checks as above, for every later player command: a new revision (or none) is `stale`.
      check: () => {
        if (this.published !== pub) return 'stale';
        const now = this.grant;
        return this.control && now && now.id === m.from && now.seq === m.grant ? null : 'cancelled';
      },
      target: pub.target,
    };
    this.o
      .onCommand(
        m.cmd,
        (o) => {
          // Once the count-in runs, the phone may send the next command (pause cancels it).
          release();
          reply(o);
        },
        run.ctl.signal,
        context,
      )
      .catch((): CommandOutcome => ({ ok: false, code: 'failed' }))
      .then((o) => {
        this.running.delete(run);
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
