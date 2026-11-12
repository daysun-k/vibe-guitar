/// <reference types="node" />
// Idle auto-stop of the VGT-13 relay: with no side panel (publisher) connected for `idleStopMs`, the relay
// closes both listeners. Viewers alone do not keep it running; a panel reconnecting cancels the countdown.
// Only setTimeout/clearTimeout are faked: sockets, Date and the relay's heartbeat interval stay real.
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startRelay, type Relay } from '../src/phone/relay';
import { OP_CLOSE, encodeFrame } from '../src/phone/ws-frame';

const EXT_ORIGIN = `chrome-extension://${'a'.repeat(32)}`;
const MIN = 60_000;

interface Harness {
  relay: Relay;
  viewerPort: number;
  pubPort: number;
  stopped: () => boolean;
  stoppedPromise: Promise<void>;
  /** Resolves the next time the relay logs a line matching `re` (no timers involved). */
  nextLog: (re: RegExp) => Promise<void>;
}

async function start(idleStopMs: number): Promise<Harness> {
  const waiters: { re: RegExp; done: () => void }[] = [];
  let stopped = false;
  let markStopped!: () => void;
  const stoppedPromise = new Promise<void>((r) => (markStopped = r));
  const relay = await startRelay({
    host: '127.0.0.1',
    allowLoopback: true,
    port: 0,
    pubPort: 0,
    extensionId: 'a'.repeat(32),
    viewerHtml: '',
    viewerJs: '',
    idleStopMs,
    onIdleStop: () => {
      stopped = true;
      markStopped();
    },
    log: (line) => {
      for (const w of waiters.splice(0)) (w.re.test(line) ? w.done : () => waiters.push(w))();
    },
  });
  return {
    relay,
    viewerPort: Number(relay.lanHost.split(':')[1]),
    pubPort: Number(new URL(relay.publisherUrl).port),
    stopped: () => stopped,
    stoppedPromise,
    nextLog: (re) => new Promise((done) => waiters.push({ re, done })),
  };
}

/** Opens a WebSocket (handshake only) and resolves with the socket once the 101 response arrived. */
function wsOpen(port: number, path: string, host: string, origin: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const key = randomBytes(16).toString('base64');
    const s = net.connect({ host: '127.0.0.1', port }, () =>
      s.write(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\nOrigin: ${origin}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${key}\r\n\r\n`));
    s.once('data', (b: Buffer) => (/^HTTP\/1\.1 101/.test(b.toString('latin1')) ? resolve(s) : reject(new Error(b.toString('latin1')))));
    s.on('error', () => {});
  });
}

const panel = (h: Harness) => wsOpen(h.pubPort, '/publish', `127.0.0.1:${h.pubPort}`, EXT_ORIGIN);
const phone = (h: Harness) => wsOpen(h.viewerPort, `/viewer?t=${h.relay.token}`, h.relay.lanHost, `http://${h.relay.lanHost}`);

/** The panel closes its WebSocket the way a browser does (close frame 1000), as when 휴대폰 악보대 is switched off. */
async function panelLeaves(h: Harness, s: net.Socket) {
  const left = h.nextLog(/publisher left/);
  s.end(Buffer.from(encodeFrame(OP_CLOSE, new Uint8Array([0x03, 0xe8]), randomBytes(4))));
  await left;
  s.destroy();
}

function refused(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    s.once('connect', () => (s.destroy(), resolve(false)));
    s.once('error', (e: NodeJS.ErrnoException) => resolve(e.code === 'ECONNREFUSED'));
  });
}

let h: Harness | null = null;
afterEach(async () => {
  vi.useRealTimers();
  await h?.relay.close();
  h = null;
});

describe('relay idle auto-stop', () => {
  it('stops after the idle time when no panel ever connected, closing both ports', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    h = await start(10 * MIN);
    await vi.advanceTimersByTimeAsync(10 * MIN - 1000);
    expect(h.stopped()).toBe(false);
    await vi.advanceTimersByTimeAsync(1000 + 200); // + the relay's 150 ms close grace
    await h.stoppedPromise;
    expect(await refused(h.pubPort)).toBe(true);
    expect(await refused(h.viewerPort)).toBe(true);
  });

  it('stays up while a panel is connected, however long', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    h = await start(10 * MIN);
    const p = await panel(h);
    await vi.advanceTimersByTimeAsync(60 * MIN);
    expect(h.stopped()).toBe(false);
    p.destroy();
  });

  it('a connected phone alone does not keep it running', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    h = await start(10 * MIN);
    const p = await panel(h);
    const v = await phone(h);
    await vi.advanceTimersByTimeAsync(30 * MIN);
    await panelLeaves(h, p);
    await vi.advanceTimersByTimeAsync(10 * MIN - 1000);
    expect(h.stopped()).toBe(false);
    const viewerClosed = new Promise((r) => v.once('close', r));
    await vi.advanceTimersByTimeAsync(1000 + 200);
    await h.stoppedPromise;
    await viewerClosed;
    expect(await refused(h.viewerPort)).toBe(true);
  });

  it('a panel reconnecting within the window cancels the countdown, which restarts when it leaves', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    h = await start(10 * MIN);
    await vi.advanceTimersByTimeAsync(9 * MIN);
    const p1 = await panel(h);
    await vi.advanceTimersByTimeAsync(5 * MIN); // 14 min since start: would have stopped without the panel
    expect(h.stopped()).toBe(false);
    await panelLeaves(h, p1);
    await vi.advanceTimersByTimeAsync(9 * MIN);
    const p2 = await panel(h); // panel switched back on
    await vi.advanceTimersByTimeAsync(9 * MIN);
    await panelLeaves(h, p2);
    await vi.advanceTimersByTimeAsync(10 * MIN - 1000);
    expect(h.stopped()).toBe(false);
    await vi.advanceTimersByTimeAsync(1000 + 200);
    await h.stoppedPromise;
  });

  it('close() after an idle stop is harmless', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    h = await start(MIN);
    await vi.advanceTimersByTimeAsync(MIN + 200);
    await h.stoppedPromise;
    vi.useRealTimers();
    await expect(h.relay.close()).resolves.toBeUndefined();
  });

  it('is off when idleStopMs is not given', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    h = await start(0);
    await vi.advanceTimersByTimeAsync(24 * 60 * MIN);
    expect(h.stopped()).toBe(false);
    expect(await refused(h.pubPort)).toBe(false);
  });
});

describe('npm run phone -- --idle-minutes', () => {
  const run = (args: string[]) =>
    new Promise<{ code: number | null; err: string }>((resolve) => {
      execFile(process.execPath, ['scripts/phone.mjs', ...args], { timeout: 30000 }, (e, _out, err) =>
        resolve({ code: e ? ((e as { code?: number }).code ?? 1) : 0, err }));
    });

  it('refuses values under one minute and non-numbers before starting anything', async () => {
    for (const v of ['0.5', '0', '-3', 'ten', '']) {
      const r = await run(['--idle-minutes', v]);
      expect(r.code, v).toBe(2);
      expect(r.err, v).toMatch(/--idle-minutes needs a number of minutes, 1 or more/);
    }
    expect((await run(['--idle-minutes'])).code).toBe(2);
  });
});
