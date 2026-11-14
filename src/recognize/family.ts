/**
 * Recognizer symbols and their C1 chord families (VGT-18), shared by the extension (uncertain-section
 * flags, docs/uncertainty-protocol.md) and the offline candidate decoders (candidate-decode.ts
 * re-exports these, so its imports and behaviour are unchanged).
 */

/** Pitch class of a sharp-spelled root. */
export const PC: Readonly<Record<string, number>> = { C: 0, 'C#': 1, D: 2, 'D#': 3, E: 4, F: 5, 'F#': 6, G: 7, 'G#': 8, A: 9, 'A#': 10, B: 11 };
export const SHARP_ROOTS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** Root pitch class and quality suffix of a recognizer symbol ("C#m7" → 1, "m7"); null for N. */
export function splitSymbol(symbol: string): { root: number; suffix: string } | null {
  if (symbol === 'N') return null;
  const m = /^([A-G]#?)(.*)$/.exec(symbol);
  if (!m || PC[m[1]] === undefined) throw new Error(`candidate decode: unexpected symbol ${symbol}`);
  return { root: PC[m[1]], suffix: m[2] };
}

const MAJOR_FAMILY = ['', '7', 'maj7'];
const MINOR_FAMILY = ['m', 'm7'];

/**
 * Family key of a symbol (C1): "<pc>:maj" for maj / 7 / maj7, "<pc>:min" for min / m7, "N" for N;
 * any other quality (sus2, sus4, dim, aug, m7b5, and the full vocabulary's 6, m6, m(maj7), dim7)
 * stays its own class, keyed by the symbol itself.
 */
export function familyOf(symbol: string): string {
  const s = splitSymbol(symbol);
  if (!s) return 'N';
  if (MAJOR_FAMILY.includes(s.suffix)) return `${s.root}:maj`;
  if (MINOR_FAMILY.includes(s.suffix)) return `${s.root}:min`;
  return symbol;
}

/** A representative chart symbol of a family key (for the key prior and the majmin model's names). */
export function familySymbol(family: string): string {
  const m = /^(\d+):(maj|min)$/.exec(family);
  if (!m) return family;
  return `${SHARP_ROOTS[Number(m[1])]}${m[2] === 'min' ? 'm' : ''}`;
}
