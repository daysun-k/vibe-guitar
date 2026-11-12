/**
 * The play button's steps (pause; or loop-start seek and play; or count-in preparation, beats and
 * play), apart from the panel's DOM so they can be tested with a fake player.
 *
 * VGT-16: a phone command passes `allowed`, its one context gate (control still held, its song
 * revision still the published one, the player target that revision was published for, and no ad;
 * see phone-control.ts). It is checked immediately before every
 * player command (pause, seek, play) and before the count-in starts; once it fails, nothing further
 * reaches the player and the result is `cancelled`. The panel's own button passes nothing and is
 * never gated.
 */
import type { PlayerControlMessage, PlayerControlResult } from '../messages';
import { prepareCountIn, runCountIn } from './countin-prep';

export type TransportResult = PlayerControlResult & { cancelled?: boolean };

/** Where a count-in starts and how long it is (null: count-in off or no chart). */
export interface CountInPlan {
  target: number;
  beats: number;
  bigPerBar: number;
  /** One big beat in seconds at 1x. */
  beatSec: number;
}

/** What the steps need from the panel. */
export interface PlayToggleEnv {
  send(msg: PlayerControlMessage): Promise<PlayerControlResult>;
  isPlaying(): boolean;
  countingIn(): boolean;
  /** Stops the running count-in (its run is no longer current). */
  stopCountIn(): void;
  /** Starts a new count-in run (any older run is no longer current) and returns its id. */
  newRun(): number;
  isRun(run: number): boolean;
  /** The count-in is shown and counts as running (countingIn() is true from here). */
  beginCountIn(): void;
  /** The count-in reached its end; play goes out next. */
  endCountIn(): void;
  countInPlan(): CountInPlan | null;
  /** With count-in off: the loop's A when the playhead is outside the loop, otherwise null. */
  loopStartOutside(): number | null;
  rate(): number;
  /** The panel is about to seek (its loop jumper follows the target). */
  seeked(sec: number): void;
  status(text: string): void;
  beat(left: number, accent: boolean): void;
  wait?: (ms: number) => Promise<void>;
}

export const RATE_CANCELS_COUNTIN = '속도가 바뀌어서 카운트인을 멈췄어요. 다시 눌러 주세요.';

const CANCELLED: TransportResult = { ok: false, cancelled: true };

export async function playToggle(env: PlayToggleEnv, o: { onCountIn?: () => void; allowed?: () => boolean } = {}): Promise<TransportResult> {
  const allowed = o.allowed ?? (() => true);
  /** Every player command goes through here: none once the gate failed. */
  const send = async (msg: PlayerControlMessage): Promise<TransportResult> => (allowed() ? env.send(msg) : CANCELLED);
  const why = (r: PlayerControlResult) => r.reason ?? '알 수 없음';

  env.status('');
  if (env.countingIn()) {
    // Stopping a count-in sends nothing to the player.
    env.stopCountIn();
    return { ok: true };
  }
  if (env.isPlaying()) {
    const r = await send({ type: 'player-control', action: 'pause' });
    if (!r.ok && !r.cancelled) env.status(`이 플레이어는 패널에서 멈출 수 없어요 (${why(r)}).`);
    return r;
  }
  const plan = env.countInPlan();
  if (!plan) {
    const loopStart = env.loopStartOutside();
    if (loopStart !== null) {
      if (!allowed()) return CANCELLED;
      env.seeked(loopStart);
      const s = await send({ type: 'player-control', action: 'seek', time: loopStart });
      if (!s.ok) {
        env.status(`반복 구간 처음으로 이동하지 못했어요 (${why(s)}).`);
        return s;
      }
    }
    // Checked again after the seek's reply: approval may have ended, the song or tab changed, or an ad started meanwhile.
    const r = await send({ type: 'player-control', action: 'play' });
    if (!r.ok && !r.cancelled) env.status(`이 플레이어는 패널에서 재생할 수 없어요 (${why(r)}).`);
    return r;
  }
  if (!allowed()) return CANCELLED;
  const run = env.newRun();
  const current = () => env.isRun(run) && allowed();
  env.seeked(plan.target);
  const prep = await prepareCountIn(send, current, plan.target);
  if (prep.kind === 'cancelled') return CANCELLED;
  if (prep.kind === 'failed') {
    env.status(prep.step === 'pause'
      ? `이 플레이어에서는 카운트인 재생을 지원하지 않아요 (${prep.reason ?? '알 수 없음'}).`
      : `마디 처음으로 이동하지 못해 카운트인을 취소했어요 (${prep.reason ?? '알 수 없음'}).`);
    return { ok: false, reason: prep.reason };
  }
  if (!current()) return CANCELLED;
  const rate = env.rate();
  env.beginCountIn();
  o.onCountIn?.();
  const done = await runCountIn({
    beats: plan.beats,
    stepMs: (plan.beatSec * 1000) / rate,
    startRate: rate,
    rate: env.rate,
    isCurrent: current,
    onBeat: (left, k) => env.beat(left, k % plan.bigPerBar === 0),
    play: () => {
      env.endCountIn();
      return send({ type: 'player-control', action: 'play' });
    },
    wait: env.wait,
  });
  if (done.kind === 'cancelled') {
    // Gate failed while the beats ran: this run is still shown, so stop it here.
    if (env.isRun(run) && env.countingIn()) env.stopCountIn();
    return CANCELLED;
  }
  if (done.kind === 'rate-changed') {
    env.stopCountIn();
    env.status(RATE_CANCELS_COUNTIN);
    return CANCELLED;
  }
  const r: TransportResult = done.result;
  if (!r.ok && !r.cancelled) env.status(`재생을 다시 시작하지 못했어요 (${why(r)}).`);
  return r;
}
