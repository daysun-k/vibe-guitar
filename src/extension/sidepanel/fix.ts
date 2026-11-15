/**
 * Play view "코드 고치기": pick one chord event of the chart, choose a replacement in the
 * names the play view shows (capo shape names; the sounding name only as a small extra when
 * 실제 음 이름 보기 is on) and save. A slash bass is kept unless the user changes or removes it. Clicking a bar still only seeks; this panel is opened
 * by its own button and starts at the chord under the playhead.
 */
import { isNoChord } from '../../arrange/chord';
import type { AutoOrigin } from '../../chart/types';
import { PICK_QUALITIES, firstHeard, pickBass, pickName, pickRoot, pickToConcert, sameChordSymbol, splitPick, type EventRef } from '../../editor/correct';
import { prettyChord, respellChord, shapeName } from '../../music/key';
import type { PlayModel } from '../../play/model';
import { inJoinedGap, withRo, type UncertainMark } from '../../play/uncertain';
import { slashChordHTML } from './chord-name';
import { escapeHtml } from './diagram';
import { formatTime } from './play';

export interface FixHost {
  model(): PlayModel | null;
  /** Playback position (seconds). */
  now(): number;
  seek(sec: number): void;
  showSounding(): boolean;
  /** Highlights the bar of the chord being fixed (null clears). */
  mark(sec: number | null): void;
  /** Stores the fix; `from`/`to` are the shown names for the status line. */
  save(event: EventRef, concert: string, names: { from: string; to: string }): Promise<void>;
  /** Plays model.uncertain[index] as its second choice (replace tier only); rejects when not stored. */
  acceptAlt(index: number): Promise<void>;
  /** 처음 코드로 되돌리기: the event plays its first recognized chord again; `from`/`to` name it for the status line. */
  restore(event: EventRef, names: { from: string; to: string }): Promise<void>;
  /** The recording's stored auto chart chord at `sec`, for events fixed before ChordEvent.auto (null: none). */
  storedAutoAt?(sec: number): AutoOrigin | null;
}

/** Index of the chart event sounding at `t` (the first event before the song's first chord). */
export function eventIndexAt(events: readonly { startSec: number }[], t: number): number {
  let i = 0;
  for (let k = 0; k < events.length; k++) if (events[k].startSec <= t + 0.02) i = k;
  return i;
}

/** Shown name of a stored chord: capo shape name, "코드 없음" for a rest. */
export function shownName(chord: string, capo: number): string {
  return isNoChord(chord) ? '코드 없음' : shapeName(chord, capo);
}

/** Short origin note of an event for the picker header. */
export function originNote(e: { source: string; confidence: number }): string {
  if (e.source === 'manual') return '직접 고른 코드';
  return e.confidence < 0.6 ? '자동으로 들은 코드 · 확실하지 않음' : '자동으로 들은 코드';
}

/**
 * 대안 of the event being fixed (VGT-19): index into `marks` of the visible stretch inside the stored
 * event starting at `eventStartSec`, the one under the playhead `t` when there is one, else the first;
 * -1 when the event has none, and -1 when `t` lies in a gap the lane draws joined (Amendment 2: no
 * stretch is under the playhead there).
 */
export function fixAltIndex(marks: readonly Pick<UncertainMark, 'fromSec' | 'toSec' | 'ref' | 'span' | 'noChord'>[], eventStartSec: number, t: number): number {
  if (inJoinedGap(marks.filter((m) => m.ref.startSec === eventStartSec), t)) return -1;
  let first = -1;
  for (let i = 0; i < marks.length; i++) {
    if (marks[i].ref.startSec !== eventStartSec) continue;
    if (t >= marks[i].fromSec && t < marks[i].toSec) return i;
    if (first < 0) first = i;
  }
  return first;
}

/**
 * "대안: X" right of the origin note: a small button on a replace-tier stretch (one tap plays that
 * stretch as X), plain text otherwise. The concert name follows only when 실제 음 이름 보기 is on.
 */
export function fixAltHTML(u: Pick<UncertainMark, 'alt' | 'altSounding' | 'replace'>, i: number, showSounding: boolean): string {
  const snd = showSounding && u.altSounding !== u.alt ? ` <small class="snd">실제 ${escapeHtml(u.altSounding)}</small>` : '';
  return u.replace
    ? `<button class="fix-alt" data-u="${i}" aria-label="대안 ${escapeHtml(withRo(u.alt))} 바꾸기">대안: ${slashChordHTML(u.alt)}${snd}</button>`
    : `<small class="fix-alt">대안: ${slashChordHTML(u.alt)}${snd}</small>`;
}

/**
 * "처음 들은 코드: X" with the "처음 코드로 되돌리기" button, for a fixed event whose first recognized
 * chord is known (`name`: as this panel names chords, a capo shape name or 코드 없음).
 */
export function fixFirstHTML(name: string): string {
  return `<span class="fix-first">처음 들은 코드: ${slashChordHTML(name)} <button class="fix-restore" data-restore="1">처음 코드로 되돌리기</button></span>`;
}

const $ = (id: string): HTMLElement => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing`);
  return el;
};

export class ChordFixer {
  private index = -1;
  private ref: EventRef | null = null;
  private rootPc = 0;
  private quality = '';
  /** Slash bass pitch class of the pick; null for 베이스 없음. */
  private bassPc: number | null = null;
  private none = false;
  private busy = false;
  /** Shown name of the selected event's first recognized chord (null: nothing to restore). */
  private firstName: string | null = null;
  private readonly panel = $('fix');
  private readonly openBtn = $('fix-open');

  constructor(private readonly host: FixHost) {
    this.openBtn.addEventListener('click', () => (this.isOpen ? this.close() : this.open()));
    $('fix-close').addEventListener('click', () => this.close());
    $('fix-prev').addEventListener('click', () => this.step(-1));
    $('fix-next').addEventListener('click', () => this.step(1));
    $('fix-roots').addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-pc]');
      if (!b) return;
      this.rootPc = Number(b.dataset.pc);
      this.none = false;
      this.renderPicker();
    });
    $('fix-kinds').addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-q]');
      if (!b) return;
      this.none = b.dataset.q === 'N';
      if (!this.none) this.quality = b.dataset.q!;
      this.renderPicker();
    });
    $('fix-bass').addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-bass]');
      if (!b || b.disabled) return;
      const pc = b.dataset.bass === '' ? null : Number(b.dataset.bass);
      this.bassPc = pc === this.rootPc ? null : pc; // the root as bass is a plain chord
      this.renderPicker();
    });
    $('fix-save').addEventListener('click', () => void this.save());
    $('fix-which').addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      const b = target.closest<HTMLElement>('[data-u]');
      if (b) void this.acceptAlt(Number(b.dataset.u));
      else if (target.closest<HTMLElement>('[data-restore]')) void this.restore();
    });
    this.panel.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.close();
    });
  }

  get isOpen(): boolean {
    return !this.panel.hidden;
  }

  open(): void {
    const m = this.host.model();
    if (!m || !m.chart.events.length) return;
    this.panel.hidden = false;
    this.openBtn.setAttribute('aria-expanded', 'true');
    this.select(eventIndexAt(m.chart.events, this.host.now()));
    ($('fix-roots').querySelector<HTMLElement>('[aria-pressed=true]') ?? $('fix-close')).focus({ preventScroll: true });
  }

  close(): void {
    if (!this.isOpen) return;
    this.panel.hidden = true;
    this.openBtn.setAttribute('aria-expanded', 'false');
    this.host.mark(null);
    this.index = -1;
    this.ref = null;
  }

  /** The model was rebuilt: keep the same event selected, or close when it is gone. */
  onModel(): void {
    const m = this.host.model();
    this.openBtn.hidden = !m;
    if (!this.isOpen) return;
    if (!m || !this.ref) return this.close();
    const i = m.chart.events.findIndex((e) => e.startSec === this.ref!.startSec);
    if (i < 0) return this.close();
    this.select(i, false);
  }

  private capo(m: PlayModel): number {
    return m.arrangement.capo;
  }

  private step(d: number): void {
    const m = this.host.model();
    if (!m) return;
    const i = Math.max(0, Math.min(m.chart.events.length - 1, this.index + d));
    if (i === this.index) return;
    const at = m.chart.events[i].startSec + 0.01;
    this.select(i, true, at);
    this.host.seek(at);
  }

  /**
   * Selects chart event i; the picker starts at its current chord unless `resetPick` is false. `at` is
   * the playhead used to choose the event's 대안 (default: now).
   */
  private select(i: number, resetPick = true, at = this.host.now()): void {
    const m = this.host.model()!;
    const shown = m.chart.events[i];
    // The stored event: same index and start as the shown (key-respelled) chart.
    this.index = i;
    this.ref = { startSec: shown.startSec, chord: shown.chord };
    if (resetPick) {
      const p = splitPick(shownName(shown.chord, this.capo(m)));
      this.none = !p;
      if (p) {
        this.rootPc = p.rootPc;
        this.quality = p.quality;
      }
      this.bassPc = p?.bassPc ?? null;
    }
    this.host.mark(shown.startSec);
    const capo = this.capo(m);
    const snd = this.host.showSounding() && capo && !isNoChord(shown.chord) ? ` <small class="snd">실제 ${escapeHtml(prettyChord(shown.chord))}</small>` : '';
    const k = fixAltIndex(m.uncertain, shown.startSec, at);
    const alt = k >= 0 ? fixAltHTML(m.uncertain[k], k, this.host.showSounding()) : '';
    // 처음 들은 코드 of a fixed event: its own record, else the stored auto chart (events fixed earlier).
    const first = firstHeard(shown, shown.source === 'manual' && !shown.auto ? (this.host.storedAutoAt?.(shown.startSec) ?? null) : null);
    this.firstName = first ? shownName(respellChord(first.chord, m.key), capo) : null;
    const restore = this.firstName ? fixFirstHTML(this.firstName) : '';
    $('fix-which').innerHTML = `<time>${formatTime(shown.startSec)}</time> <b>${slashChordHTML(shownName(shown.chord, capo))}</b>${snd}<small>${escapeHtml(originNote(shown))}</small>${alt}${restore}`;
    ($('fix-prev') as HTMLButtonElement).disabled = i === 0;
    ($('fix-next') as HTMLButtonElement).disabled = i === m.chart.events.length - 1;
    this.renderPicker();
  }

  /** ASCII shape name of the current pick, or "N". */
  private pick(): string {
    return this.none ? 'N' : pickName(this.rootPc, this.quality, this.bassPc);
  }

  private renderPicker(): void {
    const m = this.host.model();
    if (!m || this.index < 0) return;
    const capo = this.capo(m);
    const kinds = PICK_QUALITIES.includes(this.quality) ? PICK_QUALITIES : [...PICK_QUALITIES, this.quality];
    $('fix-roots').innerHTML = Array.from({ length: 12 }, (_, pc) => {
      const on = !this.none && pc === this.rootPc;
      return `<button data-pc="${pc}" aria-pressed="${on}">${escapeHtml(prettyChord(pickRoot(pc, this.quality)))}</button>`;
    }).join('');
    $('fix-kinds').innerHTML =
      kinds.map((q) => `<button data-q="${escapeHtml(q)}" aria-pressed="${!this.none && q === this.quality}">${escapeHtml(prettyChord(pickName(this.rootPc, q)))}</button>`).join('') +
      `<button data-q="N" aria-pressed="${this.none}">코드 없음</button>`;
    // A bass equal to the root is shown as 베이스 없음 (the chord carries no slash then).
    const bass = this.bassPc === null || this.bassPc === this.rootPc ? null : this.bassPc;
    $('fix-bass').innerHTML =
      `<button data-bass="" aria-pressed="${!this.none && bass === null}"${this.none ? ' disabled' : ''}>베이스 없음</button>` +
      Array.from({ length: 12 }, (_, pc) => `<button data-bass="${pc}" aria-pressed="${!this.none && pc === bass}"${this.none ? ' disabled' : ''}>/${escapeHtml(prettyChord(pickBass(pc)))}</button>`).join('');
    const from = m.chart.events[this.index].chord;
    const concert = pickToConcert(this.pick(), capo, m.key);
    const same = sameChordSymbol(concert, from);
    const to = this.none ? '코드 없음' : prettyChord(this.pick());
    const snd = this.host.showSounding() && capo && !this.none ? ` <small class="snd">실제 ${escapeHtml(prettyChord(concert))}</small>` : '';
    $('fix-preview').innerHTML = same ? '지금과 같은 코드예요' : `${slashChordHTML(shownName(from, capo))} → <b>${slashChordHTML(to)}</b>${snd}`;
    ($('fix-save') as HTMLButtonElement).disabled = same || this.busy;
  }

  /** "대안: X" tapped: replace-tier stretch k becomes X (stored like a fix), then the panel closes. */
  private async acceptAlt(k: number): Promise<void> {
    const u = this.host.model()?.uncertain[k];
    if (!u?.replace || this.busy) return;
    this.busy = true;
    this.renderPicker();
    try {
      await this.host.acceptAlt(k);
      this.close();
    } catch {
      // the status line under the panel already says why
    } finally {
      this.busy = false;
      if (this.isOpen) this.renderPicker();
    }
  }

  /** "처음 코드로 되돌리기" tapped: stored like a fix (status line with 되돌리기), then the panel closes. */
  private async restore(): Promise<void> {
    const m = this.host.model();
    if (!m || !this.ref || !this.firstName || this.busy) return;
    this.busy = true;
    this.renderPicker();
    try {
      await this.host.restore(this.ref, { from: shownName(this.ref.chord, this.capo(m)), to: this.firstName });
      this.close();
    } catch {
      // the status line under the panel already says why
    } finally {
      this.busy = false;
      if (this.isOpen) this.renderPicker();
    }
  }

  private async save(): Promise<void> {
    const m = this.host.model();
    if (!m || !this.ref || this.busy) return;
    const capo = this.capo(m);
    const concert = pickToConcert(this.pick(), capo, m.key);
    if (sameChordSymbol(concert, this.ref.chord)) return;
    this.busy = true;
    this.renderPicker();
    try {
      await this.host.save(this.ref, concert, { from: shownName(this.ref.chord, capo), to: this.none ? '코드 없음' : prettyChord(this.pick()) });
      this.close();
    } finally {
      this.busy = false;
      if (this.isOpen) this.renderPicker();
    }
  }
}
