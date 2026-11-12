/// <reference types="node" />
/**
 * VGT-13 phone music stand relay (`npm run phone`). Two HTTP servers in one process:
 *  - publisher endpoint on 127.0.0.1 only: the side panel connects to ws://127.0.0.1:<pubPort>/publish;
 *  - viewer endpoint on the LAN address only: the phone loads http://<lan>:<port>/?t=<token> and opens /viewer.
 * The token is 128 random bits created at start, kept in memory and never written anywhere.
 * It is an access check for a trusted home LAN, not encryption: traffic is plain HTTP/WebSocket.
 * The relay keeps only the latest song view and anchor in memory and forwards them; nothing is stored.
 * VGT-16: it also keeps the pairing state (see pairing.ts) and forwards a control command only from
 * the approved viewer connection to the current publisher, after checking it (switch, approval,
 * duplicate id, rate, song revision). Results go back only to the connection that asked.
 */
import http from 'node:http';
import os from 'node:os';
import { createHash, randomBytes, randomInt } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import {
  DEFAULT_PUBLISHER_PORT,
  DEFAULT_VIEWER_PORT,
  MAX_MESSAGE_BYTES,
  SongAssembler,
  isNewer,
  publisherAllowed,
  TokenBucket,
  tokenMatches,
  validatePanelMessage,
  validatePublisherMessage,
  validateViewerMessage,
  viewerHostAllowed,
  viewerOriginAllowed,
  type AnchorMessage,
  type CommandFailure,
  type CommandMessage,
  type PanelMessage,
} from './protocol';
import { Pairing } from './pairing';
import { OP_CLOSE, OP_PING, OP_PONG, OP_TEXT, closeFrame, decodeText, encodeFrame, parseFrames, textFrame } from './ws-frame';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MSGS_PER_SEC = 40;
const IDLE_MS = 20_000;

export interface RelayOptions {
  /** LAN IPv4 to bind the viewer endpoint to; detected when omitted. One private IPv4 only (see viewerHostProblem). */
  host?: string;
  /** Unit tests only: allow 127.0.0.1 as the viewer address. Not reachable from npm run phone. */
  allowLoopback?: boolean;
  port?: number;
  pubPort?: number;
  /** When set, only this extension id may publish (otherwise any Chrome extension on this Mac). */
  extensionId?: string;
  maxViewers?: number;
  /**
   * Idle auto-stop: when no publisher (side panel) has been connected for this long, the relay closes
   * both listeners by itself. Viewers alone do not keep it running. Off when omitted.
   */
  idleStopMs?: number;
  /** Called once after an idle auto-stop has closed both listeners. */
  onIdleStop?: () => void;
  viewerHtml: string;
  viewerJs: string;
  log?: (line: string) => void;
}

export interface Relay {
  token: string;
  lanHost: string;
  viewerUrl: string;
  publisherUrl: string;
  /** Stops the relay; safe to call more than once. */
  close(): Promise<void>;
}

export function newToken(): string {
  return randomBytes(16).toString('base64url');
}

/** Id of one viewer connection: 12 base-36 characters, never shown to anyone but the panel. */
function newConnId(): string {
  return Array.from(randomBytes(12), (b) => (b % 36).toString(36)).join('');
}

interface ViewerInfo {
  id: string;
  /** Highest command id seen on this connection (ids must increase). */
  lastCmd: number;
  bucket: TokenBucket;
}

/**
 * Id Chrome gives an unpacked extension loaded from `absPath` (the folder chosen in "Load unpacked",
 * symlinks resolved): SHA-256 of the path, first 32 hex digits mapped 0-f to a-p.
 */
export function unpackedExtensionId(absPath: string): string {
  const hex = createHash('sha256').update(absPath).digest('hex').slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
}

function isPrivateIpv4(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number) as [number, number];
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/** One dotted-quad IPv4 written plainly: four decimal octets 0-255, no leading zeros (Node reads "0" as 0.0.0.0). */
const IPV4_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/**
 * Checks an address for the viewer endpoint: exactly one concrete private (home network) IPv4, never a
 * wildcard, hostname, IPv6 or loopback. `allowLoopback` exists for the unit tests only.
 * Returns an error message, or null when the address is fine.
 */
export function viewerHostProblem(host: unknown, allowLoopback = false): string | null {
  if (typeof host !== 'string' || !IPV4_RE.test(host)) return `--host must be one IPv4 address such as 192.168.0.23 (got ${JSON.stringify(host)})`;
  if (allowLoopback && host === '127.0.0.1') return null;
  if (!isPrivateIpv4(host)) return `--host must be this Mac's private home-network address (10.x, 172.16-31.x or 192.168.x), not ${host}`;
  return null;
}

/** Picks the Wi-Fi/Ethernet private IPv4 (en0 first). */
export function pickLanAddress(): string | null {
  const ifs = os.networkInterfaces();
  const names = Object.keys(ifs).sort((x, y) => (x === 'en0' ? -1 : y === 'en0' ? 1 : x.localeCompare(y)));
  for (const name of names) {
    for (const a of ifs[name] ?? []) if (a.family === 'IPv4' && !a.internal && isPrivateIpv4(a.address)) return a.address;
  }
  return null;
}

class Conn {
  private buf: Uint8Array = new Uint8Array(0);
  private closed = false;
  private recent: number[] = [];
  lastRx = Date.now();

  constructor(
    private socket: Duplex,
    private onText: (text: string) => void,
    private onGone: () => void,
  ) {
    (socket as Duplex & { setNoDelay?: (on: boolean) => void }).setNoDelay?.(true);
    socket.on('close', () => this.gone());
    socket.on('error', () => this.gone());
  }

  /**
   * Starts reading. Called only after the caller has stored this object, because frames that
   * arrived together with the handshake (`head`) run the callbacks, which refer to it.
   */
  start(head: Buffer) {
    this.socket.on('data', (chunk: Buffer) => this.feed(chunk));
    if (head.length) this.feed(head);
  }

  private feed(chunk: Uint8Array) {
    if (this.closed) return;
    this.lastRx = Date.now();
    const merged = new Uint8Array(this.buf.length + chunk.length);
    merged.set(this.buf);
    merged.set(chunk, this.buf.length);
    const r = parseFrames(merged, MAX_MESSAGE_BYTES);
    this.buf = r.rest;
    for (const f of r.frames) {
      if (this.closed) return;
      if (f.opcode === OP_CLOSE) return this.close(1000, '');
      if (f.opcode === OP_PING) this.write(encodeFrame(OP_PONG, f.payload));
      if (f.opcode !== OP_TEXT) continue;
      const now = Date.now();
      this.recent = this.recent.filter((t) => now - t < 1000);
      this.recent.push(now);
      if (this.recent.length > MAX_MSGS_PER_SEC) return this.close(1008, 'rate limit');
      const text = decodeText(f.payload);
      if (text === null) return this.close(1007, 'invalid utf-8');
      try {
        this.onText(text);
      } catch {
        return this.close(1011, 'internal error');
      }
    }
    if (r.error) this.close(r.error.code, r.error.reason);
  }

  private write(bytes: Uint8Array) {
    if (!this.closed && this.socket.writable) this.socket.write(bytes);
  }

  send(text: string) {
    this.write(textFrame(text));
  }

  close(code: number, reason: string) {
    if (this.closed) return;
    this.write(closeFrame(code, reason));
    this.socket.end();
    setTimeout(() => this.socket.destroy(), 500).unref();
    this.gone();
  }

  destroy() {
    this.socket.destroy();
  }

  private gone() {
    if (this.closed) return;
    this.closed = true;
    this.onGone();
  }
}

/** A peer may reset at any moment; without a listener the 'error' would be thrown and stop the relay. */
function ignoreSocketErrors(socket: Duplex) {
  if (!socket.listenerCount('error')) socket.on('error', () => socket.destroy());
}

function reject(socket: Duplex, status: number, text: string) {
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  setTimeout(() => socket.destroy(), 200).unref();
}

function acceptUpgrade(req: http.IncomingMessage, socket: Duplex): boolean {
  const key = req.headers['sec-websocket-key'];
  if (
    req.method !== 'GET' ||
    String(req.headers.upgrade).toLowerCase() !== 'websocket' ||
    req.headers['sec-websocket-version'] !== '13' ||
    typeof key !== 'string' ||
    !/^[A-Za-z0-9+/]{22}==$/.test(key)
  ) {
    reject(socket, 400, 'Bad Request');
    return false;
  }
  const accept = createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  return true;
}

/** Parses a request target; null (= reject the request) instead of throwing on input like `//`. */
export function parseRequestUrl(raw: string | undefined, base: string): URL | null {
  try {
    return new URL(raw ?? '/', base);
  } catch {
    return null;
  }
}

function listen(server: http.Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, rejectP) => {
    server.once('error', rejectP);
    server.listen(port, host, () => {
      server.off('error', rejectP);
      resolve();
    });
  });
}

export async function startRelay(opts: RelayOptions): Promise<Relay> {
  const log = opts.log ?? (() => {});
  if (opts.host !== undefined) {
    const problem = viewerHostProblem(opts.host, opts.allowLoopback === true);
    if (problem) throw new Error(problem);
  }
  const host = opts.host ?? pickLanAddress();
  if (!host) throw new Error('no private LAN IPv4 address found (is Wi-Fi on?); pass --host <ip>');
  if (viewerHostProblem(host, opts.allowLoopback === true)) throw new Error(`refusing to bind the viewer endpoint to ${host}`);
  const maxViewers = opts.maxViewers ?? 4;
  // Final values are read back after listen() so port 0 (any free port, used by tests) works.
  let pubPort = opts.pubPort ?? DEFAULT_PUBLISHER_PORT;
  let lanHost = `${host}:${opts.port ?? DEFAULT_VIEWER_PORT}`;
  const token = newToken();

  const viewers = new Map<Conn, ViewerInfo>();
  const pairing = new Pairing(randomInt);
  let publisher: Conn | null = null;
  const song = new SongAssembler();
  let lastAnchor: AnchorMessage | null = null;

  // Idle auto-stop timer: runs only while no publisher is connected.
  let idleStopTimer: ReturnType<typeof setTimeout> | null = null;
  let closing: Promise<void> | null = null;
  // Set synchronously when close() starts, before any connection is closed: from then on no new request,
  // upgrade or idle timer is accepted (closing a publisher would otherwise re-arm the timer).
  let stopping = false;
  const disarmIdleStop = () => {
    if (idleStopTimer) clearTimeout(idleStopTimer);
    idleStopTimer = null;
  };
  const armIdleStop = () => {
    if (!opts.idleStopMs || idleStopTimer || stopping) return;
    idleStopTimer = setTimeout(() => {
      idleStopTimer = null;
      if (publisher || stopping) return;
      log(`no side panel connected for ${Math.round(opts.idleStopMs! / 1000)} s: stopping the relay`);
      void close().then(() => opts.onIdleStop?.());
    }, opts.idleStopMs);
  };

  const toViewers = (text: string) => viewers.forEach((_info, v) => v.send(text));
  const tellPublisherCount = () => publisher?.send(JSON.stringify({ t: 'viewers', n: viewers.size }));
  const tellPublisherPhones = () => publisher?.send(JSON.stringify({ t: 'phones', list: pairing.list() }));
  /** Tells every phone its pairing state and the panel the list (after any pairing change). */
  const tellPairing = () => {
    viewers.forEach((info, v) => v.send(JSON.stringify(pairing.stateFor(info.id))));
    tellPublisherPhones();
  };
  const viewerById = (id: string) => [...viewers].find(([, info]) => info.id === id)?.[0] ?? null;

  /** A command from a viewer: forwarded to the publisher only when every check passes. */
  const onCommand = (conn: Conn, info: ViewerInfo, m: CommandMessage) => {
    const fail = (code: CommandFailure) => conn.send(JSON.stringify({ t: 'result', id: m.id, ok: false, code }));
    if (!publisher) return fail('no-panel');
    if (!pairing.controlOn) return fail('off');
    const grant = pairing.grantOf(info.id);
    if (grant === null) return fail('not-approved');
    if (m.id <= info.lastCmd) return fail('duplicate');
    info.lastCmd = m.id;
    if (!info.bucket.take()) return fail('rate');
    const cur = song.current;
    if (!cur || cur.epoch !== m.epoch || cur.rev !== m.rev) return fail('stale');
    log(`phone command ${m.cmd} forwarded`);
    publisher.send(JSON.stringify({ ...m, from: info.id, grant }));
  };

  /** Pairing decisions, the control switch and command results from the publisher. */
  const onPanelMessage = (m: PanelMessage) => {
    switch (m.t) {
      case 'control':
        if (pairing.setControl(m.on)) {
          log(`phone control ${m.on ? 'allowed' : 'off'}`);
          tellPairing();
        }
        return;
      case 'approve':
        if (pairing.approve(m.id, m.code, m.grant)) {
          log(`phone ${m.code} approved`);
          tellPairing();
        }
        return;
      case 'reject':
        if (pairing.reject(m.id, m.code)) tellPairing();
        return;
      case 'revoke':
        if (pairing.revoke()) {
          log('phone approval revoked');
          tellPairing();
        }
        return;
      case 'result': {
        const { to, ...rest } = m;
        viewerById(to)?.send(JSON.stringify(rest));
        return;
      }
    }
  };

  // ---------- viewer endpoint (LAN) ----------
  const securityHeaders = {
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  };
  const viewerServer = http.createServer((req, res) => {
    const deny = (status: number, text: string) => {
      res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', ...securityHeaders });
      res.end(text);
    };
    if (stopping) return deny(503, 'relay stopping');
    if (!viewerHostAllowed({ host: req.headers.host, origin: undefined }, lanHost)) return deny(421, 'wrong host');
    if (req.method !== 'GET') return deny(405, 'method not allowed');
    const url = parseRequestUrl(req.url, `http://${lanHost}`);
    if (!url) return deny(400, 'bad request');
    if (url.pathname === '/viewer.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', ...securityHeaders });
      return res.end(opts.viewerJs);
    }
    if (url.pathname !== '/') return deny(404, 'not found');
    if (!tokenMatches(token, url.searchParams.get('t'))) {
      log(`viewer page: wrong token from ${req.socket.remoteAddress}`);
      return deny(403, 'wrong or missing token: scan the QR code printed by npm run phone');
    }
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': `default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src ws://${lanHost}; img-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      ...securityHeaders,
    });
    res.end(opts.viewerHtml);
  });
  // A bug in a handler must reject that one request, never stop the relay process.
  type UpgradeHandler = (req: http.IncomingMessage, socket: Duplex, head: Buffer) => void;
  const guarded = (fn: UpgradeHandler): UpgradeHandler => (req, socket, head) => {
    // Before any check: a client may reset right after a rejected (or accepted) upgrade.
    ignoreSocketErrors(socket);
    // A connection opened before close() started may still send an upgrade: never accept it while stopping.
    if (stopping) return reject(socket, 503, 'Service Unavailable');
    try {
      fn(req, socket, head);
    } catch (e) {
      log(`upgrade handler error: ${(e as Error).message}`);
      socket.destroy();
    }
  };
  viewerServer.on('upgrade', guarded((req, socket, head) => {
    const info = { host: req.headers.host, origin: req.headers.origin };
    const url = parseRequestUrl(req.url, `http://${lanHost}`);
    if (!url) return reject(socket, 400, 'Bad Request');
    if (url.pathname !== '/viewer' || !viewerHostAllowed(info, lanHost)) return reject(socket, 404, 'Not Found');
    if (!viewerOriginAllowed(info, lanHost)) return reject(socket, 403, 'Forbidden');
    if (!tokenMatches(token, url.searchParams.get('t'))) {
      log(`viewer socket: wrong token from ${req.socket.remoteAddress}`);
      return reject(socket, 403, 'Forbidden');
    }
    if (viewers.size >= maxViewers) return reject(socket, 503, 'Too Many Viewers');
    if (!acceptUpgrade(req, socket)) return;
    const me: ViewerInfo = { id: newConnId(), lastCmd: 0, bucket: new TokenBucket() };
    const conn: Conn = new Conn(
      socket,
      (text) => {
        const m = validateViewerMessage(text);
        if (!m) return conn.close(1008, 'bad message');
        if (m.t === 'cmd') return onCommand(conn, me, m);
        conn.send(JSON.stringify({ t: 'pong', id: m.id, c: m.c, s: Date.now() }));
      },
      () => {
        viewers.delete(conn);
        pairing.leave(me.id);
        log(`viewer left (${viewers.size} connected)`);
        tellPublisherCount();
        tellPublisherPhones();
      },
    );
    viewers.set(conn, me);
    pairing.join(me.id);
    log(`viewer joined from ${req.socket.remoteAddress} (${viewers.size} connected)`);
    conn.send(JSON.stringify({ t: 'publisher', connected: publisher !== null }));
    conn.send(JSON.stringify(pairing.stateFor(me.id)));
    for (const p of song.current?.parts ?? []) conn.send(JSON.stringify(p));
    if (lastAnchor) conn.send(JSON.stringify(lastAnchor));
    tellPublisherCount();
    tellPublisherPhones();
    conn.start(head);
  }));

  // ---------- publisher endpoint (loopback) ----------
  const pubServer = http.createServer((_req, res) => {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', ...securityHeaders });
    res.end('publisher endpoint: WebSocket only');
  });
  pubServer.on('upgrade', guarded((req, socket, head) => {
    const info = { host: req.headers.host, origin: req.headers.origin };
    const url = parseRequestUrl(req.url, 'http://127.0.0.1');
    if (!url) return reject(socket, 400, 'Bad Request');
    if (url.pathname !== '/publish') return reject(socket, 404, 'Not Found');
    if (!publisherAllowed(info, pubPort, opts.extensionId)) {
      const id = /^chrome-extension:\/\/([a-p]{32})$/.exec(info.origin ?? '')?.[1];
      log(`publisher rejected (origin ${info.origin ?? 'none'})${id && opts.extensionId ? `: if this is your Vibe Guitar, restart with npm run phone -- --extension-id ${id}` : ''}`);
      return reject(socket, 403, 'Forbidden');
    }
    if (!acceptUpgrade(req, socket)) return;
    publisher?.close(4000, 'replaced by a newer publisher');
    const conn: Conn = new Conn(
      socket,
      (text) => {
        const m = validatePublisherMessage(text);
        if (!m) {
          const c = validatePanelMessage(text);
          if (!c) return conn.close(1008, 'bad message');
          return onPanelMessage(c);
        }
        if (m.t === 'anchor') {
          if (lastAnchor && !isNewer({ epoch: lastAnchor.epoch, n: lastAnchor.seq }, { epoch: m.epoch, n: m.seq })) return;
          lastAnchor = m;
          return toViewers(JSON.stringify(m));
        }
        const r = song.add(m);
        if (r === 'invalid') return conn.close(1008, 'bad song view');
        // Viewers get a song only once all of its parts arrived and the whole view is valid.
        if (typeof r === 'object') for (const p of song.current!.parts) toViewers(JSON.stringify(p));
      },
      () => {
        if (publisher !== conn) return;
        publisher = null;
        song.clear();
        lastAnchor = null;
        log('publisher left');
        toViewers(JSON.stringify({ t: 'publisher', connected: false }));
        // The approval belongs to that panel session: a closed or replaced panel ends it.
        if (pairing.setControl(false)) tellPairing();
        armIdleStop();
      },
    );
    publisher = conn;
    disarmIdleStop();
    log(`publisher connected (${info.origin})`);
    toViewers(JSON.stringify({ t: 'publisher', connected: true }));
    tellPublisherCount();
    tellPublisherPhones();
    conn.start(head);
  }));

  await listen(pubServer, pubPort, '127.0.0.1');
  pubPort = (pubServer.address() as AddressInfo).port;
  try {
    await listen(viewerServer, opts.port ?? DEFAULT_VIEWER_PORT, host);
  } catch (e) {
    pubServer.close();
    throw e;
  }
  lanHost = `${host}:${(viewerServer.address() as AddressInfo).port}`;

  const idle = setInterval(() => {
    const now = Date.now();
    for (const c of [...viewers.keys(), ...(publisher ? [publisher] : [])]) if (now - c.lastRx > IDLE_MS) c.close(1001, 'idle');
  }, 5000);
  idle.unref();

  function close(): Promise<void> {
    if (closing) return closing;
    stopping = true;
    disarmIdleStop();
    clearInterval(idle);
    // Stop listening first; the callbacks fire once every connection is gone (upgraded sockets included).
    const serversClosed = Promise.all([new Promise((r) => viewerServer.close(r)), new Promise((r) => pubServer.close(r))]);
    const live = () => [...viewers.keys(), ...(publisher ? [publisher] : [])];
    closing = (async () => {
      const first = live();
      for (const c of first) c.close(1001, 'relay stopping');
      await new Promise((r) => setTimeout(r, 150));
      for (const c of new Set([...first, ...live()])) c.destroy();
      viewerServer.closeAllConnections();
      pubServer.closeAllConnections();
      await serversClosed;
    })();
    return closing;
  }
  // A panel may already be connected (it connects as soon as the publisher port is open).
  if (!publisher) armIdleStop();

  return {
    token,
    lanHost,
    viewerUrl: `http://${lanHost}/?t=${token}`,
    publisherUrl: `ws://127.0.0.1:${pubPort}/publish`,
    close,
  };
}
