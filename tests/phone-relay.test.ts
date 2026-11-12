/// <reference types="node" />
// Tests for the VGT-13 relay. F1/F2 are regressions from the spike's security review: before the fixes
// each of these requests threw inside an http 'upgrade'/'request' handler and killed the relay process;
// an exception escaping here would also surface as an unhandled error and fail the vitest run.
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { parseRequestUrl, startRelay, viewerHostProblem, type Relay } from '../src/phone/relay';
import { OP_TEXT, encodeFrame } from '../src/phone/ws-frame';
import { songParts } from '../src/phone/protocol';
import { EMPTY_SONG } from '../src/extension/sidepanel/phone-link';

let relay: Relay;
let viewerPort: number;
let pubPort: number;
const EXT_ORIGIN = `chrome-extension://${'a'.repeat(32)}`;

beforeAll(async () => {
  relay = await startRelay({ host: '127.0.0.1', allowLoopback: true, port: 0, pubPort: 0, extensionId: 'a'.repeat(32), viewerHtml: '<p>ok</p>', viewerJs: '', log: () => {} });
  viewerPort = Number(relay.lanHost.split(':')[1]);
  pubPort = Number(new URL(relay.publisherUrl).port);
});
afterAll(async () => {
  await relay.close();
});

/** Writes `bytes` in a single TCP write and collects everything until the peer closes (or 800 ms). */
function raw(port: number, bytes: Uint8Array | string): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const s = net.connect({ host: '127.0.0.1', port }, () => s.write(bytes));
    const done = () => {
      clearTimeout(timer);
      s.destroy();
      resolve(Buffer.concat(chunks));
    };
    const timer = setTimeout(done, 800);
    s.on('data', (c: Buffer) => chunks.push(c));
    s.on('close', done);
    s.on('error', done);
  });
}

const statusOf = (b: Buffer) => Number(/^HTTP\/1\.1 (\d{3})/.exec(b.toString('latin1'))?.[1]);

/** Close code of the first server frame after the 101 response, or null. */
function closeCodeOf(b: Buffer): number | null {
  const at = b.indexOf('\r\n\r\n');
  if (at < 0) return null;
  for (let p = at + 4; p + 1 < b.length; ) {
    const op = b[p]! & 0x0f;
    const len = b[p + 1]! & 0x7f;
    if (op === 0x8) return (b[p + 2]! << 8) | b[p + 3]!;
    p += 2 + len; // server frames here are short and unmasked
  }
  return null;
}

function upgradeRequest(path: string, host: string, origin: string): string {
  const key = randomBytes(16).toString('base64');
  return `GET ${path} HTTP/1.1\r\nHost: ${host}\r\nOrigin: ${origin}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${key}\r\n\r\n`;
}

async function relayStillServes() {
  const page = await raw(viewerPort, `GET /?t=${relay.token} HTTP/1.1\r\nHost: ${relay.lanHost}\r\nConnection: close\r\n\r\n`);
  expect(statusOf(page)).toBe(200);
}

describe('relay: malformed request targets (F1)', () => {
  it('parseRequestUrl returns null instead of throwing', () => {
    expect(parseRequestUrl('//', 'http://127.0.0.1:1')).toBeNull();
    expect(parseRequestUrl('/viewer?t=x', 'http://127.0.0.1:1')?.pathname).toBe('/viewer');
  });

  it('rejects GET // on the viewer page endpoint and keeps serving', async () => {
    const res = await raw(viewerPort, `GET // HTTP/1.1\r\nHost: ${relay.lanHost}\r\nConnection: close\r\n\r\n`);
    expect(statusOf(res)).toBe(400);
    await relayStillServes();
  });

  it('rejects an upgrade with an invalid target on both endpoints and keeps serving', async () => {
    expect(statusOf(await raw(viewerPort, upgradeRequest('//', relay.lanHost, `http://${relay.lanHost}`)))).toBe(400);
    expect(statusOf(await raw(pubPort, upgradeRequest('//', `127.0.0.1:${pubPort}`, EXT_ORIGIN)))).toBe(400);
    await relayStillServes();
  });
});

describe('relay: frames sent together with the handshake (F2)', () => {
  const badFrame = encodeFrame(OP_TEXT, new TextEncoder().encode('{}'), new Uint8Array([9, 8, 7, 6]));
  const withFrame = (req: string) => Buffer.concat([Buffer.from(req, 'latin1'), Buffer.from(badFrame)]);

  it('viewer: accepts the handshake, closes with 1008 for the invalid frame, keeps serving', async () => {
    const res = await raw(viewerPort, withFrame(upgradeRequest(`/viewer?t=${relay.token}`, relay.lanHost, `http://${relay.lanHost}`)));
    expect(statusOf(res)).toBe(101);
    expect(closeCodeOf(res)).toBe(1008);
    await relayStillServes();
  });

  it('publisher: accepts the handshake, closes with 1008 for the invalid frame, keeps serving', async () => {
    const res = await raw(pubPort, withFrame(upgradeRequest('/publish', `127.0.0.1:${pubPort}`, EXT_ORIGIN)));
    expect(statusOf(res)).toBe(101);
    expect(closeCodeOf(res)).toBe(1008);
    await relayStillServes();
  });

  it('a valid ping sent with the viewer handshake is answered', async () => {
    const ping = encodeFrame(OP_TEXT, new TextEncoder().encode(JSON.stringify({ t: 'ping', id: 1, c: 5 })), new Uint8Array([1, 2, 3, 4]));
    const req = Buffer.concat([Buffer.from(upgradeRequest(`/viewer?t=${relay.token}`, relay.lanHost, `http://${relay.lanHost}`), 'latin1'), Buffer.from(ping)]);
    const res = await raw(viewerPort, req);
    expect(statusOf(res)).toBe(101);
    expect(res.toString('utf8')).toContain('"t":"pong"');
  });
});

describe('relay: what a phone receives', () => {
  const frame = (o: unknown) => Buffer.from(encodeFrame(OP_TEXT, new TextEncoder().encode(JSON.stringify(o)), new Uint8Array([5, 6, 7, 8])));

  it('a phone joining late gets the current song view and anchor; a broken song closes the panel', async () => {
    const pub = net.connect({ host: '127.0.0.1', port: pubPort });
    await new Promise((r) => pub.once('connect', r));
    const fromRelay: Buffer[] = [];
    pub.on('data', (c: Buffer) => fromRelay.push(c));
    const song = songParts({ ...EMPTY_SONG, title: '시험' }, 'abcd1234', 1)!;
    const anchor = { t: 'anchor', epoch: 'abcd1234', seq: 1, sampledAt: Date.now(), position: 3, rate: 1, paused: true, ad: false, loop: null };
    pub.write(Buffer.concat([Buffer.from(upgradeRequest('/publish', `127.0.0.1:${pubPort}`, EXT_ORIGIN), 'latin1'), ...song.map(frame), frame(anchor)]));
    await new Promise((r) => setTimeout(r, 150));
    const res = (await raw(viewerPort, upgradeRequest(`/viewer?t=${relay.token}`, relay.lanHost, `http://${relay.lanHost}`))).toString('utf8');
    expect(res).toContain('"t":"publisher","connected":true');
    expect(res).toContain('"t":"song"');
    expect(res).toContain('\\"title\\":\\"시험\\"');
    expect(res).toContain('"t":"anchor"');
    // a song whose joined text is not a valid view: the panel connection is closed with 1008
    pub.write(frame({ t: 'song', epoch: 'abcd1234', rev: 2, i: 0, n: 1, d: '{"v":1,"lyrics":"la"}' }));
    await new Promise((r) => setTimeout(r, 150));
    const all = Buffer.concat(fromRelay);
    const at = all.indexOf(Buffer.from([0x03, 0xf0])); // close code 1008
    expect(at >= 2 && all[at - 2] === 0x88).toBe(true);
    pub.destroy();
    await relayStillServes();
  });

  it('another extension cannot publish', async () => {
    const res = await raw(pubPort, upgradeRequest('/publish', `127.0.0.1:${pubPort}`, `chrome-extension://${'b'.repeat(32)}`));
    expect(statusOf(res)).toBe(403);
  });
});

describe('relay: a client that resets after a rejected upgrade (review s4-r1, S4-R1-01)', () => {
  /** Sends `req`, waits `ms`, then aborts the TCP connection with RST instead of a normal close. */
  function sendThenReset(port: number, req: string, ms: number): Promise<void> {
    return new Promise((resolve) => {
      const s = net.connect({ host: '127.0.0.1', port }, () => {
        s.write(req);
        setTimeout(() => {
          s.resetAndDestroy();
          resolve();
        }, ms);
      });
      s.on('error', () => resolve());
    });
  }

  it('viewer (wrong token) and publisher (wrong Origin): RST does not stop the relay', async () => {
    const viewerReq = upgradeRequest(`/viewer?t=${'z'.repeat(22)}`, relay.lanHost, `http://${relay.lanHost}`);
    const pubReq = upgradeRequest('/publish', `127.0.0.1:${pubPort}`, 'http://evil.example');
    const badHostReq = upgradeRequest('/viewer', 'evil.example:1', 'http://evil.example');
    for (const ms of [0, 1, 5, 20, 60]) {
      await Promise.all([sendThenReset(viewerPort, viewerReq, ms), sendThenReset(pubPort, pubReq, ms), sendThenReset(viewerPort, badHostReq, ms)]);
    }
    await new Promise((r) => setTimeout(r, 300)); // let the server see the resets and its delayed destroys run
    await relayStillServes();
    expect(statusOf(await raw(pubPort, upgradeRequest('/publish', `127.0.0.1:${pubPort}`, 'http://evil.example')))).toBe(403);
  });
});

describe('relay: viewer address must be one private IPv4 (review s4-r1, S4-R1-02)', () => {
  it('accepts plain private IPv4 addresses only', () => {
    for (const ok of ['192.168.0.23', '10.0.0.5', '172.16.3.4', '172.31.255.254']) expect(viewerHostProblem(ok)).toBeNull();
    const bad = ['0', '0.0.0.0', '::', '::1', '', ' ', 'localhost', 'mac.local', 'example.com', '127.0.0.1', '8.8.8.8', '100.64.0.1', '169.254.1.2',
      '172.32.0.1', '192.168.0.256', '192.168.001.1', '192.168.0', '192.168.0.23 ', '192.168.0.23,10.0.0.1', '0x7f.0.0.1', '255.255.255.255'];
    for (const b of bad) expect(viewerHostProblem(b), b).not.toBeNull();
    expect(viewerHostProblem(undefined)).not.toBeNull();
    expect(viewerHostProblem('127.0.0.1', true)).toBeNull(); // unit tests only
  });

  it('startRelay refuses wildcard and non-LAN hosts before opening any port', async () => {
    for (const host of ['0', '0.0.0.0', '::', '', 'localhost', '127.0.0.1']) {
      await expect(startRelay({ host, port: 0, pubPort: 0, viewerHtml: '', viewerJs: '' }), host).rejects.toThrow(/--host|refusing/);
    }
  });

  it('npm run phone -- --host 0 exits with an error and binds nothing', async () => {
    const r = await new Promise<{ code: number | null; err: string }>((resolve) => {
      execFile(process.execPath, ['scripts/phone.mjs', '--host', '0', '--port', '0', '--pub-port', '0'], { timeout: 30000 }, (e, _out, err) =>
        resolve({ code: e ? ((e as { code?: number }).code ?? 1) : 0, err }));
    });
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/--host must be one IPv4 address/);
  });
});
