/// <reference types="node" />
// VGT-13 phone page: every id and class its CSS targets must exist in the page markup, in a class the
// page script sets, or in the diagram renderer's SVG. A selector that matches nothing (review on
// dc2725c: `.now-dia svg` while the container only had id="now-dia") silently leaves the diagrams at
// the renderer's fixed pixel size.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { renderShapeDiagram } from '../src/extension/sidepanel/diagram';
import { FIT_MIN_PX, fitFontPx } from '../src/phone/fit';

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
    expect(rule(portrait, '.stand')).toMatch(/grid-template-rows:auto minmax\(0,1fr\) auto minmax\(0,1fr\) auto/);
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

  it('long status, position and messages are cut with an ellipsis or wrap', () => {
    for (const sel of ['.status', '.where']) {
      const r = rule(portrait, sel);
      for (const d of ['min-width:0', 'white-space:nowrap', 'overflow:hidden', 'text-overflow:ellipsis']) expect(r, `${sel} ${d}`).toContain(d);
    }
    expect(rule(portrait, '.ctl-msg')).toContain('overflow-wrap:anywhere');
    expect(rule(portrait, '.snd')).toContain('overflow-wrap:anywhere');
    expect(rule(landscape, '.status')).toMatch(/flex:1 1 \d+px/);
  });

  it('four control buttons in shrinkable grid columns; their labels wrap instead of widening the page', () => {
    for (const id of ['ctl-prev', 'ctl-toggle', 'ctl-next', 'ctl-restart']) expect(body).toContain(`id="${id}"`);
    expect(rule(portrait, '.ctl')).toMatch(/grid-template-columns:minmax\(0,[\d.]+fr\) minmax\(0,[\d.]+fr\) minmax\(0,[\d.]+fr\)/);
    expect(rule(portrait, '.ctl')).toContain('"prev toggle next" "restart restart restart"');
    expect(rule(landscape, '.ctl')).toMatch(/min-width:0;grid-template-columns:repeat\(4,minmax\(0,auto\)\)/);
    const b = rule(portrait, '.ctl button');
    for (const d of ['min-width:0', 'word-break:keep-all', 'overflow-wrap:anywhere']) expect(b).toContain(d);
    // Each button sends its own command.
    expect(script).toContain("$('ctl-prev').addEventListener('click', () => sendCommand('prev-bar'))");
    expect(script).toContain("$('ctl-next').addEventListener('click', () => sendCommand('next-bar'))");
    expect(script).toContain("$('ctl-restart').addEventListener('click', () => sendCommand('restart'))");
    expect(script).toContain("$('ctl-toggle').addEventListener('click', () => sendCommand('toggle'))");
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
