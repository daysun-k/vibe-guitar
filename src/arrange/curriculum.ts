/**
 * Level vocabulary: which fingerings belong to which arrangement level, and why.
 *
 * Every hand-listed (RAW) voicing has an explicit minimum level and a basis: a teaching
 * source below, or "product" (a product judgment, with a short reason). Template shapes and
 * derived slash voicings get their level from documented rules (see `voicingLevel`).
 * The level mapping and the quotes are explained for the owner in docs/level-vocabulary.md.
 */
import { fretString, type Voicing } from './guitar';
import { LEVELS, type Level } from './levels';
import { voicingById } from './voicings';

/** Bump when a level assignment or rule changes (cached suitability results carry it). */
export const VOCAB_VERSION = 1;

export type SourceId = 'lcm' | 'trinity' | 'kyobo' | 'asome' | 'wiki-sub';

export interface Source {
  title: string;
  url: string;
  accessed: string;
  /** What the engine takes from it. */
  use: string;
}

export const SOURCES: Record<SourceId, Source> = {
  lcm: {
    title:
      'London College of Music Exams (University of West London), Acoustic Guitar Technical Requirements and Discussion Questions for Recorded Graded Exams',
    url: 'https://lcme.uwl.ac.uk/media/veraprda/technical-requirements-and-discussion-questions-acoustic-guitar.pdf',
    accessed: '2026-11-11',
    use:
      'Step 1: C, G, Am. Step 2: D, C, Em, Am, G. Grade 1: A, E, C; Dm, Am; B7, D7. Grade 2: F, E, Dm7, Em7, Amaj7, Cmaj7, G7. ' +
      'Grade 3: Asus2, Esus4, Csus4, Dsus2, F, Dmaj7, C7, Gmaj7. Grade 4: A6, D6, E6, Cadd9, Gadd9, Fadd9, two of Esus4/Fsus4/Gsus4/Csus4. ' +
      'Grade 5: major and minor barre chords. Grade 6: 7th, maj7 and m7 barre chords. Grade 7: positions, inversions, diminished 7th. Grade 8: more positions and inversions.',
  },
  trinity: {
    title: 'Trinity College London, Rock & Pop Guitar syllabus, graded exams from 2018',
    url: 'https://www.trinitycollege.com/resource?id=7899',
    accessed: '2026-11-11',
    use:
      'Initial "Simple keys and chords, two-note power chords"; Grade 1 "As Initial"; Grade 2 "Wider range of keys and chords"; ' +
      'Grade 3 "introducing three-note power chords, half/partial barre chords, occasional use of full barre chords"; ' +
      'Grade 4 "more regular use of full barre chords"; Grade 5 "Any key".',
  },
  kyobo: {
    title: '「왕초보 통기타교본」 목차 (교보문고 eBook)',
    url: 'https://ebook-product.kyobobook.co.kr/dig/epd/sam/E000005206696',
    accessed: '2026-11-11',
    use: 'Each root taught as X, X7, Xm, Xm7 in open and barre forms; change drills C-F-G7-C, D-G-A7-D, E-A-B7-E, F-Bb-C7-F.',
  },
  asome: {
    title: 'asomemusic, F코드 쉽게 잡는 법 (기타 초보 탈출을 위한 첫걸음)',
    url: 'https://asomemusic.com/f%EC%BD%94%EB%93%9C-%EC%89%BD%EA%B2%8C-%EC%9E%A1%EB%8A%94%EB%B2%95-%EA%B8%B0%ED%83%80-%EC%B4%88%EB%B3%B4-%ED%83%88%EC%B6%9C%EC%9D%84-%EC%9C%84%ED%95%9C-%EC%B2%AB%EA%B1%B8%EC%9D%8C/',
    accessed: '2026-11-11',
    use: '"F코드가 너무 어렵다면, F코드에 익숙해질 때까지 비슷한 느낌을 내는 FM7 코드로 대체해 연주할 수 있습니다." Not when the original is F7.',
  },
  'wiki-sub': {
    title: 'Wikipedia, Chord substitution',
    url: 'https://en.wikipedia.org/wiki/Chord_substitution',
    accessed: '2026-11-11',
    use:
      '"The relative major/minor substitution shares two common tones" (citing DuBrock, Acoustic Guitar, April 2009, pp. 80-82); ' +
      'the musician judges whether a substitution works with the melody.',
  },
};

export type Basis = SourceId | 'product';

export interface VocabEntry {
  level: Level;
  basis: Basis;
  /** Where in the source, or why (for a product judgment). */
  note: string;
}

const e = (level: Level, basis: Basis, note: string): VocabEntry => ({ level, basis, note });

const BEGINNER_KEEPS = 'beginner already keeps this easy open shape (PR #7); no source names it at this level';
const FRETTED_BASS = 'adds a fretted bass note to an open shape; slash chords come mid-way in Trinity session skills';
const OPEN_BASS = 'the open-string bass adds no finger to a beginner shape';

/**
 * Explicit level per hand-listed voicing, keyed "<chord> <frets>". A test fails when a RAW row
 * has no entry, so a new row needs a decision here.
 */
export const RAW_LEVELS: Record<string, VocabEntry> = {
  // C family
  'C x32010': e('beginner', 'lcm', 'Step 1: C'),
  'Cmaj7 x32000': e('beginner', 'product', `${BEGINNER_KEEPS}; LCM names Cmaj7 at Grade 2`),
  'C7 x32310': e('novice', 'lcm', 'Grade 3: C7'),
  'Cadd9 x32033': e('novice', 'lcm', 'Grade 4: Cadd9'),
  'Cmaj9 x30000': e('intermediate', 'product', '9th extension: the chord type is kept from intermediate only'),
  'Csus2 x30013': e('novice', 'lcm', 'Grade 3: sus2 chords (Asus2, Dsus2)'),
  'Csus4 x33011': e('novice', 'lcm', 'Grade 3: Csus4'),
  'Caug x32110': e('advanced', 'trinity', 'session skills: augmented chords come last'),
  'C/G 332010': e('novice', 'product', FRETTED_BASS),
  'C/E 032010': e('beginner', 'product', OPEN_BASS),
  'C/B x22010': e('novice', 'product', FRETTED_BASS),
  // D family
  'D xx0232': e('beginner', 'lcm', 'Step 2: D'),
  'Dm xx0231': e('beginner', 'lcm', 'Grade 1: Dm'),
  'D7 xx0212': e('beginner', 'lcm', 'Grade 1: D7'),
  'Dm7 xx0211': e('novice', 'lcm', 'Grade 2: Dm7'),
  'Dmaj7 xx0222': e('novice', 'lcm', 'Grade 3: Dmaj7'),
  'Dsus2 xx0230': e('novice', 'lcm', 'Grade 3: Dsus2'),
  'Dsus4 xx0233': e('novice', 'product', 'sus4 chords appear at LCM Grades 3-4 (Esus4, Csus4); Dsus4 is not named'),
  'D7sus4 xx0213': e('novice', 'product', '7th plus sus4: both families start at novice'),
  'D/F# 200232': e('novice', 'product', FRETTED_BASS),
  'D/A x00232': e('beginner', 'product', OPEN_BASS),
  'Ddim7 xx0101': e('advanced', 'lcm', 'Grade 7: diminished 7th'),
  // E family
  'E 022100': e('beginner', 'lcm', 'Grade 1: E'),
  'Em 022000': e('beginner', 'lcm', 'Step 2: Em'),
  'E7 020100': e('beginner', 'product', BEGINNER_KEEPS),
  'Em7 022030': e('beginner', 'product', `${BEGINNER_KEEPS}; LCM names Em7 at Grade 2`),
  'Em9 022032': e('intermediate', 'product', '9th extension: the chord type is kept from intermediate only'),
  'Esus4 022200': e('novice', 'lcm', 'Grade 3: Esus4'),
  'E7sus4 020200': e('novice', 'product', '7th plus sus4: both families start at novice'),
  'E5 022xxx': e('beginner', 'trinity', 'Initial: two-note power chords'),
  // F family
  'F xx3211': e('novice', 'lcm', 'Grade 2: F (partial barre; Trinity Grade 3 introduces partial barres)'),
  'Fmaj7 xx3210': e('beginner', 'asome', 'FM7 is the suggested beginner stand-in for F; also kept by the beginner level (PR #7)'),
  'Fsus2 xx3011': e('novice', 'product', 'index finger across two strings: a partial barre (Trinity Grade 3)'),
  'Fm xx3111': e('novice', 'trinity', 'Grade 3: half/partial barre chords'),
  'F#m xx4222': e('novice', 'trinity', 'Grade 3: half/partial barre chords'),
  // G family
  'G 320003': e('beginner', 'lcm', 'Step 1: G'),
  'G 320033': e('beginner', 'lcm', 'Step 1: G'),
  'G7 320001': e('novice', 'lcm', 'Grade 2: G7'),
  'Gmaj7 320002': e('novice', 'lcm', 'Grade 3: Gmaj7'),
  'G6 320000': e('novice', 'product', 'added 6th chords: LCM Grade 4 (A6, D6, E6)'),
  'Gsus4 330013': e('novice', 'lcm', 'Grade 4: Gsus4'),
  'G/B x20003': e('novice', 'product', FRETTED_BASS),
  'Gm xx5333': e('novice', 'trinity', 'Grade 3: half/partial barre chords'),
  // A family
  'A x02220': e('beginner', 'lcm', 'Grade 1: A'),
  'Am x02210': e('beginner', 'lcm', 'Step 1: Am'),
  'A7 x02020': e('beginner', 'product', BEGINNER_KEEPS),
  'Am7 x02010': e('beginner', 'product', BEGINNER_KEEPS),
  'Amaj7 x02120': e('novice', 'lcm', 'Grade 2: Amaj7'),
  'Asus2 x02200': e('novice', 'lcm', 'Grade 3: Asus2'),
  'Asus4 x02230': e('novice', 'product', 'sus4 chords appear at LCM Grades 3-4; Asus4 is not named'),
  'A7sus4 x02030': e('novice', 'product', '7th plus sus4: both families start at novice'),
  'A/C# x42220': e('novice', 'product', `${FRETTED_BASS}; the index finger also lies across three strings`),
  'Am/G 302210': e('novice', 'product', FRETTED_BASS),
  'Am/E 002210': e('beginner', 'product', OPEN_BASS),
  'A5 x022xx': e('beginner', 'trinity', 'Initial: two-note power chords'),
  // B family
  'B7 x21202': e('beginner', 'lcm', 'Grade 1: B7 (an exception: four fingers)'),
  'Bm7 x20202': e('beginner', 'product', BEGINNER_KEEPS),
  'Bm xx4432': e('novice', 'product', 'closed four-finger shape at the 4th fret, not a barre; LCM puts the barre Bm at Grade 5'),
  'B xx4442': e('novice', 'product', 'closed four-finger shape at the 4th fret, not a barre; LCM puts the barre B at Grade 5'),
  'Bb xx3331': e('novice', 'trinity', 'Grade 3: half/partial barre chords'),
  'C#m xx6654': e('novice', 'product', 'the closed Bm shape moved to the 6th fret; not a barre'),
  'F#m7 2x2220': e('beginner', 'product', `${BEGINNER_KEEPS} (no barre)`),
  'F#7 xx4320': e('beginner', 'product', 'three fingers and no barre, added for beginners in PR #7; like B7 (LCM Grade 1)'),
};

export type VocabRule = 'raw' | 'template-barre' | 'template-power' | 'template-advanced' | 'template-closed' | 'derived-slash';

export interface VoicingVocab extends VocabEntry {
  rule: VocabRule;
}

const ADVANCED_TEMPLATES = new Set(['dim', 'dim7', 'aug', 'm7b5', '9', 'm9']);

export function rawKey(v: Pick<Voicing, 'chord' | 'frets'>): string {
  return `${v.chord} ${fretString(v.frets)}`;
}

export function levelRank(l: Level): number {
  return LEVELS.indexOf(l);
}

function maxLevel(a: Level, b: Level): Level {
  return levelRank(a) >= levelRank(b) ? a : b;
}

const memo = new Map<string, VoicingVocab | null>();

/**
 * Minimum level of a fingering, with its basis. Rules:
 * - a hand-listed voicing: its explicit RAW_LEVELS entry;
 * - a template with a full barre (E/A shapes): intermediate (LCM Grades 5-6, Trinity Grades 3-4);
 * - a three-note movable power chord: novice (Trinity Grade 3);
 * - movable dim, dim7, aug, m7b5, 9 and m9 shapes: advanced (LCM Grade 7, Trinity's last session skills);
 * - any other movable closed shape: intermediate (product judgment);
 * - a derived slash voicing: its base voicing's level, and at least novice when the bass is fretted.
 * Returns null for an unknown voicing (a hand-listed row without an entry).
 */
export function voicingLevel(v: Voicing): VoicingVocab | null {
  const hit = memo.get(v.id);
  if (hit !== undefined) return hit;
  const out = computeLevel(v);
  memo.set(v.id, out);
  return out;
}

function computeLevel(v: Voicing): VoicingVocab | null {
  if (v.origin === 'db') {
    const entry = RAW_LEVELS[rawKey(v)];
    return entry ? { ...entry, rule: 'raw' } : null;
  }
  if (v.origin === 'template') {
    const m = /^tpl:[EA](.*)@\d+$/.exec(v.id);
    const suffix = m ? (m[1] === 'maj' ? '' : m[1]) : '';
    if (ADVANCED_TEMPLATES.has(suffix)) return { level: 'advanced', basis: 'lcm', note: 'movable diminished/augmented/9th shapes: LCM Grade 7 and up', rule: 'template-advanced' };
    if (suffix === '5') return { level: 'novice', basis: 'trinity', note: 'Grade 3: three-note power chords', rule: 'template-power' };
    if (v.kind === 'barre') return { level: 'intermediate', basis: 'lcm', note: 'Grades 5-6: full barre chords (Trinity Grades 3-4)', rule: 'template-barre' };
    return { level: 'intermediate', basis: 'product', note: 'movable closed four-finger shape away from open strings', rule: 'template-closed' };
  }
  // derived slash voicing: "slash:<base id>><string>:<fret>"
  const m = /^slash:(.*)>(\d):(\d+)$/.exec(v.id);
  const base = m ? voicingById(m[1]) : undefined;
  const baseLevel = base ? voicingLevel(base) : null;
  if (!m || !baseLevel) return null;
  const fretted = Number(m[3]) > 0;
  const level = fretted ? maxLevel(baseLevel.level, 'novice') : baseLevel.level;
  return { level, basis: baseLevel.basis, note: `slash bass on ${baseLevel.note}${fretted ? '; fretted bass: at least novice' : ''}`, rule: 'derived-slash' };
}

/** The voicing belongs to the level's vocabulary (cumulative: lower levels' shapes included). */
export function inLevel(v: Voicing, level: Level): boolean {
  const vl = voicingLevel(v);
  return vl !== null && levelRank(vl.level) <= levelRank(level);
}
