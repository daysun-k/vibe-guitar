/**
 * VGT-16 phone page: a chord name in the stand's huge font ("C#m7b5/G#", "Bbmaj7") may be wider than
 * the space beside its diagram. The name is drawn at the CSS size and scaled down until it fits, so
 * the diagram (fixed size, flex:none) always stays fully on screen and the page never gets wider than
 * the viewport. Below FIT_MIN_PX the CSS ellipsis clips the name instead of widening the page.
 * The small slash bass ("/G#", .slash-bass) is em-sized inside the name, so scrollWidth measures it and
 * the fitted size shrinks it with the rest.
 */

/** Smallest font size a fitted chord name gets (px). */
export const FIT_MIN_PX = 16;

/**
 * Font size (px) that makes text measuring `contentPx` at `basePx` fit a box `boxPx` wide: `basePx`
 * when it already fits, never below FIT_MIN_PX (or `basePx`, if that is smaller). Null when the box
 * has no width yet (hidden): measure again once it is shown.
 */
export function fitFontPx(basePx: number, contentPx: number, boxPx: number): number | null {
  if (!(boxPx > 0) || !(basePx > 0)) return null;
  if (contentPx <= boxPx) return basePx;
  return Math.max(Math.min(FIT_MIN_PX, basePx), Math.floor((basePx * boxPx) / contentPx));
}

/** The next chord is drawn at most this fraction of the current chord's size (34vw : 22vw in the CSS). */
export const NEXT_SCALE = 0.65;

/**
 * Fits `el` (white-space:nowrap; overflow:hidden; inside a min-width:0 box) to its own width, at most
 * `capPx`. Returns the font size it got, or null when it could not be measured (not laid out yet), so
 * the caller tries again later.
 */
export function fitText(el: HTMLElement, capPx = Infinity): number | null {
  el.style.fontSize = '';
  const css = parseFloat(getComputedStyle(el).fontSize);
  const base = Math.min(css, capPx);
  if (base < css) el.style.fontSize = `${base}px`;
  const px = fitFontPx(base, el.scrollWidth, el.clientWidth);
  if (px === null) return null;
  if (px >= base) return base;
  // Glyph widths do not scale exactly linearly (hinting, rounding): step down until it fits.
  let size = px;
  for (let i = 0; i < 6; i++, size--) {
    el.style.fontSize = `${size}px`;
    if (el.scrollWidth <= el.clientWidth || size <= FIT_MIN_PX) break;
  }
  return size;
}
