// VGT-16 phone control, pure parts: message validation, the pairing state machine, the rate limit, the
// panel's own command gate (PhoneLink) and how a command is carried out and reported (phone-control).
import { readFileSync } from 'node:fs';
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
import { ShownModel, modelSongId, playerTargetKey, songIdOf, songViewReady, restartTargetSec, barIndexAt, barStepTargetSec, type TargetParts, runPhoneCommand, panelClock, intervalProgressSec, RATE_CHANGE_CREDIT_SEC, type CommandContext, type ObservedPlayer, type PanelTransport, type TransportResult, type WrapSample } from '../src/extension/sidepanel/phone-control';
import { playToggle, type PlayToggleEnv } from '../src/extension/sidepanel/play-toggle';
import type { PlayerControlMessage, PlayerControlResult } from '../src/extension/messages';
import { DEFAULT_SETTINGS, chartSongKey, normalizeSettings } from '../src/extension/storage';

const ID_A = 'aaaaaaaaaaaa';
const ID_B = 'bbbbbbbbbbbb';
const EPOCH = 'epochepoch01';

describe('protocol: control messages', () => {
  const cmd = { t: 'cmd', id: 1, epoch: EPOCH, rev: 3, cmd: 'toggle' };

  it('accepts exactly the four commands from a viewer', () => {
    expect(validateViewerMessage(JSON.stringify(cmd))).toEqual(cmd);
    for (const c of ['restart', 'prev-bar', 'next-bar']) expect(validateViewerMessage(JSON.stringify({ ...cmd, cmd: c }))).toEqual({ ...cmd, cmd: c });
    expect(validateViewerMessage(JSON.stringify({ t: 'ping', id: 1, c: 5 }))?.t).toBe('ping');
  });

  it('rejects any other command, extra fields (seek times, rates, tabs, urls) and bad ids', () => {
    for (const bad of [
      { ...cmd, cmd: 'seek' },
      { ...cmd, cmd: 'play' },
      { ...cmd, cmd: 'bar' },
      { ...cmd, cmd: 'next-bar', bar: 3 },
      { ...cmd, cmd: 'prev-bar', bars: -2 },
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

  it('panel messages: control, approve with id, code and grant, reject, revoke, results', () => {
    expect(validatePanelMessage('{"t":"control","on":true}')).toEqual({ t: 'control', on: true });
    expect(validatePanelMessage(JSON.stringify({ t: 'approve', id: ID_A, code: '0042', grant: 3 }))).toEqual({ t: 'approve', id: ID_A, code: '0042', grant: 3 });
    expect(validatePanelMessage(JSON.stringify({ t: 'reject', id: ID_A, code: '0042' }))).toEqual({ t: 'reject', id: ID_A, code: '0042' });
    expect(validatePanelMessage('{"t":"revoke"}')).toEqual({ t: 'revoke' });
    expect(validatePanelMessage(JSON.stringify({ t: 'result', to: ID_A, id: 2, ok: false, code: 'autoplay' }))).toEqual({ t: 'result', to: ID_A, id: 2, ok: false, code: 'autoplay' });
    for (const bad of [
      { t: 'control', on: 1 },
      { t: 'approve', id: ID_A, code: '12345', grant: 1 },
      { t: 'approve', id: 'short', code: '1234', grant: 1 },
      { t: 'approve', id: ID_A, code: '1234' }, // no grant
      { t: 'approve', id: ID_A, code: '1234', grant: 0 },
      { t: 'approve', id: ID_A, code: '1234', grant: 1.5 },
      { t: 'reject', id: ID_A, code: '1234', grant: 1 },
      { t: 'revoke', id: ID_A },
      { t: 'result', to: ID_A, id: 2, ok: true, state: 'seeking' },
      { t: 'result', to: ID_A, id: 2, ok: false, code: 'whatever' },
      { t: 'result', to: ID_A, id: 2, ok: true, state: 'playing', text: 'hi' },
    ])
      expect(validatePanelMessage(JSON.stringify(bad)), JSON.stringify(bad)).toBeNull();
  });

  it('relay -> panel and relay -> viewer messages are validated field by field', () => {
    expect(validateRelayToPanel(JSON.stringify({ ...cmd, from: ID_A, grant: 2 }))).toEqual({ ...cmd, from: ID_A, grant: 2 });
    expect(validateRelayToPanel(JSON.stringify({ ...cmd, from: ID_A }))).toBeNull(); // no grant
    expect(validateRelayToPanel(JSON.stringify({ t: 'phones', list: [{ id: ID_A, code: '1234', state: 'pending' }] }))?.t).toBe('phones');
    expect(validateRelayToPanel(JSON.stringify({ t: 'phones', list: [{ id: ID_A, code: '1234', state: 'pending', ip: '1.2.3.4' }] }))).toBeNull();
    expect(validateRelayToPanel(JSON.stringify({ t: 'phones', list: [{ id: ID_A, code: '1234', state: 'approved', grant: 3 }] }))?.t).toBe('phones');
    expect(validateRelayToPanel(JSON.stringify({ t: 'phones', list: [{ id: ID_A, code: '1234', state: 'pending', grant: 3 }] }))).toBeNull();
    expect(validateRelayToPanel(JSON.stringify({ t: 'phones', list: [{ id: ID_A, code: '1234', state: 'approved', grant: 0 }] }))).toBeNull();
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
    expect(p.approve(ID_A, '0042', 1)).toBe(false);
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
    expect(p.approve(ID_A, '2222', 1)).toBe(false);
    expect(p.approve(ID_A, '1111', 1)).toBe(true);
    expect(p.isApproved(ID_A)).toBe(true);
    expect(p.grantOf(ID_A)).toBe(1);
    expect(p.approve(ID_B, '2222', 2)).toBe(true);
    expect(p.isApproved(ID_A)).toBe(false);
    expect(p.grantOf(ID_A)).toBeNull();
    expect(p.grantOf(ID_B)).toBe(2);
    expect(p.list().filter((e) => e.state === 'approved')).toHaveLength(1);
    // The panel sees which of its grants the relay holds; only approved entries carry one.
    expect(p.list()).toEqual([{ id: ID_A, code: '1111', state: 'pending' }, { id: ID_B, code: '2222', state: 'approved', grant: 2 }]);
  });

  it("keeps the panel's grant with the approval and replaces it on a new approval of the same phone", () => {
    const p = new Pairing(seq(1111));
    p.join(ID_A);
    p.setControl(true);
    expect(p.approve(ID_A, '1111', 4)).toBe(true);
    expect(p.approve(ID_A, '1111', 4)).toBe(false);
    expect(p.approve(ID_A, '1111', 7)).toBe(true);
    expect(p.grantOf(ID_A)).toBe(7);
    p.revoke();
    expect(p.grantOf(ID_A)).toBeNull();
    p.approve(ID_A, '1111', 8);
    p.reject(ID_A, '1111');
    expect(p.grantOf(ID_A)).toBeNull();
    p.approve(ID_A, '1111', 9);
    p.setControl(false);
    p.setControl(true);
    expect(p.grantOf(ID_A)).toBeNull();
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
    p.approve(ID_A, '1111', 1);
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
    expect(restartTargetSec(4.01, bars)).toBe(4.01);
  });
  it('otherwise to the start of the song, never the current bar', () => {
    expect(restartTargetSec(null, bars)).toBe(0);
  });
  it('null without bars', () => {
    expect(restartTargetSec(null, [])).toBeNull();
  });
});

describe('bar step target (이전 마디 / 다음 마디)', () => {
  // Bars 1..5 start at 2, 4, 6, 8, 10 s; a step lands just inside the bar, like a bar click.
  const bars = [{ startSec: 2 }, { startSec: 4 }, { startSec: 6 }, { startSec: 8 }, { startSec: 10 }];
  it('이전 마디 goes to the previous bar, also from the very start of the current bar', () => {
    expect(barStepTargetSec(-1, bars, 7.5)).toBe(4.01);
    expect(barStepTargetSec(-1, bars, 6.01)).toBe(4.01);
    expect(barStepTargetSec(-1, bars, 6)).toBe(4.01);
  });
  it('a step that landed a frame early still counts as that bar (no skipped bar on the next tap)', () => {
    expect(barStepTargetSec(-1, bars, 5.97)).toBe(4.01); // reported 0.03 s before bar 3
    expect(barStepTargetSec(1, bars, 5.97)).toBe(8.01);
    expect(barStepTargetSec(-1, bars, 5.8)).toBe(2.01); // well inside bar 2
  });
  it('이전 마디 in (or before) the first bar stays at the first bar', () => {
    expect(barStepTargetSec(-1, bars, 3)).toBe(2.01);
    expect(barStepTargetSec(-1, bars, 0.5)).toBe(2.01);
  });
  it('다음 마디 goes to the next bar; before the first bar that is bar 1', () => {
    expect(barStepTargetSec(1, bars, 7.5)).toBe(8.01);
    expect(barStepTargetSec(1, bars, 0.5)).toBe(2.01);
  });
  it('다음 마디 in the last bar is `last` (nothing to do)', () => {
    expect(barStepTargetSec(1, bars, 10.5)).toBe('last');
    expect(barStepTargetSec(1, bars, 30)).toBe('last');
  });
  it('with a loop (bars 2..4), steps stay inside its bars', () => {
    const loop: [number, number] = [1, 3];
    expect(barStepTargetSec(-1, bars, 4.5, loop)).toBe(4.01); // at A: stays at A
    expect(barStepTargetSec(-1, bars, 6.5, loop)).toBe(4.01);
    expect(barStepTargetSec(1, bars, 6.5, loop)).toBe(8.01);
    expect(barStepTargetSec(1, bars, 8.5, loop)).toBe('last'); // at B
    expect(barStepTargetSec(1, bars, 3, loop)).toBe(4.01); // before A: next is A
    expect(barStepTargetSec(-1, bars, 3, loop)).toBe(4.01);
    expect(barStepTargetSec(-1, bars, 10.5, loop)).toBe(8.01); // after B: back to B
    expect(barStepTargetSec(1, bars, 10.5, loop)).toBe(8.01);
  });
  it('barIndexAt: up to 0.1 s before a bar start counts as that bar', () => {
    expect(barIndexAt(bars, 3.9)).toBe(1); // 0.1 s before bar 2's start
    expect(barIndexAt(bars, 3.89)).toBe(0);
    expect(barIndexAt(bars, 1)).toBe(-1);
  });
  it('null without bars', () => {
    expect(barStepTargetSec(1, [], 3)).toBeNull();
    expect(barStepTargetSec(-1, [], 3)).toBeNull();
  });
});

const FAKE_BARS = Array.from({ length: 10 }, (_, i) => ({ startSec: i * 2 }));

/** A fake panel: the player reacts after `lagMs` (or never, like an autoplay block). */
function fakePanel(o: { playing?: boolean; countIn?: boolean; countingIn?: boolean; heldCountIn?: boolean; ad?: boolean; target?: boolean; lagMs?: number; blockPlay?: boolean; position?: number; rate?: number; noSeek?: boolean; target10?: boolean; loopBars?: [number, number]; landAt?: number; loopA?: boolean; bars?: { startSec: number }[]; restartAt?: number; pollMs?: number } = {}) {
  let t = 0;
  const st = { playing: o.playing ?? false, countingIn: o.countingIn ?? false, position: o.position ?? 10, ad: o.ad ?? false, wrap: null as WrapSample | null };
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
    target: () => ((o.target ?? true) ? 'song' : null),
    wrapSample: () => st.wrap,
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
      if (!o.noSeek) later(() => (st.position = o.landAt ?? sec));
      return { ok: true };
    },
    // With loopA: 처음부터 to a loop whose A is bar 3 (4 s), as sidepanel.ts builds it.
    restartTarget: () => o.restartAt ?? (o.loopA ? restartTargetSec(4.01, FAKE_BARS) : o.target10 ? 10 : 4),
    // Bars every 2 s from 0 to 18 s unless given.
    barTarget: (step) => barStepTargetSec(step, o.bars ?? FAKE_BARS, st.position, o.loopBars ?? null),
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
      pollMs: o.pollMs,
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

  it('이전 마디 / 다음 마디 seek through the panel handler to the bar next to the observed position', async () => {
    const prev = fakePanel({ position: 9 });
    expect(await prev.run('prev-bar')).toEqual({ ok: true, state: 'paused' });
    expect(prev.calls).toEqual(['seek 6.01']);
    const next = fakePanel({ playing: true, position: 9 });
    expect(await next.run('next-bar')).toEqual({ ok: true, state: 'playing' });
    expect(next.calls).toEqual(['seek 10.01']);
  });

  it('다음 마디 in the last bar sends nothing and reports last-bar; also at the loop end', async () => {
    const f = fakePanel({ position: 19 });
    expect(await f.run('next-bar')).toEqual({ ok: false, code: 'last-bar' });
    const loop = fakePanel({ position: 9, loopBars: [2, 4] });
    expect(await loop.run('next-bar')).toEqual({ ok: false, code: 'last-bar' });
    expect([...f.calls, ...loop.calls]).toEqual([]);
    expect(await loop.run('prev-bar')).toEqual({ ok: true, state: 'paused' });
    expect(loop.calls).toEqual(['seek 6.01']);
  });

  it('bar steps are refused during ads, without a target and once control is gone, touching nothing', async () => {
    const ad = fakePanel({ ad: true });
    const none = fakePanel({ target: false });
    const gone = fakePanel();
    const ctl = new AbortController();
    ctl.abort();
    for (const cmd of ['prev-bar', 'next-bar'] as const) {
      expect(await ad.run(cmd)).toEqual({ ok: false, code: 'ad' });
      expect(await none.run(cmd)).toEqual({ ok: false, code: 'no-target' });
      expect(await gone.run(cmd, undefined, ctl.signal)).toEqual({ ok: false, code: 'cancelled' });
    }
    expect([...ad.calls, ...none.calls, ...gone.calls]).toEqual([]);
  });

  it('S6-R12-01: 다음 마디 accepted but not applied while paused in the bar before is not success', async () => {
    // Bars every 2 s; paused at 3.7 s (bar 2). 3.7 is inside the generic seek window of 4.01 but not in bar 3.
    const f = fakePanel({ position: 3.7, noSeek: true });
    expect(await f.run('next-bar')).toEqual({ ok: false, code: 'timeout' });
    expect(f.calls).toEqual(['seek 4.01']);
  });

  it('S6-R12-01: a dropped 다음 마디 at 0.5x is never success while the position is still in the bar before', async () => {
    const f = fakePanel({ playing: true, rate: 0.5, position: 3.7, noSeek: true });
    const r = await f.run('next-bar');
    // Not at 50 ms (3.725 s): only once normal playback carried the position to 4.01 - BAR_EARLY_SEC
    // (the documented decision: then the position is at the target).
    if (r.ok) {
      expect(f.time()).toBeGreaterThanOrEqual(400);
      expect(barIndexAt(FAKE_BARS, f.st.position)).toBe(2);
    } else expect(r).toEqual({ ok: false, code: 'timeout' });
    expect(f.st.position).toBeGreaterThanOrEqual(3.9);
  });

  it('S6-R12-01: a step observed 0.26 s early is not success; one in the target bar is, and the next step counts from it', async () => {
    const early = fakePanel({ position: 9, landAt: 9.75 }); // 다음 마디 to 10.01 shows up at 9.75 (still bar 5)
    expect(await early.run('next-bar')).toEqual({ ok: false, code: 'timeout' });
    const landed = fakePanel({ position: 9, landAt: 9.95 }); // within BAR_EARLY_SEC of bar 6: bar 6 by the lookup
    expect(await landed.run('next-bar')).toEqual({ ok: true, state: 'paused' });
    expect(barIndexAt(FAKE_BARS, landed.st.position)).toBe(5);
    // An immediate 이전 마디 goes to bar 5 (8.01), not two bars back.
    expect(await landed.run('prev-bar')).toEqual({ ok: false, code: 'timeout' }); // lands at 9.95 again (fake)
    expect(landed.calls).toEqual(['seek 10.01', 'seek 8.01']);
  });

  it('S6-R12-01: 처음부터 to loop A counts only in the A bar; to the song start the time window stays', async () => {
    const dropped = fakePanel({ position: 3.7, noSeek: true, loopA: true }); // in the window of 4.01, but bar 2
    expect(await dropped.run('restart')).toEqual({ ok: false, code: 'timeout' });
    const ok = fakePanel({ position: 9, loopA: true });
    expect(await ok.run('restart')).toEqual({ ok: true, state: 'paused' });
    expect(ok.calls).toEqual(['seek 4.01']);
  });

  it('S6-R13-01: at 2x with 0.5 s bars, 이전 마디 observed late (already in the next bar) is success', async () => {
    // 240 BPM 2/4: bars every 0.5 s. From 3.2 s (bar starting at 3.0), 이전 마디 seeks to 2.51; the first
    // observation of the applied seek comes 250 ms later at 3.01 (2.51 + 2 x 0.25 s).
    const bars = Array.from({ length: 20 }, (_, i) => ({ startSec: i * 0.5 }));
    const f = fakePanel({ playing: true, rate: 2, position: 3.2, bars, lagMs: 250, landAt: 3.01 });
    expect(await f.run('prev-bar')).toEqual({ ok: true, state: 'playing' });
    expect(f.calls).toEqual(['seek 2.51']);
    expect(f.time()).toBeLessThan(500);
  });

  it('S6-R13-02: a short first bar (starts before 0): 처음부터 to loop A there and 이전 마디 into it succeed on landing', async () => {
    // 180 BPM 4/4, first beat at 0.05 s: bar 0 = [-1.283, 0.05). barIndexAt(0.01) already sees bar 1.
    const bars = [{ startSec: -1.283 }, { startSec: 0.05 }, { startSec: 1.383 }, { startSec: 2.717 }];
    const a = fakePanel({ position: 2, bars, restartAt: restartTargetSec(Math.max(0, -1.283) + 0.01, bars)! });
    expect(await a.run('restart')).toEqual({ ok: true, state: 'paused' });
    expect(a.calls).toEqual(['seek 0.01']);
    const prev = fakePanel({ position: 0.5, bars });
    expect(await prev.run('prev-bar')).toEqual({ ok: true, state: 'paused' });
    expect(prev.calls).toEqual(['seek 0.01']);
  });

  it('S6-R14-01: 0.5x -> 1x at 2.5 s with a dropped seek is not success (allowance follows the rate per interval)', async () => {
    // Target 10 from 11.5: at 2.5 s the position is 12.75; real progress is 1.25 s, so the bound is ~11.6.
    const opts = { playing: true, rate: 0.5, position: 11.5, noSeek: true, target10: true };
    const f = fakePanel(opts);
    f.schedule(2500, () => (opts.rate = 1));
    expect(await f.run('restart')).toEqual({ ok: false, code: 'timeout' });
  });

  it('S6-R14-01: 2x -> 0.5x just before the first observation keeps the progress already made', async () => {
    // The seek to 10 lands; the first observation (300 ms) shows 10.6 after 2x playback; the rate dropped at 290 ms.
    const opts = { playing: true, rate: 2, position: 9, lagMs: 300, landAt: 10.61 };
    const f = fakePanel(opts);
    f.schedule(290, () => (opts.rate = 0.5));
    expect(await f.run('next-bar')).toEqual({ ok: true, state: 'playing' });
    expect(f.calls).toEqual(['seek 10.01']);
  });

  describe('S6-R14-02: a loop jump between two polls', () => {
    // 240 BPM 2/4 (0.5 s bars), loop over bars 0..20 = [0, 10.5), 2x. 이전 마디 at 10.2 seeks 9.51; the
    // next poll comes 500 ms later, after the panel's loop jumped back to A (now at 0.31).
    const bars = Array.from({ length: 30 }, (_, i) => ({ startSec: i * 0.5 }));
    const scenario = (wrap: WrapSample, preset: WrapSample | null = null) => {
      const f = fakePanel({ playing: true, rate: 2, position: 10.2, bars, loopBars: [0, 20], noSeek: true, pollMs: 500 });
      f.st.wrap = preset;
      f.schedule(500, () => {
        f.st.wrap = wrap;
        f.st.position = 0.31;
      });
      return f;
    };
    it('the position seen just before the jump in the window counts', async () => {
      const f = scenario({ at: 400, position: 9.75, target: 'song' });
      expect(await f.run('prev-bar')).toEqual({ ok: true, state: 'playing' });
      expect(f.calls).toEqual(['seek 9.51']);
    });
    it('a pre-jump position outside the window does not count (dropped seek)', async () => {
      const f = scenario({ at: 150, position: 10.5, target: 'song' });
      expect(await f.run('prev-bar')).toEqual({ ok: false, code: 'timeout' });
    });
    it('a jump from before the seek is never taken', async () => {
      const f = scenario({ at: 0, position: 9.6, target: 'song' }, { at: 0, position: 9.6, target: 'song' });
      expect(await f.run('prev-bar')).toEqual({ ok: false, code: 'timeout' });
    });
    it('S6-R15-02: a jump the panel saw for another tab (target) never counts, even in the window', async () => {
      const f = scenario({ at: 400, position: 9.75, target: 'another-tab' });
      expect(await f.run('prev-bar')).toEqual({ ok: false, code: 'timeout' });
    });
  });

  it('S6-R15-01: 0.5x -> 1x just before a late first observation (2.5 s) with a dropped seek is not success', async () => {
    // Target 10 from 11.5, the first observation after the seek only at 2.5 s, the rate became 1x just
    // before it: the position is 12.75 (real progress 1.25 s). The higher rate counts for at most 0.1 s,
    // so the bound is 10 + 1.3 + 0.35 = 11.65, not 12.85; later polls never catch up.
    const opts = { playing: true, rate: 0.5, position: 11.5, noSeek: true, target10: true, pollMs: 2500 };
    const f = fakePanel(opts);
    f.schedule(2500, () => (opts.rate = 1));
    expect(await f.run('restart')).toEqual({ ok: false, code: 'timeout' });
    expect(f.calls).toEqual(['seek 10']);
  });

  it('S6-R15-01: the mirror case (2x -> 0.5x right after the seek, dropped, observed late) is not success either', async () => {
    // From 11, the rate dropped to 0.5x 50 ms after the seek; at 2.5 s the position is 11 + 0.1 + 1.225
    // (the fake's own playback ran at 2x until the observation, so the real progress is set here).
    const opts = { playing: true, rate: 2, position: 11, noSeek: true, target10: true, pollMs: 2500 };
    const f = fakePanel(opts);
    f.schedule(2500, () => {
      opts.rate = 0.5;
      f.st.position = 11 + 0.1 + 1.225;
    });
    expect(await f.run('restart')).toEqual({ ok: false, code: 'timeout' });
  });

  it('S6-R15-01: per interval, the higher rate is credited for at most RATE_CHANGE_CREDIT_SEC', () => {
    // A poll-sized interval: the higher rate for all of it (S6-R14-01 keeps the progress already made).
    expect(intervalProgressSec(2, 0.5, 50)).toBeCloseTo(0.1);
    expect(intervalProgressSec(0.5, 2, 100)).toBeCloseTo(0.2);
    // A long gap: the lower rate, plus the difference for 0.1 s only.
    expect(RATE_CHANGE_CREDIT_SEC).toBe(0.1);
    expect(intervalProgressSec(0.5, 1, 2500)).toBeCloseTo(1.3);
    expect(intervalProgressSec(1, 0.5, 2500)).toBeCloseTo(1.3);
    expect(intervalProgressSec(0, 1, 2500)).toBeCloseTo(0.1); // paused -> playing
    expect(intervalProgressSec(1, 1, 2500)).toBeCloseTo(2.5);
    expect(intervalProgressSec(1, 1, -5)).toBe(0);
  });

  describe('S6-R15-02: seek and wrap times are on the monotonic panel clock', () => {
    afterEach(() => vi.restoreAllMocks());
    // Paused at 9; 다음 마디 to 10.01 is accepted but never applied. Real timers, default clock.
    const run = (wrapAt: () => WrapSample | null) => {
      const player: ObservedPlayer = {
        playing: () => false,
        countingIn: () => false,
        position: () => 9,
        rate: () => 1,
        isAd: () => false,
        target: () => 'song',
        wrapSample: wrapAt,
      };
      const transport: PanelTransport = {
        toggle: async () => ({ ok: true }),
        seek: async () => ({ ok: true }),
        restartTarget: () => null,
        barTarget: (step) => barStepTargetSec(step, FAKE_BARS, 9),
        cancelCountIn: () => {},
      };
      return runPhoneCommand('next-bar', player, transport, { pollMs: 10, observeMs: 300 });
    };
    it('a wall-clock rollback never makes a wrap taken before the seek count', async () => {
      const stale: WrapSample = { at: panelClock(), position: 10.05, target: 'song' };
      const wall = Date.now();
      vi.spyOn(Date, 'now').mockImplementation(() => wall - 3_600_000); // the wall clock went back an hour
      expect(await run(() => stale)).toEqual({ ok: false, code: 'timeout' });
    });
    it('a wrap taken after the seek still counts across the rollback', async () => {
      const wall = Date.now();
      vi.spyOn(Date, 'now').mockImplementation(() => wall - 3_600_000);
      let fresh: WrapSample | null = null;
      setTimeout(() => (fresh = { at: panelClock(), position: 10.05, target: 'song' }), 30);
      expect(await run(() => fresh)).toEqual({ ok: true, state: 'paused' });
    });
    it('the panel stamps loop jumps and its seeks on panelClock and binds the wrap to the player target', () => {
      const src = readFileSync(new URL('../src/extension/sidepanel/sidepanel.ts', import.meta.url), 'utf8');
      expect(src).not.toMatch(/jumper\.seeked\([^)]*Date\.now/);
      expect(src).toMatch(/const nowMs = panelClock\(\);/);
      expect(src).toMatch(/loopWrap = \{ at: nowMs, position: positionSec, target: phonePlayer\.target\(\) \};/);
    });
  });

  it('S6-R13: the window: never below target - BAR_EARLY_SEC, above it only by what playback can have added', async () => {
    // Paused: a position 0.4 s past the target is not the seek's result.
    expect(await fakePanel({ position: 9, landAt: 10.41 }).run('next-bar')).toEqual({ ok: false, code: 'timeout' });
    expect(await fakePanel({ position: 9, landAt: 10.35 }).run('next-bar')).toEqual({ ok: true, state: 'paused' });
    // Lower bound: 10.01 - 0.1.
    expect(await fakePanel({ position: 9, landAt: 9.92 }).run('next-bar')).toEqual({ ok: true, state: 'paused' });
    expect(await fakePanel({ position: 9, landAt: 9.9 }).run('next-bar')).toEqual({ ok: false, code: 'timeout' });
  });

  it('a bar step that was accepted but never applied is not success (observed position only)', async () => {
    const f = fakePanel({ playing: true, position: 9, noSeek: true });
    expect(await f.run('prev-bar')).toEqual({ ok: false, code: 'timeout' });
    expect(f.calls).toEqual(['seek 6.01']);
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
  let answer: (cmd: PhoneCommand, progress: (o: CommandOutcome) => void, signal: AbortSignal, context: CommandContext) => Promise<CommandOutcome> = async () => ({ ok: true, state: 'playing' });
  const link = new PhoneLink({
    onStatus: () => {},
    sample: () => ({ position: 1, rate: 1, paused: true, ad: false, loop: null }),
    onPhones: (l) => phones.push(l),
    onCommand: (cmd, progress, signal, context) => {
      commands.push(cmd);
      return answer(cmd, progress, signal, context);
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
    /** The grant of the panel's last 승인 (what the relay stamps on that phone's commands). */
    grant: () => (sockets.flatMap((s) => s.json()).filter((m) => m.t === 'approve').at(-1)?.grant as number | undefined) ?? 1,
    cmd: (id: number, from = ID_A, extra: Record<string, unknown> = {}) => ws.rx({ t: 'cmd', id, epoch: h.epoch, rev: h.rev, cmd: 'toggle', from, grant: h.grant(), ...extra }),
    results: () => ws.json().filter((m) => m.t === 'result'),
    /** The phone is listed, the panel approves it, and the relay's list shows it approved. */
    approve: (id = ID_A) => {
      ws.rx({ t: 'phones', list: [{ id, code: '1234', state: 'pending' }] });
      link.approve(id);
      ws.rx({ t: 'phones', list: [{ id, code: '1234', state: 'approved', grant: h.grant() }] });
    },
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
    h.ws.rx({ t: 'phones', list: [{ id: ID_A, code: '1234', state: 'approved', grant: h.grant() }, { id: ID_B, code: '5678', state: 'pending' }] });
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
      { t: 'approve', id: ID_A, code: '1234', grant: 1 },
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
  /** `target`: the song and tab sendControl would reach right now (as the panel's target()). */
  const st = { playing: false, position: 20, countingIn: false, run: 0, phoneRun: -1, target: TARGET_A as string | null, ad: false };
  const sent: string[] = [];
  /** Which target each player command reached. */
  const sentTo: (string | null)[] = [];
  const pending: (() => void)[] = [];
  const env: PlayToggleEnv = {
    send: (msg: PlayerControlMessage) => {
      sent.push(msg.action === 'seek' ? `seek ${msg.time}` : msg.action);
      sentTo.push(st.target);
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
    isAd: () => st.ad,
    target: () => st.target,
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
    barTarget: (step) => (step < 0 ? 2 : 6),
  };
  /** Answers the oldest player command still waiting for its reply. */
  const reply = () => pending.shift()?.();
  return { st, sent, sentTo, pending, env, player, transport, reply };
}

const TARGET_A = 'tab 101 / song A';

const settle = () => vi.advanceTimersByTimeAsync(0);

const REVOKE_TRIGGERS: [string, (h: ReturnType<typeof linkHarness>) => void][] = [
  ['switch off', (h) => h.link.setControl(false)],
  ['승인 해제', (h) => h.link.revoke()],
  ['phone disconnected', (h) => h.ws.rx({ t: 'phones', list: [] })],
  // The relay rejects or moves an approval only when the panel asks; its list alone grants or ends nothing.
  ['거절', (h) => h.link.reject(ID_A)],
  ['approving another phone', (h) => {
    h.ws.rx({ t: 'phones', list: [{ id: ID_A, code: '1234', state: 'approved', grant: h.grant() }, { id: ID_B, code: '5678', state: 'pending' }] });
    h.link.approve(ID_B);
  }],
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
    h.ws.rx({ t: 'cmd', id: 1, epoch: h.epoch, rev: h.rev, cmd: 'restart', from: ID_A, grant: h.grant() });
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

// ---------- S6-R5B-01: a phone command acts only on the song and tab it was started for ----------
/** Another song view than the harness's empty one (PhoneLink only compares its JSON). */
const OTHER_SONG = { title: 'other song' } as never;

const SONG_TRIGGERS: [string, (h: ReturnType<typeof linkHarness>, p: ReturnType<typeof gatePanel>) => void][] = [
  ['tab change', (_h, p) => (p.st.target = 'tab 202 / song A')],
  ['new song in the same tab', (_h, p) => (p.st.target = 'tab 101 / song B')],
  ['player gone', (_h, p) => (p.st.target = null)],
  ['song view changed', (h) => h.link.setSong(OTHER_SONG)],
  ['tab and song view changed', (h, p) => {
    p.st.target = 'tab 202 / song B';
    h.link.setSong(OTHER_SONG);
  }],
  // S6-R6-02: what sidepanel.ts does first when its player, recording, chart or demo changes.
  ['panel song changing', (h) => h.link.songChanging()],
];

describe('S6-R5B-01: a song or tab change stops a phone command', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  for (const point of POINTS) {
    it(`${point.name}: nothing further reaches the new song or tab, and the phone hears stale`, async () => {
      for (const [name, trigger] of SONG_TRIGGERS) {
        const h = linkHarness();
        h.link.setControl(true);
        h.approve();
        const p = gatePanel({ countIn: point.countIn, loopStart: point.countIn ? null : 5 });
        h.answer = (c, progress, signal) => runPhoneCommand(c, p.player, p.transport, { progress, signal });
        h.cmd(1);
        await settle();
        await point.reach(p);
        const label = `${point.name} / ${name}`;
        expect(p.sent, label).toEqual(point.sentBefore);
        trigger(h, p);
        for (let i = 0; i < 20; i++) {
          while (p.pending.length) p.reply();
          await vi.advanceTimersByTimeAsync(500);
        }
        expect(p.sent, `${label}: no player command after the change`).toEqual(point.sentBefore);
        expect(p.sentTo, `${label}: every command went to the starting tab and song`).toEqual(point.sentBefore.map(() => TARGET_A));
        expect(p.st.countingIn, label).toBe(false);
        if (!point.sentBefore.includes('play')) expect(p.st.playing, `${label}: never plays`).toBe(false);
        const results = h.results().filter((r) => r.id === 1 && r.state !== 'countin');
        expect(results, label).toEqual([expect.objectContaining({ ok: false, code: 'stale' })]);
      }
    });
  }

  it('an unchanged song and tab (the same song view set again) runs to the end', async () => {
    for (const countIn of [true, false]) {
      const h = linkHarness();
      h.link.setControl(true);
      h.approve();
      h.link.setSong(OTHER_SONG);
      h.advance(1000);
      const p = gatePanel({ countIn, loopStart: countIn ? null : 5 });
      h.answer = (c, progress, signal) => runPhoneCommand(c, p.player, p.transport, { progress, signal });
      h.cmd(1, ID_A, { rev: h.rev + 1 });
      await settle();
      h.link.setSong(OTHER_SONG);
      p.st.target = TARGET_A;
      for (let i = 0; i < 20; i++) {
        while (p.pending.length) p.reply();
        await vi.advanceTimersByTimeAsync(500);
      }
      expect(p.sent).toEqual(countIn ? ['pause', 'seek 4', 'play'] : ['seek 5', 'play']);
      expect(h.results().at(-1)).toMatchObject({ id: 1, ok: true, state: 'playing' });
    }
  });

  it('restart: a song or tab change while the seek reply is pending is reported as stale, not as landed', async () => {
    for (const [name, trigger] of SONG_TRIGGERS) {
      const h = linkHarness();
      h.link.setControl(true);
      h.approve();
      const p = gatePanel({ countIn: false });
      h.answer = (c, progress, signal) => runPhoneCommand(c, p.player, p.transport, { progress, signal });
      h.ws.rx({ t: 'cmd', id: 1, epoch: h.epoch, rev: h.rev, cmd: 'restart', from: ID_A, grant: h.grant() });
      await settle();
      trigger(h, p);
      for (let i = 0; i < 10; i++) {
        while (p.pending.length) p.reply();
        await vi.advanceTimersByTimeAsync(500);
      }
      expect(p.sent, name).toEqual(['seek 4']);
      expect(p.sentTo, name).toEqual([TARGET_A]);
      expect(h.results().at(-1), name).toMatchObject({ id: 1, ok: false, code: 'stale' });
    }
  });

  it('losing control (not a song change) still reports cancelled', async () => {
    const h = linkHarness();
    h.link.setControl(true);
    h.approve();
    const p = gatePanel({ countIn: false, loopStart: 5 });
    h.answer = (c, progress, signal) => runPhoneCommand(c, p.player, p.transport, { progress, signal });
    h.cmd(1);
    await settle();
    h.link.revoke();
    while (p.pending.length) p.reply();
    await vi.advanceTimersByTimeAsync(5000);
    expect(p.sent).toEqual(['seek 5']);
    expect(h.results().at(-1)).toMatchObject({ id: 1, ok: false, code: 'cancelled' });
  });
});

// ---------- S6-R3/R4-01: the panel's grant is the only permission, in every message order ----------
/**
 * The real PhoneLink, runPhoneCommand and playToggle against a relay made of the real Pairing. Both
 * directions are FIFO, as on one WebSocket. A scenario is a list of panel actions plus a number of
 * commands phone A sends; `explore` replays every interleaving of: the next panel action, the relay
 * handling the next panel message, phone A sending a command (checked by the relay at that moment and
 * stamped with its grant), and the next relay message reaching the panel. At every player command the
 * panel sends, the panel's latest decision must be "A may control".
 */
/** `intent`: who may control after the user's action (approving needs the phone in the panel's list). */
type Action = { name: string; run: (link: PhoneLink) => void; intent: (prev: string | null, link: PhoneLink) => string | null };
const shown = (l: PhoneLink, id: string) => l.phoneList.some((x) => x.id === id);
const act = {
  approveA: { name: 'approve A', run: (l: PhoneLink) => l.approve(ID_A), intent: (p: string | null, l: PhoneLink) => (shown(l, ID_A) ? ID_A : p) },
  approveB: { name: 'approve B', run: (l: PhoneLink) => l.approve(ID_B), intent: (p: string | null, l: PhoneLink) => (shown(l, ID_B) ? ID_B : p) },
  revoke: { name: '승인 해제', run: (l: PhoneLink) => l.revoke(), intent: () => null },
  rejectA: { name: 'reject A', run: (l: PhoneLink) => l.reject(ID_A), intent: (p: string | null) => (p === ID_A ? null : p) },
  controlOff: { name: 'control OFF', run: (l: PhoneLink) => l.setControl(false), intent: () => null },
  controlOn: { name: 'control ON', run: (l: PhoneLink) => l.setControl(true), intent: () => null },
  standOff: { name: '악보대 OFF', run: (l: PhoneLink) => l.setEnabled(false), intent: () => null },
} satisfies Record<string, Action>;

type Ev = 'act' | 'relay' | 'cmd' | 'deliver';
interface Scenario {
  name: string;
  /** Done before exploring: delivered and settled (e.g. A already approved). */
  setup: Action[];
  actions: Action[];
  cmds: number;
  /** Count-in off; with a loop start the command is seek then play, without one a single play. */
  loopStart: number | null;
}

async function replayRace(sc: Scenario, events: Ev[]) {
  let now = 1_000_000;
  const sockets: FakeSocket[] = [];
  const pairing = new Pairing(((xs: number[]) => () => xs.shift() ?? 0)([1111, 2222]));
  const toPanel: string[] = [];
  const toRelay: Record<string, unknown>[] = [];
  let sentToRelay = 0;
  /** The panel closed its socket (악보대 OFF): the relay hears it after what was sent before. */
  let closed = false;
  let intent: string | null = null;
  const violations: string[] = [];
  const p = gatePanel({ countIn: false, loopStart: sc.loopStart });
  const realSend = p.env.send;
  p.env.send = (msg) => {
    if (intent !== ID_A) violations.push(`${msg.action} sent while the panel's decision was ${intent ?? 'nobody'}`);
    return realSend(msg);
  };
  const link = new PhoneLink({
    onStatus: () => {},
    sample: () => ({ position: 1, rate: 1, paused: true, ad: false, loop: null }),
    onCommand: (cmd, progress, signal) => runPhoneCommand(cmd, p.player, p.transport, { progress, signal }),
    makeSocket: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    now: () => now,
    setTimer: () => 0,
    clearTimer: () => {},
  });
  link.setEnabled(true);
  const ws = sockets[0]!;
  ws.open();
  const song = ws.json().find((m) => m.t === 'song')!;
  pairing.join(ID_A);
  pairing.join(ID_B);
  /** Panel -> relay messages not yet seen by the relay (FIFO). */
  const collect = () => {
    for (const m of ws.json().slice(sentToRelay)) if (['control', 'approve', 'reject', 'revoke'].includes(m.t as string)) toRelay.push(m);
    sentToRelay = ws.json().length;
    if (!link.isEnabled && !closed) {
      closed = true;
      toRelay.push({ t: 'closed' });
    }
  };
  const tellPanel = () => toPanel.push(JSON.stringify({ t: 'phones', list: pairing.list() }));
  const relayStep = () => {
    const m = toRelay.shift()!;
    let changed = false;
    if (m.t === 'control') changed = pairing.setControl(m.on as boolean);
    if (m.t === 'closed') changed = pairing.setControl(false); // the relay when its panel leaves
    if (m.t === 'approve') changed = pairing.approve(m.id as string, m.code as string, m.grant as number);
    if (m.t === 'reject') changed = pairing.reject(m.id as string, m.code as string);
    if (m.t === 'revoke') changed = pairing.revoke();
    if (changed) tellPanel();
  };
  let cmdId = 0;
  const phoneCmd = () => {
    cmdId++;
    const grant = pairing.grantOf(ID_A);
    if (grant !== null) toPanel.push(JSON.stringify({ t: 'cmd', id: cmdId, epoch: song.epoch, rev: song.rev, cmd: 'toggle', from: ID_A, grant }));
  };
  const deliver = () => {
    const text = toPanel.shift()!;
    if (ws.readyState === 1) ws.onmessage?.({ data: text } as MessageEvent);
  };
  // Count-in off: every step runs on promise jobs, so draining them (and answering the player) settles it.
  const settleAll = async () => {
    for (let i = 0; i < 12; i++) {
      while (p.pending.length) p.reply();
      await Promise.resolve();
    }
  };
  const drainAll = async () => {
    for (;;) {
      collect();
      if (toRelay.length) relayStep();
      else if (toPanel.length) deliver();
      else break;
      await settleAll();
    }
  };
  // Setup: control on, the list, then the setup actions, all delivered.
  link.setControl(true);
  for (const a of sc.setup) {
    await drainAll();
    intent = a.intent(intent, link);
    a.run(link);
  }
  await drainAll();
  now += 10_000; // the rate limit refills
  let nextAction = 0;
  let cmdsLeft = sc.cmds;
  const possible = (): Ev[] => {
    collect();
    const out: Ev[] = [];
    if (nextAction < sc.actions.length) out.push('act');
    if (toRelay.length) out.push('relay');
    if (cmdsLeft > 0) out.push('cmd');
    if (toPanel.length) out.push('deliver');
    return out;
  };
  for (const e of events) {
    if (!possible().includes(e)) throw new Error(`impossible event ${e}`);
    if (e === 'act') {
      const a = sc.actions[nextAction++]!;
      intent = a.intent(intent, link);
      a.run(link);
    } else if (e === 'relay') relayStep();
    else if (e === 'cmd') {
      cmdsLeft--;
      now += 1000;
      phoneCmd();
    } else deliver();
    await settleAll();
  }
  const next = possible();
  const finish = async () => {
    await drainAll();
    await vi.advanceTimersByTimeAsync(10_000);
    // After everything settled: does a fresh command from A play exactly when the panel granted A?
    const before = p.sent.length;
    p.st.playing = false;
    now += 10_000;
    phoneCmd();
    await drainAll();
    return { granted: intent === ID_A, playedAfter: p.sent.length > before };
  };
  return { next, violations, finish };
}

/** Every interleaving: depth-first over event prefixes, each replayed from scratch. */
async function explore(sc: Scenario) {
  const violations = new Map<string, string[]>();
  let leaves = 0;
  const liveness: string[] = [];
  const walk = async (prefix: Ev[]) => {
    const r = await replayRace(sc, prefix);
    if (r.violations.length) violations.set(prefix.join(' '), r.violations);
    if (r.next.length === 0) {
      leaves++;
      const f = await r.finish();
      if (f.granted !== f.playedAfter) liveness.push(`${prefix.join(' ')}: granted=${f.granted} played=${f.playedAfter}`);
      return;
    }
    for (const e of r.next) await walk([...prefix, e]);
  };
  await walk([]);
  return { violations, leaves, liveness };
}

describe('S6-R4-01: only the panel grants control; late lists and late commands never play', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const scenarios: Scenario[] = [
    // The reviewer's two sequences (approval still in flight).
    { name: 'approve A -> approve B (A still in flight)', setup: [], actions: [act.approveA, act.approveB], cmds: 2, loopStart: null },
    { name: 'approve A -> control OFF -> control ON (A still in flight)', setup: [], actions: [act.approveA, act.controlOff, act.controlOn], cmds: 2, loopStart: null },
    // A already approved, then each way the panel ends it (count-in off, with and without a loop).
    ...[act.revoke, act.rejectA, act.controlOff, act.approveB, act.standOff].flatMap((a) =>
      [null, 5].map((loopStart) => ({ name: `A approved -> ${a.name}${loopStart === null ? '' : ' (loop: seek, play)'}`, setup: [act.approveA], actions: [a], cmds: 1, loopStart })),
    ),
    // Re-approval after ending it, also while the end is still in flight.
    { name: 'A approved -> 승인 해제 -> approve A again', setup: [act.approveA], actions: [act.revoke, act.approveA], cmds: 2, loopStart: null },
    { name: 'A approved -> reject A -> approve A again', setup: [act.approveA], actions: [act.rejectA, act.approveA], cmds: 2, loopStart: null },
    { name: 'A approved -> approve B -> approve A again', setup: [act.approveA], actions: [act.approveB, act.approveA], cmds: 2, loopStart: null },
    { name: 'A approved -> control OFF -> ON -> approve A again', setup: [act.approveA], actions: [act.controlOff, act.controlOn, act.approveA], cmds: 1, loopStart: null },
  ];

  for (const sc of scenarios) {
    it(`${sc.name}: no player command without the panel's grant, in every order`, async () => {
      const r = await explore(sc);
      expect(r.leaves).toBeGreaterThan(1);
      expect([...r.violations].slice(0, 3), `${r.violations.size} of ${r.leaves} orders`).toEqual([]);
      // A re-approval works, and nothing else lets A play once everything settled.
      expect(r.liveness.slice(0, 3)).toEqual([]);
    }, 60_000);
  }

  it('a list from the relay never grants: an approved entry the panel did not approve shows as pending and cannot play', async () => {
    const h = linkHarness();
    h.link.setControl(true);
    h.ws.rx({ t: 'phones', list: [{ id: ID_A, code: '1234', state: 'approved' }] });
    expect(h.link.phoneList).toEqual([{ id: ID_A, code: '1234', state: 'pending' }]);
    h.cmd(1, ID_A, { grant: 1 });
    await settle();
    expect(h.commands).toEqual([]);
    expect(h.results()[0]).toMatchObject({ code: 'not-approved' });
  });

  it('a command stamped with an older grant of the same phone is rejected', async () => {
    const h = linkHarness();
    h.link.setControl(true);
    h.approve();
    const old = h.grant();
    h.link.revoke();
    h.approve();
    expect(h.grant()).toBeGreaterThan(old);
    h.cmd(1, ID_A, { grant: old });
    await settle();
    expect(h.commands).toEqual([]);
    h.advance(1000);
    h.cmd(2);
    await settle();
    expect(h.commands).toEqual(['toggle']);
  });
});

// ---------- S6-R6: one context predicate (grant, published revision and its target, no ad) ----------
const SONG_A = { title: 'song A' } as never;
const SONG_B = { title: 'song B' } as never;
const TARGET_B = 'tab 101 / song B';

/** The harness with song A published for TARGET_A, and commands carried out as sidepanel.ts wires them. */
function wiredHarness(p: ReturnType<typeof gatePanel>) {
  const h = linkHarness();
  h.link.setControl(true);
  h.approve();
  h.answer = (c, progress, signal, context) => runPhoneCommand(c, p.player, p.transport, { progress, signal, context });
  publish(h, SONG_A, TARGET_A);
  return h;
}

/** The panel sets a song for a target and it is published; later commands carry its revision. */
function publish(h: ReturnType<typeof linkHarness>, view: never, target: string | null) {
  h.link.setSong(view, target);
  h.advance(1000);
  h.rev = h.ws.json().filter((m) => m.t === 'song').at(-1)!.rev as number;
}

async function finish(p: ReturnType<typeof gatePanel>) {
  for (let i = 0; i < 20; i++) {
    while (p.pending.length) p.reply();
    await vi.advanceTimersByTimeAsync(500);
  }
}

describe('S6-R6-01: an ad that starts while a phone command waits stops it before the next player command', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  for (const point of POINTS) {
    for (const wired of [false, true]) {
      it(`${point.name}${wired ? ' (with the link context)' : ''}: nothing is sent during the ad, the phone hears ad`, async () => {
        const p = gatePanel({ countIn: point.countIn, loopStart: point.countIn ? null : 5 });
        let h: ReturnType<typeof linkHarness>;
        if (wired) h = wiredHarness(p);
        else {
          h = linkHarness();
          h.link.setControl(true);
          h.approve();
          h.answer = (c, progress, signal) => runPhoneCommand(c, p.player, p.transport, { progress, signal });
        }
        h.cmd(1);
        await settle();
        await point.reach(p);
        expect(p.sent).toEqual(point.sentBefore);
        // Same tab, same song: only the ad starts.
        p.st.ad = true;
        await finish(p);
        expect(p.sent, 'no player command once the ad started').toEqual(point.sentBefore);
        expect(p.st.countingIn).toBe(false);
        if (!point.sentBefore.includes('play')) expect(p.st.playing, 'never plays').toBe(false);
        // S6-R7-02: also when play went out before the ad, the phone hears ad, not success.
        const results = h.results().filter((r) => r.id === 1 && r.state !== 'countin');
        expect(results).toEqual([expect.objectContaining({ ok: false, code: 'ad' })]);
      });
    }
  }

  for (const cmd of ['restart', 'prev-bar', 'next-bar'] as const) {
    it(`${cmd} during an ad sends nothing (with the link context)`, async () => {
      const p = gatePanel({ countIn: false });
      const h = wiredHarness(p);
      p.st.ad = true;
      h.ws.rx({ t: 'cmd', id: 1, epoch: h.epoch, rev: h.rev, cmd, from: ID_A, grant: h.grant() });
      await finish(p);
      expect(p.sent).toEqual([]);
      expect(h.results().at(-1)).toMatchObject({ id: 1, ok: false, code: 'ad' });
    });
  }
});

describe('S6-R6-02: a command for the previous song never reaches a player that changed before the new song is published', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const CMDS: [string, PhoneCommand, boolean][] = [
    ['restart', 'restart', false],
    ['이전 마디', 'prev-bar', false],
    ['다음 마디', 'next-bar', false],
    ['play (count-in on)', 'toggle', true],
    ['play (count-in off)', 'toggle', false],
  ];

  for (const [name, cmd, countIn] of CMDS) {
    for (const marked of [true, false]) {
      it(`${name}: player changed to song B, ${marked ? 'panel marked not ready' : 'not marked (target binding alone)'}: stale, nothing sent`, async () => {
        const p = gatePanel({ countIn, loopStart: countIn ? null : 5 });
        const h = wiredHarness(p);
        // sidepanel.ts onPlayerState: player and chartKey are song B's, the chart is still loading, and
        // syncPhoneSong has not published song B yet. The phone still shows song A.
        if (marked) h.link.songChanging();
        p.st.target = TARGET_B;
        h.ws.rx({ t: 'cmd', id: 1, epoch: h.epoch, rev: h.rev, cmd, from: ID_A, grant: h.grant() });
        await finish(p);
        expect(p.sent).toEqual([]);
        expect(h.results().at(-1)).toMatchObject({ id: 1, ok: false, code: 'stale' });

        // Once song B is published for its target, a command with that revision acts on song B.
        publish(h, SONG_B, TARGET_B);
        h.ws.rx({ t: 'cmd', id: 2, epoch: h.epoch, rev: h.rev, cmd, from: ID_A, grant: h.grant() });
        await finish(p);
        expect(p.sent.length).toBeGreaterThan(0);
        expect(new Set(p.sentTo)).toEqual(new Set([TARGET_B]));
        expect(h.results().at(-1)).toMatchObject({ id: 2, ok: true });
      });
    }
  }

  it('after songChanging, setting the same song and target again publishes a new revision', async () => {
    const p = gatePanel({ countIn: false });
    const h = wiredHarness(p);
    const before = h.rev;
    h.link.songChanging();
    h.ws.rx({ t: 'cmd', id: 1, epoch: h.epoch, rev: before, cmd: 'restart', from: ID_A, grant: h.grant() });
    await finish(p);
    expect(h.results().at(-1)).toMatchObject({ id: 1, ok: false, code: 'stale' });
    publish(h, SONG_A, TARGET_A);
    expect(h.rev).toBeGreaterThan(before);
    h.ws.rx({ t: 'cmd', id: 2, epoch: h.epoch, rev: h.rev, cmd: 'restart', from: ID_A, grant: h.grant() });
    await finish(p);
    expect(p.sent).toEqual(['seek 4']);
    expect(h.results().at(-1)).toMatchObject({ id: 2, ok: true });
  });

  it('the same view set for another target is a new revision (the old one is stale)', async () => {
    const p = gatePanel({ countIn: false });
    const h = wiredHarness(p);
    const before = h.rev;
    publish(h, SONG_A, 'tab 202 / song A');
    expect(h.rev).toBeGreaterThan(before);
    h.ws.rx({ t: 'cmd', id: 1, epoch: h.epoch, rev: before, cmd: 'restart', from: ID_A, grant: h.grant() });
    await finish(p);
    expect(p.sent).toEqual([]);
    expect(h.results().at(-1)).toMatchObject({ id: 1, ok: false, code: 'stale' });
  });
});

describe('S6-R6: the link context also carries the grant (every revoke trigger, count-in on and off)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  for (const point of POINTS) {
    it(`${point.name}: cancelled, nothing further sent`, async () => {
      for (const [name, trigger] of REVOKE_TRIGGERS) {
        const p = gatePanel({ countIn: point.countIn, loopStart: point.countIn ? null : 5 });
        const h = wiredHarness(p);
        h.cmd(1);
        await settle();
        await point.reach(p);
        const label = `${point.name} / ${name}`;
        expect(p.sent, label).toEqual(point.sentBefore);
        trigger(h);
        await finish(p);
        expect(p.sent, label).toEqual(point.sentBefore);
        expect(p.st.countingIn, label).toBe(false);
        if (!point.sentBefore.includes('play')) {
          const results = h.results().filter((r) => r.id === 1 && r.state !== 'countin');
          for (const r of results) expect(r, label).toMatchObject({ ok: false, code: 'cancelled' });
        }
      }
    });
  }

  it('without a trigger the same steps run to the end', async () => {
    for (const countIn of [true, false]) {
      const p = gatePanel({ countIn, loopStart: countIn ? null : 5 });
      const h = wiredHarness(p);
      h.cmd(1);
      await finish(p);
      expect(p.sent).toEqual(countIn ? ['pause', 'seek 4', 'play'] : ['seek 5', 'play']);
      expect(h.results().at(-1)).toMatchObject({ id: 1, ok: true, state: 'playing' });
    }
  });
});

describe('S6-R7-02: an ad that starts before the outcome is observed is reported as ad', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('restart: the ad starts while the seek reply is pending', async () => {
    const p = gatePanel({ countIn: false });
    const h = wiredHarness(p);
    h.ws.rx({ t: 'cmd', id: 1, epoch: h.epoch, rev: h.rev, cmd: 'restart', from: ID_A, grant: h.grant() });
    await settle();
    expect(p.sent).toEqual(['seek 4']);
    p.st.ad = true;
    await finish(p);
    expect(p.sent).toEqual(['seek 4']);
    expect(h.results().at(-1)).toMatchObject({ id: 1, ok: false, code: 'ad' });
  });

  it('pause: the ad starts while the pause reply is pending', async () => {
    const p = gatePanel({ countIn: false });
    p.st.playing = true;
    const h = wiredHarness(p);
    h.cmd(1);
    await settle();
    expect(p.sent).toEqual(['pause']);
    p.st.ad = true;
    await finish(p);
    expect(p.sent).toEqual(['pause']);
    expect(h.results().at(-1)).toMatchObject({ id: 1, ok: false, code: 'ad' });
  });

  it('without an ad the same steps still report success', async () => {
    const p = gatePanel({ countIn: false });
    const h = wiredHarness(p);
    h.ws.rx({ t: 'cmd', id: 1, epoch: h.epoch, rev: h.rev, cmd: 'restart', from: ID_A, grant: h.grant() });
    await finish(p);
    expect(h.results().at(-1)).toMatchObject({ id: 1, ok: true });
  });
});

// ---------- S6-R7-01: replacing the play model (same song) invalidates the published revision ----------
type Bars = { bars: { startSec: number }[] };
const MODEL_8: Bars = { bars: [{ startSec: 0 }, { startSec: 8 }] };
const MODEL_9: Bars = { bars: [{ startSec: 0 }, { startSec: 9 }] };
/** Song ids (what songIdOf makes; only their equality matters here). */
const REC_A = 'rec youtube:A';
const DEMO_B = 'demo 1 B';

/** The panel's model, target and 처음부터 as sidepanel.ts wires them, for one recording in tab 101. */
function modelPanel(marked: boolean) {
  const p = gatePanel({ countIn: false });
  const m = { link: null as PhoneLink | null, model: null as Bars | null };
  const shown = new ShownModel<Bars>(() => {
    if (marked) m.link?.songChanging();
  });
  m.model = shown.replace(MODEL_8, REC_A);
  p.player.target = () =>
    playerTargetKey({ modelVersion: m.model ? shown.version : null, modelFor: shown.builtFor, songId: REC_A, demo: null, chartLoaded: true, tab: 101, recordingKey: 'youtube:A', chartKey: 'youtube:A' });
  p.st.target = 'unused';
  p.transport.restartTarget = () => (m.model ? restartTargetSec(null, m.model.bars) : null);
  p.transport.barTarget = (step) => (m.model ? barStepTargetSec(step, m.model.bars, p.st.position) : null);
  // sentTo records the panel's real target.
  const send = p.env.send;
  p.env.send = (msg) => {
    p.st.target = p.player.target();
    return send(msg);
  };
  return { p, m, shown };
}

describe('S6-R7-01: a chart or model replaced for the same song stops commands for the previous model', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  for (const marked of [true, false]) {
    it(`restart with the old revision after the model changed (bar 8 -> 9), ${marked ? 'marked by ShownModel' : 'model version in the target alone'}: stale, no seek`, async () => {
      const { p, m, shown } = modelPanel(marked);
      const h = wiredHarness(p);
      m.link = h.link;
      publish(h, SONG_A, p.player.target());
      // A chart reload, save, import, chord fix or settings change: recompute() replaces the model.
      m.model = shown.replace(MODEL_9, REC_A);
      h.ws.rx({ t: 'cmd', id: 1, epoch: h.epoch, rev: h.rev, cmd: 'restart', from: ID_A, grant: h.grant() });
      await finish(p);
      expect(p.sent).toEqual([]);
      expect(h.results().at(-1)).toMatchObject({ id: 1, ok: false, code: 'stale' });

      // syncPhoneSong publishes the new model's view: a command with that revision uses the new bars
      // (다음 마디 from bar 1 goes to the new model's bar 2).
      publish(h, SONG_B, p.player.target());
      p.st.position = 1;
      h.ws.rx({ t: 'cmd', id: 2, epoch: h.epoch, rev: h.rev, cmd: 'next-bar', from: ID_A, grant: h.grant() });
      await finish(p);
      expect(p.sent).toEqual(['seek 9.01']);
      expect(h.results().at(-1)).toMatchObject({ id: 2, ok: true });
    });
  }

  it('a model replaced while a play waits for the loop-start seek reply sends no play', async () => {
    const p = gatePanel({ countIn: false, loopStart: 5 });
    let link: PhoneLink | null = null;
    const shown = new ShownModel<Bars>(() => link?.songChanging());
    shown.replace(MODEL_8, REC_A);
    const h = wiredHarness(p);
    link = h.link;
    h.cmd(1);
    await settle();
    expect(p.sent).toEqual(['seek 5']);
    shown.replace(MODEL_9, REC_A);
    await finish(p);
    expect(p.sent).toEqual(['seek 5']);
    expect(h.results().at(-1)).toMatchObject({ id: 1, ok: false, code: 'stale' });
  });

  it('ShownModel: only another model counts as a replacement, and the phone is told before it is shown', () => {
    const order: string[] = [];
    let current: Bars | null = null;
    const shown = new ShownModel<Bars>(() => order.push(`changing (shown ${current === MODEL_8 ? '8' : current === MODEL_9 ? '9' : 'none'})`));
    current = shown.replace(MODEL_8, REC_A);
    const v = shown.version;
    current = shown.replace(MODEL_8, REC_A);
    expect(shown.version).toBe(v);
    current = shown.replace(MODEL_9, REC_A);
    current = shown.replace(null, REC_A);
    expect(order).toEqual(['changing (shown none)', 'changing (shown 8)', 'changing (shown 9)']);
    expect(shown.version).toBe(v + 2);
    // S6-R8-01: the same model object for another song is a replacement too.
    current = shown.replace(MODEL_9, REC_A);
    current = shown.replace(MODEL_9, DEMO_B);
    expect(shown.builtFor).toBe(DEMO_B);
    expect(order.length).toBe(5);
  });

  it('the target changes with the model version, and is null while the chart shown is the previous song\'s', () => {
    const base = { modelVersion: 3, modelFor: REC_A, songId: REC_A, demo: null, chartLoaded: true, tab: 101, recordingKey: 'youtube:A', chartKey: 'youtube:A' };
    expect(playerTargetKey(base)).not.toBe(playerTargetKey({ ...base, modelVersion: 4 }));
    expect(playerTargetKey({ ...base, chartLoaded: false })).toBeNull();
    expect(playerTargetKey({ ...base, modelVersion: null })).toBeNull();
    expect(playerTargetKey({ ...base, tab: null })).toBeNull();
    const demo = { ...base, demo: { run: 1, key: 'd' }, modelFor: DEMO_B, songId: DEMO_B };
    expect(playerTargetKey(demo)).not.toBe(playerTargetKey({ ...demo, modelVersion: 4 }));
  });

  it('sidepanel.ts replaces the model only through ShownModel and builds the phone target with its version', () => {
    const src = readFileSync(new URL('../src/extension/sidepanel/sidepanel.ts', import.meta.url), 'utf8');
    // `const model = …` in renderModelState is a local, not the shown model.
    const assigns = [...src.matchAll(/(?<![\w.]|const )model = (.*);/g)].map((x) => x[1]);
    expect(assigns).toEqual(['shownModel.replace(next, modelSongId(demo, c ? songKey(c.recording) : null, songKey(player?.recording ?? null)))']);
    expect(src).toMatch(/modelVersion: model \? shownModel\.version : null/);
    expect(src).toMatch(/new ShownModel<PlayModel>\(\(\) => phoneSongChanging\(\)\)/);
  });
});

// ---------- S6-R8-01: leaving a demo never publishes the demo's model for the real player ----------
/**
 * The real song A plays in tab 101 while the demo of song B (bar start 9; A's is 8) is shown, as
 * sidepanel.ts wires it: the model records the song it was built for, the target and syncPhoneSong
 * check it against the song commands would act on now.
 */
function demoExitPanel() {
  const p = gatePanel({ countIn: false });
  const s = { link: null as PhoneLink | null, model: null as Bars | null, inDemo: true };
  const shown = new ShownModel<Bars>(() => s.link?.songChanging());
  const parts = (): TargetParts => ({
    modelVersion: s.model ? shown.version : null,
    modelFor: shown.builtFor,
    songId: s.inDemo ? DEMO_B : REC_A,
    demo: s.inDemo ? { run: 1, key: 'B' } : null,
    chartLoaded: true,
    tab: 101,
    recordingKey: 'youtube:A',
    chartKey: 'youtube:A',
  });
  s.model = shown.replace(MODEL_9, DEMO_B);
  p.player.target = () => playerTargetKey(parts());
  p.transport.restartTarget = () => (s.model ? restartTargetSec(null, s.model.bars) : null);
  p.transport.barTarget = (step) => (s.model ? barStepTargetSec(step, s.model.bars, p.st.position) : null);
  const send = p.env.send;
  p.env.send = (msg) => {
    p.st.target = p.player.target();
    return send(msg);
  };
  /** exitDemo(): marks the phone's song as changing, then the demo ends; the real model comes after an await. */
  const exitDemo = () => {
    s.link?.songChanging();
    s.inDemo = false;
  };
  /** recompute() once the tab query answered: the real song's model. */
  const buildReal = () => (s.model = shown.replace(MODEL_8, REC_A));
  return { p, s, parts, exitDemo, buildReal };
}

describe('S6-R8-01: while the demo is being left, the demo model is never published or used for the real player', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a frame during the tab query publishes nothing; commands are stale; after the real model they act on song A', async () => {
    const d = demoExitPanel();
    const h = wiredHarness(d.p);
    d.s.link = h.link;
    // syncPhoneSong during the demo: demo B is published for the demo target.
    expect(songViewReady(d.parts())).toBe(true);
    publish(h, SONG_B, d.p.player.target());
    const demoRev = h.rev;
    d.exitDemo();
    // Frames while refreshActiveTab() is pending (longer than the 250 ms publish delay).
    expect(songViewReady(d.parts()), 'syncPhoneSong publishes nothing').toBe(false);
    expect(d.p.player.target(), 'no target while the model is the demo song').toBeNull();
    h.advance(1000);
    h.ws.rx({ t: 'cmd', id: 1, epoch: h.epoch, rev: demoRev, cmd: 'restart', from: ID_A, grant: h.grant() });
    await finish(d.p);
    expect(d.p.sent).toEqual([]);
    expect(h.results().at(-1)).toMatchObject({ id: 1, ok: false, code: 'stale' });

    d.buildReal();
    expect(songViewReady(d.parts())).toBe(true);
    publish(h, SONG_A, d.p.player.target());
    d.p.st.position = 1;
    h.ws.rx({ t: 'cmd', id: 2, epoch: h.epoch, rev: h.rev, cmd: 'next-bar', from: ID_A, grant: h.grant() });
    await finish(d.p);
    expect(d.p.sent).toEqual(['seek 8.01']);
    expect(h.results().at(-1)).toMatchObject({ id: 2, ok: true });
  });

  it('even a revision published in that window (the reviewer\'s harness) never seeks the real player to the demo bar', async () => {
    const d = demoExitPanel();
    const h = wiredHarness(d.p);
    d.s.link = h.link;
    publish(h, SONG_B, d.p.player.target());
    d.exitDemo();
    // What 24f4900's syncPhoneSong did on a frame here: a new revision with the current target.
    publish(h, SONG_B, d.p.player.target());
    h.ws.rx({ t: 'cmd', id: 1, epoch: h.epoch, rev: h.rev, cmd: 'restart', from: ID_A, grant: h.grant() });
    await finish(d.p);
    expect(d.p.sent).toEqual([]);
    expect(h.results().at(-1)).toMatchObject({ id: 1, ok: false });
  });

  it('the model built for another song than the current one gives no target and is not ready', () => {
    const base = { modelVersion: 3, modelFor: DEMO_B, songId: REC_A, demo: null, chartLoaded: true, tab: 101, recordingKey: 'youtube:A', chartKey: 'youtube:A' };
    expect(playerTargetKey(base)).toBeNull();
    expect(playerTargetKey({ ...base, modelFor: REC_A })).not.toBeNull();
  });

  it('sidepanel.ts: syncPhoneSong checks songViewReady, the target uses the song ids, and exitDemo marks not ready before its await', () => {
    const src = readFileSync(new URL('../src/extension/sidepanel/sidepanel.ts', import.meta.url), 'utf8');
    const sync = src.slice(src.indexOf('function syncPhoneSong'), src.indexOf('function phoneSongChanging'));
    expect(sync).toMatch(/if \(!songViewReady\(phoneTargetParts\(\)\)\) return;/);
    expect(src).toMatch(/modelFor: shownModel\.builtFor,\s+songId: songIdOf\(demo, songKey\(player\?\.recording \?\? null\)\)/);
    const exit = src.slice(src.indexOf('async function exitDemo'));
    expect(exit.indexOf('phoneSongChanging();')).toBeGreaterThan(-1);
    expect(exit.indexOf('phoneSongChanging();')).toBeLessThan(exit.indexOf('demo = null'));
    expect(exit.indexOf('demo = null')).toBeLessThan(exit.indexOf('await '));
  });
});

// ---------- S6-R9-01: a late save reply never labels another song's chart as the current song's ----------
describe('S6-R9-01: the shown model is labelled with the recording of the chart it was built from', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("A's chart shown after B loaded (late save reply): not ready, no target, restart sends nothing", async () => {
    const p = gatePanel({ countIn: false });
    const s = { link: null as PhoneLink | null, model: null as Bars | null };
    const shown = new ShownModel<Bars>(() => s.link?.songChanging());
    // Song B is current and its chart (bar start 6) is loaded: chartKey = chartFor = B.
    const cur = { chartKey: 'youtube:B', chartFor: 'youtube:B' };
    const parts = (): TargetParts => ({
      modelVersion: s.model ? shown.version : null,
      modelFor: shown.builtFor,
      songId: songIdOf(null, cur.chartKey),
      demo: null,
      chartLoaded: cur.chartFor === cur.chartKey,
      tab: 101,
      recordingKey: cur.chartKey,
      chartKey: cur.chartKey,
    });
    /** recompute() as sidepanel.ts labels it, from the chart's own recording. */
    const recompute = (chartRecording: string, m: Bars) => (s.model = shown.replace(m, modelSongId(null, chartRecording, cur.chartFor)));
    p.player.target = () => playerTargetKey(parts());
    p.transport.restartTarget = () => (s.model ? restartTargetSec(null, s.model.bars) : null);
    p.transport.barTarget = (step) => (s.model ? barStepTargetSec(step, s.model.bars, p.st.position) : null);
    const MODEL_6: Bars = { bars: [{ startSec: 0 }, { startSec: 6 }] };
    recompute('youtube:B', MODEL_6);
    const h = wiredHarness(p);
    s.link = h.link;
    publish(h, SONG_B, p.player.target());

    // A's example-chart save reply arrives late and A's chart (bar start 9) is shown (pre-fix attachExample).
    recompute('youtube:A', MODEL_9);
    expect(songViewReady(parts()), 'syncPhoneSong publishes nothing').toBe(false);
    expect(p.player.target()).toBeNull();
    // Even a revision published now is bound to no target.
    publish(h, SONG_A, p.player.target());
    h.ws.rx({ t: 'cmd', id: 1, epoch: h.epoch, rev: h.rev, cmd: 'restart', from: ID_A, grant: h.grant() });
    await finish(p);
    expect(p.sent).toEqual([]);
    expect(h.results().at(-1)).toMatchObject({ id: 1, ok: false });

    // B's chart shown again: ready, and 다음 마디 goes to B's bar.
    recompute('youtube:B', MODEL_6);
    expect(songViewReady(parts())).toBe(true);
    publish(h, SONG_B, p.player.target());
    p.st.position = 1;
    h.ws.rx({ t: 'cmd', id: 2, epoch: h.epoch, rev: h.rev, cmd: 'next-bar', from: ID_A, grant: h.grant() });
    await finish(p);
    expect(p.sent).toEqual(['seek 6.01']);
  });

  it('modelSongId: the chart recording decides, chartFor only without a chart, the demo run for a demo', () => {
    expect(modelSongId(null, 'youtube:A', 'youtube:B')).toBe(songIdOf(null, 'youtube:A'));
    expect(modelSongId(null, null, 'youtube:B')).toBe(songIdOf(null, 'youtube:B'));
    const demo = { run: 2, key: 'K' };
    expect(modelSongId(demo, 'youtube:A', 'youtube:B')).toBe(songIdOf(demo, ''));
  });

  it('sidepanel.ts: doSave and attachExample show a saved chart only if it is still the current song', () => {
    const src = readFileSync(new URL('../src/extension/sidepanel/sidepanel.ts', import.meta.url), 'utf8');
    for (const fn of ['async function doSave', 'async function attachExample', 'async function importJson']) {
      const body = src.slice(src.indexOf(fn), src.indexOf('\n}\n', src.indexOf(fn)));
      const after = body.slice(body.indexOf('await saveChart('));
      expect(after.indexOf('=== chartKey'), fn).toBeGreaterThan(-1);
      expect(after.indexOf('=== chartKey'), `${fn}: checked before the chart is shown`).toBeLessThan(after.indexOf('chart = '));
    }
  });
});

// ---------- S6-R10-01: a chart the loader falls back to (YouTube <-> YouTube Music) is the current song's ----------
describe('S6-R10-01: the shown model belongs to the current song as the chart loader sees it', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  type Rec = { source: 'youtube' | 'ytmusic' | 'applemusic'; id: string };
  const key = (r: Rec) => chartSongKey(r.source, r.id);

  /** The player plays `player`; the chart shown (bar start 8) was stored for `chartRecording`. Labelled as sidepanel.ts does. */
  function run(player: Rec, chartRecording: Rec) {
    const p = gatePanel({ countIn: false });
    const s = { link: null as PhoneLink | null, model: null as Bars | null };
    const shown = new ShownModel<Bars>(() => s.link?.songChanging());
    const playerKey = `${player.source}:${player.id}`;
    const parts = (): TargetParts => ({
      modelVersion: s.model ? shown.version : null,
      modelFor: shown.builtFor,
      songId: songIdOf(null, key(player)),
      demo: null,
      chartLoaded: true,
      tab: 101,
      recordingKey: playerKey,
      chartKey: playerKey,
    });
    s.model = shown.replace(MODEL_8, modelSongId(null, key(chartRecording), key(player)));
    p.player.target = () => playerTargetKey(parts());
    p.transport.restartTarget = () => (s.model ? restartTargetSec(null, s.model.bars) : null);
    p.transport.barTarget = (step) => (s.model ? barStepTargetSec(step, s.model.bars, p.st.position) : null);
    return { p, s, parts };
  }

  for (const [player, chartRec] of [
    [{ source: 'ytmusic', id: 'A' }, { source: 'youtube', id: 'A' }],
    [{ source: 'youtube', id: 'A' }, { source: 'ytmusic', id: 'A' }],
  ] as [Rec, Rec][]) {
    it(`${player.source}:A playing with the stored ${chartRec.source}:A chart: published, and restart and a bar step act`, async () => {
      const d = run(player, chartRec);
      expect(songViewReady(d.parts())).toBe(true);
      expect(d.p.player.target()).not.toBeNull();
      const h = wiredHarness(d.p);
      d.s.link = h.link;
      publish(h, SONG_A, d.p.player.target());
      h.ws.rx({ t: 'cmd', id: 1, epoch: h.epoch, rev: h.rev, cmd: 'restart', from: ID_A, grant: h.grant() });
      await finish(d.p);
      expect(d.p.sent).toEqual(['seek 0']);
      expect(h.results().at(-1)).toMatchObject({ id: 1, ok: true });
      h.ws.rx({ t: 'cmd', id: 2, epoch: h.epoch, rev: h.rev, cmd: 'next-bar', from: ID_A, grant: h.grant() });
      await finish(d.p);
      expect(d.p.sent).toEqual(['seek 0', 'seek 8.01']);
      expect(h.results().at(-1)).toMatchObject({ id: 2, ok: true });
    });
  }

  for (const [name, player, chartRec] of [
    ['a different video id (S6-R9-01: A\'s chart while B plays)', { source: 'youtube', id: 'B' }, { source: 'youtube', id: 'A' }],
    ['a different id across YouTube Music', { source: 'ytmusic', id: 'B' }, { source: 'youtube', id: 'A' }],
    ['Apple Music with a YouTube chart of the same id', { source: 'applemusic', id: 'A' }, { source: 'youtube', id: 'A' }],
  ] as [string, Rec, Rec][]) {
    it(`${name}: not ready, no target, nothing sent`, async () => {
      const d = run(player, chartRec);
      expect(songViewReady(d.parts())).toBe(false);
      expect(d.p.player.target()).toBeNull();
      const h = wiredHarness(d.p);
      d.s.link = h.link;
      publish(h, SONG_A, d.p.player.target());
      h.ws.rx({ t: 'cmd', id: 1, epoch: h.epoch, rev: h.rev, cmd: 'restart', from: ID_A, grant: h.grant() });
      await finish(d.p);
      expect(d.p.sent).toEqual([]);
      expect(h.results().at(-1)).toMatchObject({ id: 1, ok: false });
    });
  }

  it('chartSongKey follows the loader: YouTube and YouTube Music of one id are one song, nothing else is', () => {
    expect(chartSongKey('youtube', 'A')).toBe(chartSongKey('ytmusic', 'A'));
    expect(chartSongKey('youtube', 'A')).not.toBe(chartSongKey('youtube', 'B'));
    expect(chartSongKey('applemusic', 'A')).not.toBe(chartSongKey('youtube', 'A'));
    expect(chartSongKey('applemusic', 'A')).not.toBe(chartSongKey('applemusic', 'B'));
    // A demo is never a real song, whatever its chart.
    expect(songIdOf({ run: 1, key: 'K' }, chartSongKey('youtube', 'A'))).not.toBe(songIdOf(null, chartSongKey('youtube', 'A')));
  });

  it('sidepanel.ts: doSave and attachExample build the saved chart for the current recording, so a fallback chart shown does not hide it', () => {
    const src = readFileSync(new URL('../src/extension/sidepanel/sidepanel.ts', import.meta.url), 'utf8');
    const save = src.slice(src.indexOf('async function doSave'), src.indexOf('\n}\n', src.indexOf('async function doSave')));
    expect(save).toMatch(/checkSaveTarget\(currentDraft\(\), currentRecording\(\)/);
    expect(save).toMatch(/buildChartDetailed\(\{ recording: r,/);
    expect(save).toMatch(/recordingKey\(built\.recording\) === chartKey/);
    const attach = src.slice(src.indexOf('async function attachExample'), src.indexOf('\n}\n', src.indexOf('async function attachExample')));
    expect(attach).toMatch(/chartWriteTarget\(currentRecording\(\)/);
    expect(attach).toMatch(/attachChartToRecording\(ex, r\)/);
    expect(attach).toMatch(/recordingKey\(c\.recording\) === chartKey/);
  });
});
