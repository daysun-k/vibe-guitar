/// <reference types="node" />
// Regression tests for the VGT-13 relay (security review s3-r1, F1 and F2). Before the fixes each of
// these requests threw inside an http 'upgrade'/'request' handler and killed the whole relay process;
// an exception escaping here would also surface as an unhandled error and fail the vitest run.
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseRequestUrl, startRelay, type Relay } from '../src/phone/relay';
import { OP_TEXT, encodeFrame } from '../src/phone/ws-frame';

let relay: Relay;
let viewerPort: number;
let pubPort: number;
const EXT_ORIGIN = `chrome-extension://${'a'.repeat(32)}`;

beforeAll(async () => {
  relay = await startRelay({ host: '127.0.0.1', port: 0, pubPort: 0, viewerHtml: '<p>ok</p>', viewerJs: '', log: () => {} });
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
