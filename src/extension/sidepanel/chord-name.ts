/**
 * Display-only split of a slash chord name: "C♯m7♭5/G♯" → head "C♯m7♭5", bass "/G♯". The bass part is
 * drawn smaller (side panel and phone stand) so long names fit; the chord data, comparisons, exports
 * and screen-reader text keep the full plain name. Pure string code: the phone page uses it too.
 */
import { escapeHtml } from './diagram';

export interface SlashParts {
  /** Root and quality ("C♯m7♭5"); the whole name when there is no slash bass. */
  head: string;
  /** "/" + bass note with its accidental ("/G♯", "/Bb"), or '' when the name has no slash bass. */
  bass: string;
}

// Only a trailing "/<note>" is a bass: "C6/9" and "N.C." stay whole.
const SLASH_BASS = /^(.*[^/\s])(\/[A-G][#b♯♭]?)$/;

export function splitSlashBass(name: string): SlashParts {
  const m = SLASH_BASS.exec(name);
  return m ? { head: m[1]!, bass: m[2]! } : { head: name, bass: '' };
}

/** Escaped HTML of the small bass part, '' when there is none (its text is exactly `bass`). */
export function bassHTML(bass: string): string {
  return bass ? `<span class="slash-bass">${escapeHtml(bass)}</span>` : '';
}

/**
 * Escaped HTML of a whole chord name with the slash bass in a smaller span. Its text content is the
 * name unchanged, so screen readers and copy/paste still get "C♯m7♭5/G♯".
 */
export function slashChordHTML(name: string): string {
  const { head, bass } = splitSlashBass(name);
  return escapeHtml(head) + bassHTML(bass);
}
