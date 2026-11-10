/** Static shape difficulty and chord-change (transition) cost. */
import { detectBarre, fretSpan, lowestFret, voicingBassPc, type Voicing } from './guitar';
import type { LevelConfig, Profile } from './levels';

/** Static difficulty of grabbing a shape (roughly 1 = trivial, 6+ = full barre). */
export function staticDifficulty(v: Voicing): number {
  const fingers = new Set(v.fingers.filter((f) => f !== null && f > 0));
  const span = fretSpan(v);
  const barre = detectBarre(v);
  const sounding = v.frets.map((f, s) => (f === null ? -1 : s)).filter((s) => s >= 0);
  const first = sounding[0] ?? 0;
  const last = sounding[sounding.length - 1] ?? 5;
  let innerMuted = 0;
  for (let s = first; s <= last; s++) if (v.frets[s] === null) innerMuted++;
  const mutedOuter = v.frets.filter((f) => f === null).length - innerMuted;

  let d = 0.6 * fingers.size;
  d += 0.6 * Math.max(0, span - 1);
  if (barre) d += barre.full ? 3 : 1;
  if (lowestFret(v) > 4) d += 0.4;
  d += 0.8 * innerMuted;
  if (mutedOuter >= 2) d += 0.3;
  return Math.round(d * 100) / 100;
}

interface FingerPos {
  string: number;
  fret: number;
}

function fingerPositions(v: Voicing): Map<number, FingerPos> {
  const m = new Map<number, FingerPos>();
  v.fingers.forEach((g, s) => {
    const f = v.frets[s];
    if (!g || f === null || f === 0) return;
    if (!m.has(g)) m.set(g, { string: s, fret: f });
  });
  return m;
}

/** Cost of moving from voicing a to voicing b (0 when identical). */
export function transitionCost(a: Voicing | null, b: Voicing | null): number {
  if (!a || !b) return 0;
  if (a.frets.join() === b.frets.join()) return 0;
  const pa = fingerPositions(a);
  const pb = fingerPositions(b);
  let cost = 0;
  for (const [g, posB] of pb) {
    const posA = pa.get(g);
    if (!posA) cost += 0.7;
    else if (posA.string === posB.string && posA.fret === posB.fret) cost += 0;
    else if (posA.string === posB.string) cost += 0.4 + 0.1 * Math.abs(posA.fret - posB.fret);
    else cost += 0.9 + 0.1 * Math.abs(posA.fret - posB.fret);
  }
  cost += 0.15 * Math.abs(handPosition(a) - handPosition(b));
  const ba = detectBarre(a);
  const bb = detectBarre(b);
  if ((ba?.full ?? false) !== (bb?.full ?? false)) cost += 0.5;
  return Math.round(cost * 100) / 100;
}

function handPosition(v: Voicing): number {
  return lowestFret(v) || 1;
}

/** Time pressure: changes into short chords or at fast tempo cost more. */
export function timePressure(prevDurationSec: number, profile: Profile): number {
  const speed = profile.changeSpeed === 'slow' ? 1.5 : profile.changeSpeed === 'fast' ? 0.7 : 1;
  const p = 1.2 / Math.max(prevDurationSec, 0.3);
  return Math.min(3, Math.max(0.4, p)) * speed;
}

export const PENALTY = {
  /** Base cost of one unit of harmonic-substitution weight. */
  substitution: 4,
  unknownShape: 3,
  barreNotAllowed: 20,
  overStretch: 20,
  rootNotInBass: 0.3,
  /** Fewer than 4 sounding strings: thin for strummed accompaniment. */
  thinVoicing: 1,
  /** Keeping an original 7th that the level would drop (a mild preference for triads). */
  keepSeventh: 0.5,
} as const;

/** Cost of playing voicing v for one chord event, excluding the substitution penalty. */
export function voicingCost(v: Voicing, rootPc: number, level: LevelConfig, profile: Profile, capo = 0): number {
  let c = staticDifficulty(v) * level.difficultyWeight;
  const barre = detectBarre(v);
  if (barre?.full && !(level.barreAllowed && profile.canBarre)) c += PENALTY.barreNotAllowed;
  if (barre && !barre.full) c += level.partialBarreCost;
  const low = lowestFret(v);
  if (level.highPositionCost > 0 && low >= 5) c += level.highPositionCost + 0.5 * (low - 5);
  if (fretSpan(v) > profile.maxStretch) c += PENALTY.overStretch;
  if (profile.knownShapes.length > 0 && !profile.knownShapes.includes(v.id)) c += PENALTY.unknownShape;
  const bass = voicingBassPc(v, capo);
  if (bass !== null && bass !== (rootPc % 12) && !v.chord.includes('/')) c += PENALTY.rootNotInBass;
  if (v.frets.filter((f) => f !== null).length < 4) c += PENALTY.thinVoicing;
  return c;
}
