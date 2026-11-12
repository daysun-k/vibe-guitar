/// <reference types="node" />
/**
 * VGT-13 phone probe relay (spike). Two HTTP servers in one process:
 *  - publisher endpoint on 127.0.0.1 only: the extension probe page connects to ws://127.0.0.1:<pubPort>/publish;
 *  - viewer endpoint on the LAN address only: the phone loads http://<lan>:<port>/?t=<token> and opens /viewer.
 * The token is 128 random bits created at start, kept in memory and never written anywhere.
 * It is an access check for a trusted home LAN, not encryption: traffic is plain HTTP/WebSocket.
 */
import http from 'node:http';
import os from 'node:os';
import { createHash, randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import {
  MAX_MESSAGE_BYTES,
  isNewer,
  publisherAllowed,
  tokenMatches,
  validatePublisherMessage,
  validateViewerMessage,
  viewerHostAllowed,
  viewerOriginAllowed,
  type StateMessage,
} from './protocol';
import { OP_CLOSE, OP_PING, OP_PONG, OP_TEXT, closeFrame, decodeText, encodeFrame, parseFrames, textFrame } from './ws-frame';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MSGS_PER_SEC = 40;
const IDLE_MS = 20_000;

export interface RelayOptions {
  /** LAN IPv4 to bind the viewer endpoint to; detected when omitted. Never 0.0.0.0. */
  host?: string;
  port?: number;
  pubPort?: number;
  /** When set, only this extension id may publish. */
  extensionId?: string;
  maxViewers?: number;
  viewerHtml: string;
  viewerJs: string;
  log?: (line: string) => void;
}

export interface Relay {
  token: string;
  lanHost: string;
  viewerUrl: string;
  publisherUrl: string;
  close(): Promise<void>;
}

export function newToken(): string {
  return randomBytes(16).toString('base64url');
}

function isPrivateIpv4(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number) as [number, number];
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
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
  const host = opts.host ?? pickLanAddress();
  if (!host) throw new Error('no private LAN IPv4 address found (is Wi-Fi on?); pass --host <ip>');
  if (host === '0.0.0.0' || host === '::') throw new Error('refusing to bind the viewer endpoint to all interfaces');
  const maxViewers = opts.maxViewers ?? 4;
  // Final values are read back after listen() so port 0 (any free port, used by tests) works.
  let pubPort = opts.pubPort ?? 47821;
  let lanHost = `${host}:${opts.port ?? 47822}`;
  const token = newToken();

  const viewers = new Set<Conn>();
  let publisher: Conn | null = null;
  let lastState: StateMessage | null = null;

  const toViewers = (text: string) => viewers.forEach((v) => v.send(text));
  const tellPublisherCount = () => publisher?.send(JSON.stringify({ t: 'viewers', n: viewers.size }));

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
    const conn: Conn = new Conn(
      socket,
      (text) => {
        const m = validateViewerMessage(text);
        if (!m) return conn.close(1008, 'bad message');
        conn.send(JSON.stringify({ t: 'pong', id: m.id, c: m.c, s: Date.now() }));
      },
      () => {
        viewers.delete(conn);
        log(`viewer left (${viewers.size} connected)`);
        tellPublisherCount();
      },
    );
    viewers.add(conn);
    log(`viewer joined from ${req.socket.remoteAddress} (${viewers.size} connected)`);
    conn.send(JSON.stringify({ t: 'publisher', connected: publisher !== null }));
    if (lastState) conn.send(JSON.stringify(lastState));
    tellPublisherCount();
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
      log(`publisher rejected (origin ${info.origin ?? 'none'})`);
      return reject(socket, 403, 'Forbidden');
    }
    if (!acceptUpgrade(req, socket)) return;
    publisher?.close(4000, 'replaced by a newer publisher');
    const conn: Conn = new Conn(
      socket,
      (text) => {
        const m = validatePublisherMessage(text);
        if (!m) return conn.close(1008, 'bad message');
        if (m.t === 'state') {
          if (!isNewer(lastState, m)) return;
          lastState = m;
        }
        toViewers(JSON.stringify(m));
      },
      () => {
        if (publisher !== conn) return;
        publisher = null;
        lastState = null;
        log('publisher left');
        toViewers(JSON.stringify({ t: 'publisher', connected: false }));
      },
    );
    publisher = conn;
    log(`publisher connected (${info.origin})`);
    toViewers(JSON.stringify({ t: 'publisher', connected: true }));
    tellPublisherCount();
    conn.start(head);
  }));

  await listen(pubServer, pubPort, '127.0.0.1');
  pubPort = (pubServer.address() as AddressInfo).port;
  try {
    await listen(viewerServer, opts.port ?? 47822, host);
  } catch (e) {
    pubServer.close();
    throw e;
  }
  lanHost = `${host}:${(viewerServer.address() as AddressInfo).port}`;

  const idle = setInterval(() => {
    const now = Date.now();
    for (const c of [...viewers, ...(publisher ? [publisher] : [])]) if (now - c.lastRx > IDLE_MS) c.close(1001, 'idle');
  }, 5000);
  idle.unref();

  return {
    token,
    lanHost,
    viewerUrl: `http://${lanHost}/?t=${token}`,
    publisherUrl: `ws://127.0.0.1:${pubPort}/publish`,
    async close() {
      clearInterval(idle);
      const all = [...viewers, ...(publisher ? [publisher] : [])];
      for (const c of all) c.close(1001, 'relay stopping');
      await new Promise((r) => setTimeout(r, 150));
      for (const c of all) c.destroy();
      viewerServer.closeAllConnections();
      pubServer.closeAllConnections();
      await Promise.all([new Promise((r) => viewerServer.close(r)), new Promise((r) => pubServer.close(r))]);
    },
  };
}
