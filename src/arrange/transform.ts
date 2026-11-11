/**
 * Harmonic transformations. These change the sounding chord and are therefore
 * shown with a "substitution" badge — unlike voicing changes, which keep the
 * chord and only pick an easier shape (handled by voicing selection).
 */
import { formatChord, withChanges, type Chord } from './chord';
import type { LevelConfig } from './levels';
import { mod12 } from './notes';

export type SubstitutionReason =
  | 'level-simplify' // mandatory reduction for the level (Cmaj7 → C at beginner)
  | 'easier-sound-alike' // optional, chosen by cost (F → Fmaj7, Bm → Bm7)
  | 'drop-slash'
  | 'drop-sus'
  | 'fallback'; // no playable voicing for the requested chord

export interface Substitution {
  chord: Chord;
  /** Penalty units (multiplied by level.substitutionWeight and PENALTY.substitution). */
  weight: number;
  reason: SubstitutionReason;
}

/** Context of a chord inside the song, used for context-aware simplification. */
export interface ChordContext {
  prev: Chord | null;
  next: Chord | null;
}

function bassOf(c: Chord): number {
  return c.bass ?? c.root;
}

function stepDistance(a: number, b: number): number {
  const d = mod12(a - b);
  return Math.min(d, 12 - d);
}

/** The slash bass is part of a bass line (step-wise motion or a pedal). */
export function isStructuralSlash(c: Chord, ctx: ChordContext): boolean {
  if (c.bass === null) return false;
  const neighbours = [ctx.prev, ctx.next].filter((x): x is Chord => x !== null);
  return neighbours.some((n) => {
    const d = stepDistance(bassOf(n), c.bass!);
    if (d === 1 || d === 2) return true;
    return d === 0 && n.root !== c.root; // pedal bass under a different chord
  });
}

/** The sus chord resolves to (or comes from) the same-root chord. */
export function isStructuralSus(c: Chord, ctx: ChordContext): boolean {
  if (c.triad !== 'sus2' && c.triad !== 'sus4') return false;
  return [ctx.prev, ctx.next].some((n) => n !== null && n.root === c.root && n.triad !== c.triad);
}

export interface Reduction {
  chord: Chord;
  /** Human-readable steps, e.g. "drop 9", "drop slash bass". */
  steps: string[];
  changed: boolean;
}

/** Mandatory, level-driven simplification of a chord (context-aware for slash bass). */
export function reduceForLevel(original: Chord, level: LevelConfig, ctx: ChordContext): Reduction {
  let c = withChanges(original, {});
  const steps: string[] = [];

  if (!level.allowAlterations && c.alterations.length) {
    steps.push(`drop ${c.alterations.join(',')}`);
    c = withChanges(c, { alterations: [] });
  }
  if (!level.allowExtensions) {
    if (c.extension !== null) {
      steps.push(`drop ${c.extension}`);
      c = withChanges(c, { extension: null });
    }
    // Novice keeps add9 (Cadd9, and the 9 of a 6/9) but no other add-tone.
    const dropped = c.adds.filter((a) => !(level.allowAddNine && a === 9));
    if (dropped.length) {
      steps.push(`drop add${dropped.join(',')}`);
      c = withChanges(c, { adds: c.adds.filter((a) => !dropped.includes(a)) });
    }
  }
  if (!level.allowSevenths && c.seventh !== 'none') {
    steps.push(`drop ${c.seventh === '6' ? '6' : '7th'}`);
    c = withChanges(c, { seventh: 'none' });
  }
  if (c.bass !== null && level.slashPolicy === 'structural' && !isStructuralSlash(original, ctx)) {
    steps.push('drop slash bass');
    c = withChanges(c, { bass: null, bassName: null });
  }
  return { chord: c, steps, changed: steps.length > 0 };
}

/** Optional alternatives for a (reduced) chord, each with a penalty weight. */
export function substitutionCandidates(c: Chord, ctx: ChordContext, original: Chord): Substitution[] {
  const out: Substitution[] = [];
  const push = (chord: Chord, weight: number, reason: SubstitutionReason): void => {
    if (out.some((s) => formatChord(s.chord) === formatChord(chord))) return;
    out.push({ chord, weight, reason });
  };
  const plain = c.extension === null && c.adds.length === 0 && c.alterations.length === 0;

  if (plain && c.seventh === 'none' && c.bass === null) {
    // A dominant 7th reduced to its triad must not come back as a major 7th (G7 -> Gmaj7 clashes).
    if (c.triad === 'maj' && original.seventh !== 'b7') push(withChanges(c, { seventh: 'maj7' }), 1, 'easier-sound-alike');
    if (c.triad === 'min') push(withChanges(c, { seventh: 'b7' }), 1, 'easier-sound-alike');
    if (c.triad === 'maj') push(withChanges(c, { triad: 'sus2' }), 1.4, 'easier-sound-alike');
  }
  if (c.extension !== null || c.adds.length || c.alterations.length) {
    push(withChanges(c, { extension: null, adds: [], alterations: [] }), 0.8, 'fallback');
  }
  if (c.seventh !== 'none') {
    const triad = c.triad === 'dim' && c.seventh === 'b7' ? 'min' : c.triad;
    push(withChanges(c, { seventh: 'none', extension: null, adds: [], alterations: [], triad }), 1, 'fallback');
  }
  if (c.triad === 'sus2' || c.triad === 'sus4') {
    const structural = isStructuralSus(original, ctx);
    push(withChanges(c, { triad: 'maj' }), structural ? 3 : 1.2, 'drop-sus');
  }
  if (c.bass !== null) {
    const structural = isStructuralSlash(original, ctx);
    push(withChanges(c, { bass: null, bassName: null }), structural ? 3 : 1, 'drop-slash');
  }
  if (c.triad === 'aug' || c.triad === 'dim') {
    push(withChanges(c, { triad: c.triad === 'aug' ? 'maj' : 'min', seventh: 'none', extension: null, adds: [], alterations: [] }), 2, 'fallback');
  }
  // Last resort: bare major/minor triad on the root.
  const core = withChanges(c, {
    triad: c.triad === 'min' || c.triad === 'dim' ? 'min' : 'maj',
    seventh: 'none',
    extension: null,
    adds: [],
    alterations: [],
    bass: null,
    bassName: null,
  });
  push(core, 2.5, 'fallback');
  return out.filter((s) => formatChord(s.chord) !== formatChord(c));
}
