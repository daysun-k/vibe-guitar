// VGT-16 phone control, pure parts: message validation, the pairing state machine, the rate limit, the
// panel's own command gate (PhoneLink) and how a command is carried out and reported (phone-control).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CONTROL_OBSERVE_MS,
  TokenBucket,
  validatePanelMessage,
  validateRelayToPanel,
  validateRelayToViewer,
  validateViewerMessage,
  type CommandOutcome,
  type PhoneCommand,
  type PhoneEntry,
} from '../src/phone/protocol';
import { Pairing } from '../src/phone/pairing';
import { PhoneLink, type SocketLike } from '../src/extension/sidepanel/phone-link';
import { restartTargetSec, runPhoneCommand, type ObservedPlayer, type PanelTransport, type TransportResult } from '../src/extension/sidepanel/phone-control';
import { playToggle, type PlayToggleEnv } from '../src/extension/sidepanel/play-toggle';
import type { PlayerControlMessage, PlayerControlResult } from '../src/extension/messages';
import { DEFAULT_SETTINGS, normalizeSettings } from '../src/extension/storage';

const ID_A = 'aaaaaaaaaaaa';
const ID_B = 'bbbbbbbbbbbb';
const EPOCH = 'epochepoch01';

describe('protocol: control messages', () => {
  const cmd = { t: 'cmd', id: 1, epoch: EPOCH, rev: 3, cmd: 'toggle' };

  it('accepts exactly the two commands from a viewer', () => {
    expect(validateViewerMessage(JSON.stringify(cmd))).toEqual(cmd);
    expect(validateViewerMessage(JSON.stringify({ ...cmd, cmd: 'restart' }))?.t).toBe('cmd');
    expect(validateViewerMessage(JSON.stringify({ t: 'ping', id: 1, c: 5 }))?.t).toBe('ping');
  });

  it('rejects any other command, extra fields (seek times, rates, tabs, urls) and bad ids', () => {
    for (const bad of [
      { ...cmd, cmd: 'seek' },
      { ...cmd, cmd: 'play' },
      { ...cmd, time: 12 },
      { ...cmd, rate: 2 },
      { ...cmd, tabId: 5 },
      { ...cmd, url: 'https://x' },
      { ...cmd, from: ID_A },
      { ...cmd, id: 0 },
      { ...cmd, id: 1.5 },
      { ...cmd, rev: 0 },
      { ...cmd, epoch: 'BAD' },
      { t: 'approve', id: ID_A, code: '1234' },
      { t: 'result', id: 1, ok: true, state: 'playing' },
    ])
      expect(validateViewerMessage(JSON.stringify(bad)), JSON.stringify(bad)).toBeNull();
  });

  it('panel messages: control, approve/reject with id and code, revoke, results', () => {
    expect(validatePanelMessage('{"t":"control","on":true}')).toEqual({ t: 'control', on: true });
    expect(validatePanelMessage(JSON.stringify({ t: 'approve', id: ID_A, code: '0042' }))).toEqual({ t: 'approve', id: ID_A, code: '0042' });
    expect(validatePanelMessage('{"t":"revoke"}')).toEqual({ t: 'revoke' });
    expect(validatePanelMessage(JSON.stringify({ t: 'result', to: ID_A, id: 2, ok: false, code: 'autoplay' }))).toEqual({ t: 'result', to: ID_A, id: 2, ok: false, code: 'autoplay' });
    for (const bad of [
      { t: 'control', on: 1 },
      { t: 'approve', id: ID_A, code: '12345' },
      { t: 'approve', id: 'short', code: '1234' },
      { t: 'revoke', id: ID_A },
      { t: 'result', to: ID_A, id: 2, ok: true, state: 'seeking' },
      { t: 'result', to: ID_A, id: 2, ok: false, code: 'whatever' },
      { t: 'result', to: ID_A, id: 2, ok: true, state: 'playing', text: 'hi' },
    ])
      expect(validatePanelMessage(JSON.stringify(bad)), JSON.stringify(bad)).toBeNull();
  });

  it('relay -> panel and relay -> viewer messages are validated field by field', () => {
    expect(validateRelayToPanel(JSON.stringify({ ...cmd, from: ID_A }))).toEqual({ ...cmd, from: ID_A });
    expect(validateRelayToPanel(JSON.stringify({ t: 'phones', list: [{ id: ID_A, code: '1234', state: 'pending' }] }))?.t).toBe('phones');
    expect(validateRelayToPanel(JSON.stringify({ t: 'phones', list: [{ id: ID_A, code: '1234', state: 'pending', ip: '1.2.3.4' }] }))).toBeNull();
    expect(validateRelayToPanel(JSON.stringify({ ...cmd }))).toBeNull(); // no `from`
    expect(validateRelayToViewer(JSON.stringify({ t: 'pair', state: 'pending', code: '0007' }))).toEqual({ t: 'pair', state: 'pending', code: '0007' });
    expect(validateRelayToViewer('{"t":"pair","state":"off"}')).toEqual({ t: 'pair', state: 'off' });
    expect(validateRelayToViewer(JSON.stringify({ t: 'pair', state: 'approved' }))).toBeNull();
    expect(validateRelayToViewer(JSON.stringify({ t: 'result', id: 4, ok: true, state: 'countin' }))).toEqual({ t: 'result', id: 4, ok: true, state: 'countin' });
    expect(validateRelayToViewer(JSON.stringify({ t: 'result', to: ID_A, id: 4, ok: true, state: 'playing' }))).toBeNull();
  });
});

describe('TokenBucket (about 4 per second, burst 2)', () => {
  it('lets two through at once, then one every 250 ms, without queuing', () => {
    let t = 0;
    const b = new TokenBucket(4, 2, () => t);
    expect([b.take(), b.take(), b.take()]).toEqual([true, true, false]);
    t += 100;
    expect(b.take()).toBe(false);
    t += 150;
    expect(b.take()).toBe(true);
    t += 10_000;
    expect([b.take(), b.take(), b.take()]).toEqual([true, true, false]);
  });
});

describe('Pairing', () => {
  const seq = (...xs: number[]) => () => xs.shift() ?? 0;

  it('gives each phone a 4-digit code and shows nothing while control is off', () => {
    const p = new Pairing(seq(42, 1234));
    expect(p.join(ID_A)).toBe('0042');
    expect(p.join(ID_B)).toBe('1234');
    expect(p.list()).toEqual([]);
    expect(p.stateFor(ID_A)).toEqual({ t: 'pair', state: 'off' });
    expect(p.approve(ID_A, '0042')).toBe(false);
    p.setControl(true);
    expect(p.stateFor(ID_A)).toEqual({ t: 'pair', state: 'pending', code: '0042' });
    expect(p.list().map((e) => e.code)).toEqual(['0042', '1234']);
  });

  it('never hands out a code another connected phone or a recent connection had', () => {
    const p = new Pairing(seq(5, 5, 5, 6, 7));
    expect(p.join(ID_A)).toBe('0005');
    expect(p.join(ID_B)).toBe('0006');
    p.leave(ID_A);
    expect(p.join('cccccccccccc')).toBe('0007');
  });

  it('approves only with the matching code, one phone at a time', () => {
    const p = new Pairing(seq(1111, 2222));
    p.join(ID_A);
    p.join(ID_B);
    p.setControl(true);
    expect(p.approve(ID_A, '2222')).toBe(false);
    expect(p.approve(ID_A, '1111')).toBe(true);
    expect(p.isApproved(ID_A)).toBe(true);
    expect(p.approve(ID_B, '2222')).toBe(true);
    expect(p.isApproved(ID_A)).toBe(false);
    expect(p.isApproved(ID_B)).toBe(true);
    expect(p.list().filter((e) => e.state === 'approved')).toHaveLength(1);
  });

  it('reject marks the phone, which cannot control', () => {
    const p = new Pairing(seq(1111));
    p.join(ID_A);
    p.setControl(true);
    expect(p.reject(ID_A, '1111')).toBe(true);
    expect(p.stateFor(ID_A)).toEqual({ t: 'pair', state: 'rejected', code: '1111' });
    expect(p.isApproved(ID_A)).toBe(false);
  });

  const approved = () => {
    const p = new Pairing(seq(1111, 2222));
    p.join(ID_A);
    p.join(ID_B);
    p.setControl(true);
    p.approve(ID_A, '1111');
    return p;
  };

  it('revokes on 승인 해제', () => {
    const p = approved();
    expect(p.revoke()).toBe(true);
    expect(p.isApproved(ID_A)).toBe(false);
    expect(p.stateFor(ID_A)).toEqual({ t: 'pair', state: 'pending', code: '1111' });
  });

  it('revokes when the phone disconnects (a new connection is a new, pending phone)', () => {
    const p = approved();
    p.leave(ID_A);
    expect(p.isApproved(ID_A)).toBe(false);
    p.join(ID_A); // even an id that came back would start pending
    expect(p.isApproved(ID_A)).toBe(false);
  });

  it('revokes when the switch goes off, and stays revoked when it comes back on', () => {
    const p = approved();
    p.setControl(false);
    expect(p.isApproved(ID_A)).toBe(false);
    p.setControl(true);
    expect(p.isApproved(ID_A)).toBe(false);
  });

  it('revokes when the panel closes or is replaced (the relay turns control off)', () => {
    const p = approved();
    expect(p.setControl(false)).toBe(true); // what the relay does when its publisher leaves
    expect(p.list()).toEqual([]);
    expect(p.stateFor(ID_B)).toEqual({ t: 'pair', state: 'off' });
  });

  it('a relay restart starts with no approval at all', () => {
    const p = new Pairing(seq(1111));
    p.join(ID_A);
    p.setControl(true);
    expect(p.isApproved(ID_A)).toBe(false);
  });
});

describe('restart target', () => {
  const bars = [{ startSec: 2 }, { startSec: 4 }, { startSec: 6 }];
  it('goes to loop A when a loop exists', () => {
    expect(restartTargetSec(4.01, bars, 5.5)).toBe(4.01);
  });
  it('otherwise to the start of the current bar', () => {
    expect(restartTargetSec(null, bars, 5.5)).toBe(4);
    expect(restartTargetSec(null, bars, 4)).toBe(4);
    expect(restartTargetSec(null, bars, 30)).toBe(6);
  });
  it('to 0 before the first bar, null without bars', () => {
    expect(restartTargetSec(null, bars, 1)).toBe(0);
    expect(restartTargetSec(null, [], 1)).toBeNull();
  });
});

/** A fake panel: the player reacts after `lagMs` (or never, like an autoplay block). */
function fakePanel(o: { playing?: boolean; countIn?: boolean; countingIn?: boolean; heldCountIn?: boolean; ad?: boolean; target?: boolean; lagMs?: number; blockPlay?: boolean; position?: number; rate?: number; noSeek?: boolean; target10?: boolean } = {}) {
  let t = 0;
  const st = { playing: o.playing ?? false, countingIn: o.countingIn ?? false, position: o.position ?? 10, ad: o.ad ?? false };
  let countInDone: ((r: TransportResult) => void) | null = null;
  /** The held count-in reaches its end: plays only if nobody cancelled it. */
  const endCountIn = () => {
    if (!st.countingIn || !countInDone) return;
    st.countingIn = false;
    st.playing = true;
    countInDone({ ok: true });
  };
  const later = (fn: () => void) => {
    const at = t + (o.lagMs ?? 200);
    pendingFx.push({ at, fn });
  };
  const pendingFx: { at: number; fn: () => void }[] = [];
  const calls: string[] = [];
  const player: ObservedPlayer = {
    playing: () => st.playing,
    countingIn: () => st.countingIn,
    position: () => st.position,
    rate: () => o.rate ?? 1,
    isAd: () => st.ad,
    hasTarget: () => o.target ?? true,
  };
  const transport: PanelTransport = {
    toggle: async (onCountIn): Promise<TransportResult> => {
      calls.push('toggle');
      if (st.countingIn) {
        st.countingIn = false;
        return { ok: true };
      }
      if (st.playing) {
        later(() => (st.playing = false));
        return { ok: true };
      }
      if (o.heldCountIn) {
        // A count-in that really waits: it plays only when endCountIn() runs, unless cancelled first.
        st.countingIn = true;
        const p = new Promise<TransportResult>((r) => (countInDone = r));
        onCountIn();
        return p;
      }
      if (o.countIn) {
        st.countingIn = true;
        onCountIn();
        return { ok: false, cancelled: true }; // the test cancels it
      }
      if (!o.blockPlay) later(() => (st.playing = true));
      return { ok: true };
    },
    seek: async (sec) => {
      calls.push(`seek ${sec}`);
      if (!o.noSeek) later(() => (st.position = sec));
      return { ok: true };
    },
    restartTarget: () => (o.target10 ? 10 : 4),
    cancelCountIn: () => {
      calls.push('cancelCountIn');
      if (!st.countingIn) return;
      st.countingIn = false;
      countInDone?.({ ok: false, cancelled: true });
    },
  };
  const run = (cmd: PhoneCommand, progress?: (x: CommandOutcome) => void, signal?: AbortSignal) =>
    runPhoneCommand(cmd, player, transport, {
      progress,
      signal,
      now: () => t,
      sleep: async (ms) => {
        t += ms;
        if (st.playing) st.position += ((o.rate ?? 1) * ms) / 1000;
        for (const fx of pendingFx.filter((x) => x.at <= t)) {
          fx.fn();
          pendingFx.splice(pendingFx.indexOf(fx), 1);
        }
      },
    });
  /** Runs `fn` once the fake clock reaches `at` ms (e.g. a rate change from the panel). */
  const schedule = (at: number, fn: () => void) => pendingFx.push({ at, fn });
  return { st, calls, run, endCountIn, schedule, time: () => t };
}

describe('runPhoneCommand: the outcome follows the observed player state', () => {
  it('play is reported only once the player shows it playing', async () => {
    const f = fakePanel({ lagMs: 300 });
    expect(await f.run('toggle')).toEqual({ ok: true, state: 'playing' });
    expect(f.time()).toBeGreaterThanOrEqual(300);
  });

  it('pause is reported once the player shows it paused', async () => {
    const f = fakePanel({ playing: true });
    expect(await f.run('toggle')).toEqual({ ok: true, state: 'paused' });
  });

  it('a play the page never starts (autoplay rule) ends with the autoplay message after the bounded wait', async () => {
    const f = fakePanel({ blockPlay: true });
    expect(await f.run('toggle')).toEqual({ ok: false, code: 'autoplay' });
    expect(f.time()).toBeGreaterThanOrEqual(CONTROL_OBSERVE_MS);
    expect(f.time()).toBeLessThan(CONTROL_OBSERVE_MS + 200);
  });

  it('a pause that never shows ends with timeout', async () => {
    const f = fakePanel({ playing: true, lagMs: 60_000 });
    expect(await f.run('toggle')).toEqual({ ok: false, code: 'timeout' });
  });

  it('reports the count-in as progress, and a pause during it cancels it', async () => {
    const f = fakePanel({ countIn: true });
    const progress: CommandOutcome[] = [];
    expect(await f.run('toggle', (x) => progress.push(x))).toEqual({ ok: true, state: 'paused' });
    expect(progress).toEqual([{ ok: true, state: 'countin' }]);
    f.st.countingIn = true; // count-in still running when the phone taps again
    expect(await f.run('toggle')).toEqual({ ok: true, state: 'paused' });
    expect(f.st.countingIn).toBe(false);
  });

  it('rejects during ads and without a target, before touching the player', async () => {
    const ad = fakePanel({ ad: true });
    expect(await ad.run('toggle')).toEqual({ ok: false, code: 'ad' });
    expect(await ad.run('restart')).toEqual({ ok: false, code: 'ad' });
    const none = fakePanel({ target: false });
    expect(await none.run('restart')).toEqual({ ok: false, code: 'no-target' });
    expect([...ad.calls, ...none.calls]).toEqual([]);
  });

  it('restart seeks through the panel handler and keeps the paused state', async () => {
    const f = fakePanel({ position: 9 });
    expect(await f.run('restart')).toEqual({ ok: true, state: 'paused' });
    expect(f.calls).toEqual(['seek 4']);
    expect(f.st.position).toBe(4);
  });

  it('restart keeps playing when it was playing', async () => {
    const f = fakePanel({ playing: true, position: 9 });
    expect(await f.run('restart')).toEqual({ ok: true, state: 'playing' });
  });

  it('S6-R1-01: losing control during a phone-started count-in cancels it, so it never plays', async () => {
    const f = fakePanel({ heldCountIn: true });
    const ctl = new AbortController();
    const progress: CommandOutcome[] = [];
    const done = f.run('toggle', (x) => progress.push(x), ctl.signal);
    await Promise.resolve();
    expect(progress).toEqual([{ ok: true, state: 'countin' }]);
    ctl.abort(); // switch off, 승인 해제, phone or relay gone, panel replaced
    f.endCountIn(); // the count-in would have reached its play now
    expect(f.st.playing).toBe(false);
    expect(f.calls).toContain('cancelCountIn');
    expect(await done).toEqual({ ok: false, code: 'cancelled' });
  });

  it('S6-R1-01: a command whose control is already gone touches nothing', async () => {
    const f = fakePanel({ heldCountIn: true });
    const ctl = new AbortController();
    ctl.abort();
    const progress: CommandOutcome[] = [];
    const done = f.run('toggle', (x) => progress.push(x), ctl.signal);
    f.endCountIn();
    expect(f.st.playing).toBe(false);
    expect(progress).toEqual([]);
    expect(await done).toEqual({ ok: false, code: 'cancelled' });
    expect(await f.run('restart', undefined, ctl.signal)).toEqual({ ok: false, code: 'cancelled' });
    expect(f.calls).toEqual([]);
  });

  it('S6-R1-02: pause during a count-in also pauses a player started on the Mac meanwhile', async () => {
    const f = fakePanel({ countingIn: true, playing: true });
    expect(await f.run('toggle')).toEqual({ ok: true, state: 'paused' });
    expect(f.calls).toEqual(['toggle', 'toggle']);
    expect(f.st.playing).toBe(false);
  });

  it('S6-R1-02: a pause during a count-in that never shows is not reported as paused', async () => {
    const f = fakePanel({ countingIn: true, playing: true, lagMs: 60_000 });
    expect(await f.run('toggle')).toEqual({ ok: false, code: 'timeout' });
  });

  it('S6-R1-03: at 0.5x a seek that was accepted but not applied is not reported as success', async () => {
    const f = fakePanel({ playing: true, rate: 0.5, position: 11.5, noSeek: true, target10: true });
    expect(await f.run('restart')).toEqual({ ok: false, code: 'timeout' });
    expect(f.st.position).toBeGreaterThan(12.4);
  });

  it('S6-R1-03: at 0.5x a seek that lands is reported once the position reaches the target', async () => {
    const f = fakePanel({ playing: true, rate: 0.5, position: 11.5, target10: true, lagMs: 400 });
    expect(await f.run('restart')).toEqual({ ok: true, state: 'playing' });
    expect(f.time()).toBeGreaterThanOrEqual(400);
  });

  it('S6-R2-03: 0.5x -> 1x during the check with a dropped seek is not success (no rate x time window)', async () => {
    const opts = { playing: true, rate: 0.5, position: 11.5, noSeek: true, target10: true };
    const f = fakePanel(opts);
    f.schedule(2000, () => (opts.rate = 1)); // the panel's speed button during the check
    expect(await f.run('restart')).toEqual({ ok: false, code: 'timeout' });
    expect(f.calls).toEqual(['seek 10']);
  });

  it('S6-R2-03: 0.5x -> 1x during the check with an applied seek is success from fresh observations', async () => {
    const opts = { playing: true, rate: 0.5, position: 11.5, target10: true, lagMs: 400 };
    const f = fakePanel(opts);
    f.schedule(100, () => (opts.rate = 1));
    expect(await f.run('restart')).toEqual({ ok: true, state: 'playing' });
    expect(f.time()).toBeGreaterThanOrEqual(400);
    expect(f.st.position).toBeLessThan(10 + 0.6);
  });

  it('restart that never lands times out', async () => {
    const f = fakePanel({ position: 9, lagMs: 60_000 });
    expect(await f.run('restart')).toEqual({ ok: false, code: 'timeout' });
  });
});

// ---------- the panel's gate in PhoneLink ----------
class FakeSocket implements SocketLike {
  readyState = 0;
  sent: string[] = [];
  onopen: SocketLike['onopen'] = null;
  onmessage: SocketLike['onmessage'] = null;
  onclose: SocketLike['onclose'] = null;
  onerror: SocketLike['onerror'] = null;
  send(text: string) {
    this.sent.push(text);
  }
  close() {}
  open() {
    this.readyState = 1;
    this.onopen?.(new Event('open'));
  }
  rx(m: unknown) {
    this.onmessage?.({ data: JSON.stringify(m) } as MessageEvent);
  }
  drop() {
    this.readyState = 3;
    this.onclose?.({ code: 1006 } as CloseEvent);
  }
  json() {
    return this.sent.map((x) => JSON.parse(x) as Record<string, unknown>);
  }
}

function linkHarness() {
  let now = 1_000_000;
  const timers: { at: number; fn: () => void }[] = [];
  const sockets: FakeSocket[] = [];
  const commands: PhoneCommand[] = [];
  const phones: PhoneEntry[][] = [];
  let answer: (cmd: PhoneCommand, progress: (o: CommandOutcome) => void, signal: AbortSignal) => Promise<CommandOutcome> = async () => ({ ok: true, state: 'playing' });
  const link = new PhoneLink({
    onStatus: () => {},
    sample: () => ({ position: 1, rate: 1, paused: true, ad: false, loop: null }),
    onPhones: (l) => phones.push(l),
    onCommand: (cmd, progress, signal) => {
      commands.push(cmd);
      return answer(cmd, progress, signal);
    },
    makeSocket: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    now: () => now,
    setTimer: (fn, ms) => {
      const t = { at: now + ms, fn };
      timers.push(t);
      return t;
    },
    clearTimer: (id) => {
      const i = timers.indexOf(id as (typeof timers)[number]);
      if (i >= 0) timers.splice(i, 1);
    },
  });
  const advance = (ms: number) => {
    const end = now + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const t = timers[0];
      if (!t || t.at > end) break;
      timers.shift();
      now = t.at;
      t.fn();
    }
    now = end;
  };
  link.setEnabled(true);
  const ws = sockets[0]!;
  ws.open();
  const song = ws.json().find((m) => m.t === 'song')!;
  const h = {
    link,
    ws,
    sockets,
    commands,
    phones,
    advance,
    set answer(fn: typeof answer) {
      answer = fn;
    },
    epoch: song.epoch as string,
    rev: song.rev as number,
    cmd: (id: number, from = ID_A, extra: Record<string, unknown> = {}) => ws.rx({ t: 'cmd', id, epoch: h.epoch, rev: h.rev, cmd: 'toggle', from, ...extra }),
    results: () => ws.json().filter((m) => m.t === 'result'),
    approve: (id = ID_A) => ws.rx({ t: 'phones', list: [{ id, code: '1234', state: 'approved' }] }),
  };
  return h;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('PhoneLink: the panel checks every forwarded command again', () => {
  it('settings: 휴대폰에서 조작 허용 is off by default and kept only as a boolean true', () => {
    expect(DEFAULT_SETTINGS.phoneControl).toBe(false);
    expect(normalizeSettings({}).phoneControl).toBe(false);
    expect(normalizeSettings({ phoneControl: 'yes' } as never).phoneControl).toBe(false);
    expect(normalizeSettings({ phoneControl: true }).phoneControl).toBe(true);
  });

  it('tells the relay when control is switched, also after a reconnect', () => {
    const h = linkHarness();
    expect(h.ws.json().some((m) => m.t === 'control')).toBe(false);
    h.link.setControl(true);
    expect(h.ws.json().filter((m) => m.t === 'control')).toEqual([{ t: 'control', on: true }]);
    h.ws.drop();
    h.advance(1000);
    h.sockets[1]!.open();
    expect(h.sockets[1]!.json().filter((m) => m.t === 'control')).toEqual([{ t: 'control', on: true }]);
  });

  it('switch off: rejects without reaching the player', async () => {
    const h = linkHarness();
    h.approve();
    h.cmd(1);
    await flush();
    expect(h.commands).toEqual([]);
    expect(h.results()).toEqual([{ t: 'result', to: ID_A, id: 1, ok: false, code: 'off' }]);
  });

  it('unapproved connection: rejected', async () => {
    const h = linkHarness();
    h.link.setControl(true);
    h.ws.rx({ t: 'phones', list: [{ id: ID_A, code: '1234', state: 'pending' }, { id: ID_B, code: '5678', state: 'approved' }] });
    h.cmd(1, ID_A);
    await flush();
    expect(h.commands).toEqual([]);
    expect(h.results()[0]).toMatchObject({ ok: false, code: 'not-approved' });
  });

  it('approved: carried out once, then duplicate and stale requests are rejected', async () => {
    const h = linkHarness();
    h.link.setControl(true);
    h.approve();
    h.cmd(1);
    await flush();
    expect(h.commands).toEqual(['toggle']);
    expect(h.results().at(-1)).toEqual({ t: 'result', to: ID_A, id: 1, ok: true, state: 'playing' });
    h.advance(1000);
    h.cmd(1);
    h.advance(1000);
    h.cmd(2, ID_A, { rev: h.rev + 5 });
    h.advance(1000);
    h.cmd(3, ID_A, { epoch: 'otherepoch01' });
    await flush();
    expect(h.commands).toEqual(['toggle']);
    expect(h.results().slice(1).map((r) => r.code)).toEqual(['duplicate', 'stale', 'stale']);
  });

  it('a song change waiting for its debounce makes a command stale', async () => {
    const h = linkHarness();
    h.link.setControl(true);
    h.approve();
    h.link.setSong({ ...JSON.parse('{"v":1}'), v: 1 } as never);
    h.cmd(1);
    await flush();
    expect(h.commands).toEqual([]);
    expect(h.results()[0]).toMatchObject({ code: 'stale' });
  });

  it('rate limit: a third command at once is rejected, not queued', async () => {
    const h = linkHarness();
    h.link.setControl(true);
    h.approve();
    let release!: () => void;
    h.answer = () => new Promise((r) => (release = () => r({ ok: true, state: 'paused' })));
    h.cmd(1);
    h.cmd(2);
    h.cmd(3);
    await flush();
    expect(h.commands).toEqual(['toggle']);
    expect(h.results().map((r) => r.code)).toEqual(['busy', 'rate']);
    release();
    await flush();
    expect(h.results().at(-1)).toMatchObject({ id: 1, ok: true });
  });

  it('count-in progress frees the panel for the next command (pause cancels the count-in)', async () => {
    const h = linkHarness();
    h.link.setControl(true);
    h.approve();
    let finish!: (o: CommandOutcome) => void;
    h.answer = (_c, progress) =>
      new Promise((r) => {
        progress({ ok: true, state: 'countin' });
        finish = r;
      });
    h.cmd(1);
    await flush();
    expect(h.results()).toEqual([{ t: 'result', to: ID_A, id: 1, ok: true, state: 'countin' }]);
    h.answer = async () => ({ ok: true, state: 'paused' });
    h.advance(1000);
    h.cmd(2);
    await flush();
    finish({ ok: true, state: 'paused' });
    await flush();
    expect(h.commands).toEqual(['toggle', 'toggle']);
    expect(h.results().map((r) => [r.id, r.state])).toEqual([[1, 'countin'], [2, 'paused'], [1, 'paused']]);
  });

  it('never sends a result over a later connection (no replay after reconnect)', async () => {
    const h = linkHarness();
    h.link.setControl(true);
    h.approve();
    let finish!: (o: CommandOutcome) => void;
    h.answer = () => new Promise((r) => (finish = r));
    h.cmd(1);
    h.ws.drop();
    expect(h.phones.at(-1)).toEqual([]);
    h.advance(1000);
    h.sockets[1]!.open();
    finish({ ok: true, state: 'playing' });
    await flush();
    expect(h.sockets[1]!.json().filter((m) => m.t === 'result')).toEqual([]);
  });

  it('switching control off clears the list and rejects what still arrives', async () => {
    const h = linkHarness();
    h.link.setControl(true);
    h.approve();
    expect(h.link.phoneList).toHaveLength(1);
    h.link.setControl(false);
    expect(h.link.phoneList).toEqual([]);
    expect(h.ws.json().filter((m) => m.t === 'control').at(-1)).toEqual({ t: 'control', on: false });
    h.cmd(1);
    await flush();
    expect(h.commands).toEqual([]);
    expect(h.results()[0]).toMatchObject({ code: 'off' });
  });

  it('S6-R1-01: a running command is aborted on switch-off, 승인 해제, phone or relay gone, and panel replacement', async () => {
    const triggers: [string, (h: ReturnType<typeof linkHarness>) => void][] = [
      ['switch off', (h) => h.link.setControl(false)],
      ['revoke', (h) => h.link.revoke()],
      ['phone disconnected', (h) => h.ws.rx({ t: 'phones', list: [] })],
      ['approval moved to another phone', (h) => h.ws.rx({ t: 'phones', list: [{ id: ID_B, code: '5678', state: 'approved' }] })],
      ['relay disconnected', (h) => h.ws.drop()],
      ['panel replaced', (h) => {
        h.ws.readyState = 3;
        h.ws.onclose?.({ code: 4000 } as CloseEvent);
      }],
      ['phone stand off', (h) => h.link.setEnabled(false)],
    ];
    for (const [name, trigger] of triggers) {
      const h = linkHarness();
      h.link.setControl(true);
      h.approve();
      // The real runner with a count-in that waits for its end.
      const f = fakePanel({ heldCountIn: true });
      let signal: AbortSignal | null = null;
      h.answer = (c, progress, sig) => {
        signal = sig;
        return f.run(c, progress, sig);
      };
      h.cmd(1);
      await flush();
      expect(f.st.countingIn, name).toBe(true);
      expect(signal!.aborted, name).toBe(false);
      trigger(h);
      expect(signal!.aborted, name).toBe(true);
      f.endCountIn(); // the moment the count-in would have played
      await flush();
      expect(f.st.playing, `${name}: no play reaches the player`).toBe(false);
      expect(f.calls, name).toEqual(['toggle', 'cancelCountIn']);
    }
  });

  it('a phones update that keeps the same approved phone does not abort its command', async () => {
    const h = linkHarness();
    h.link.setControl(true);
    h.approve();
    let signal: AbortSignal | null = null;
    h.answer = (_c, _p, sig) => {
      signal = sig;
      return new Promise(() => {});
    };
    h.cmd(1);
    await flush();
    h.ws.rx({ t: 'phones', list: [{ id: ID_A, code: '1234', state: 'approved' }, { id: ID_B, code: '5678', state: 'pending' }] });
    expect(signal!.aborted).toBe(false);
  });

  it('approve / reject / revoke carry the shown code', () => {
    const h = linkHarness();
    h.link.setControl(true);
    h.ws.rx({ t: 'phones', list: [{ id: ID_A, code: '1234', state: 'pending' }] });
    h.link.approve(ID_A);
    h.link.reject(ID_A);
    h.link.revoke();
    h.link.approve(ID_B); // not listed: nothing sent
    expect(h.ws.json().filter((m) => ['approve', 'reject', 'revoke'].includes(m.t as string))).toEqual([
      { t: 'approve', id: ID_A, code: '1234' },
      { t: 'reject', id: ID_A, code: '1234' },
      { t: 'revoke' },
    ]);
  });
});

// ---------- S6-R2-01: one authorization gate in front of every player command ----------
/**
 * The panel's real play-button steps (playToggle) on a fake player. Each player command waits for
 * its reply until the test calls reply(); seeks may be dropped (accepted, never applied). The
 * count-in really waits for its beats (fake timers).
 */
function gatePanel(o: { countIn: boolean; loopStart?: number | null; dropSeek?: boolean }) {
  const st = { playing: false, position: 20, countingIn: false, run: 0, phoneRun: -1 };
  const sent: string[] = [];
  const pending: (() => void)[] = [];
  const env: PlayToggleEnv = {
    send: (msg: PlayerControlMessage) => {
      sent.push(msg.action === 'seek' ? `seek ${msg.time}` : msg.action);
      return new Promise<PlayerControlResult>((resolve) =>
        pending.push(() => {
          if (msg.action === 'pause') st.playing = false;
          if (msg.action === 'play') st.playing = true;
          if (msg.action === 'seek' && !o.dropSeek) st.position = msg.time!;
          resolve({ ok: true });
        }),
      );
    },
    isPlaying: () => st.playing,
    countingIn: () => st.countingIn,
    stopCountIn: () => {
      st.run++;
      st.countingIn = false;
    },
    newRun: () => ++st.run,
    isRun: (run) => run === st.run,
    beginCountIn: () => (st.countingIn = true),
    endCountIn: () => (st.countingIn = false),
    countInPlan: () => (o.countIn ? { target: 4, beats: 4, bigPerBar: 4, beatSec: 0.5 } : null),
    loopStartOutside: () => o.loopStart ?? null,
    rate: () => 1,
    seeked: () => {},
    status: () => {},
    beat: () => {},
  };
  const player: ObservedPlayer = {
    playing: () => st.playing && !st.countingIn,
    countingIn: () => st.countingIn,
    position: () => st.position,
    rate: () => 1,
    isAd: () => false,
    hasTarget: () => true,
  };
  // As sidepanel.ts wires it.
  const transport: PanelTransport = {
    toggle: (onCountIn, allowed) =>
      playToggle(env, {
        onCountIn: () => {
          st.phoneRun = st.run;
          onCountIn();
        },
        allowed,
      }),
    cancelCountIn: () => {
      if (st.countingIn && st.run === st.phoneRun) env.stopCountIn();
    },
    seek: (sec) => {
      env.stopCountIn();
      return env.send({ type: 'player-control', action: 'seek', time: sec });
    },
    restartTarget: () => 4,
  };
  /** Answers the oldest player command still waiting for its reply. */
  const reply = () => pending.shift()?.();
  return { st, sent, pending, env, player, transport, reply };
}

const settle = () => vi.advanceTimersByTimeAsync(0);

const REVOKE_TRIGGERS: [string, (h: ReturnType<typeof linkHarness>) => void][] = [
  ['switch off', (h) => h.link.setControl(false)],
  ['승인 해제', (h) => h.link.revoke()],
  ['phone disconnected', (h) => h.ws.rx({ t: 'phones', list: [] })],
  ['phone rejected', (h) => h.ws.rx({ t: 'phones', list: [{ id: ID_A, code: '1234', state: 'rejected' }] })],
  ['approval moved to another phone', (h) => h.ws.rx({ t: 'phones', list: [{ id: ID_B, code: '5678', state: 'approved' }] })],
  ['relay disconnected', (h) => h.ws.drop()],
  ['panel replaced', (h) => {
    h.ws.readyState = 3;
    h.ws.onclose?.({ code: 4000 } as CloseEvent);
  }],
  ['악보대 OFF', (h) => h.link.setEnabled(false)],
];

type Point = { name: string; countIn: boolean; reach: (p: ReturnType<typeof gatePanel>) => Promise<void>; sentBefore: string[] };
const POINTS: Point[] = [
  // count-in on: pause, seek to the bar start, the beats, play
  { name: 'count-in preparation: pause reply', countIn: true, reach: async () => {}, sentBefore: ['pause'] },
  { name: 'count-in preparation: seek reply', countIn: true, reach: async (p) => { p.reply(); await settle(); }, sentBefore: ['pause', 'seek 4'] },
  { name: 'count-in beats', countIn: true, reach: async (p) => { p.reply(); await settle(); p.reply(); await settle(); await vi.advanceTimersByTimeAsync(600); }, sentBefore: ['pause', 'seek 4'] },
  { name: 'count-in: play reply', countIn: true, reach: async (p) => { p.reply(); await settle(); p.reply(); await settle(); await vi.advanceTimersByTimeAsync(2100); }, sentBefore: ['pause', 'seek 4', 'play'] },
  // count-in off, playhead outside the loop: seek to A, then play
  { name: 'loop-start seek reply (count-in off)', countIn: false, reach: async () => {}, sentBefore: ['seek 5'] },
  { name: 'play reply (count-in off)', countIn: false, reach: async (p) => { p.reply(); await settle(); }, sentBefore: ['seek 5', 'play'] },
];

describe('S6-R2-01: once the phone loses control, a phone command sends nothing further', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  for (const point of POINTS) {
    for (const dropSeek of [false, true]) {
      it(`${point.name}${dropSeek ? ', seek dropped' : ''}: every revoke trigger`, async () => {
        for (const [name, trigger] of REVOKE_TRIGGERS) {
          const h = linkHarness();
          h.link.setControl(true);
          h.approve();
          const p = gatePanel({ countIn: point.countIn, loopStart: point.countIn ? null : 5, dropSeek });
          h.answer = (c, progress, signal) => runPhoneCommand(c, p.player, p.transport, { progress, signal });
          h.cmd(1);
          await settle();
          await point.reach(p);
          const label = `${point.name} / ${name}`;
          expect(p.sent, label).toEqual(point.sentBefore);
          if (point.name === 'count-in beats') expect(p.st.countingIn, label).toBe(true);
          trigger(h);
          // Let everything finish: every reply arrives, every beat and wait runs out.
          for (let i = 0; i < 20; i++) {
            while (p.pending.length) p.reply();
            await vi.advanceTimersByTimeAsync(500);
          }
          expect(p.sent, `${label}: no player command after the trigger`).toEqual(point.sentBefore);
          expect(p.st.countingIn, label).toBe(false);
          if (!point.sentBefore.includes('play')) {
            expect(p.st.playing, `${label}: never plays`).toBe(false);
            const results = h.results().filter((r) => r.id === 1 && r.state !== 'countin');
            for (const r of results) expect(r, label).toMatchObject({ ok: false, code: 'cancelled' });
          }
        }
      });
    }
  }

  it('without a trigger the same steps run to the end (count-in on and off)', async () => {
    for (const countIn of [true, false]) {
      const h = linkHarness();
      h.link.setControl(true);
      h.approve();
      const p = gatePanel({ countIn, loopStart: countIn ? null : 5 });
      h.answer = (c, progress, signal) => runPhoneCommand(c, p.player, p.transport, { progress, signal });
      h.cmd(1);
      for (let i = 0; i < 20; i++) {
        while (p.pending.length) p.reply();
        await vi.advanceTimersByTimeAsync(500);
      }
      expect(p.sent).toEqual(countIn ? ['pause', 'seek 4', 'play'] : ['seek 5', 'play']);
      expect(h.results().at(-1)).toMatchObject({ id: 1, ok: true, state: 'playing' });
    }
  });

  it('the panel\'s own button is never gated', async () => {
    const p = gatePanel({ countIn: false, loopStart: 5 });
    const done = playToggle(p.env);
    await settle();
    p.reply();
    await settle();
    p.reply();
    expect(await done).toEqual({ ok: true });
    expect(p.sent).toEqual(['seek 5', 'play']);
  });

  it('restart: control lost while the seek reply is pending sends nothing more and reports no success', async () => {
    const h = linkHarness();
    h.link.setControl(true);
    h.approve();
    const p = gatePanel({ countIn: false, dropSeek: true });
    h.answer = (c, progress, signal) => runPhoneCommand(c, p.player, p.transport, { progress, signal });
    h.ws.rx({ t: 'cmd', id: 1, epoch: h.epoch, rev: h.rev, cmd: 'restart', from: ID_A });
    await settle();
    h.link.revoke();
    for (let i = 0; i < 10; i++) {
      while (p.pending.length) p.reply();
      await vi.advanceTimersByTimeAsync(500);
    }
    expect(p.sent).toEqual(['seek 4']);
    expect(h.results().at(-1)).toMatchObject({ id: 1, ok: false, code: 'timeout' });
  });
});

// ---------- S6-R3-01: a local revoke rejects the phone at once, before the relay's update ----------
describe('S6-R3-01: the panel withdraws control locally before the relay confirms', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const BOTH: PhoneEntry[] = [
    { id: ID_A, code: '1234', state: 'approved' },
    { id: ID_B, code: '5678', state: 'pending' },
  ];
  const LOCAL_TRIGGERS: [string, (h: ReturnType<typeof linkHarness>) => void, PhoneEntry[]][] = [
    ['승인 해제', (h) => h.link.revoke(), [{ ...BOTH[0]!, state: 'pending' }, BOTH[1]!]],
    ['reject', (h) => h.link.reject(ID_A), [{ ...BOTH[0]!, state: 'rejected' }, BOTH[1]!]],
    ['switch off', (h) => h.link.setControl(false), []],
    ['악보대 OFF', (h) => h.link.setEnabled(false), []],
    ['approving another phone', (h) => h.link.approve(ID_B), [{ ...BOTH[0]!, state: 'pending' }, { ...BOTH[1]!, state: 'approved' }]],
  ];

  for (const stale of [false, true]) {
    it(`trigger -> command from the old phone${stale ? ' -> (an older list still showing it approved)' : ''} -> relay update: nothing is played`, async () => {
      for (const [name, trigger, after] of LOCAL_TRIGGERS) {
        const h = linkHarness();
        h.link.setControl(true);
        h.ws.rx({ t: 'phones', list: BOTH });
        // Count-in off, no loop: the command is a single play.
        const p = gatePanel({ countIn: false, loopStart: null });
        h.answer = (c, progress, signal) => runPhoneCommand(c, p.player, p.transport, { progress, signal });
        trigger(h);
        if (stale) h.ws.rx({ t: 'phones', list: BOTH }); // sent by the relay before it saw the request
        h.cmd(1);
        h.ws.rx({ t: 'phones', list: after });
        for (let i = 0; i < 10; i++) {
          while (p.pending.length) p.reply();
          await vi.advanceTimersByTimeAsync(500);
        }
        expect(p.sent, name).toEqual([]);
        expect(h.commands, name).toEqual([]);
        expect(p.st.playing, name).toBe(false);
        const r = h.results().filter((x) => x.id === 1);
        if (r.length) expect(['not-approved', 'off'], name).toContain(r[0]!.code);
      }
    });
  }

  it('approving the same phone again lifts the local withdrawal', async () => {
    const h = linkHarness();
    h.link.setControl(true);
    h.ws.rx({ t: 'phones', list: BOTH });
    h.link.revoke();
    expect(h.link.phoneList.find((x) => x.id === ID_A)?.state).toBe('pending');
    h.ws.rx({ t: 'phones', list: [{ ...BOTH[0]!, state: 'pending' }, BOTH[1]!] });
    h.link.approve(ID_A);
    h.ws.rx({ t: 'phones', list: BOTH });
    h.cmd(1);
    await settle();
    expect(h.commands).toEqual(['toggle']);
  });
});
