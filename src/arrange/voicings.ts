/**
 * Voicing database: hand-listed open and small shapes, movable barre/closed
 * templates (E-shape root on 6th string, A-shape root on 5th string), and
 * slash-bass variants derived on demand. Every entry is checked by tests against
 * its chord name via pitch classes.
 */
import { chordKey, parseChord, qualityKey, type Chord } from './chord';
import {
  STANDARD_TUNING,
  fretString,
  matchVoicing,
  parseFingers,
  parseFrets,
  voicingBassPc,
  type Finger,
  type Fret,
  type Voicing,
  type VoicingKind,
} from './guitar';
import { mod12, spellPitchClass } from './notes';

interface RawVoicing {
  chord: string;
  frets: string;
  fingers: string;
  kind: Extract<VoicingKind, 'open' | 'small'>;
}

/** Strings are listed low E → high e. */
const RAW: RawVoicing[] = [
  // C family
  { chord: 'C', frets: 'x32010', fingers: 'x32010', kind: 'open' },
  { chord: 'Cmaj7', frets: 'x32000', fingers: 'x32000', kind: 'open' },
  { chord: 'C7', frets: 'x32310', fingers: 'x32410', kind: 'open' },
  { chord: 'Cadd9', frets: 'x32033', fingers: 'x21034', kind: 'open' },
  { chord: 'Cmaj9', frets: 'x30000', fingers: 'x30000', kind: 'open' },
  { chord: 'Csus2', frets: 'x30013', fingers: 'x30014', kind: 'open' },
  { chord: 'Csus4', frets: 'x33011', fingers: 'x34011', kind: 'open' },
  { chord: 'Caug', frets: 'x32110', fingers: 'x43120', kind: 'open' },
  { chord: 'C/G', frets: '332010', fingers: '342010', kind: 'open' },
  { chord: 'C/E', frets: '032010', fingers: '032010', kind: 'open' },
  { chord: 'C/B', frets: 'x22010', fingers: 'x23010', kind: 'open' },
  // D family
  { chord: 'D', frets: 'xx0232', fingers: 'xx0132', kind: 'open' },
  { chord: 'Dm', frets: 'xx0231', fingers: 'xx0231', kind: 'open' },
  { chord: 'D7', frets: 'xx0212', fingers: 'xx0213', kind: 'open' },
  { chord: 'Dm7', frets: 'xx0211', fingers: 'xx0211', kind: 'open' },
  { chord: 'Dmaj7', frets: 'xx0222', fingers: 'xx0111', kind: 'open' },
  { chord: 'Dsus2', frets: 'xx0230', fingers: 'xx0130', kind: 'open' },
  { chord: 'Dsus4', frets: 'xx0233', fingers: 'xx0134', kind: 'open' },
  { chord: 'D7sus4', frets: 'xx0213', fingers: 'xx0214', kind: 'open' },
  { chord: 'D/F#', frets: '200232', fingers: '100243', kind: 'open' },
  { chord: 'D/A', frets: 'x00232', fingers: 'x00132', kind: 'open' },
  { chord: 'Ddim7', frets: 'xx0101', fingers: 'xx0102', kind: 'open' },
  // E family
  { chord: 'E', frets: '022100', fingers: '023100', kind: 'open' },
  { chord: 'Em', frets: '022000', fingers: '023000', kind: 'open' },
  { chord: 'E7', frets: '020100', fingers: '020100', kind: 'open' },
  { chord: 'Em7', frets: '022030', fingers: '012030', kind: 'open' },
  { chord: 'Em9', frets: '022032', fingers: '012043', kind: 'open' },
  { chord: 'Esus4', frets: '022200', fingers: '023400', kind: 'open' },
  { chord: 'E7sus4', frets: '020200', fingers: '020300', kind: 'open' },
  { chord: 'E5', frets: '022xxx', fingers: '012xxx', kind: 'open' },
  // F family (small shapes avoid the full barre)
  { chord: 'F', frets: 'xx3211', fingers: 'xx3211', kind: 'small' },
  { chord: 'Fmaj7', frets: 'xx3210', fingers: 'xx3210', kind: 'small' },
  { chord: 'Fsus2', frets: 'xx3011', fingers: 'xx3011', kind: 'small' },
  { chord: 'Fm', frets: 'xx3111', fingers: 'xx3111', kind: 'small' },
  { chord: 'F#m', frets: 'xx4222', fingers: 'xx3111', kind: 'small' },
  // G family
  { chord: 'G', frets: '320003', fingers: '210003', kind: 'open' },
  { chord: 'G', frets: '320033', fingers: '210034', kind: 'open' },
  { chord: 'G7', frets: '320001', fingers: '320001', kind: 'open' },
  { chord: 'Gmaj7', frets: '320002', fingers: '320001', kind: 'open' },
  { chord: 'G6', frets: '320000', fingers: '320000', kind: 'open' },
  { chord: 'Gsus4', frets: '330013', fingers: '230014', kind: 'open' },
  { chord: 'G/B', frets: 'x20003', fingers: 'x10003', kind: 'open' },
  { chord: 'Gm', frets: 'xx5333', fingers: 'xx3111', kind: 'small' },
  // A family
  { chord: 'A', frets: 'x02220', fingers: 'x01230', kind: 'open' },
  { chord: 'Am', frets: 'x02210', fingers: 'x02310', kind: 'open' },
  { chord: 'A7', frets: 'x02020', fingers: 'x02030', kind: 'open' },
  { chord: 'Am7', frets: 'x02010', fingers: 'x02010', kind: 'open' },
  { chord: 'Amaj7', frets: 'x02120', fingers: 'x02130', kind: 'open' },
  { chord: 'Asus2', frets: 'x02200', fingers: 'x01200', kind: 'open' },
  { chord: 'Asus4', frets: 'x02230', fingers: 'x01230', kind: 'open' },
  { chord: 'A7sus4', frets: 'x02030', fingers: 'x02030', kind: 'open' },
  { chord: 'A/C#', frets: 'x42220', fingers: 'x31110', kind: 'open' },
  { chord: 'Am/G', frets: '302210', fingers: '402310', kind: 'open' },
  { chord: 'Am/E', frets: '002210', fingers: '002310', kind: 'open' },
  { chord: 'A5', frets: 'x022xx', fingers: 'x012xx', kind: 'open' },
  // B family
  { chord: 'B7', frets: 'x21202', fingers: 'x21304', kind: 'open' },
  { chord: 'Bm7', frets: 'x20202', fingers: 'x20304', kind: 'open' },
  { chord: 'Bm', frets: 'xx4432', fingers: 'xx3421', kind: 'small' },
  { chord: 'B', frets: 'xx4442', fingers: 'xx2341', kind: 'small' },
  { chord: 'Bb', frets: 'xx3331', fingers: 'xx3331', kind: 'small' },
  { chord: 'C#m', frets: 'xx6654', fingers: 'xx3421', kind: 'small' },
  // Append new shapes here: an id carries the row index, and saved "known shapes" refer to ids.
  { chord: 'F#m7', frets: '2x2220', fingers: '1x2340', kind: 'open' },
  { chord: 'F#7', frets: 'xx4320', fingers: 'xx3210', kind: 'small' },
];

/** The hand-listed rows as voicings, in row order (ids carry the row index). */
export function rawVoicings(): Voicing[] {
  return RAW.map((r, i) => rawToVoicing(r, i));
}

interface Template {
  name: string;
  /** Chord suffix, appended to the root name. */
  suffix: string;
  rootString: 0 | 1;
  /** Offsets relative to the root fret (null = muted). */
  offsets: (number | null)[];
  fingers: Finger[];
  kind: Extract<VoicingKind, 'barre' | 'movable'>;
}

const T = (
  name: string,
  suffix: string,
  rootString: 0 | 1,
  offsets: string,
  fingers: string,
  kind: Template['kind'] = 'barre',
): Template => ({
  name,
  suffix,
  rootString,
  offsets: offsets.split(',').map((x) => (x === 'x' ? null : Number(x))),
  fingers: parseFingers(fingers),
  kind,
});

const TEMPLATES: Template[] = [
  // E-shape: root on the 6th string
  T('E', '', 0, '0,2,2,1,0,0', '134211'),
  T('E', 'm', 0, '0,2,2,0,0,0', '134111'),
  T('E', '7', 0, '0,2,0,1,0,0', '131211'),
  T('E', 'm7', 0, '0,2,0,0,0,0', '131111'),
  T('E', 'maj7', 0, '0,x,1,1,0,x', '1x342x', 'movable'), // 1x221x for F (no 5th string)
  T('E', 'sus4', 0, '0,2,2,2,0,0', '123411'),
  T('E', '7sus4', 0, '0,2,0,2,0,0', '131411'),
  T('E', '5', 0, '0,2,2,x,x,x', '134xxx', 'movable'),
  // A-shape: root on the 5th string
  T('A', '', 1, 'x,0,2,2,2,0', 'x13331'),
  T('A', 'm', 1, 'x,0,2,2,1,0', 'x13421'),
  T('A', '7', 1, 'x,0,2,0,2,0', 'x13141'),
  T('A', 'm7', 1, 'x,0,2,0,1,0', 'x13121'),
  T('A', 'maj7', 1, 'x,0,2,1,2,0', 'x13241'),
  T('A', 'sus2', 1, 'x,0,2,2,0,0', 'x13411'),
  T('A', 'sus4', 1, 'x,0,2,2,3,0', 'x12341'),
  T('A', '7sus4', 1, 'x,0,2,0,3,0', 'x13141'),
  T('A', '6', 1, 'x,0,2,2,2,2', 'x13333'),
  T('A', '5', 1, 'x,0,2,2,x,x', 'x134xx', 'movable'),
  // closed movable shapes without a barre
  T('A', 'm7b5', 1, 'x,0,1,0,1,x', 'x1324x', 'movable'),
  T('A', 'dim', 1, 'x,0,1,2,1,x', 'x1243x', 'movable'),
  T('A', 'dim7', 1, 'x,0,1,-1,1,x', 'x2314x', 'movable'),
  T('A', 'aug', 1, 'x,0,-1,-2,-2,x', 'x3211x', 'movable'),
  T('A', '9', 1, 'x,0,-1,0,0,0', 'x21333', 'movable'),
  T('A', 'm9', 1, 'x,0,-2,0,0,x', 'x2134x', 'movable'),
];

const MAX_FRET = 14;

function rawToVoicing(r: RawVoicing, index: number): Voicing {
  return {
    id: `db:${r.chord}:${r.frets}:${index}`,
    chord: r.chord,
    frets: parseFrets(r.frets),
    fingers: parseFingers(r.fingers),
    kind: r.kind,
    origin: 'db',
  };
}

function templateVoicings(t: Template): Voicing[] {
  const out: Voicing[] = [];
  const openPc = mod12(STANDARD_TUNING[t.rootString]);
  for (let rootFret = 1; rootFret <= 12; rootFret++) {
    const frets: Fret[] = t.offsets.map((o) => (o === null ? null : rootFret + o));
    if (frets.some((f) => f !== null && (f < 1 || f > MAX_FRET))) continue;
    const rootName = spellPitchClass(openPc + rootFret, t.suffix.startsWith('m') && !t.suffix.startsWith('maj') ? 'guitar-minor' : 'guitar-major');
    const chord = rootName + t.suffix;
    out.push({
      id: `tpl:${t.name}${t.suffix || 'maj'}@${rootFret}`,
      chord,
      frets,
      fingers: [...t.fingers],
      kind: t.kind,
      origin: 'template',
    });
  }
  return out;
}

let cachedAll: Voicing[] | null = null;
let cachedIndex: Map<string, Voicing[]> | null = null;

/** All database voicings (explicit + every template position). */
export function allVoicings(): Voicing[] {
  if (!cachedAll) {
    const seen = new Set<string>();
    cachedAll = [];
    const push = (v: Voicing): void => {
      const key = `${v.chord}|${fretString(v.frets)}`;
      if (seen.has(key)) return;
      seen.add(key);
      cachedAll!.push(v);
    };
    RAW.forEach((r, i) => push(rawToVoicing(r, i)));
    for (const t of TEMPLATES) templateVoicings(t).forEach(push);
  }
  return cachedAll;
}

let cachedById: Map<string, Voicing> | null = null;

/** A database voicing (explicit or template) by id. */
export function voicingById(id: string): Voicing | undefined {
  if (!cachedById) cachedById = new Map(allVoicings().map((v) => [v.id, v]));
  return cachedById.get(id);
}

function index(): Map<string, Voicing[]> {
  if (!cachedIndex) {
    cachedIndex = new Map();
    for (const v of allVoicings()) {
      const key = chordKey(parseChord(v.chord));
      const list = cachedIndex.get(key) ?? [];
      list.push(v);
      cachedIndex.set(key, list);
    }
  }
  return cachedIndex;
}

/** Voicings for a chord (shape space, i.e. relative to the capo). Includes derived slash voicings. */
export function voicingsForChord(chord: Chord): Voicing[] {
  const direct = index().get(chordKey(chord)) ?? [];
  if (chord.bass === null) return direct;
  const base = index().get(chordKey({ ...chord, bass: null, bassName: null })) ?? [];
  const derived: Voicing[] = [];
  const seen = new Set(direct.map((v) => fretString(v.frets)));
  for (const v of base) {
    for (const d of deriveSlashVoicings(v, chord)) {
      const k = fretString(d.frets);
      if (seen.has(k)) continue;
      seen.add(k);
      derived.push(d);
    }
  }
  return [...direct, ...derived];
}

export function hasQualityShapes(chord: Chord): boolean {
  const q = qualityKey(chord);
  return allVoicings().some((v) => qualityKey(parseChord(v.chord)) === q);
}

/**
 * Put the slash bass on a lower (or the lowest) string of an existing voicing,
 * muting everything below it. Results are validated with matchVoicing.
 */
export function deriveSlashVoicings(v: Voicing, slashChord: Chord): Voicing[] {
  const bass = slashChord.bass;
  if (bass === null) return [];
  const out: Voicing[] = [];
  const fretted = v.frets.filter((f): f is number => f !== null && f > 0);
  const lo = fretted.length ? Math.min(...fretted) : 0;
  const hi = fretted.length ? Math.max(...fretted) : 0;
  // Bass only on the three lowest strings (a G-string bass sounds like an inversion, not a bass line).
  for (let s = 0; s <= 2; s++) {
    const candidates: number[] = [];
    for (let f = 0; f <= MAX_FRET; f++) {
      if (mod12(STANDARD_TUNING[s] + f) !== bass) continue;
      if (f === 0 || (f >= Math.max(1, lo - 1) && f <= Math.max(hi, lo) + 1 && Math.max(hi, f) - Math.min(lo || f, f) <= 3)) candidates.push(f);
    }
    for (const f of candidates) {
      const frets: Fret[] = v.frets.map((x, i) => (i < s ? null : i === s ? f : x));
      if (frets.filter((x) => x !== null).length < 3) continue;
      const fingers = assignFingers(v, frets, s);
      if (!fingers) continue;
      const d: Voicing = {
        id: `slash:${v.id}>${s}:${f}`,
        chord: `${v.chord}/${slashChord.bassName}`,
        frets,
        fingers,
        kind: v.kind,
        origin: 'derived',
      };
      if (voicingBassPc(d) === bass && matchVoicing(d, slashChord).ok) out.push(d);
    }
  }
  return out;
}

function assignFingers(v: Voicing, frets: Fret[], bassString: number): Finger[] | null {
  const fingers: Finger[] = v.fingers.map((g, i) => (frets[i] === null ? null : i === bassString ? null : g));
  const f = frets[bassString];
  if (f === null) return null;
  if (f === 0) {
    fingers[bassString] = 0;
    return fingers;
  }
  if (v.frets[bassString] === f && v.fingers[bassString]) {
    fingers[bassString] = v.fingers[bassString];
    return fingers;
  }
  const used = new Set(fingers.filter((g): g is 1 | 2 | 3 | 4 => !!g));
  const others = frets.filter((x, i): x is number => x !== null && x > 0 && i !== bassString);
  const lo = others.length ? Math.min(...others, f) : f;
  const preferred = Math.min(4, Math.max(1, f - lo + 1));
  const order = [preferred, preferred + 1, preferred - 1, preferred + 2, preferred - 2, 1, 2, 3, 4].filter((x) => x >= 1 && x <= 4);
  for (const g of order) {
    if (!used.has(g as 1 | 2 | 3 | 4)) {
      fingers[bassString] = g as Finger;
      return fingers;
    }
  }
  return null;
}
