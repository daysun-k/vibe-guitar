/** Skill levels (proposal section 5) and the personal profile. */

export type Level = 'beginner' | 'novice' | 'intermediate' | 'advanced';
export const LEVELS: readonly Level[] = ['beginner', 'novice', 'intermediate', 'advanced'];

export interface LevelConfig {
  level: Level;
  /** Keep 7th/6th chords (novice+: "7th 허용"). */
  allowSevenths: boolean;
  /** Keep 9/11/13 extensions and add-tones. */
  allowExtensions: boolean;
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
}

export const LEVEL_CONFIGS: Record<Level, LevelConfig> = {
  beginner: {
    level: 'beginner',
    allowSevenths: false,
    allowExtensions: false,
    allowAlterations: false,
    slashPolicy: 'structural',
    barreAllowed: false,
    substitutionWeight: 1,
    difficultyWeight: 1.6,
    minChordBeats: 2,
  },
  novice: {
    level: 'novice',
    allowSevenths: true,
    allowExtensions: false,
    allowAlterations: false,
    slashPolicy: 'structural',
    barreAllowed: false,
    substitutionWeight: 1.5,
    difficultyWeight: 1.3,
    minChordBeats: 1,
  },
  intermediate: {
    level: 'intermediate',
    allowSevenths: true,
    allowExtensions: true,
    allowAlterations: false,
    slashPolicy: 'always',
    barreAllowed: true,
    substitutionWeight: 3,
    difficultyWeight: 1,
    minChordBeats: 0.5,
  },
  advanced: {
    level: 'advanced',
    allowSevenths: true,
    allowExtensions: true,
    allowAlterations: true,
    slashPolicy: 'always',
    barreAllowed: true,
    substitutionWeight: 5,
    difficultyWeight: 0.6,
    minChordBeats: 0,
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
