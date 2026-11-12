/**
 * VGT-16: carrying out a command from the approved phone in the side panel.
 *
 * The phone's commands go through the same handlers as the panel's own controls: play/pause is the
 * play button's togglePlay (count-in, loop start and pause-cancels-count-in included); "처음부터"
 * (loop A, else the song's start) and "이전 마디" / "다음 마디" are the same seek a bar click uses.
 * The panel then waits until the player's reported
 * state shows the change (bounded by CONTROL_OBSERVE_MS) before it tells the phone, because the
 * content script answers before play/seek has actually happened, and a phone tap does not count as a
 * user gesture on the Mac's page: the browser's autoplay rule may keep the video paused.
 *
 * Context gate: one predicate, checked when the command starts and again immediately before every
 * player command and count-in start the command causes. It holds only while
 *   - the phone still holds the grant the command came with (else `cancelled`),
 *   - the command's song revision is still the one published to phones (else `stale`),
 *   - the panel's player target (song, tab, recording) is still the one that revision was published
 *     for, so a player that changed before the panel published the new song is never reached (else
 *     `stale`; at the start, no target at all is `no-target`),
 *   - no ad is playing (else `ad`).
 * Once it fails nothing further is sent, and the phone (if still connected) gets that code. While the
 * panel then waits to observe the change, a song or target change (`stale`) or an ad that starts
 * (`ad`) before the change is seen is reported instead of success.
 *
 * The player target includes the version of the play model the panel shows (ShownModel): a chart
 * reload, save, import, chord fix or settings change that replaces the model is a new target, and the
 * replacement first marks the phone's song as changing (PhoneLink.songChanging).
 */
import { CONTROL_OBSERVE_MS, type CommandFailure, type CommandOutcome, type PhoneCommand } from '../../phone/protocol';
import type { PlayerControlResult } from '../messages';
import type { TransportResult } from './play-toggle';

/** What the panel currently observes about its player (demo clock or the content script's reports). */
export interface ObservedPlayer {
  playing(): boolean;
  countingIn(): boolean;
  /** Song position in seconds (no sync offset). */
  position(): number;
  rate(): number;
  isAd(): boolean;
  /**
   * Which song and player commands would act on right now (demo, or tab + recording + chart), or null
   * when no song is shown or its player may not be controlled from this panel.
   */
  target(): string | null;
  /**
   * The position the panel observed just before its loop jumped back from B to A, when (ms on the
   * monotonic `now` clock, panelClock), and the player target it was taken for (target()), or null.
   * A seek command that is still waiting takes it as one more observation at that time, so a step
   * that landed and then played past B before the next poll still counts. A sample taken for another
   * target (another tab, song or chart) never counts.
   */
  wrapSample?(): WrapSample | null;
}

export interface WrapSample {
  at: number;
  position: number;
  target: string | null;
}

/**
 * The panel's clock for phone commands and loop wraps: monotonic (performance.now), so a wall-clock
 * change (NTP, the user setting the time) never makes an older wrap sample look newer than a seek.
 */
export const panelClock = (): number => performance.now();

export type { TransportResult };

/** The panel's own handlers. */
export interface PanelTransport {
  /**
   * The play button. `onCountIn` runs when a count-in starts. `allowed` is checked immediately before
   * every player command and the count-in start; once false, nothing more is sent (`cancelled`).
   * Resolves when the handler is done.
   */
  toggle(onCountIn: () => void, allowed: () => boolean): Promise<TransportResult>;
  /** The bar-click seek (cancels a count-in). Sends synchronously: the caller checks the gate first. */
  seek(sec: number): Promise<PlayerControlResult>;
  /** Where 처음부터 goes (see restartTargetSec), or null when there is nowhere to go. */
  restartTarget(): number | null;
  /**
   * Where 이전 마디 (-1) / 다음 마디 (+1) goes from the position now (see barStepTargetSec): a time,
   * `last` when 다음 마디 is already in the last bar (of the loop, when one is set), or null without bars.
   */
  barTarget(step: -1 | 1): number | 'last' | null;
  /** Cancels the count-in this command started (never one started from the panel), so it never plays. */
  cancelCountIn(): void;
}

/** What PhoneLink knows about a command it hands over: its grant and the song revision it was sent for. */
export interface CommandContext {
  /** `cancelled` once the grant the command came with ended, `stale` once its revision is no longer the one published; else null. */
  check(): CommandFailure | null;
  /** The player target the command's revision was published for (null: published with no song). */
  readonly target: string | null;
}

export interface RunOptions {
  /**
   * The command's grant and published revision. Without it (tests of the steps alone), the target seen
   * when the command starts is the one it is bound to.
   */
  context?: CommandContext;
  /** Progress before the final outcome (the count-in started). */
  progress?: (o: CommandOutcome) => void;
  /**
   * Aborted when the phone loses the right to control (switch off, 승인 해제, phone or relay gone, panel
   * replaced): a count-in this command started is cancelled and its play never happens.
   */
  signal?: AbortSignal;
  observeMs?: number;
  pollMs?: number;
  /** Defaults to panelClock (monotonic). */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const fail = (code: CommandFailure): CommandOutcome => ({ ok: false, code });

/** The AbortSignal reason PhoneLink uses when the song the phone saw changed. */
export const SONG_CHANGED: CommandFailure = 'stale';

/** How far past the target, beyond what playback can have added since the seek, an observation may be. */
export const SEEK_SLACK_SEC = 0.35;

/**
 * When the rate differs at the two ends of an observation interval, the change happened at an unknown
 * time inside it: the higher rate is credited for at most this long, the lower one for the rest.
 */
export const RATE_CHANGE_CREDIT_SEC = 0.1;

/**
 * Playback progress (seconds) the allowance may grow by over an interval of `dtMs` whose ends saw the
 * rates `r0` and `r1` (0 while paused): the lower rate for the whole interval plus the difference for
 * at most RATE_CHANGE_CREDIT_SEC. For a poll-sized interval (<= 0.1 s) that is the higher rate times
 * its length; over a long gap (a late first observation) it never credits the higher rate for longer
 * than 0.1 s, so the allowance exceeds real progress by at most |r1 - r0| x 0.1 s (S6-R15-01).
 */
export function intervalProgressSec(r0: number, r1: number, dtMs: number): number {
  const dt = Math.max(0, dtMs) / 1000;
  return Math.min(r0, r1) * dt + Math.abs(r1 - r0) * Math.min(dt, RATE_CHANGE_CREDIT_SEC);
}

/** Pauses the player if it plays (e.g. started on the Mac during a count-in) and reports what it shows. */
async function settlePaused(player: ObservedPlayer, transport: PanelTransport, g: Gate, observeMs: number, pollMs: number, now: () => number, sleep: (ms: number) => Promise<void>): Promise<CommandOutcome> {
  if (!player.playing()) return { ok: true, state: 'paused' };
  const r = await transport.toggle(() => {}, g.allowed);
  if (r.cancelled) return g.refused();
  if (!r.ok) return fail('failed');
  if (await waitUntil(() => g.observed() !== null || !player.playing(), observeMs, pollMs, now, sleep)) return outcome(g, { ok: true, state: 'paused' });
  return fail('timeout');
}

interface Gate {
  /** Why the context gate (see the file comment) fails right now, or null while it holds. */
  why: () => CommandFailure | null;
  /** The gate holds. */
  allowed: () => boolean;
  /** While observing the outcome: `stale` (another song's player is observed now) or `ad`, else null. */
  observed: () => CommandFailure | null;
  /** The failure to report once the gate failed. */
  refused: () => CommandOutcome;
  /** The target the command is bound to. */
  target: string | null;
}

function gate(player: ObservedPlayer, signal: AbortSignal | undefined, context: CommandContext | undefined): Gate {
  const target = context ? context.target : player.target();
  // A song or target change wins over a lost grant: what is observed now is another song's.
  const why = (): CommandFailure | null => {
    const c = context?.check() ?? null;
    if (c === 'stale' || (signal?.aborted && signal.reason === SONG_CHANGED) || player.target() !== target) return 'stale';
    if (c) return c;
    if (signal?.aborted) return 'cancelled';
    if (player.isAd()) return 'ad';
    return null;
  };
  return {
    why,
    allowed: () => why() === null,
    observed: () => {
      const w = why();
      return w === 'stale' ? 'stale' : player.isAd() ? 'ad' : null;
    },
    refused: () => fail(why() ?? 'cancelled'),
    target,
  };
}

/** The success observed, unless the song or target changed or an ad started first. */
function outcome(g: Gate, ok: CommandOutcome): CommandOutcome {
  const f = g.observed();
  return f ? fail(f) : ok;
}

/** Polls `pred` until it holds or `ms` passed. */
export async function waitUntil(pred: () => boolean, ms: number, pollMs: number, now: () => number, sleep: (ms: number) => Promise<void>): Promise<boolean> {
  const end = now() + ms;
  for (;;) {
    if (pred()) return true;
    if (now() >= end) return false;
    await sleep(pollMs);
  }
}

/**
 * Where 처음부터 goes: the loop's A (`loopStartSec`, already the bar-click target) when a loop exists,
 * otherwise the start of the song (0). Never the current bar. Null without bars (no chart to play).
 */
export function restartTargetSec(loopStartSec: number | null, bars: readonly { startSec: number }[]): number | null {
  if (loopStartSec !== null) return Math.max(0, loopStartSec);
  return bars.length ? 0 : null;
}

/** A bar step seeks just inside the bar, like a bar click (so the bar under the playhead is that bar). */
const BAR_SEEK_INSIDE_SEC = 0.01;
/**
 * A position this little before a bar's start counts as that bar: a step that landed a frame early (players
 * round to frames) must not make the next 이전 마디 skip a bar. landedAt uses the same amount as the
 * lowest position that counts as having reached a seek target, so a position still in the bar before
 * the target never counts as success.
 */
export const BAR_EARLY_SEC = 0.1;

/**
 * The bar under `position`: the last bar starting at or before `position + BAR_EARLY_SEC`, -1 before
 * the first bar. Used to choose 이전 마디 / 다음 마디 targets.
 */
export function barIndexAt(bars: readonly { startSec: number }[], position: number): number {
  let at = -1;
  for (let i = 0; i < bars.length; i++) if (bars[i]!.startSec <= position + BAR_EARLY_SEC) at = i;
  return at;
}

/**
 * Where 이전 마디 (`step` -1) / 다음 마디 (+1) goes from `position`: the start of the bar before / after
 * the bar under `position` (barIndexAt; before the first bar, bar 1 counts as the current bar's successor).
 * 이전 마디 always goes to the previous bar, never back to the start of the current one, and stays at
 * the first bar's start there. 다음 마디 in the last bar is `last` (nothing to do). With a loop
 * (`loopBars`: indexes of its A and B bars), the steps stay inside its bars: 이전 마디 at A stays at A,
 * 다음 마디 at B is `last`, and from outside the loop a step lands on the nearest loop bar.
 * Null without bars.
 */
export function barStepTargetSec(step: -1 | 1, bars: readonly { startSec: number }[], position: number, loopBars: readonly [number, number] | null = null): number | 'last' | null {
  if (!bars.length) return null;
  const lo = loopBars ? Math.max(0, Math.min(loopBars[0], bars.length - 1)) : 0;
  const hi = loopBars ? Math.max(lo, Math.min(loopBars[1], bars.length - 1)) : bars.length - 1;
  const at = barIndexAt(bars, position);
  // In the last bar (of the loop): 다음 마디 has nothing to do.
  if (step > 0 && at === hi) return 'last';
  const to = Math.max(lo, Math.min(hi, at + step));
  return Math.max(0, bars[to]!.startSec) + BAR_SEEK_INSIDE_SEC;
}

export async function runPhoneCommand(cmd: PhoneCommand, player: ObservedPlayer, transport: PanelTransport, o: RunOptions = {}): Promise<CommandOutcome> {
  const now = o.now ?? panelClock;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const observeMs = o.observeMs ?? CONTROL_OBSERVE_MS;
  const pollMs = o.pollMs ?? 50;
  const g = gate(player, o.signal, o.context);
  const { allowed } = g;
  if (!allowed()) return g.refused();
  if (g.target === null) return fail('no-target');

  if (cmd === 'toggle') {
    // Pause during a count-in cancels it. The player itself may still play (started on the Mac
    // meanwhile): then it is paused as well, and only an observed pause is reported.
    if (player.countingIn()) {
      await transport.toggle(() => {}, allowed);
      return settlePaused(player, transport, g, observeMs, pollMs, now, sleep);
    }
    const want = !player.playing();
    let countIn = false;
    const onAbort = () => {
      if (countIn) transport.cancelCountIn();
    };
    o.signal?.addEventListener('abort', onAbort, { once: true });
    let r: TransportResult;
    try {
      r = await transport.toggle(() => {
        countIn = true;
        // The gate passed just before the count-in started; checked again in case that changes.
        if (!allowed()) return transport.cancelCountIn();
        o.progress?.({ ok: true, state: 'countin' });
      }, allowed);
    } finally {
      o.signal?.removeEventListener('abort', onAbort);
    }
    if (r.cancelled) return allowed() ? { ok: true, state: player.playing() ? 'playing' : 'paused' } : g.refused();
    if (!r.ok) return fail('failed');
    if (await waitUntil(() => g.observed() !== null || player.playing() === want, observeMs, pollMs, now, sleep)) return outcome(g, { ok: true, state: want ? 'playing' : 'paused' });
    return fail(want ? 'autoplay' : 'timeout');
  }

  const target = cmd === 'restart' ? transport.restartTarget() : transport.barTarget(cmd === 'prev-bar' ? -1 : 1);
  if (target === null) return fail('no-target');
  // 다음 마디 in the last bar: nothing is sent to the player.
  if (target === 'last') return fail('last-bar');
  // seek() sends synchronously, so this is the check immediately before the seek goes out.
  if (!allowed()) return g.refused();
  // The window's elapsed time counts from just before the seek goes out.
  const landed = landedAt(target, player, now, g.target);
  const r = await transport.seek(target);
  if (!r.ok) return fail('failed');
  if (await waitUntil(() => g.observed() !== null || landed(), observeMs, pollMs, now, sleep)) return outcome(g, { ok: true, state: player.playing() ? 'playing' : 'paused' });
  return fail('timeout');
}

/**
 * A seek command (처음부터 to 0 or loop A, 이전 마디, 다음 마디) counts as done once one observation
 * taken after the seek was sent has the position p in
 *   target - BAR_EARLY_SEC <= p <= target + allowance + SEEK_SLACK_SEC
 * where allowance starts at 0 just before the seek goes out and grows, per observation interval, by
 * intervalProgressSec: the lower of the rates at its two ends x its length, plus the difference for at
 * most RATE_CHANGE_CREDIT_SEC (rate 0 while paused). The time of a rate change inside an interval is
 * not known, so a long interval (a late first observation) never credits the higher rate for longer
 * than that: the allowance never exceeds what playback can have added by more than |change| x 0.1 s
 * (S6-R15-01), while a change just before a poll-sized observation keeps the progress already made
 * (S6-R14-01). Within CONTROL_OBSERVE_MS; otherwise the caller reports timeout. Nothing else is
 * extrapolated.
 * - The lower bound is the bar lookup's own BAR_EARLY_SEC: a position still in the bar before the
 *   target (a seek accepted but not applied, or observed early) never counts (S6-R12-01).
 * - The upper bound grows with what playback can have added since the seek, so a correct seek seen
 *   late at a high rate counts (S6-R13-01). No bar indexes are compared, so a target in a short first
 *   bar (where barIndexAt already sees the next bar) counts when it lands (S6-R13-02).
 * - A loop jump (B back to A) between two polls would hide a step that landed and played on past B:
 *   the position the panel saw just before the jump (ObservedPlayer.wrapSample) counts as one more
 *   observation at its time, judged by the same window; a pre-wrap position outside it does not count.
 *   Only a sample taken after the seek went out (on the monotonic panelClock, so a wall-clock change
 *   never revives an old one) and for the command's own target (`boundTarget`: never another tab's,
 *   song's or chart's) counts (S6-R15-02).
 * - Decision: if a seek is dropped while playing and normal playback carries the position into the
 *   window before the timeout, that counts as success. Success means "the observed position is at the
 *   target now", which is then true.
 */
export function landedAt(target: number, player: Pick<ObservedPlayer, 'position' | 'rate' | 'playing' | 'wrapSample'>, now: () => number, boundTarget: string | null): () => boolean {
  const rateNow = () => (player.playing() ? player.rate() : 0);
  const inWindow = (p: number, allowance: number) => p >= target - BAR_EARLY_SEC && p <= target + allowance + SEEK_SLACK_SEC;
  // Playback progress the position may show since the seek, summed per observation interval (a rate
  // change never rewrites progress already made).
  let lastT = now();
  let lastRate = rateNow();
  let allowanceSec = 0;
  // Loop wraps already seen (or from before the seek) are never taken again.
  let wrapSeenAt = lastT;
  return () => {
    const t = now();
    const r = rateNow();
    // A loop jump since the last poll: its pre-wrap position, judged with the allowance at its time.
    const w = player.wrapSample?.() ?? null;
    let wrapLanded = false;
    if (w && w.at > wrapSeenAt) {
      wrapSeenAt = w.at;
      wrapLanded = w.target === boundTarget && inWindow(w.position, allowanceSec + intervalProgressSec(lastRate, r, Math.min(w.at, t) - lastT));
    }
    allowanceSec += intervalProgressSec(lastRate, r, t - lastT);
    lastT = t;
    lastRate = r;
    return wrapLanded || inWindow(player.position(), allowanceSec);
  };
}

/**
 * The play model the panel shows and the song it was built for (`builtFor`: a recording's or a demo
 * run's song id, see TargetParts.songId). `replace` is the only way it changes: when it is another
 * model or another song, the phone's song is marked as changing first (synchronously), then the
 * version goes up, so a phone revision published for the previous model never acts on this one.
 */
export class ShownModel<M> {
  private current: M | null = null;
  private forId = '';
  private n = 0;
  constructor(private readonly beforeReplace: () => void) {}

  get version(): number {
    return this.n;
  }

  get builtFor(): string {
    return this.forId;
  }

  replace(next: M | null, builtFor: string): M | null {
    if (next !== this.current || builtFor !== this.forId) {
      this.beforeReplace();
      this.current = next;
      this.forId = builtFor;
      this.n++;
    }
    return next;
  }
}

/** What the player target of a phone command is made of (see ObservedPlayer.target). */
export interface TargetParts {
  /** ShownModel.version, or null without a model. */
  modelVersion: number | null;
  /** ShownModel.builtFor: the song the shown model was built for. */
  modelFor: string;
  /**
   * The song player commands would act on right now (the demo run's, or the player's recording's).
   * While it is not the one the shown model was built for (e.g. the demo was left and the real song's
   * model is not built yet), the phone's song is not ready: nothing is published and commands are stale.
   */
  songId: string;
  demo: { run: number; key: string } | null;
  /** The chart shown was loaded for the current recording (not the previous song's, still loading). */
  chartLoaded: boolean;
  /** The tab player commands would go to, or null. */
  tab: number | null;
  recordingKey: string;
  chartKey: string;
}

/** The shown model belongs to the song player commands would act on, so its view may be published. */
export function songViewReady(s: Pick<TargetParts, 'modelFor' | 'songId' | 'demo' | 'chartLoaded'>): boolean {
  return s.modelFor === s.songId && (!!s.demo || s.chartLoaded);
}

/** A demo run's or a recording's song id (TargetParts.songId, ShownModel.builtFor). */
export function songIdOf(demo: { run: number; key: string } | null, recordingKey: string): string {
  return demo ? JSON.stringify(['demo', demo.run, demo.key]) : JSON.stringify(['rec', recordingKey]);
}

/**
 * The song a model is built for (ShownModel.builtFor): the demo run's, or, with the real player, the
 * song of the chart the model is built from, never a label kept beside the chart (a late save reply
 * may have put another song's chart there). `noChart` names it when there is no chart. Both are song
 * keys as the chart loader sees them (storage.ts chartSongKey: YouTube and YouTube Music recordings
 * of one video are one song), as is the recording key in TargetParts.songId.
 */
export function modelSongId(demo: { run: number; key: string } | null, chartSong: string | null, noChart: string): string {
  return songIdOf(demo, chartSong ?? noChart);
}

/** The player target: which song, model and player commands would act on right now, or null. */
export function playerTargetKey(s: TargetParts): string | null {
  if (s.modelVersion === null || !songViewReady(s)) return null;
  if (s.demo) return JSON.stringify(['demo', s.demo.run, s.demo.key, s.modelVersion]);
  if (!s.chartLoaded || s.tab === null) return null;
  return JSON.stringify(['tab', s.tab, s.recordingKey, s.chartKey, s.modelVersion]);
}
