/**
 * Play view "코드 고치기": pick one chord event of the chart, choose a replacement in the
 * names the play view shows (capo shape names; the sounding name only as a small extra when
 * 실제 음 이름 보기 is on) and save. A slash bass is kept unless the user changes or removes it. Clicking a bar still only seeks; this panel is opened
 * by its own button and starts at the chord under the playhead.
 */
import { isNoChord } from '../../arrange/chord';
import { PICK_QUALITIES, pickBass, pickName, pickRoot, pickToConcert, sameChordSymbol, splitPick, type EventRef } from '../../editor/correct';
import { prettyChord, shapeName } from '../../music/key';
import type { PlayModel } from '../../play/model';
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
    this.select(i);
    this.host.seek(m.chart.events[i].startSec + 0.01);
  }

  /** Selects chart event i; the picker starts at its current chord unless `resetPick` is false. */
  private select(i: number, resetPick = true): void {
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
    $('fix-which').innerHTML = `<time>${formatTime(shown.startSec)}</time> <b>${escapeHtml(shownName(shown.chord, capo))}</b>${snd}<small>${escapeHtml(originNote(shown))}</small>`;
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
    $('fix-preview').innerHTML = same ? '지금과 같은 코드예요' : `${escapeHtml(shownName(from, capo))} → <b>${escapeHtml(to)}</b>${snd}`;
    ($('fix-save') as HTMLButtonElement).disabled = same || this.busy;
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
