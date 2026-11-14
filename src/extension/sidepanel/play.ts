/**
 * Play view (mockup B "진행표형"): chord-shape strip, pinned lyric line, bar-grid lane and
 * transport. Built once per PlayModel; `render(t)` runs every animation frame and only
 * touches the DOM when something changed.
 */
import type { Arrangement } from '../../arrange/arrange';
import { prettyChord, shapeName } from '../../music/key';
import { bigBeatSeconds } from '../../music/meter';
import { barsForHardChord, changeConcertLabel, frameAt, upcomingShapes, type PlayModel } from '../../play/model';
import { withRo } from '../../play/uncertain';
import { bassHTML, slashChordHTML, splitSlashBass } from './chord-name';
import { escapeHtml, renderShapeDiagram, shapeDiagramHeight } from './diagram';
import { ScrubState } from './scrub';

/** Korean particle follows the spoken final digit (10 ends in 십). */
export function capoReason(capo: number): string {
  return `카포 ${capo}${[2, 4, 5, 9].includes(capo % 10) ? '라' : '이라'}`;
}

/** The settings card uses shape names, with optional secondary concert names. */
export function unplayableLine(a: Pick<Arrangement, 'unplayable' | 'capo'>, showSounding: boolean): string {
  const names = a.unplayable.map((name) => escapeHtml(shapeName(name, a.capo)) +
    (showSounding && a.capo ? ` <small class="snd">실제 ${escapeHtml(prettyChord(name))}</small>` : ''));
  return `운지를 찾지 못함: ${names.join(', ')}`;
}

export interface PlayHost {
  seek(sec: number): void;
  togglePlay(): void;
  /** A speed button was pressed (the buttons show the reported rate, set by the panel). */
  setRate?(rate: number): void;
  /** A lane bar was pressed: true when the host used it (choosing loop bars), else it seeks. */
  barClick?(index: number): boolean;
  /** 불확실한 곳 (VGT-19): play model.uncertain[index] as its second choice. */
  acceptAlt?(index: number): void;
}

/**
 * Temporary visual variants of the uncertain marks (dev query `uv=A|B|C`, default A); the
 * visibility, names and replacement are shared, only the drawing below differs.
 * A: dashed amber outline and "?" on the lane, second choice + button under the strip.
 * B: "또는 Am" chip on the lane (its own button), only a "?" on the current card.
 * C: thin amber underline on the lane, second choice + button under the strip.
 */
export type UncertainVariant = 'A' | 'B' | 'C';

export function uncertainVariant(q: string | null): UncertainVariant {
  return q === 'B' || q === 'C' ? q : 'A';
}

/** Screen-reader / status wording of a mark: "확실하지 않아요, 다른 후보 Am". */
export function uncertainText(alt: string): string {
  return `확실하지 않아요, 다른 후보 ${alt}`;
}

/** Lane marks of the practice loop: the looped bar indexes, and the A bar while B is being chosen. */
export interface LoopMarks {
  range: { from: number; to: number } | null;
  picking: { a: number | null } | null;
}

const reduceMotion = (): boolean => matchMedia('(prefers-reduced-motion: reduce)').matches;

const REPEAT_SVG =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M17 5 7 19" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><circle cx="7.5" cy="8" r="2" fill="currentColor"/><circle cx="16.5" cy="16" r="2" fill="currentColor"/></svg>';
export const ICON_PLAY = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.4-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z"/></svg>';
export const ICON_PAUSE = '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4.2" height="14" rx="1.2"/><rect x="13.8" y="5" width="4.2" height="14" rx="1.2"/></svg>';

export function formatTime(sec: number): string {
  const s = Math.max(0, sec);
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

/**
 * Chord name with small accidental / quality. A dropped 7th is shown only by the change mark
 * (●) and its tooltip: a superscript 7 after the name read as a 7th chord ("G⁷" looked like G7).
 */
export function chordHTML(name: string): string {
  if (!name || name === 'N.C.' || name === '—') return '<span class="cn">—</span>';
  const { head, bass } = splitSlashBass(name);
  const m = /^([A-G])([♭♯]?)(.*)$/.exec(head);
  if (!m) return `<span class="cn">${escapeHtml(head)}${bassHTML(bass)}</span>`;
  return `<span class="cn">${m[1]}${m[2] ? `<span class="acc">${m[2]}</span>` : ''}${m[3] ? `<span class="q">${escapeHtml(m[3])}</span>` : ''}${bassHTML(bass)}</span>`;
}

/** Screen-reader text of a change: "원래 코드 F, 바뀐 코드 Fmaj7. <reason>" (no particle after a chord name). */
export function changeLabel(c: { from: string; to: string; text: string; root: boolean; badge?: string }): string {
  if (c.from === c.to && c.badge) return `${c.badge}. ${c.text}`;
  return `원래 모양 ${c.from}, 바뀐 모양 ${c.to}${c.root ? '(근음 바뀜)' : ''}. ${c.text}`;
}

/** Keeps `el` near 30 % of the scroller unless the user scrolled away ("현재 위치로" brings it back). */
function follower(scroller: HTMLElement, btn: HTMLElement) {
  let free = false;
  let target: HTMLElement | null = null;
  const release = () => {
    free = true;
    btn.classList.add('show');
  };
  for (const n of ['wheel', 'touchmove'] as const) scroller.addEventListener(n, release, { passive: true });
  scroller.addEventListener('keydown', (e) => {
    if (['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End'].includes(e.key)) release();
  });
  function step(jump: boolean) {
    if (free || !target) return;
    const want = Math.max(0, target.offsetTop - scroller.clientHeight * 0.3);
    const d = want - scroller.scrollTop;
    if (Math.abs(d) < 1) return;
    scroller.scrollTop += jump || reduceMotion() ? d : d * 0.14;
  }
  btn.addEventListener('click', () => {
    free = false;
    btn.classList.remove('show');
    step(true);
  });
  return {
    release,
    follow(el: HTMLElement, jump: boolean) {
      target = el;
      step(jump);
    },
    reset() {
      free = false;
      btn.classList.remove('show');
    },
  };
}

const $ = (id: string): HTMLElement => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing`);
  return el;
};

export class PlayScreen {
  private m: PlayModel | null = null;
  private lookBars = 1;
  private slots: HTMLElement[] = [];
  private barEls: HTMLElement[] = [];
  private secEls: HTMLElement[] = [];
  private last = { bar: -2, up: '', soon: '', line: -2, section: -2, cd: -1, unc: '' };
  private readonly fol;
  private readonly dias = $('dias');
  private readonly lane = $('lane');
  private readonly lyCur = $('ly-cur');
  private readonly seek = $('seek') as HTMLInputElement;
  private readonly scrub = new ScrubState();
  private readonly uncRow = $('unc-row');

  constructor(
    private readonly host: PlayHost,
    private readonly uv: UncertainVariant = 'A',
  ) {
    document.documentElement.dataset.uv = uv;
    this.fol = follower(this.lane, $('follow'));
    // Tap or Enter on a changed chord's "F→Fmaj7" button shows or hides its reason.
    this.uncRow.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-u]');
      if (b) this.host.acceptAlt?.(Number(b.dataset.u));
    });
    this.dias.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('.chg-btn');
      if (!btn) return;
      const li = btn.closest('li');
      const open = !li?.classList.contains('open');
      li?.classList.toggle('open', open);
      btn.setAttribute('aria-expanded', String(open));
    });
    // Variant B: the "또는 Am" chip is its own button; the rest of the bar still only seeks.
    this.lane.addEventListener('keydown', (e) => {
      const chip = (e.target as HTMLElement).closest<HTMLElement>('.unc-chip');
      if (!chip || (e.key !== 'Enter' && e.key !== ' ')) return;
      e.preventDefault();
      e.stopPropagation();
      this.host.acceptAlt?.(Number(chip.dataset.u));
    });
    this.lane.addEventListener('click', (e) => {
      const chip = (e.target as HTMLElement).closest<HTMLElement>('.unc-chip');
      if (chip) {
        e.preventDefault();
        this.host.acceptAlt?.(Number(chip.dataset.u));
        return;
      }
      const b = (e.target as HTMLElement).closest<HTMLElement>('.bar');
      if (!b) return;
      if (this.host.barClick?.(Number(b.dataset.k))) return;
      this.host.seek(Math.max(0, Number(b.dataset.t)) + 0.01);
      this.fol.reset();
    });
    this.seek.addEventListener('input', () => this.host.seek(Number(this.seek.value)));
    // Track an active drag, not focus (a clicked slider keeps focus after release).
    this.seek.addEventListener('pointerdown', () => this.scrub.begin());
    for (const ev of ['pointerup', 'pointercancel'] as const) addEventListener(ev, () => this.scrub.end());
    this.seek.addEventListener('change', () => this.scrub.end());
    this.seek.addEventListener('blur', () => this.scrub.end());
    $('play-btn').addEventListener('click', () => this.host.togglePlay());
    for (const b of document.querySelectorAll<HTMLButtonElement>('#rate-seg [data-rate]')) {
      b.addEventListener('click', () => this.host.setRate?.(Number(b.dataset.rate)));
    }
    addEventListener('resize', () => {
      this.last.line = -2;
    });
    // The fixing panel, lyrics and diagrams resize the lane after it opens: keep the marked bar in view.
    new ResizeObserver(() => this.lane.querySelector('.bar.fix-at')?.scrollIntoView({ block: 'nearest', behavior: 'instant' })).observe(this.lane);
  }

  private showSounding = false;
  private highlighted: string | null = null;

  setSounding(on: boolean): void {
    if (on === this.showSounding) return;
    this.showSounding = on;
    this.setModel(this.m);
  }

  clearHardChord(): void {
    if (this.highlighted !== null) $('hard-chord-status').textContent = '표시를 껐어요';
    this.highlighted = null;
    for (const b of this.barEls) b.classList.remove('hard-hit');
  }

  highlightHardChord(shape: string): void {
    const previous = this.highlighted;
    this.clearHardChord();
    if (!this.m || previous === shape) return;
    this.highlighted = shape;
    const hits = barsForHardChord(this.m, shape);
    $('hard-chord-status').textContent = `${prettyChord(shape)} 마디 ${hits.length}곳을 표시했어요`;
    for (const i of hits) this.barEls[i]?.classList.add('hard-hit');
    this.fol.release();
    const first = this.barEls[hits[0]];
    first?.scrollIntoView({ block: 'center', behavior: 'instant' });
    first?.focus({ preventScroll: true });
  }

  /** Dashed outline on the bar holding `sec` (the chord being fixed); null clears it. */
  markFix(sec: number | null): void {
    const k = sec === null || !this.m ? -1 : this.m.bars.findIndex((b) => sec + 0.001 >= b.startSec && sec + 0.001 < b.endSec);
    this.barEls.forEach((b, i) => b.classList.toggle('fix-at', i === k));
    if (sec === null) this.fol.reset();
    else if (k >= 0) {
      this.fol.release();
      this.barEls[k].scrollIntoView({ block: 'nearest', behavior: 'instant' });
    }
  }

  private loopMarks: LoopMarks = { range: null, picking: null };

  /** Marks the looped bars (A and B tagged) and, while choosing, the A bar; kept across rebuilds. */
  setLoop(marks: LoopMarks): void {
    this.loopMarks = marks;
    this.applyLoop();
  }

  private applyLoop(): void {
    const { range, picking } = this.loopMarks;
    this.lane.classList.toggle('loop-picking', picking !== null);
    this.barEls.forEach((b, i) => {
      const inRange = !!range && i >= range.from && i <= range.to;
      b.classList.toggle('loop', inRange || picking?.a === i);
      b.classList.toggle('loop-a', (inRange && i === range!.from) || picking?.a === i);
      b.classList.toggle('loop-b', inRange && i === range!.to);
    });
  }

  private concert(c: NonNullable<PlayModel['labels'][number]['change']>, includeMerge = true): string {
    return changeConcertLabel(c, this.showSounding, includeMerge);
  }

  get model(): PlayModel | null {
    return this.m;
  }

  setLook(lookAheadBars: number): void {
    this.lookBars = lookAheadBars;
    this.last.soon = 'x';
  }

  setModel(m: PlayModel | null): void {
    this.clearHardChord();
    this.m = m;
    this.last = { bar: -2, up: 'x', soon: 'x', line: -2, section: -2, cd: -1, unc: 'x' };
    for (const id of ['dias-wrap', 'lane-wrap', 'transport']) $(id).hidden = !m;
    // A and C: the second-choice line under the strip keeps its height for the whole song, so the
    // lane does not jump when the playhead enters or leaves a stretch.
    this.uncRow.hidden = !m?.uncertain.length || this.uv === 'B';
    this.uncRow.innerHTML = '';
    $('pin').hidden = !m?.lyrics;
    if (!m) {
      this.dias.innerHTML = '';
      this.lane.innerHTML = '';
      return;
    }
    this.buildStrip(m);
    this.buildLane(m);
    this.applyLoop();
    this.seek.max = String(m.durationSec);
    $('t-dur').textContent = formatTime(m.durationSec);
    $('seek-ticks').innerHTML = m.sections
      .slice(1)
      .map((s) => `<i style="left:${((s.startSec / Math.max(1, m.durationSec)) * 100).toFixed(2)}%"></i>`)
      .join('');
  }

  /** Three fixed slots: the current shape, the next one and the one after it. */
  private buildStrip(m: PlayModel): void {
    // Reserve the tallest diagram of the song so names and the lane below stay put as shapes change.
    const tallest = Math.max(128, ...m.strip.map((it) => (it.event.voicing ? shapeDiagramHeight(it.event.voicing) : 0)));
    this.dias.style.setProperty('--fig-h', String(tallest));
    this.dias.innerHTML = '<li class="empty"></li>'.repeat(3);
    this.slots = [...this.dias.querySelectorAll<HTMLElement>('li')];
  }

  private fillStrip(m: PlayModel, up: number[]): void {
    this.slots.forEach((li, k) => {
      const ev = up[k];
      li.className = ev === undefined ? 'empty' : '';
      if (ev === undefined) {
        li.innerHTML = '<div class="fig"></div>';
        return;
      }
      const e = m.arrangement.events[ev];
      const lab = m.labels[ev];
      const dia = e.voicing ? renderShapeDiagram(e.voicing, 120) : '<div class="nodia">운지 없음</div>';
      const snd = lab.sounding !== lab.name ? `<span class="sd snd">${escapeHtml(lab.sounding)}</span>` : '';
      const ch = lab.change;
      // A changed chord: "F→Fmaj7" button; the reason shows on hover, focus and tap.
      const chg = ch
        ? `<button class="chg-btn${ch.root ? ' root' : ''}" aria-expanded="false" aria-label="${escapeHtml(changeLabel(ch) + (this.concert(ch) ? `. ${this.concert(ch)}` : ''))}">${escapeHtml(ch.badge)}${this.concert(ch) ? `<small class="snd">${escapeHtml(this.concert(ch, false))}</small>` : ''}</button><span class="chg-pop" role="tooltip">${escapeHtml(ch.text)}${this.concert(ch) ? `<small class="snd">${escapeHtml(this.concert(ch))}</small>` : ''}</span>`
        : '';
      li.classList.toggle('changed', !!ch);
      li.classList.toggle('root', !!ch?.root);
      li.innerHTML = `<div class="fig">${dia}</div><span class="nm">${chordHTML(lab.name)}</span>${snd}${chg}<span class="cd" aria-hidden="true"></span>`;
    });
  }

  private segHTML(m: PlayModel, ev: number, weight: number, repeat: boolean, flag = -1): string {
    if (repeat) return `<span class="sg rep" style="flex:${weight} 1 0" title="앞 마디와 같아요">${REPEAT_SVG}</span>`;
    if (ev < 0) return `<span class="sg" style="flex:${weight} 1 0"><span class="cn muted">—</span></span>`;
    const lab = m.labels[ev];
    const snd = lab.sounding !== lab.name ? `<small class="snd">${escapeHtml(lab.sounding)}</small>` : '';
    const alt = lab.hint ? `<small class="alt">${escapeHtml(lab.hint)}</small>` : '';
    const ch = lab.change;
    const mark = ch ? `<i class="chg${ch.root ? ' root' : ''}" aria-hidden="true">${ch.root ? '◆' : '●'}</i>` : '';
    const u = flag >= 0 ? m.uncertain[flag] : undefined;
    const tipText = [ch ? `${ch.badge} · ${ch.text}${this.concert(ch) ? ` · ${this.concert(ch)}` : ''}` : '', u ? uncertainText(u.alt) : ''].filter(Boolean).join(' · ');
    const title = tipText ? ` title="${escapeHtml(tipText)}"` : '';
    let unc = '';
    if (u && this.uv === 'A') unc = '<i class="unc-q" aria-hidden="true">?</i>';
    if (u && this.uv === 'B') unc = `<i class="unc-br" aria-hidden="true"></i><span class="unc-chip" role="button" tabindex="0" data-u="${flag}" aria-label="${escapeHtml(`${withRo(u.alt)} 바꾸기`)}">또는 ${chordHTML(u.alt)}</span>`;
    return `<span class="sg${ch ? ' changed' : ''}${u ? ' unc' : ''}" style="flex:${weight} 1 0"${title}>${chordHTML(lab.name)}${mark}${this.uv === 'B' ? `${alt}${snd}${unc}` : `${unc}${alt}${snd}`}</span>`;
  }

  /** The second-choice line under the strip (A, C) or the "?" on the current card (B). */
  private renderUncertain(m: PlayModel, i: number, onCard: boolean): void {
    const u = i >= 0 && onCard ? m.uncertain[i] : undefined;
    if (this.uv === 'B') {
      const li = this.slots[0];
      li?.querySelector('.unc-q')?.remove();
      if (u && li) li.querySelector('.nm')?.insertAdjacentHTML('beforeend', `<i class="unc-q" title="${escapeHtml(uncertainText(u.alt))}" aria-label="확실하지 않아요">?</i>`);
      return;
    }
    if (!u) {
      this.uncRow.innerHTML = '';
      return;
    }
    const snd = this.showSounding && u.altSounding !== u.alt ? ` <small class="snd">실제 ${escapeHtml(u.altSounding)}</small>` : '';
    this.uncRow.innerHTML = `<span class="unc-line">확실하지 않아요 · 다른 후보 <b>${slashChordHTML(u.alt)}</b>${snd}</span><button class="unc-btn" data-u="${i}">${escapeHtml(withRo(u.alt))} 바꾸기</button>`;
  }

  private buildLane(m: PlayModel): void {
    const n = m.big.bigPerBar;
    const ticks = '<i></i>'.repeat(n);
    const unit = m.big.compound ? '큰 박 하나' : '한 박';
    let h = `<p class="legend"><span class="mini">${'<i></i>'.repeat(Math.min(n, 4))}</span>칸 하나가 1마디, 막대 하나가 ${unit}예요 · ${m.big.label}${m.arrangement.capo > 0 ? ` · 코드 이름은 카포 ${m.arrangement.capo}에서 잡는 모양이에요` : ''}</p>`;
    m.sections.forEach((sec, si) => {
      const end = m.sections[si + 1]?.firstBar ?? m.bars.length;
      if (end <= sec.firstBar) return;
      h += `<div class="sec" data-s="${si}"><h3><span>${escapeHtml(sec.name)}</span><time>${formatTime(m.bars[sec.firstBar].startSec)}</time></h3>`;
      for (let i = sec.firstBar; i < end; i += 4) {
        const row: string[] = [];
        for (let k = i; k < Math.min(end, i + 4); k++) {
          const b = m.bars[k];
          const col = k - i;
          const segs = b.segments.map((s) => this.segHTML(m, s.event, s.weight, b.repeat && col !== 0, s.flag)).join('');
          const aria = b.segments
            .map((s) => {
              if (s.event < 0) return '코드 없음';
              const lab = m.labels[s.event];
              const unc = s.flag >= 0 ? `, ${uncertainText(m.uncertain[s.flag].alt)}` : '';
              return (lab.change ? `${lab.name}, ${changeLabel(lab.change)}${this.concert(lab.change) ? `. ${this.concert(lab.change)}` : ''}` : lab.name) + unc;
            })
            .join(', ');
          const changes = [...new Set(b.segments.filter((s) => s.event >= 0 && m.labels[s.event].change).map((s) => s.event))].map((ev) => m.labels[ev].change!);
          const tip = changes.length ? `<span class="chg-tip" aria-hidden="true">${changes.map((c) => `<b>${escapeHtml(c.badge)}</b> ${escapeHtml(c.text)}${this.concert(c) ? `<small class="snd">${escapeHtml(this.concert(c))}</small>` : ''}`).join('<br>')}</span>` : '';
          row.push(`<button class="bar${changes.length ? ' has-chg' : ''}${b.segments.some((s) => s.flag >= 0) ? ' has-unc' : ''}" data-k="${k}" data-t="${b.startSec.toFixed(3)}" aria-label="${k + 1}마디, ${escapeHtml(aria)}"><span class="segs">${segs}</span><span class="ticks">${ticks}</span><span class="ph"></span>${tip}</button>`);
        }
        h += `<div class="row4">${row.join('')}</div>`;
      }
      h += '</div>';
    });
    this.lane.innerHTML = h;
    this.barEls = [...this.lane.querySelectorAll<HTMLElement>('.bar')];
    this.secEls = [...this.lane.querySelectorAll<HTMLElement>('.sec')];
  }

  private lyricHTML(m: PlayModel, li: number): string {
    const line = m.lyrics!.lines[li];
    const p = m.placed[li];
    const name = (j: number) => (m.labels[j]?.name === 'N.C.' ? '' : slashChordHTML(m.labels[j]?.name ?? ''));
    return line.words
      .map((w, i) => {
        const a = p.anchors[i];
        let c = a !== null ? name(a) : '';
        if (p.fallback && i === 0) c = p.fallback.map(name).filter(Boolean).join(' · ');
        return `<span class="w" data-s="${w.startSec}"><span class="c"${a !== null ? ` data-e="${a}"` : ''}>${c}</span><span class="x">${escapeHtml(w.text)}</span></span>`;
      })
      .join(' ');
  }

  private markLyric(t: number, event: number, active: boolean, wordTimed: boolean): void {
    for (const c of this.lyCur.querySelectorAll<HTMLElement>('.c[data-e]')) {
      const e = Number(c.dataset.e);
      c.classList.toggle('hit', active && e < event);
      c.classList.toggle('live', active && e === event);
    }
    const ws = [...this.lyCur.querySelectorAll<HTMLElement>('.w')];
    let at = -1;
    ws.forEach((w, i) => {
      const on = active && Number(w.dataset.s) <= t;
      w.classList.toggle('on', on);
      if (on) at = i;
    });
    ws.forEach((w, i) => w.classList.toggle('at', wordTimed && i === at));
  }

  private fitLyric(): void {
    const el = this.lyCur;
    let f = 17.5;
    el.style.fontSize = `${f}px`;
    while (el.scrollHeight > el.clientHeight + 1 && f > 12.5) {
      f -= 1;
      el.style.fontSize = `${f}px`;
    }
  }

  render(t: number, playing: boolean, jump: boolean): void {
    const m = this.m;
    const pb = $('play-btn');
    const icon = playing ? ICON_PAUSE : ICON_PLAY;
    if (pb.dataset.icon !== (playing ? 'pause' : 'play')) {
      pb.innerHTML = icon;
      pb.dataset.icon = playing ? 'pause' : 'play';
      pb.setAttribute('aria-label', playing ? '일시 정지' : '재생');
    }
    if (!m) return;
    const f = frameAt(m, t);
    if (this.scrub.shouldSync(jump)) this.seek.value = String(t);
    this.seek.setAttribute('aria-valuetext', formatTime(t));
    $('seek-fill').style.width = `${Math.min(100, (t / Math.max(1, m.durationSec)) * 100)}%`;
    $('t-now').textContent = formatTime(t);

    if (f.bar !== this.last.bar) {
      for (const b of this.barEls) {
        const k = Number(b.dataset.k);
        b.classList.toggle('past', k < f.bar);
        b.classList.toggle('now', k === f.bar);
      }
      this.last.bar = f.bar;
    }
    const sectionChanged = f.section !== this.last.section;
    if (sectionChanged) {
      for (const s of this.secEls) s.classList.toggle('cur', Number(s.dataset.s) === f.section);
      $('sec-now').textContent = m.sections[f.section]?.name ?? '';
      this.last.section = f.section;
    }
    const el = this.barEls[Math.max(0, f.bar)];
    if (el) {
      this.fol.follow(el.parentElement as HTMLElement, jump);
      if (f.bar >= 0) {
        (el.querySelector('.ph') as HTMLElement).style.left = `calc(${f.barFraction * 100}% - 1px)`;
        el.querySelectorAll('.ticks i').forEach((x, i) => x.classList.toggle('on', i <= f.bigInBar));
      }
    }

    const up = upcomingShapes(m, f);
    const upKey = `${f.event}|${up.join(',')}`;
    if (upKey !== this.last.up) {
      this.fillStrip(m, up);
      this.slots[0]?.classList.toggle('now', f.event >= 0 && up[0] === f.event);
      this.last.up = upKey;
      this.last.soon = 'x';
      this.last.cd = -1;
    }
    const onCard = f.event >= 0 && up[0] === f.event;
    const uncKey = `${onCard ? f.uncertain : -1}|${upKey}`;
    if (uncKey !== this.last.unc) {
      this.renderUncertain(m, f.uncertain, onCard);
      this.last.unc = uncKey;
    }
    const lookBig = Math.max(1, Math.round(this.lookBars * m.big.bigPerBar));
    const soon = f.next >= 0 && f.bigLeft > 0 && f.bigLeft <= lookBig;
    const soonKey = soon ? `${f.event}>${f.next}` : '';
    if (soonKey !== this.last.soon) {
      for (const li of this.slots) li.classList.remove('nx');
      for (const b of this.barEls) b.classList.remove('soon');
      if (soon) {
        // The countdown sits on the slot that shows the next event; none when it keeps the same shape.
        const k = up.indexOf(f.next);
        if (k >= 0) this.slots[k].classList.add('nx');
        const nb = m.bars.findIndex((b) => m.arrangement.events[f.next].startSec + 0.05 >= b.startSec && m.arrangement.events[f.next].startSec + 0.05 < b.endSec);
        if (nb >= 0) this.barEls[nb]?.classList.add('soon');
      }
      this.last.soon = soonKey;
    }
    const cd = soon ? f.bigLeft : 0;
    if (cd !== this.last.cd) {
      const nx = this.dias.querySelector<HTMLElement>('li.nx .cd');
      if (nx) nx.textContent = String(cd);
      this.last.cd = cd;
    }

    if (m.lyrics) {
      if (f.line !== this.last.line) {
        $('pin-sec').textContent = m.sections[f.section]?.name ?? '';
        if (f.line >= 0) {
          this.lyCur.innerHTML = this.lyricHTML(m, f.line);
          this.fitLyric();
        } else {
          this.lyCur.innerHTML = '<span class="inst">♪ 연주만 나와요</span>';
          this.lyCur.style.fontSize = '';
        }
        const nl = m.lyrics.lines[f.nextLine];
        $('ly-next').textContent = nl ? `${f.line >= 0 ? '다음' : '곧'} · ${nl.text}` : '';
        this.last.line = f.line;
      } else if (sectionChanged) $('pin-sec').textContent = m.sections[f.section]?.name ?? '';
      if (f.line >= 0) this.markLyric(t, f.event, true, m.lyrics.lines[f.line].wordTimed);
    }
  }

  /** Length of one big beat at playback rate 1 (for the count-in). */
  bigBeatSec(): number {
    return this.m ? bigBeatSeconds(this.m.timing, this.m.big) : 0.5;
  }
}
