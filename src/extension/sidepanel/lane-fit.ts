/**
 * Lane chord names wider than their cell ("Fmaj7" in a half bar at 400 px, "G♯m/F♯" in a quarter) are
 * drawn smaller, down to LANE_FIT_MIN_PX; below that the CSS ellipsis ends the name. Same rule as the
 * phone stand's names (src/phone/fit.ts). Only the drawn size changes: the text, the bar's aria-label
 * and the shape strip keep the full name. Batched (one read pass, one write pass, then a few 1 px steps
 * for names that still overflow, as glyph widths do not scale exactly linearly), so a long song costs a
 * handful of layouts rather than one per cell.
 */
import { fitFontPx } from '../../phone/fit';

/** Smallest font size a fitted lane name gets (px); the CSS size is 20 px (19 px at 340 px and below). */
export const LANE_FIT_MIN_PX = 14;

/** Overflow under this many px is not visible and gets no change (glyph edges, rounding). */
const SLACK_PX = 0.5;

/** Drawn width of a name's text, also past its box (a Range ignores the box and the ellipsis). */
function textWidth(el: HTMLElement): number {
  const r = document.createRange();
  r.selectNodeContents(el);
  return r.getBoundingClientRect().width;
}

/** Fits every lane name to its cell; a hidden lane (no width) is left alone and fitted once shown. */
export function fitLaneNames(lane: HTMLElement): void {
  const els = [...lane.querySelectorAll<HTMLElement>('.sg .cn')];
  for (const el of els) {
    el.style.fontSize = '';
    el.classList.remove('cut');
  }
  if (!els.length || lane.clientWidth === 0) return;
  const base = parseFloat(getComputedStyle(els[0]!).fontSize);
  const over = (el: HTMLElement) => textWidth(el) - el.getBoundingClientRect().width;
  let todo: { el: HTMLElement; px: number }[] = [];
  for (const el of els) {
    const px = fitFontPx(base, textWidth(el), el.getBoundingClientRect().width + SLACK_PX, LANE_FIT_MIN_PX);
    if (px !== null && px < base) todo.push({ el, px });
  }
  const fitted = todo.map((t) => t.el);
  for (let round = 0; todo.length && round < 6; round++) {
    for (const t of todo) t.el.style.fontSize = `${t.px}px`;
    todo = todo.filter((t) => t.px > LANE_FIT_MIN_PX && over(t.el) > SLACK_PX).map((t) => ({ el: t.el, px: t.px - 1 }));
  }
  // Still too wide at the minimum: the ellipsis shows the name goes on.
  for (const el of fitted.filter((e) => over(e) > SLACK_PX)) el.classList.add('cut');
}
