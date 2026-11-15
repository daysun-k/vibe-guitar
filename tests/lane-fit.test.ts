/**
 * Lane names wider than their cell are drawn smaller down to LANE_FIT_MIN_PX, then the CSS ellipsis
 * ends them (candidate 1 for clipped lane names, e.g. "Fmaj7" drawn as "Fmaj" at 400 px).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LANE_FIT_MIN_PX } from '../src/extension/sidepanel/lane-fit';
import { FIT_MIN_PX, fitFontPx } from '../src/phone/fit';

const css = readFileSync(new URL('../src/extension/static/sidepanel.css', import.meta.url), 'utf8');

describe('lane name fit', () => {
  it('shrinks a name a little too wide for its cell (Fmaj7 at 400 px: 41.9 px of text in 40 px)', () => {
    expect(fitFontPx(20, 41.9, 40, LANE_FIT_MIN_PX)).toBe(19);
  });
  it('stops at the lane minimum, not the phone one', () => {
    expect(fitFontPx(20, 120, 11, LANE_FIT_MIN_PX)).toBe(LANE_FIT_MIN_PX);
    expect(fitFontPx(132, 100_000, 166)).toBe(FIT_MIN_PX);
  });
  it('takes its cell before the marks, and ends with an ellipsis only below the minimum', () => {
    const rule = /\.sg \.cn\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(rule).toContain('flex:none;max-width:100%;overflow:hidden');
    expect(rule).not.toContain('ellipsis'); // only a name still too wide at the minimum gets it
    expect(css).toContain('.sg .cn.cut{text-overflow:ellipsis}');
  });
});
