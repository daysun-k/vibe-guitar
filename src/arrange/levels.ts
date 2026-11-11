/** Skill levels (proposal section 5) and the personal profile. */

export type Level = 'beginner' | 'novice' | 'intermediate' | 'advanced';
export const LEVELS: readonly Level[] = ['beginner', 'novice', 'intermediate', 'advanced'];

export interface LevelConfig {
  level: Level;
  /** Keep 7th/6th chords (novice+: "7th 허용"). */
  allowSevenths: boolean;
  /** Keep 9/11/13 extensions and every add-tone. */
  allowExtensions: boolean;
  /** Keep add9 (and so 6/9) even without extensions (novice: LCM Grade 4 Cadd9, Gadd9, Fadd9). */
  allowAddNine: boolean;
  /** Keep altered tones (b9, #9, #11, b13). */
  allowAlterations: boolean;
  /** Slash bass: kept only when it forms a bass line, or always. */
  slashPolicy: 'structural' | 'always';
  /** Full barre shapes are part of the level's vocabulary. */
  barreAllowed: boolean;
  /** Multiplier for harmonic-substitution penalties (higher = stick to the original). */
  substitutionWeight: number;
  /** Multiplier for static shape difficulty. */
  difficultyWeight: number;
  /** Chords shorter than this many beats are merged into the previous chord. */
  minChordBeats: number;
  /** Extra cost of a partial barre (one finger across some strings, e.g. F#m xx4222). */
  partialBarreCost: number;
  /** Extra cost of a shape from the 5th fret up (plus 0.5 per fret beyond the 5th). */
  highPositionCost: number;
}

export const LEVEL_CONFIGS: Record<Level, LevelConfig> = {
  beginner: {
    level: 'beginner',
    allowSevenths: false,
    allowExtensions: false,
    allowAddNine: false,
    allowAlterations: false,
    slashPolicy: 'structural',
    barreAllowed: false,
    substitutionWeight: 1,
    difficultyWeight: 1.6,
    minChordBeats: 2,
    // Kept below one substitution unit (4): a partial barre alone must not turn a faithful F
    // into a flagged Fmaj7; it only steers shape and capo choice.
    partialBarreCost: 2,
    highPositionCost: 2,
  },
  novice: {
    level: 'novice',
    allowSevenths: true,
    allowExtensions: false,
    allowAddNine: true,
    allowAlterations: false,
    slashPolicy: 'structural',
    barreAllowed: false,
    substitutionWeight: 1.5,
    difficultyWeight: 1.3,
    minChordBeats: 1,
    partialBarreCost: 0,
    highPositionCost: 0,
  },
  intermediate: {
    level: 'intermediate',
    allowSevenths: true,
    allowExtensions: true,
    allowAddNine: true,
    allowAlterations: false,
    slashPolicy: 'always',
    barreAllowed: true,
    substitutionWeight: 3,
    difficultyWeight: 1,
    minChordBeats: 0.5,
    partialBarreCost: 0,
    highPositionCost: 0,
  },
  advanced: {
    level: 'advanced',
    allowSevenths: true,
    allowExtensions: true,
    allowAddNine: true,
    allowAlterations: true,
    slashPolicy: 'always',
    barreAllowed: true,
    substitutionWeight: 5,
    difficultyWeight: 0.6,
    minChordBeats: 0,
    partialBarreCost: 0,
    highPositionCost: 0,
  },
};

export interface Profile {
  /** Voicing ids the player can already grab. Empty = unknown (no bonus/penalty). */
  knownShapes: string[];
  canBarre: boolean;
  /** Max fret distance between the lowest and highest fretted note. */
  maxStretch: number;
  changeSpeed: 'slow' | 'normal' | 'fast';
  capoMin: number;
  capoMax: number;
}

export const DEFAULT_PROFILE: Profile = {
  knownShapes: [],
  canBarre: false,
  maxStretch: 3,
  changeSpeed: 'normal',
  capoMin: 0,
  capoMax: 7,
};
