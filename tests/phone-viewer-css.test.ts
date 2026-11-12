/// <reference types="node" />
// VGT-13 phone page: every id and class its CSS targets must exist in the page markup, in a class the
// page script sets, or in the diagram renderer's SVG. A selector that matches nothing (review on
// dc2725c: `.now-dia svg` while the container only had id="now-dia") silently leaves the diagrams at
// the renderer's fixed pixel size.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { renderShapeDiagram } from '../src/extension/sidepanel/diagram';
import { FIT_MIN_PX, fitFontPx } from '../src/phone/fit';
import { AD_TEXT, NO_POSITION_TEXT, beatSegments, statusLine, toggleLook } from '../src/phone/stand';

const html = readFileSync(new URL('../src/phone/viewer.html', import.meta.url), 'utf8');
const script = readFileSync(new URL('../src/phone/viewer.ts', import.meta.url), 'utf8');
const css = /<style>([\s\S]*?)<\/style>/.exec(html)![1]!;
const body = html.slice(html.indexOf('<body'));

/** Selector parts of every rule (declarations and @media headers dropped). */
function selectors(text: string): string[] {
  return [...text.replace(/\{[^{}]*\}/g, '\n').matchAll(/([^\n{}]+)/g)].map((m) => m[1]!.trim()).filter((s) => s && !s.startsWith('@'));
}

describe('phone page CSS', () => {
  const sel = selectors(css).join(' ');
  const ids = new Set([...sel.matchAll(/#([\w-]+)/g)].map((m) => m[1]!));
  const classes = new Set([...sel.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]!));
  // Diagram SVGs as the page draws them: open strings, a mute, a barre and a high position.
  const svg = renderShapeDiagram({ id: 't', chord: 'C', frets: [null, 3, 2, 0, 1, 0], fingers: [null, 3, 2, 0, 1, 0], kind: 'open', origin: 'db' }, 170)
    + renderShapeDiagram({ id: 't', chord: 'B♭', frets: [6, 8, 8, 7, 6, 6], fingers: [1, 3, 4, 2, 1, 1], kind: 'barre', origin: 'db' }, 130);

  it('every targeted id exists in the markup', () => {
    for (const id of ids) expect(body, `#${id}`).toContain(`id="${id}"`);
    expect(ids).toContain('now-dia');
    expect(ids).toContain('next-dia');
  });

  it('every targeted class exists in the markup, the page script or the diagram SVG', () => {
    const markupClasses = new Set([...body.matchAll(/class="([^"]*)"/g)].flatMap((m) => m[1]!.split(/\s+/)));
    // Classes the page script sets: setClass(el, 'x', …), classList.*('x') and class="x" in its HTML strings.
    const scriptClasses = new Set([
      ...[...script.matchAll(/setClass\([^,]+,\s*'([\w-]+)'/g)].map((m) => m[1]!),
      ...[...script.matchAll(/classList\.\w+\('([\w-]+)'/g)].map((m) => m[1]!),
      ...[...script.matchAll(/class="([^"$]*)"/g)].flatMap((m) => m[1]!.split(/\s+/)),
      ...[...script.matchAll(/class=\\?"([\w-]+)/g)].map((m) => m[1]!),
    ]);
    const svgClasses = new Set([...svg.matchAll(/class="([^"]*)"/g)].flatMap((m) => m[1]!.split(/\s+/)));
    for (const c of classes) {
      const used = markupClasses.has(c) || svgClasses.has(c) || scriptClasses.has(c);
      expect(used, `.${c}`).toBe(true);
    }
  });

  it('diagram sizes come from CSS: one side set per container, the other follows the viewBox', () => {
    // portrait: width set, height auto; landscape (short rows): height set, width auto
    expect(css).toMatch(/#now-dia svg\{width:min\([^}]+\);height:auto\}/);
    expect(css).toMatch(/#next-dia svg\{width:min\([^}]+\);height:auto\}/);
    expect(css).toMatch(/#now-dia svg\{width:auto;height:min\([^}]+\)\}/);
    expect(css).toMatch(/#next-dia svg\{width:auto;height:min\([^}]+\)\}/);
    expect(svg).toMatch(/viewBox="0 0 100 \d+"/);
  });
});

/** Declarations of the first rule whose selector is exactly `sel` (in `text`). */
function rule(text: string, sel: string): string {
  const esc = sel.replace(/[.*+?^${}()|[\]\\#>]/g, '\\$&');
  const m = new RegExp(`(?:^|[}\\s])${esc}\\{([^}]*)\\}`).exec(text);
  if (!m) throw new Error(`no rule for ${sel}`);
  return m[1]!;
}

describe('VGT-16 phone page never gets wider than the screen', () => {
  const landscape = /@media \(orientation:landscape\)\{([\s\S]*)\}\s*$/.exec(css)![1]!;
  const portrait = css.slice(0, css.indexOf('@media (orientation:landscape)'));

  it('grid columns are pinned to the viewport (a wide chord name cannot grow a column)', () => {
    // Real-phone report: the single implicit `auto` column grew to the huge "Bm7" and pushed the
    // diagram, the 처음부터 button and the status line past the right edge.
    expect(rule(portrait, '.stand')).toContain('grid-template-columns:minmax(0,1fr)');
    // current chord, its bar card, next chord, buttons (no header row: no capo or bar text)
    expect(rule(portrait, '.stand')).toMatch(/grid-template-rows:minmax\(0,1fr\) auto minmax\(0,1fr\) auto/);
    expect(rule(landscape, '.stand')).toMatch(/grid-template-columns:minmax\(0,[\d.]+fr\) minmax\(0,[\d.]+fr\)/);
    expect(rule(portrait, '.stand>*')).toContain('min-width:0');
  });

  it('the chord name shrinks beside its fixed-size diagram and never pushes it out', () => {
    expect(rule(portrait, '.names')).toMatch(/flex:1 1 0;min-width:0/);
    expect(rule(landscape, '.names')).toContain('flex:0 1 auto');
    expect(rule(portrait, '.dia')).toContain('flex:none');
    const chord = rule(portrait, '.chord');
    for (const d of ['white-space:nowrap', 'overflow:hidden', 'text-overflow:ellipsis', 'max-width:100%']) expect(chord).toContain(d);
    expect(body).toMatch(/<div class="names"><div id="now-name" class="chord">/);
    expect(body).toMatch(/<div class="names">\s*<div class="lbl">다음<\/div>\s*<div id="next-name" class="chord">/);
    // The page script fits both names after a change and after a resize or rotation.
    expect(script).toContain("const nowPx = fitText($('now-name'));");
    expect(script).toContain("fitText($('next-name'), Math.round(nowPx * NEXT_SCALE))");
    expect(script).toMatch(/addEventListener\('resize', \(\) => \(fitDirty = true\)\)/);
  });

  it('the one status line is a single line cut with an ellipsis, and hidden while empty', () => {
    const r = rule(portrait, '.status');
    for (const d of ['min-width:0', 'white-space:nowrap', 'overflow:hidden', 'text-overflow:ellipsis']) expect(r, `.status ${d}`).toContain(d);
    expect(rule(portrait, '.status:empty')).toBe('display:none');
    expect(rule(portrait, '.snd')).toContain('overflow-wrap:anywhere');
    expect(rule(landscape, '.status')).toMatch(/flex:1 1 \d+px/);
    // Above the buttons: a message shown or gone grows the footer upward, the buttons stay put.
    expect(body.indexOf('id="status"')).toBeLessThan(body.indexOf('id="ctl"'));
  });

  it('four icon buttons in one row of shrinkable grid columns, at least 56 px tall', () => {
    for (const id of ['ctl-prev', 'ctl-toggle', 'ctl-next', 'ctl-restart']) expect(body).toContain(`id="${id}"`);
    expect(rule(portrait, '.ctl')).toMatch(/grid-template-columns:minmax\(0,[\d.]+fr\) minmax\(0,[\d.]+fr\) minmax\(0,[\d.]+fr\) minmax\(0,[\d.]+fr\)/);
    expect(rule(portrait, '.ctl')).toContain('grid-template-areas:"restart prev toggle next"');
    expect(rule(landscape, '.ctl')).toMatch(/min-width:0;grid-template-columns:repeat\(4,minmax\(0,auto\)\)/);
    const b = rule(portrait, '.ctl button');
    expect(b).toContain('min-width:0');
    expect(Number(/min-height:(\d+)px/.exec(b)![1])).toBeGreaterThanOrEqual(56);
    expect(Number(/min-height:(\d+)px/.exec(rule(landscape, '.ctl button'))![1])).toBeGreaterThanOrEqual(56);
    // Each button sends its own command.
    expect(script).toContain("$('ctl-prev').addEventListener('click', () => sendCommand('prev-bar'))");
    expect(script).toContain("$('ctl-next').addEventListener('click', () => sendCommand('next-bar'))");
    expect(script).toContain("$('ctl-restart').addEventListener('click', () => sendCommand('restart'))");
    expect(script).toContain("$('ctl-toggle').addEventListener('click', () => sendCommand('toggle'))");
  });
});

/** The markup of the button with id `id`. */
function button(id: string): string {
  const m = new RegExp(`<button id="${id}"[^>]*>([\\s\\S]*?)</button>`).exec(body);
  if (!m) throw new Error(`no button ${id}`);
  return m[0];
}

describe('minimal phone stand (real-iPhone feedback on PR #19)', () => {
  it('shows no auto-lock notice, capo, bar number, beat countdown text, beat dots or connection text', () => {
    for (const gone of ['id="lock"', 'lock-ok', '자동 잠금', 'id="capo"', 'id="where"', 'id="dots"', 'id="count"', 'id="ctl-msg"', 'class="rule"']) expect(html, gone).not.toContain(gone);
    for (const gone of ['localStorage', '박 뒤에 바뀜', '카포 ', '모양`', '마디\'', 'Mac과 연결됨', "'lock'", 'view.title']) expect(script, gone).not.toContain(gone);
  });

  it('icon-only buttons: each has a Korean aria-label and title, an inline SVG and no visible text', () => {
    const labels: Record<string, string> = { 'ctl-prev': '이전 마디', 'ctl-toggle': '재생', 'ctl-next': '다음 마디', 'ctl-restart': '처음부터' };
    for (const [id, label] of Object.entries(labels)) {
      const b = button(id);
      expect(b, id).toContain(`aria-label="${label}"`);
      expect(b, id).toContain(`title="${label}"`);
      expect(b, id).toMatch(/<svg [^>]*aria-hidden="true"/);
      expect(b.replace(/<[^>]*>/g, '').trim(), `${id} text`).toBe('');
    }
    // Play and pause icons are both in the toggle; the page shows one by the 'pause' class.
    expect(button('ctl-toggle')).toContain('class="i-play"');
    expect(button('ctl-toggle')).toContain('class="i-pause"');
    expect(css).toContain('#ctl-toggle .i-pause,#ctl-toggle.pause .i-play{display:none}');
    expect(css).toContain('#ctl-toggle.pause .i-pause{display:block}');
    expect(script).toContain("setClass(toggle, 'pause', look.pause)");
    expect(script).toContain("toggle.setAttribute('aria-label', look.label)");
  });

  it('play/pause shows what a tap does: pause while playing or counting in, play otherwise', () => {
    expect(toggleLook(false, false)).toEqual({ pause: false, label: '재생' });
    expect(toggleLook(true, false)).toEqual({ pause: true, label: '일시정지' });
    expect(toggleLook(false, true)).toEqual({ pause: true, label: '일시정지' });
  });

  it('the bar card: one segment per big beat, filled up to the beat under the playhead', () => {
    expect(beatSegments(4, 3, 0)).toEqual({ total: 4, filled: 1 });
    expect(beatSegments(4, 3, 2)).toEqual({ total: 4, filled: 3 });
    expect(beatSegments(4, 3, 3)).toEqual({ total: 4, filled: 4 });
    expect(beatSegments(4, 3, 9)).toEqual({ total: 4, filled: 4 });
    expect(beatSegments(2, 0, 1)).toEqual({ total: 2, filled: 2 }); // 6/8: two big beats
    expect(beatSegments(3, 0, 0)).toEqual({ total: 3, filled: 1 });
    expect(beatSegments(4, -1, 0)).toEqual({ total: 4, filled: 0 }); // outside every bar
    expect(beatSegments(0, 0, 0).total).toBe(1);
    // The card is in the markup between the current and the next chord; its parts are styled.
    expect(body).toMatch(/<section class="now"[\s\S]*<div id="meter" class="meter"[\s\S]*<section class="nx"/);
    expect(rule(css, '.ticks i.on')).toContain('background:var(--accent)');
    expect(rule(css, '.ph')).toMatch(/position:absolute;top:0;bottom:0/);
    expect(script).toContain('beatSegments(s.big.bigPerBar, f.bar, f.bigInBar)');
    expect(script).toContain('drawMeter(seg.total, seg.filled, f.bar, f.barFraction)');
  });

  it('the status line is hidden while all is well and shown only when something needs attention', () => {
    const quiet = { text: '', alert: false };
    const ok = { ready: true, live: true, ad: false, message: quiet };
    expect(statusLine(ok)).toBeNull(); // connected and playing or paused: no title, no "Mac과 연결됨"
    expect(statusLine({ ...ok, live: false })).toEqual({ text: NO_POSITION_TEXT, alert: false });
    expect(statusLine({ ...ok, ad: true })).toEqual({ text: AD_TEXT, alert: true });
    const failed = { text: '마지막 마디예요 · 더 갈 마디가 없어요', alert: true };
    expect(statusLine({ ...ok, message: failed })).toEqual(failed);
    expect(statusLine({ ...ok, ad: true, message: failed })).toEqual(failed); // the newest word wins
    // Not ready (connecting, reconnecting, panel off, no song): the waiting screen says it instead.
    expect(statusLine({ ...ok, ready: false, ad: true, message: failed })).toBeNull();
    // Successes are not said; failures and the count-in are, for a few seconds.
    expect(script).not.toContain('재생했어요');
    expect(script).not.toContain('다음 마디로 옮겼어요');
    expect(script).toContain('카운트인 뒤에 재생해요');
    expect(script).toContain("'Mac과 연결이 끊겼어요 · 다시 연결하는 중'");
    expect(script).toMatch(/if \(message\.text && t > message\.until\) message = \{ text: '', alert: false, until: 0 \};/);
  });
});

describe('fitFontPx', () => {
  it('keeps the CSS size when the name fits', () => {
    expect(fitFontPx(132, 120, 166)).toBe(132);
    expect(fitFontPx(132, 166, 166)).toBe(132);
  });
  it('scales a wider name down to the box', () => {
    expect(fitFontPx(132, 264, 166)).toBe(83);
    expect(fitFontPx(132, 736, 166)).toBe(29);
  });
  it('never below the minimum (the ellipsis clips then), nor above the CSS size', () => {
    expect(fitFontPx(132, 100_000, 166)).toBe(FIT_MIN_PX);
    expect(fitFontPx(12, 100, 50)).toBe(12);
  });
  it('null while the box has no width (hidden): measured again later', () => {
    expect(fitFontPx(132, 200, 0)).toBeNull();
    expect(fitFontPx(0, 200, 100)).toBeNull();
  });
});
