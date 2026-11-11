/**
 * Play view (mockup B "진행표형"): chord-shape strip, pinned lyric line, bar-grid lane and
 * transport. Built once per PlayModel; `render(t)` runs every animation frame and only
 * touches the DOM when something changed.
 */
import { bigBeatSeconds } from '../../music/meter';
import { frameAt, upcomingShapes, type PlayModel } from '../../play/model';
import { escapeHtml, renderShapeDiagram, shapeDiagramHeight } from './diagram';
import { ScrubState } from './scrub';

export interface PlayHost {
  seek(sec: number): void;
  togglePlay(): void;
  setRate?(rate: number): void;
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

/** Chord name with small accidental / quality and an optional superscript 7. */
export function chordHTML(name: string, had7 = false): string {
  if (!name || name === 'N.C.' || name === '—') return '<span class="cn">—</span>';
  const m = /^([A-G])([♭♯]?)(.*)$/.exec(name);
  if (!m) return `<span class="cn">${escapeHtml(name)}</span>`;
  const sup = had7 ? '<sup class="h7" title="원곡은 7화음, 입문에서는 줄였어요">7</sup>' : '';
  return `<span class="cn">${m[1]}${m[2] ? `<span class="acc">${m[2]}</span>` : ''}${m[3] ? `<span class="q">${escapeHtml(m[3])}</span>` : ''}${sup}</span>`;
}

/** Screen-reader text of a change: "원래 코드 F, 바뀐 코드 Fmaj7. <reason>" (no particle after a chord name). */
export function changeLabel(c: { from: string; to: string; text: string; root: boolean }): string {
  return `원래 코드 ${c.from}, 바뀐 코드 ${c.to}${c.root ? '(근음 바뀜)' : ''}. ${c.text}`;
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
  private last = { bar: -2, up: '', soon: '', line: -2, section: -2, cd: -1 };
  private readonly fol;
  private readonly dias = $('dias');
  private readonly lane = $('lane');
  private readonly lyCur = $('ly-cur');
  private readonly seek = $('seek') as HTMLInputElement;
  private readonly scrub = new ScrubState();

  constructor(private readonly host: PlayHost) {
    this.fol = follower(this.lane, $('follow'));
    // Tap or Enter on a changed chord's "F→Fmaj7" button shows or hides its reason.
    this.dias.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('.chg-btn');
      if (!btn) return;
      const li = btn.closest('li');
      const open = !li?.classList.contains('open');
      li?.classList.toggle('open', open);
      btn.setAttribute('aria-expanded', String(open));
    });
    this.lane.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('.bar');
      if (!b) return;
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
      b.addEventListener('click', () => {
        for (const x of document.querySelectorAll('#rate-seg [data-rate]')) x.setAttribute('aria-pressed', String(x === b));
        this.host.setRate?.(Number(b.dataset.rate));
      });
    }
    addEventListener('resize', () => {
      this.last.line = -2;
    });
  }

  get model(): PlayModel | null {
    return this.m;
  }

  setLook(lookAheadBars: number): void {
    this.lookBars = lookAheadBars;
    this.last.soon = 'x';
  }

  setModel(m: PlayModel | null): void {
    this.m = m;
    this.last = { bar: -2, up: 'x', soon: 'x', line: -2, section: -2, cd: -1 };
    for (const id of ['dias-wrap', 'lane-wrap', 'transport']) $(id).hidden = !m;
    $('pin').hidden = !m?.lyrics;
    if (!m) {
      this.dias.innerHTML = '';
      this.lane.innerHTML = '';
      return;
    }
    this.buildStrip(m);
    this.buildLane(m);
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
        ? `<button class="chg-btn${ch.root ? ' root' : ''}" aria-expanded="false" aria-label="${escapeHtml(changeLabel(ch))}">${escapeHtml(ch.from)}→${escapeHtml(ch.to)}</button><span class="chg-pop" role="tooltip">${escapeHtml(ch.text)}</span>`
        : '';
      li.classList.toggle('changed', !!ch);
      li.classList.toggle('root', !!ch?.root);
      li.innerHTML = `<div class="fig">${dia}</div><span class="nm">${chordHTML(lab.name)}</span>${snd}${chg}<span class="cd" aria-hidden="true"></span>`;
    });
  }

  private segHTML(m: PlayModel, ev: number, weight: number, repeat: boolean): string {
    if (repeat) return `<span class="sg rep" style="flex:${weight} 1 0" title="앞 마디와 같아요">${REPEAT_SVG}</span>`;
    if (ev < 0) return `<span class="sg" style="flex:${weight} 1 0"><span class="cn muted">—</span></span>`;
    const lab = m.labels[ev];
    const snd = lab.sounding !== lab.name ? `<small class="snd">${escapeHtml(lab.sounding)}</small>` : '';
    const alt = lab.hint ? `<small class="alt">${escapeHtml(lab.hint)}</small>` : '';
    const ch = lab.change;
    const mark = ch ? `<i class="chg${ch.root ? ' root' : ''}" aria-hidden="true">${ch.root ? '◆' : '●'}</i>` : '';
    const title = ch ? ` title="${escapeHtml(`${ch.from} → ${ch.to} · ${ch.text}`)}"` : '';
    return `<span class="sg${ch ? ' changed' : ''}" style="flex:${weight} 1 0"${title}>${chordHTML(lab.name, lab.had7)}${mark}${alt}${snd}</span>`;
  }

  private buildLane(m: PlayModel): void {
    const n = m.big.bigPerBar;
    const ticks = '<i></i>'.repeat(n);
    const unit = m.big.compound ? '큰 박 하나' : '한 박';
    let h = `<p class="legend"><span class="mini">${'<i></i>'.repeat(Math.min(n, 4))}</span>칸 하나가 1마디, 막대 하나가 ${unit}예요 · ${m.big.label}</p>`;
    m.sections.forEach((sec, si) => {
      const end = m.sections[si + 1]?.firstBar ?? m.bars.length;
      if (end <= sec.firstBar) return;
      h += `<div class="sec" data-s="${si}"><h3><span>${escapeHtml(sec.name)}</span><time>${formatTime(m.bars[sec.firstBar].startSec)}</time></h3>`;
      for (let i = sec.firstBar; i < end; i += 4) {
        const row: string[] = [];
        for (let k = i; k < Math.min(end, i + 4); k++) {
          const b = m.bars[k];
          const col = k - i;
          const segs = b.segments.map((s) => this.segHTML(m, s.event, s.weight, b.repeat && col !== 0)).join('');
          const aria = b.segments
            .map((s) => {
              if (s.event < 0) return '코드 없음';
              const lab = m.labels[s.event];
              return lab.change ? `${lab.name}, ${changeLabel(lab.change)}` : lab.name;
            })
            .join(', ');
          const changes = [...new Set(b.segments.filter((s) => s.event >= 0 && m.labels[s.event].change).map((s) => s.event))].map((ev) => m.labels[ev].change!);
          const tip = changes.length ? `<span class="chg-tip" aria-hidden="true">${changes.map((c) => `<b>${escapeHtml(c.from)} → ${escapeHtml(c.to)}</b> ${escapeHtml(c.text)}`).join('<br>')}</span>` : '';
          row.push(`<button class="bar${changes.length ? ' has-chg' : ''}" data-k="${k}" data-t="${b.startSec.toFixed(3)}" aria-label="${k + 1}마디, ${escapeHtml(aria)}"><span class="segs">${segs}</span><span class="ticks">${ticks}</span><span class="ph"></span>${tip}</button>`);
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
    const name = (j: number) => (m.labels[j]?.name === 'N.C.' ? '' : escapeHtml(m.labels[j]?.name ?? ''));
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
