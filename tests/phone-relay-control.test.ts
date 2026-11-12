/// <reference types="node" />
// VGT-16 relay: pairing and command forwarding over real sockets (loopback viewer address, tests only).
// A command reaches the panel only from the approved connection, with control on, for the current song;
// approvals end on disconnect, switch-off, revoke and when the panel leaves or is replaced.
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { startRelay, type Relay } from '../src/phone/relay';
import { OP_CLOSE, OP_TEXT, encodeFrame, parseFrames } from '../src/phone/ws-frame';
import { songParts } from '../src/phone/protocol';
import { EMPTY_SONG } from '../src/extension/sidepanel/phone-link';

const EXT_ORIGIN = `chrome-extension://${'a'.repeat(32)}`;
const EPOCH = 'controltest01';

interface Client {
  msgs: Record<string, unknown>[];
  send(m: unknown): void;
  bye(): void;
  closed(): boolean;
  /** Resolves with the first message (already received or later) matching `pred`. */
  next(pred: (m: Record<string, unknown>) => boolean, ms?: number): Promise<Record<string, unknown>>;
}

function connect(port: number, path: string, host: string, origin: string): Promise<Client> {
  return new Promise((resolve, reject) => {
    const s = net.connect({ host: '127.0.0.1', port }, () =>
      s.write(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\nOrigin: ${origin}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\n\r\n`));
    let buf: Uint8Array = new Uint8Array(0);
    let upgraded = false;
    let closed = false;
    const waiters: { pred: (m: Record<string, unknown>) => boolean; done: (m: Record<string, unknown>) => void }[] = [];
    const c: Client = {
      msgs: [],
      send: (m) => s.write(encodeFrame(OP_TEXT, new TextEncoder().encode(JSON.stringify(m)), randomBytes(4))),
      bye: () => s.end(Buffer.from(encodeFrame(OP_CLOSE, new Uint8Array([0x03, 0xe8]), randomBytes(4)))),
      closed: () => closed,
      next: (pred, ms = 1500) =>
        new Promise((done, fail) => {
          const have = c.msgs.find(pred);
          if (have) return done(have);
          const timer = setTimeout(() => fail(new Error('no matching message')), ms);
          waiters.push({ pred, done: (m) => (clearTimeout(timer), done(m)) });
        }),
    };
    s.on('data', (chunk: Buffer) => {
      let bytes = new Uint8Array(chunk);
      if (!upgraded) {
        const text = Buffer.from(bytes).toString('latin1');
        const at = text.indexOf('\r\n\r\n');
        if (!/^HTTP\/1\.1 101/.test(text)) return reject(new Error(text.split('\r\n')[0]));
        upgraded = true;
        bytes = bytes.subarray(at + 4);
        resolve(c);
      }
      const merged = new Uint8Array(buf.length + bytes.length);
      merged.set(buf);
      merged.set(bytes, buf.length);
      const r = parseFrames(merged, 1 << 20, false);
      buf = r.rest;
      for (const f of r.frames) {
        if (f.opcode !== OP_TEXT) continue;
        const m = JSON.parse(new TextDecoder().decode(f.payload)) as Record<string, unknown>;
        c.msgs.push(m);
        for (const w of waiters.splice(0)) (w.pred(m) ? () => w.done(m) : () => waiters.push(w))();
      }
    });
    s.on('close', () => (closed = true));
    s.on('error', () => {});
  });
}

let relay: Relay | null = null;
afterEach(async () => {
  await relay?.close();
  relay = null;
});

async function setup() {
  relay = await startRelay({ host: '127.0.0.1', allowLoopback: true, port: 0, pubPort: 0, extensionId: 'a'.repeat(32), viewerHtml: '', viewerJs: '', log: () => {} });
  const r = relay;
  const viewerPort = Number(r.lanHost.split(':')[1]);
  const pubPort = Number(new URL(r.publisherUrl).port);
  const panel = () => connect(pubPort, '/publish', `127.0.0.1:${pubPort}`, EXT_ORIGIN);
  const phone = () => connect(viewerPort, `/viewer?t=${r.token}`, r.lanHost, `http://${r.lanHost}`);
  const pub = await panel();
  for (const p of songParts(EMPTY_SONG, EPOCH, 1)!) pub.send(p);
  const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
  /** The code a phone shows once control is allowed. */
  const code = async (c: Client) => (await c.next((m) => m.t === 'pair' && m.state === 'pending')).code as string;
  const idOf = async (codeText: string) => {
    const m = await pub.next((x) => x.t === 'phones' && (x.list as { code: string }[]).some((e) => e.code === codeText));
    return (m.list as { id: string; code: string }[]).find((e) => e.code === codeText)!.id;
  };
  const cmd = (c: Client, id: number, extra: Record<string, unknown> = {}) => c.send({ t: 'cmd', id, epoch: EPOCH, rev: 1, cmd: 'toggle', ...extra });
  const resultFor = (c: Client, id: number) => c.next((m) => m.t === 'result' && m.id === id);
  const forwarded = () => pub.msgs.filter((m) => m.t === 'cmd');
  return { pub, panel, phone, code, idOf, cmd, resultFor, forwarded, sleep };
}

/** Control on, one phone approved. */
async function approvedSetup() {
  const h = await setup();
  const ph = await h.phone();
  h.pub.send({ t: 'control', on: true });
  const code = await h.code(ph);
  const id = await h.idOf(code);
  h.pub.send({ t: 'approve', id, code, grant: 5 });
  await ph.next((m) => m.t === 'pair' && m.state === 'approved');
  return { ...h, ph, id, codeText: code };
}

describe('relay: pairing', () => {
  it('shows no code while control is off, then one per connection; the panel sees only id, code and state', async () => {
    const h = await setup();
    const ph = await h.phone();
    expect(await ph.next((m) => m.t === 'pair')).toEqual({ t: 'pair', state: 'off' });
    h.pub.send({ t: 'control', on: true });
    const code = await h.code(ph);
    expect(code).toMatch(/^\d{4}$/);
    const list = await h.pub.next((m) => m.t === 'phones' && (m.list as unknown[]).length === 1);
    expect(Object.keys((list.list as object[])[0]!).sort()).toEqual(['code', 'id', 'state']);
  });

  it('approval needs the matching code; only one phone at a time', async () => {
    const h = await setup();
    const a = await h.phone();
    const b = await h.phone();
    h.pub.send({ t: 'control', on: true });
    const ca = await h.code(a);
    const cb = await h.code(b);
    expect(ca).not.toBe(cb);
    const ida = await h.idOf(ca);
    const idb = await h.idOf(cb);
    h.pub.send({ t: 'approve', id: ida, code: cb, grant: 1 }); // wrong code for that connection
    await h.sleep(100);
    expect(a.msgs.some((m) => m.state === 'approved')).toBe(false);
    h.pub.send({ t: 'approve', id: ida, code: ca, grant: 2 });
    await a.next((m) => m.state === 'approved');
    h.pub.send({ t: 'approve', id: idb, code: cb, grant: 3 });
    await b.next((m) => m.state === 'approved');
    await h.sleep(100);
    expect(a.msgs.filter((m) => m.t === 'pair').at(-1)).toEqual({ t: 'pair', state: 'pending', code: ca });
  });
});

describe('relay: commands', () => {
  it('rejects a command while control is off and from an unapproved phone; nothing reaches the panel', async () => {
    const h = await setup();
    const ph = await h.phone();
    h.cmd(ph, 1);
    expect(await h.resultFor(ph, 1)).toEqual({ t: 'result', id: 1, ok: false, code: 'off' });
    h.pub.send({ t: 'control', on: true });
    await h.code(ph);
    h.cmd(ph, 2);
    expect(await h.resultFor(ph, 2)).toMatchObject({ ok: false, code: 'not-approved' });
    expect(h.forwarded()).toEqual([]);
  });

  it('forwards the approved phone command to the panel and the result back to that phone only', async () => {
    const h = await approvedSetup();
    const other = await h.phone();
    h.cmd(h.ph, 1);
    const fwd = await h.pub.next((m) => m.t === 'cmd');
    // Stamped with the grant the panel approved this phone under.
    expect(fwd).toEqual({ t: 'cmd', id: 1, epoch: EPOCH, rev: 1, cmd: 'toggle', from: h.id, grant: 5 });
    h.pub.send({ t: 'result', to: h.id, id: 1, ok: true, state: 'playing' });
    expect(await h.resultFor(h.ph, 1)).toEqual({ t: 'result', id: 1, ok: true, state: 'playing' });
    await h.sleep(100);
    expect(other.msgs.some((m) => m.t === 'result')).toBe(false);
  });

  it('rejects duplicate ids, stale songs and bursts above the rate limit without queuing', async () => {
    const h = await approvedSetup();
    h.cmd(h.ph, 5);
    h.cmd(h.ph, 5);
    expect(await h.resultFor(h.ph, 5)).toMatchObject({ code: 'duplicate' });
    await h.sleep(600);
    h.cmd(h.ph, 6, { rev: 2 });
    expect(await h.resultFor(h.ph, 6)).toMatchObject({ code: 'stale' });
    await h.sleep(600);
    h.cmd(h.ph, 7);
    h.cmd(h.ph, 8);
    h.cmd(h.ph, 9);
    expect(await h.resultFor(h.ph, 9)).toMatchObject({ code: 'rate' });
    await h.sleep(100);
    expect(h.forwarded().map((m) => m.id)).toEqual([5, 7, 8]);
  });

  it('a viewer that sends a seek, a rate or anything else is closed', async () => {
    const h = await approvedSetup();
    h.ph.send({ t: 'cmd', id: 1, epoch: EPOCH, rev: 1, cmd: 'seek', time: 30 });
    await h.sleep(150);
    expect(h.ph.closed()).toBe(true);
    expect(h.forwarded()).toEqual([]);
  });
});

describe('relay: approval ends', () => {
  it('on 승인 해제', async () => {
    const h = await approvedSetup();
    h.pub.send({ t: 'revoke' });
    await h.ph.next((m) => m.t === 'pair' && m.state === 'pending');
    h.cmd(h.ph, 1);
    expect(await h.resultFor(h.ph, 1)).toMatchObject({ code: 'not-approved' });
  });

  it('on switch-off', async () => {
    const h = await approvedSetup();
    h.pub.send({ t: 'control', on: false });
    await h.ph.next((m) => m.t === 'pair' && m.state === 'off');
    h.pub.send({ t: 'control', on: true });
    await h.ph.next((m) => m.t === 'pair' && m.state === 'pending');
    h.cmd(h.ph, 1);
    expect(await h.resultFor(h.ph, 1)).toMatchObject({ code: 'not-approved' });
  });

  it('when the phone disconnects: the reconnected phone is a new, pending connection', async () => {
    const h = await approvedSetup();
    h.ph.bye();
    await h.pub.next((m) => m.t === 'phones' && (m.list as unknown[]).length === 0);
    const again = await h.phone();
    const code = await h.code(again);
    expect(code).not.toBe(h.codeText);
    h.cmd(again, 1);
    expect(await h.resultFor(again, 1)).toMatchObject({ code: 'not-approved' });
  });

  it('when the panel closes', async () => {
    const h = await approvedSetup();
    h.pub.bye();
    await h.ph.next((m) => m.t === 'pair' && m.state === 'off');
    h.cmd(h.ph, 1);
    expect(await h.resultFor(h.ph, 1)).toMatchObject({ code: 'no-panel' });
  });

  it('when another panel replaces it (control starts off for the new one)', async () => {
    const h = await approvedSetup();
    const pub2 = await h.panel();
    await h.ph.next((m) => m.t === 'pair' && m.state === 'off');
    for (const p of songParts(EMPTY_SONG, EPOCH, 2)!) pub2.send(p);
    pub2.send({ t: 'control', on: true });
    await h.ph.next((m) => m.t === 'pair' && m.state === 'pending');
    h.cmd(h.ph, 1, { rev: 2 });
    expect(await h.resultFor(h.ph, 1)).toMatchObject({ code: 'not-approved' });
    expect(pub2.msgs.some((m) => m.t === 'cmd')).toBe(false);
  });
});
