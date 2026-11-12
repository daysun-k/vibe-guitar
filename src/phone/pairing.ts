/**
 * VGT-16 pairing state machine (kept by the relay, in memory only).
 *
 * Every phone connection gets a 4-digit code when it joins. While the panel's 휴대폰에서 조작 허용
 * is on, the phone shows its code and the panel lists it with 승인 / 거절. At most one connection is
 * approved at a time, and only it may send commands. An approval belongs to one connection and to the
 * current panel session: it ends when that phone disconnects, the switch goes off, the panel closes or
 * is replaced (the relay calls setControl(false)), on 승인 해제, and with the relay process itself.
 * Nothing is stored. Codes are unique among the connected phones and not reused for the next
 * RECENT_CODES joins, so a code on the panel always names exactly one connection.
 *
 * The panel decides: each approval carries the panel's grant number, kept with the approved
 * connection, stamped on its forwarded commands and shown in the panel's list. The panel runs a
 * command only when the number matches its own current grant.
 */
import type { PairMessage, PairState, PhoneEntry } from './protocol';

const RECENT_CODES = 64;

export class Pairing {
  private on = false;
  /** `grant`: the panel's number for the current approval (only while approved). */
  private readonly phones = new Map<string, { code: string; state: PairState; grant?: number }>();
  private readonly recent: string[] = [];

  /** `randomInt(n)` returns a uniform integer in [0, n) (crypto.randomInt in the relay). */
  constructor(private readonly randomInt: (n: number) => number) {}

  get controlOn(): boolean {
    return this.on;
  }

  /** A phone connected: gives it a code (pending). */
  join(id: string): string {
    const code = this.newCode();
    this.phones.set(id, { code, state: 'pending' });
    return code;
  }

  /** A phone disconnected; its approval (if any) ends with it. */
  leave(id: string): boolean {
    return this.phones.delete(id);
  }

  /**
   * The panel's switch (false also when the panel left or was replaced). Any change starts over:
   * the approval is revoked and every phone is pending again. Returns whether anything changed.
   */
  setControl(on: boolean): boolean {
    if (on === this.on) return false;
    this.on = on;
    for (const p of this.phones.values()) this.unapprove(p, 'pending');
    return true;
  }

  /**
   * Approves the connection `id` showing `code` under the panel's `grant`; another approved phone goes
   * back to pending. Approving the approved phone again with a new grant replaces its grant.
   */
  approve(id: string, code: string, grant: number): boolean {
    const p = this.phones.get(id);
    if (!this.on || !p || p.code !== code || (p.state === 'approved' && p.grant === grant)) return false;
    for (const q of this.phones.values()) if (q.state === 'approved') this.unapprove(q, 'pending');
    p.state = 'approved';
    p.grant = grant;
    return true;
  }

  reject(id: string, code: string): boolean {
    const p = this.phones.get(id);
    if (!this.on || !p || p.code !== code || p.state === 'rejected') return false;
    this.unapprove(p, 'rejected');
    return true;
  }

  /** 승인 해제: the approved phone goes back to pending. */
  revoke(): boolean {
    let changed = false;
    for (const p of this.phones.values()) {
      if (p.state !== 'approved') continue;
      this.unapprove(p, 'pending');
      changed = true;
    }
    return changed;
  }

  /** The grant the approved connection `id` was approved under (null: not approved). */
  grantOf(id: string): number | null {
    const p = this.phones.get(id);
    return this.on && p?.state === 'approved' && p.grant !== undefined ? p.grant : null;
  }

  private unapprove(p: { state: PairState; grant?: number }, state: PairState): void {
    p.state = state;
    delete p.grant;
  }

  isApproved(id: string): boolean {
    return this.on && this.phones.get(id)?.state === 'approved';
  }

  /** What the phone `id` is told. */
  stateFor(id: string): PairMessage {
    const p = this.phones.get(id);
    if (!this.on || !p) return { t: 'pair', state: 'off' };
    return { t: 'pair', state: p.state, code: p.code };
  }

  /** What the panel lists (nothing while control is off). */
  list(): PhoneEntry[] {
    if (!this.on) return [];
    return [...this.phones].map(([id, p]) => (p.state === 'approved' && p.grant !== undefined ? { id, code: p.code, state: p.state, grant: p.grant } : { id, code: p.code, state: p.state }));
  }

  private newCode(): string {
    const taken = new Set([...this.recent, ...[...this.phones.values()].map((p) => p.code)]);
    let code = '';
    // 10 000 codes, at most RECENT_CODES + a few connections taken: a free one comes up quickly.
    for (let i = 0; i < 1000; i++) {
      code = String(this.randomInt(10000)).padStart(4, '0');
      if (!taken.has(code)) break;
    }
    this.recent.push(code);
    if (this.recent.length > RECENT_CODES) this.recent.shift();
    return code;
  }
}
