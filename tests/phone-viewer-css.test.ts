/// <reference types="node" />
// VGT-13 phone page: every id and class its CSS targets must exist in the page markup, in a class the
// page script sets, or in the diagram renderer's SVG. A selector that matches nothing (review on
// dc2725c: `.now-dia svg` while the container only had id="now-dia") silently leaves the diagrams at
// the renderer's fixed pixel size.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { renderShapeDiagram } from '../src/extension/sidepanel/diagram';

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
