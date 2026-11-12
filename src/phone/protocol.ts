/**
 * VGT-13 phone music stand: wire protocol and pure timing math.
 *
 * Roles: the side panel is the *publisher* (Mac, loopback only), the phone page is a *viewer*
 * (home LAN). The Mac is the timing authority: every anchor carries `sampledAt` (Mac wall-clock
 * ms), `position` (song seconds), `rate`, `paused` and `ad`, and the viewer extrapolates
 * `position + rate * (macNow - sampledAt)`, where `macNow = phoneNow + offset` and `offset` comes
 * from ping round trips to the relay. The song itself travels as a "song view" (see song-view.ts)
 * split into parts that each fit one frame. No audio, no lyrics, no storage keys.
 *
 * VGT-16 adds phone control: with 휴대폰에서 조작 허용 on, each phone connection gets a pairing code;
 * the panel approves one of them, and only that connection may send the two commands (play/pause
 * toggle, restart). The QR token stays the viewing credential; the approval is the control one.
 */
import { validateSongView, type SongView } from './song-view';

export const MAX_MESSAGE_BYTES = 8192;
/** A song view may span at most this many frames (about 120 KiB of JSON). */
export const MAX_SONG_PARTS = 16;
/** A viewer treats its anchor as expired when none arrived for this long. */
export const ANCHOR_TTL_MS = 3000;
/** The publisher re-sends a fresh anchor this often, even when paused. */
export const HEARTBEAT_MS = 1000;
export const DEFAULT_PUBLISHER_PORT = 47821;
export const DEFAULT_VIEWER_PORT = 47822;
/** Playback rates outside this range are clamped by the publisher before sending. */
export const RATE_MIN = 0.1;
export const RATE_MAX = 4;
const MAX_POSITION_SEC = 4 * 3600;

export interface Loop {
  a: number;
  b: number;
}

/** One frame of a song view: `d` is a slice of the view's JSON text; parts are joined in order. */
export interface SongPartMessage {
  t: 'song';
  epoch: string;
  /** Song view revision inside this epoch; a higher one replaces the shown song. */
  rev: number;
  i: number;
  n: number;
  d: string;
}

export interface AnchorMessage {
  t: 'anchor';
  epoch: string;
  /** Increases with every anchor in this epoch (heartbeats included). */
  seq: number;
  /** Mac wall-clock ms at which the song was at `position`. */
  sampledAt: number;
  position: number;
  rate: number;
  paused: boolean;
  /** An ad is playing: the phone shows "광고 중" and holds the chord. */
  ad: boolean;
  loop: Loop | null;
}

export type PublisherMessage = SongPartMessage | AnchorMessage;

export interface PingMessage {
  t: 'ping';
  id: number;
  /** Viewer clock ms when sent. */
  c: number;
}

/**
 * VGT-16: one control request from the approved phone. Exactly two commands exist; the phone never
 * names a time, rate, tab or URL. `epoch`/`rev` are the song view the phone shows: a request made
 * against another song (or another panel) is rejected as stale. `id` increases per connection.
 */
export interface CommandMessage {
  t: 'cmd';
  id: number;
  epoch: string;
  rev: number;
  cmd: PhoneCommand;
}

export type ViewerMessage = PingMessage | CommandMessage;

export interface PongMessage {
  t: 'pong';
  id: number;
  c: number;
  /** Relay (Mac) wall-clock ms when answered. */
  s: number;
}

export interface PublisherStatusMessage {
  t: 'publisher';
  connected: boolean;
}

export interface ViewersMessage {
  t: 'viewers';
  n: number;
}

export type RelayToViewer = SongPartMessage | AnchorMessage | PongMessage | PublisherStatusMessage | PairMessage | ResultMessage;

// ---------- validation ----------

const EPOCH_RE = /^[a-z0-9]{8,32}$/;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
export function finite(v: unknown, min: number, max: number): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
}
export function int(v: unknown, min: number, max: number): v is number {
  return finite(v, min, max) && Number.isInteger(v);
}
export function onlyKeys(o: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(o).every((k) => keys.includes(k));
}

const encoder = new TextEncoder();
export function utf8Length(text: string): number {
  return encoder.encode(text).length;
}

function parseJson(text: string): unknown {
  if (typeof text !== 'string' || text.length > MAX_MESSAGE_BYTES) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function validLoop(v: unknown): Loop | null | undefined {
  if (v === null) return null;
  if (!isObj(v) || !onlyKeys(v, ['a', 'b']) || !finite(v.a, 0, MAX_POSITION_SEC) || !finite(v.b, 0, MAX_POSITION_SEC)) return undefined;
  if (v.b - v.a < 0.25) return undefined;
  return { a: v.a, b: v.b };
}

/** Returns a validated copy (no extra fields) of a publisher message, or null. */
export function validatePublisherMessage(text: string): PublisherMessage | null {
  const v = parseJson(text);
  if (!isObj(v)) return null;
  if (typeof v.epoch !== 'string' || !EPOCH_RE.test(v.epoch)) return null;
  if (v.t === 'song') {
    if (!onlyKeys(v, ['t', 'epoch', 'rev', 'i', 'n', 'd'])) return null;
    if (!int(v.rev, 1, Number.MAX_SAFE_INTEGER) || !int(v.n, 1, MAX_SONG_PARTS) || !int(v.i, 0, v.n - 1)) return null;
    if (typeof v.d !== 'string' || v.d.length === 0) return null;
    return { t: 'song', epoch: v.epoch, rev: v.rev, i: v.i, n: v.n, d: v.d };
  }
  if (v.t !== 'anchor' || !onlyKeys(v, ['t', 'epoch', 'seq', 'sampledAt', 'position', 'rate', 'paused', 'ad', 'loop'])) return null;
  if (!int(v.seq, 1, Number.MAX_SAFE_INTEGER) || !finite(v.sampledAt, 0, 1e15) || !finite(v.position, 0, MAX_POSITION_SEC)) return null;
  if (!finite(v.rate, RATE_MIN, RATE_MAX) || typeof v.paused !== 'boolean' || typeof v.ad !== 'boolean') return null;
  const loop = validLoop(v.loop);
  if (loop === undefined) return null;
  return { t: 'anchor', epoch: v.epoch, seq: v.seq, sampledAt: v.sampledAt, position: v.position, rate: v.rate, paused: v.paused, ad: v.ad, loop };
}

export function validateViewerMessage(text: string): ViewerMessage | null {
  const v = parseJson(text);
  if (!isObj(v)) return null;
  if (v.t === 'cmd') return validCommand(v, false) as CommandMessage | null;
  if (v.t !== 'ping' || !onlyKeys(v, ['t', 'id', 'c'])) return null;
  if (!int(v.id, 0, Number.MAX_SAFE_INTEGER) || !finite(v.c, 0, 1e15)) return null;
  return { t: 'ping', id: v.id, c: v.c };
}

// ---------- phone control (VGT-16) ----------

export type PhoneCommand = 'toggle' | 'restart';
/** Commands the approved phone may send per second, and how many may come at once. */
export const CONTROL_RATE_PER_SEC = 4;
export const CONTROL_BURST = 2;
/** The panel reports a command's outcome once the player shows it, or gives up after this long. */
export const CONTROL_OBSERVE_MS = 3000;
/** Pairing code shown on the phone and compared on the panel. */
export const PAIR_CODE_RE = /^\d{4}$/;
/** Relay-assigned id of one viewer connection (never reused for another connection). */
export const CONN_ID_RE = /^[a-z0-9]{12}$/;

export type CommandFailure =
  /** 휴대폰에서 조작 허용 is off. */
  | 'off'
  /** This connection is not the approved phone. */
  | 'not-approved'
  /** The song (or the panel) changed since the phone got it. */
  | 'stale'
  /** Request id already seen on this connection. */
  | 'duplicate'
  | 'rate'
  | 'ad'
  /** No player (or no song) the panel may control. */
  | 'no-target'
  /** The panel is still carrying out the previous command. */
  | 'busy'
  /** Play was sent but the player stayed paused (most likely the browser's autoplay rule). */
  | 'autoplay'
  | 'timeout'
  | 'failed'
  /** The phone lost the right to control while the command ran: nothing further was sent to the player. */
  | 'cancelled'
  /** No side panel is connected to the relay. */
  | 'no-panel';
const FAILURES: readonly CommandFailure[] = ['off', 'not-approved', 'stale', 'duplicate', 'rate', 'ad', 'no-target', 'busy', 'autoplay', 'timeout', 'failed', 'cancelled', 'no-panel'];

/** 'countin': the count-in started; a second result with the same id follows once playback starts (or fails). */
export type CommandState = 'playing' | 'paused' | 'countin';
const STATES: readonly CommandState[] = ['playing', 'paused', 'countin'];

export type CommandOutcome = { ok: true; state: CommandState } | { ok: false; code: CommandFailure };

/** Relay -> panel: a command the relay accepted from the approved viewer `from`. */
export interface ForwardedCommand extends CommandMessage {
  from: string;
}

/** Relay -> viewer: the outcome of request `id`. */
export type ResultMessage = { t: 'result'; id: number } & CommandOutcome;

export type PairState = 'pending' | 'approved' | 'rejected';
/** Relay -> viewer: this connection's pairing state ('off': control is not allowed on the panel). */
export type PairMessage = { t: 'pair'; state: 'off' } | { t: 'pair'; state: PairState; code: string };

export interface PhoneEntry {
  id: string;
  code: string;
  state: PairState;
}

/** Relay -> panel: the connected phones and their codes (empty while control is off). */
export interface PhonesMessage {
  t: 'phones';
  list: PhoneEntry[];
}

/** Panel -> relay messages besides the song view and anchors. */
export type PanelMessage =
  | { t: 'control'; on: boolean }
  | { t: 'approve'; id: string; code: string }
  | { t: 'reject'; id: string; code: string }
  | { t: 'revoke' }
  | ({ t: 'result'; to: string; id: number } & CommandOutcome);

function validCommand(v: Record<string, unknown>, forwarded: boolean): CommandMessage | ForwardedCommand | null {
  if (!onlyKeys(v, forwarded ? ['t', 'id', 'epoch', 'rev', 'cmd', 'from'] : ['t', 'id', 'epoch', 'rev', 'cmd'])) return null;
  if (!int(v.id, 1, Number.MAX_SAFE_INTEGER) || !int(v.rev, 1, Number.MAX_SAFE_INTEGER)) return null;
  if (typeof v.epoch !== 'string' || !EPOCH_RE.test(v.epoch) || (v.cmd !== 'toggle' && v.cmd !== 'restart')) return null;
  const m: CommandMessage = { t: 'cmd', id: v.id, epoch: v.epoch, rev: v.rev, cmd: v.cmd };
  if (!forwarded) return m;
  if (typeof v.from !== 'string' || !CONN_ID_RE.test(v.from)) return null;
  return { ...m, from: v.from };
}

/** Validates the outcome fields of a result; `extra` are the keys allowed besides them. */
function validOutcome(v: Record<string, unknown>, extra: string[]): CommandOutcome | null {
  if (v.ok === true) {
    if (!onlyKeys(v, [...extra, 'ok', 'state']) || !STATES.includes(v.state as CommandState)) return null;
    return { ok: true, state: v.state as CommandState };
  }
  if (v.ok !== false || !onlyKeys(v, [...extra, 'ok', 'code']) || !FAILURES.includes(v.code as CommandFailure)) return null;
  return { ok: false, code: v.code as CommandFailure };
}

function validEntry(v: unknown): PhoneEntry | null {
  if (!isObj(v) || !onlyKeys(v, ['id', 'code', 'state'])) return null;
  if (typeof v.id !== 'string' || !CONN_ID_RE.test(v.id) || typeof v.code !== 'string' || !PAIR_CODE_RE.test(v.code)) return null;
  if (v.state !== 'pending' && v.state !== 'approved' && v.state !== 'rejected') return null;
  return { id: v.id, code: v.code, state: v.state };
}

/** Panel messages for the relay (pairing decisions, the control switch, command results), or null. */
export function validatePanelMessage(text: string): PanelMessage | null {
  const v = parseJson(text);
  if (!isObj(v)) return null;
  switch (v.t) {
    case 'control':
      return onlyKeys(v, ['t', 'on']) && typeof v.on === 'boolean' ? { t: 'control', on: v.on } : null;
    case 'approve':
    case 'reject': {
      if (!onlyKeys(v, ['t', 'id', 'code']) || typeof v.id !== 'string' || !CONN_ID_RE.test(v.id)) return null;
      if (typeof v.code !== 'string' || !PAIR_CODE_RE.test(v.code)) return null;
      return { t: v.t, id: v.id, code: v.code };
    }
    case 'revoke':
      return onlyKeys(v, ['t']) ? { t: 'revoke' } : null;
    case 'result': {
      if (typeof v.to !== 'string' || !CONN_ID_RE.test(v.to) || !int(v.id, 1, Number.MAX_SAFE_INTEGER)) return null;
      const o = validOutcome(v, ['t', 'to', 'id']);
      return o ? { t: 'result', to: v.to, id: v.id, ...o } : null;
    }
    default:
      return null;
  }
}

/** Relay -> panel messages the panel acts on, or null (the panel ignores anything else). */
export function validateRelayToPanel(text: string): { t: 'viewers'; n: number } | PhonesMessage | ForwardedCommand | null {
  const v = parseJson(text);
  if (!isObj(v)) return null;
  if (v.t === 'viewers') return onlyKeys(v, ['t', 'n']) && int(v.n, 0, 1000) ? { t: 'viewers', n: v.n } : null;
  if (v.t === 'cmd') return validCommand(v, true) as ForwardedCommand | null;
  if (v.t !== 'phones' || !onlyKeys(v, ['t', 'list']) || !Array.isArray(v.list) || v.list.length > 16) return null;
  const list: PhoneEntry[] = [];
  for (const e of v.list) {
    const ok = validEntry(e);
    if (!ok) return null;
    list.push(ok);
  }
  return { t: 'phones', list };
}

/** Relay -> viewer pairing and result messages, or null. */
export function validateRelayToViewer(text: string): PairMessage | ResultMessage | null {
  const v = parseJson(text);
  if (!isObj(v)) return null;
  if (v.t === 'pair') {
    if (v.state === 'off') return onlyKeys(v, ['t', 'state']) ? { t: 'pair', state: 'off' } : null;
    if (!onlyKeys(v, ['t', 'state', 'code']) || typeof v.code !== 'string' || !PAIR_CODE_RE.test(v.code)) return null;
    if (v.state !== 'pending' && v.state !== 'approved' && v.state !== 'rejected') return null;
    return { t: 'pair', state: v.state, code: v.code };
  }
  if (v.t !== 'result' || !int(v.id, 1, Number.MAX_SAFE_INTEGER)) return null;
  const o = validOutcome(v, ['t', 'id']);
  return o ? { t: 'result', id: v.id, ...o } : null;
}

/**
 * Token bucket: `burst` commands at once, refilled at `perSec`. Excess is rejected, never queued.
 */
export class TokenBucket {
  private tokens: number;
  private at: number;

  constructor(
    private readonly perSec = CONTROL_RATE_PER_SEC,
    private readonly burst = CONTROL_BURST,
    private readonly now: () => number = Date.now,
  ) {
    this.tokens = burst;
    this.at = now();
  }

  take(): boolean {
    const t = this.now();
    this.tokens = Math.min(this.burst, this.tokens + (Math.max(0, t - this.at) * this.perSec) / 1000);
    this.at = t;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

/** True when a message is newer than what is held (new epoch, or a higher number in the same one). */
export function isNewer(prev: { epoch: string; n: number } | null, next: { epoch: string; n: number }): boolean {
  return !prev || prev.epoch !== next.epoch || next.n > prev.n;
}

// ---------- song view parts ----------

/**
 * Splits a song view into part messages whose JSON text is at most `maxBytes` (UTF-8) each.
 * Returns null when it would need more than MAX_SONG_PARTS parts.
 */
export function songParts(view: SongView, epoch: string, rev: number, maxBytes = MAX_MESSAGE_BYTES): SongPartMessage[] | null {
  const json = JSON.stringify(view);
  const chunks: string[] = [];
  let at = 0;
  while (at < json.length) {
    // Escaping in the envelope can grow a slice, so shrink until the whole message fits.
    let len = Math.min(json.length - at, maxBytes);
    for (;;) {
      let end = at + len;
      // Never split a surrogate pair.
      if (end < json.length && /[\uD800-\uDBFF]/.test(json[end - 1]!)) end--;
      const d = json.slice(at, end);
      const probe: SongPartMessage = { t: 'song', epoch, rev, i: MAX_SONG_PARTS, n: MAX_SONG_PARTS, d };
      if (utf8Length(JSON.stringify(probe)) <= maxBytes) {
        chunks.push(d);
        at = end;
        break;
      }
      len = Math.floor(len * 0.85);
      if (len < 16) return null;
    }
    if (chunks.length > MAX_SONG_PARTS) return null;
  }
  return chunks.map((d, i) => ({ t: 'song', epoch, rev, i, n: chunks.length, d }));
}

/**
 * Collects song parts (relay and viewer). `add` returns the validated view once every part of a
 * revision is in, 'pending' while parts are missing, 'stale' for a revision not newer than the
 * held one, and 'invalid' when the joined text is not a valid song view.
 */
export class SongAssembler {
  private pending: { epoch: string; rev: number; n: number; parts: (SongPartMessage | undefined)[] } | null = null;
  current: { epoch: string; rev: number; view: SongView; parts: SongPartMessage[] } | null = null;

  add(p: SongPartMessage): SongView | 'pending' | 'stale' | 'invalid' {
    if (this.current && !isNewer({ epoch: this.current.epoch, n: this.current.rev }, { epoch: p.epoch, n: p.rev })) return 'stale';
    if (!this.pending || this.pending.epoch !== p.epoch || this.pending.rev !== p.rev) {
      // A newer revision (or epoch) replaces a half-received one.
      if (this.pending && this.pending.epoch === p.epoch && p.rev < this.pending.rev) return 'stale';
      this.pending = { epoch: p.epoch, rev: p.rev, n: p.n, parts: Array.from({ length: p.n }, () => undefined) };
    }
    const pend = this.pending;
    if (p.n !== pend.n) {
      this.pending = null;
      return 'invalid';
    }
    pend.parts[p.i] = p;
    if (pend.parts.some((x) => x === undefined)) return 'pending';
    this.pending = null;
    const parts = pend.parts as SongPartMessage[];
    let view: SongView | null = null;
    try {
      view = validateSongView(JSON.parse(parts.map((x) => x.d).join('')));
    } catch {
      view = null;
    }
    if (!view) return 'invalid';
    this.current = { epoch: p.epoch, rev: p.rev, view, parts };
    return view;
  }

  clear(): void {
    this.pending = null;
    this.current = null;
  }
}

// ---------- access checks ----------

/** 128-bit token, base64url without padding: 22 characters. */
export const TOKEN_RE = /^[A-Za-z0-9_-]{22}$/;

/** Constant-time string comparison (time depends only on the expected token's length). */
export function tokenMatches(expected: string, given: string | null | undefined): boolean {
  if (typeof given !== 'string') return false;
  let diff = expected.length ^ given.length;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ (given.charCodeAt(i) || 0);
  return diff === 0;
}

export interface RequestInfo {
  host: string | undefined;
  origin: string | undefined;
}

/** Viewer endpoint (LAN): Host must be exactly the advertised address (blocks DNS rebinding). */
export function viewerHostAllowed(req: RequestInfo, lanHost: string): boolean {
  return req.host === lanHost;
}

/** Viewer WebSocket: a browser always sends Origin; it must be our own page. */
export function viewerOriginAllowed(req: RequestInfo, lanHost: string): boolean {
  return req.origin === `http://${lanHost}`;
}

const EXT_ORIGIN_RE = /^chrome-extension:\/\/[a-p]{32}$/;
export const EXTENSION_ID_RE = /^[a-p]{32}$/;

/**
 * Publisher endpoint (loopback): Host must be the loopback address and Origin a Chrome extension;
 * with `extensionId` set, only that extension.
 */
export function publisherAllowed(req: RequestInfo, port: number, extensionId?: string): boolean {
  if (req.host !== `127.0.0.1:${port}` && req.host !== `localhost:${port}`) return false;
  if (!req.origin || !EXT_ORIGIN_RE.test(req.origin)) return false;
  return !extensionId || req.origin === `chrome-extension://${extensionId}`;
}

// ---------- timing math ----------

/** Song position (seconds) at Mac time `macNow`: held while paused or during an ad, wrapped by the loop. */
export function positionAt(anchor: Pick<AnchorMessage, 'sampledAt' | 'position' | 'rate' | 'paused' | 'ad' | 'loop'>, duration: number, macNow: number): number {
  if (anchor.paused || anchor.ad) return anchor.position;
  let p = anchor.position + (anchor.rate * (macNow - anchor.sampledAt)) / 1000;
  const loop = anchor.loop;
  if (loop && anchor.position < loop.b && p >= loop.b) p = loop.a + ((p - loop.b) % (loop.b - loop.a));
  return Math.max(0, Math.min(duration, p));
}

export interface ClockSample {
  /** Round trip in ms (viewer clock). */
  rtt: number;
  /** Relay clock minus viewer clock, ms. */
  offset: number;
}

/** One ping round trip: c0 sent, s relay time, c1 received (c0, c1 on the viewer clock). */
export function clockSample(c0: number, s: number, c1: number): ClockSample {
  return { rtt: c1 - c0, offset: s - (c0 + c1) / 2 };
}

/**
 * Clock granularity allowed per sample: the relay stamps with Date.now() (whole ms, floored) and a
 * phone browser may floor performance.now() to 1 ms. Each sample's interval is widened by this much.
 */
export const CLOCK_RESOLUTION_MS = 1;

export interface ClockEstimate {
  offset: number;
  /**
   * Error bound in ms: |true offset - offset| <= bound whenever every sample's interval
   * `offset_i ± (rtt_i / 2 + CLOCK_RESOLUTION_MS)` holds (true for any delay asymmetry).
   */
  bound: number;
  /** False when the sample intervals do not overlap (clock drift or a stall); bound is then a best guess. */
  consistent: boolean;
  /** Lowest RTT seen. */
  rtt: number;
  samples: number;
}

/**
 * Each round trip proves the true offset lies in `offset_i ± (rtt_i / 2 + resolution)`, whatever the
 * split between the two one-way delays. The estimate is the middle of the intersection of those
 * intervals and the bound is half its width. If they do not intersect, fall back to the lowest-RTT
 * sample and mark the estimate inconsistent. Callers should pass recent samples only (drift).
 */
export function estimateOffset(samples: ClockSample[]): ClockEstimate | null {
  const good = samples.filter((s) => Number.isFinite(s.rtt) && s.rtt >= 0 && Number.isFinite(s.offset));
  if (!good.length) return null;
  let lo = -Infinity;
  let hi = Infinity;
  let best = good[0]!;
  for (const s of good) {
    const half = s.rtt / 2 + CLOCK_RESOLUTION_MS;
    lo = Math.max(lo, s.offset - half);
    hi = Math.min(hi, s.offset + half);
    if (s.rtt < best.rtt) best = s;
  }
  if (lo <= hi) return { offset: (lo + hi) / 2, bound: (hi - lo) / 2, consistent: true, rtt: best.rtt, samples: good.length };
  return { offset: best.offset, bound: best.rtt / 2 + CLOCK_RESOLUTION_MS, consistent: false, rtt: best.rtt, samples: good.length };
}

export function median(xs: number[]): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export interface Change {
  /** Event index that became current. */
  index: number;
  /** Mac-clock ms of the frame that showed it. */
  at: number;
}

/** Pairs a reference change with the nearest change to the same event within `windowMs`; returns other minus reference ms, or null. */
export function matchChange(changes: Change[], ref: Change, windowMs = 1500): number | null {
  let best: number | null = null;
  for (const c of changes) {
    if (c.index !== ref.index) continue;
    const d = c.at - ref.at;
    if (Math.abs(d) <= windowMs && (best === null || Math.abs(d) < Math.abs(best))) best = d;
  }
  return best;
}

export interface ErrorSummary {
  n: number;
  medianAbs: number;
  worstAbs: number;
  mean: number;
}

export function summarizeErrors(errors: number[]): ErrorSummary {
  const abs = errors.map(Math.abs);
  return {
    n: errors.length,
    medianAbs: median(abs),
    worstAbs: abs.length ? Math.max(...abs) : NaN,
    mean: errors.length ? errors.reduce((a, b) => a + b, 0) / errors.length : NaN,
  };
}
