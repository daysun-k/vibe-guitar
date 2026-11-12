/**
 * VGT-13 phone probe: wire protocol and pure timing math (spike, not merged).
 *
 * Roles: the extension probe page is the *publisher* (Mac, loopback only), the phone page is a
 * *viewer* (home LAN). The Mac is the timing authority: every state carries an anchor
 * (`at` in Mac wall-clock ms, `position` in song seconds, `rate`, `paused`) and the viewer
 * extrapolates `position = anchor.position + rate * (macNow - anchor.at)`, where
 * `macNow = phoneNow + offset` and `offset` comes from ping round trips to the relay.
 * No audio, no lyrics, synthetic chord names only.
 */

export const MAX_MESSAGE_BYTES = 8192;
export const MAX_CHORDS = 64;
/** A viewer treats its anchor as expired when no state arrived for this long. */
export const ANCHOR_TTL_MS = 3000;
/** The publisher re-sends its current anchor this often, even when paused. */
export const HEARTBEAT_MS = 1000;

export interface ChordEvent {
  /** Song position in seconds where this chord starts. */
  at: number;
  name: string;
}

export interface Song {
  bpm: number;
  beatsPerBar: number;
  duration: number;
  chords: ChordEvent[];
}

export interface Anchor {
  /** Changes only on a discontinuity (play, pause, seek, rate, loop jump); heartbeats keep it. */
  id: number;
  /** Mac wall-clock ms at which the song was at `position`. */
  at: number;
  position: number;
  rate: number;
  paused: boolean;
}

export interface Loop {
  a: number;
  b: number;
}

export interface StateMessage {
  t: 'state';
  epoch: string;
  seq: number;
  song: Song;
  anchor: Anchor;
  loop: Loop | null;
}

export interface MarkMessage {
  t: 'mark';
  epoch: string;
  index: number;
  /** Mac wall-clock ms of the frame where the publisher showed chord `index`. */
  at: number;
}

export type PublisherMessage = StateMessage | MarkMessage;

export interface PingMessage {
  t: 'ping';
  id: number;
  /** Viewer clock ms when sent. */
  c: number;
}

export type ViewerMessage = PingMessage;

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

export type RelayToViewer = StateMessage | MarkMessage | PongMessage | PublisherStatusMessage;

// ---------- validation ----------

const EPOCH_RE = /^[a-z0-9]{8,32}$/;
const CHORD_NAME_RE = /^[A-Za-z0-9#♯♭+\-/().°ø]{1,12}$/;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function finite(v: unknown, min: number, max: number): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
}
function int(v: unknown, min: number, max: number): v is number {
  return finite(v, min, max) && Number.isInteger(v);
}
function onlyKeys(o: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(o).every((k) => keys.includes(k));
}

/** Parses raw text and returns a validated copy (no extra fields), or null. */
function parseJson(text: string): unknown {
  if (typeof text !== 'string' || text.length > MAX_MESSAGE_BYTES) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function validSong(v: unknown): Song | null {
  if (!isObj(v) || !onlyKeys(v, ['bpm', 'beatsPerBar', 'duration', 'chords'])) return null;
  if (!finite(v.bpm, 20, 300) || !int(v.beatsPerBar, 1, 12) || !finite(v.duration, 1, 3600)) return null;
  if (!Array.isArray(v.chords) || v.chords.length < 1 || v.chords.length > MAX_CHORDS) return null;
  const chords: ChordEvent[] = [];
  let prev = -1;
  for (const c of v.chords) {
    if (!isObj(c) || !onlyKeys(c, ['at', 'name'])) return null;
    if (!finite(c.at, 0, v.duration) || c.at <= prev) return null;
    if (typeof c.name !== 'string' || !CHORD_NAME_RE.test(c.name)) return null;
    chords.push({ at: c.at, name: c.name });
    prev = c.at;
  }
  if (chords[0]!.at !== 0) return null;
  return { bpm: v.bpm, beatsPerBar: v.beatsPerBar, duration: v.duration, chords };
}

export function validatePublisherMessage(text: string): PublisherMessage | null {
  const v = parseJson(text);
  if (!isObj(v)) return null;
  if (typeof v.epoch !== 'string' || !EPOCH_RE.test(v.epoch)) return null;
  if (v.t === 'mark') {
    if (!onlyKeys(v, ['t', 'epoch', 'index', 'at'])) return null;
    if (!int(v.index, 0, MAX_CHORDS - 1) || !finite(v.at, 0, 1e15)) return null;
    return { t: 'mark', epoch: v.epoch, index: v.index, at: v.at };
  }
  if (v.t !== 'state' || !onlyKeys(v, ['t', 'epoch', 'seq', 'song', 'anchor', 'loop'])) return null;
  if (!int(v.seq, 0, Number.MAX_SAFE_INTEGER)) return null;
  const song = validSong(v.song);
  if (!song) return null;
  const a = v.anchor;
  if (!isObj(a) || !onlyKeys(a, ['id', 'at', 'position', 'rate', 'paused'])) return null;
  if (!int(a.id, 0, Number.MAX_SAFE_INTEGER) || !finite(a.at, 0, 1e15) || !finite(a.position, 0, song.duration)) return null;
  if (!finite(a.rate, 0.25, 2) || typeof a.paused !== 'boolean') return null;
  let loop: Loop | null = null;
  if (v.loop !== null) {
    const l = v.loop;
    if (!isObj(l) || !onlyKeys(l, ['a', 'b']) || !finite(l.a, 0, song.duration) || !finite(l.b, 0, song.duration)) return null;
    if (l.b - l.a < 0.5) return null;
    loop = { a: l.a, b: l.b };
  }
  return {
    t: 'state',
    epoch: v.epoch,
    seq: v.seq,
    song,
    anchor: { id: a.id, at: a.at, position: a.position, rate: a.rate, paused: a.paused },
    loop,
  };
}

export function validateViewerMessage(text: string): ViewerMessage | null {
  const v = parseJson(text);
  if (!isObj(v) || v.t !== 'ping' || !onlyKeys(v, ['t', 'id', 'c'])) return null;
  if (!int(v.id, 0, Number.MAX_SAFE_INTEGER) || !finite(v.c, 0, 1e15)) return null;
  return { t: 'ping', id: v.id, c: v.c };
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

/**
 * Publisher endpoint (loopback): Host must be the loopback address and Origin a Chrome extension
 * (optionally one specific extension id), so an ordinary web page cannot publish.
 */
export function publisherAllowed(req: RequestInfo, port: number, extensionId?: string): boolean {
  if (req.host !== `127.0.0.1:${port}` && req.host !== `localhost:${port}`) return false;
  if (!req.origin || !EXT_ORIGIN_RE.test(req.origin)) return false;
  return !extensionId || req.origin === `chrome-extension://${extensionId}`;
}

// ---------- timing math ----------

/** Song position (seconds) at Mac time `macNow`, applying the A/B loop and the song end. */
export function positionAt(anchor: Anchor, loop: Loop | null, duration: number, macNow: number): number {
  if (anchor.paused) return anchor.position;
  let p = anchor.position + (anchor.rate * (macNow - anchor.at)) / 1000;
  if (loop && anchor.position < loop.b && p >= loop.b) p = loop.a + ((p - loop.b) % (loop.b - loop.a));
  return Math.max(0, Math.min(duration, p));
}

/** Index of the chord sounding at `pos` (chords sorted, first at 0). */
export function chordIndexAt(chords: ChordEvent[], pos: number): number {
  let lo = 0;
  let hi = chords.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (chords[mid]!.at <= pos) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export interface Upcoming {
  index: number;
  nextIndex: number;
  /** Song seconds until the next change (before rate). */
  songSeconds: number;
  /** Wall seconds until the next change at the current rate; Infinity when paused. */
  wallSeconds: number;
  beats: number;
}

/** Current chord, the next one and the time to the change, honoring the loop wrap. */
export function upcoming(song: Song, anchor: Anchor, loop: Loop | null, pos: number): Upcoming {
  const { chords } = song;
  const index = chordIndexAt(chords, pos);
  let nextIndex = index + 1;
  let changeAt = nextIndex < chords.length ? chords[nextIndex]!.at : song.duration;
  if (loop && pos < loop.b && changeAt >= loop.b) {
    nextIndex = chordIndexAt(chords, loop.a);
    changeAt = loop.b;
  } else if (nextIndex >= chords.length) nextIndex = index;
  const songSeconds = Math.max(0, changeAt - pos);
  return {
    index,
    nextIndex,
    songSeconds,
    wallSeconds: anchor.paused ? Infinity : songSeconds / anchor.rate,
    beats: (songSeconds * song.bpm) / 60,
  };
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
  index: number;
  /** Mac-clock ms of the frame that showed `index`. */
  at: number;
}

/**
 * Pairs a publisher mark with the viewer's own change to the same chord within `windowMs`
 * and returns viewer minus publisher in ms (positive = phone late), or null.
 */
export function matchChange(viewerChanges: Change[], mark: Change, windowMs = 1500): number | null {
  let best: number | null = null;
  for (const c of viewerChanges) {
    if (c.index !== mark.index) continue;
    const d = c.at - mark.at;
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

/** True when a state is newer than what the viewer holds (new epoch, or a higher seq). */
export function isNewer(prev: { epoch: string; seq: number } | null, next: { epoch: string; seq: number }): boolean {
  return !prev || prev.epoch !== next.epoch || next.seq > prev.seq;
}
