/**
 * Runtime validator for chart v1. Mirrors chart.schema.json (structure) and adds
 * semantic checks the schema cannot express (ordering, parseable chords).
 */
import { isNoChord, parseChord } from '../arrange/chord';
import type { Chart } from './types';

export interface ValidationResult {
  ok: boolean;
  chart?: Chart;
  errors: string[];
  warnings: string[];
}

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => typeof x === 'object' && x !== null && !Array.isArray(x);
const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const isStr = (x: unknown): x is string => typeof x === 'string';

function checkKeys(o: Obj, path: string, allowed: string[], required: string[], errors: string[]): void {
  for (const k of required) if (!(k in o)) errors.push(`${path}.${k} is required`);
  for (const k of Object.keys(o)) if (!allowed.includes(k)) errors.push(`${path}.${k} is not allowed`);
}

export function validateChart(input: unknown): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!isObj(input)) return { ok: false, errors: ['chart must be an object'], warnings };

  checkKeys(input, 'chart', ['schemaVersion', 'recording', 'timing', 'events', 'coverage', 'provenance'], ['schemaVersion', 'recording', 'timing', 'events', 'coverage', 'provenance'], errors);
  if (input.schemaVersion !== 1) errors.push('chart.schemaVersion must be 1');

  const rec = input.recording;
  if (!isObj(rec)) errors.push('chart.recording must be an object');
  else {
    checkKeys(rec, 'recording', ['source', 'id', 'title', 'artist'], ['source', 'id', 'title', 'artist'], errors);
    if (!['youtube', 'ytmusic', 'applemusic'].includes(rec.source as string)) errors.push('recording.source must be youtube|ytmusic|applemusic');
    if (!isStr(rec.id) || rec.id.length === 0) errors.push('recording.id must be a non-empty string');
    if (!isStr(rec.title)) errors.push('recording.title must be a string');
    if (!isStr(rec.artist)) errors.push('recording.artist must be a string');
  }

  const tim = input.timing;
  if (!isObj(tim)) errors.push('chart.timing must be an object');
  else {
    checkKeys(tim, 'timing', ['bpm', 'beatsPerBar', 'beatUnit', 'firstDownbeatSec', 'beatTimes', 'feel'], ['bpm', 'beatsPerBar', 'firstDownbeatSec'], errors);
    if (!isNum(tim.bpm) || tim.bpm <= 0 || tim.bpm > 400) errors.push('timing.bpm must be a number in (0, 400]');
    if (!Number.isInteger(tim.beatsPerBar) || (tim.beatsPerBar as number) < 1 || (tim.beatsPerBar as number) > 16) errors.push('timing.beatsPerBar must be an integer 1..16');
    if (tim.beatUnit !== undefined && tim.beatUnit !== 4 && tim.beatUnit !== 8) errors.push('timing.beatUnit must be 4 or 8');
    if (!isNum(tim.firstDownbeatSec) || tim.firstDownbeatSec < 0) errors.push('timing.firstDownbeatSec must be a number >= 0');
    if (tim.feel !== undefined && tim.feel !== 'straight' && tim.feel !== 'shuffle') errors.push('timing.feel must be straight|shuffle');
    if (tim.beatTimes !== undefined) {
      if (!Array.isArray(tim.beatTimes) || !tim.beatTimes.every((b) => isNum(b) && b >= 0)) errors.push('timing.beatTimes must be an array of numbers >= 0');
      else {
        for (let i = 1; i < tim.beatTimes.length; i++) {
          if ((tim.beatTimes[i] as number) <= (tim.beatTimes[i - 1] as number)) {
            errors.push(`timing.beatTimes must be strictly ascending (index ${i})`);
            break;
          }
        }
        if (tim.beatTimes.length && isNum(tim.firstDownbeatSec) && Math.abs((tim.beatTimes[0] as number) - tim.firstDownbeatSec) > 0.05) {
          warnings.push('timing.beatTimes[0] differs from firstDownbeatSec; beat 0 is taken from beatTimes[0]');
        }
      }
    }
  }

  const events = input.events;
  if (!Array.isArray(events)) errors.push('chart.events must be an array');
  else {
    if (events.length === 0) warnings.push('chart has no chord events');
    let prev = -Infinity;
    events.forEach((e, i) => {
      const p = `events[${i}]`;
      if (!isObj(e)) {
        errors.push(`${p} must be an object`);
        return;
      }
      checkKeys(e, p, ['startSec', 'chord', 'confidence', 'source'], ['startSec', 'chord', 'confidence', 'source'], errors);
      if (!isNum(e.startSec) || e.startSec < 0) errors.push(`${p}.startSec must be a number >= 0`);
      else {
        if (e.startSec <= prev) errors.push(`${p}.startSec must be greater than the previous event`);
        prev = e.startSec;
      }
      if (!isStr(e.chord) || e.chord.length === 0) errors.push(`${p}.chord must be a non-empty string`);
      else if (!isNoChord(e.chord)) {
        try {
          parseChord(e.chord);
        } catch (err) {
          errors.push(`${p}.chord: ${(err as Error).message}`);
        }
      }
      if (!isNum(e.confidence) || e.confidence < 0 || e.confidence > 1) errors.push(`${p}.confidence must be in [0, 1]`);
      if (e.source !== 'manual' && e.source !== 'auto') errors.push(`${p}.source must be manual|auto`);
    });
  }

  const cov = input.coverage;
  if (!Array.isArray(cov)) errors.push('chart.coverage must be an array');
  else {
    cov.forEach((c, i) => {
      const p = `coverage[${i}]`;
      if (!isObj(c)) {
        errors.push(`${p} must be an object`);
        return;
      }
      checkKeys(c, p, ['fromSec', 'toSec'], ['fromSec', 'toSec'], errors);
      if (!isNum(c.fromSec) || !isNum(c.toSec) || c.fromSec < 0 || c.toSec <= c.fromSec) errors.push(`${p} must satisfy 0 <= fromSec < toSec`);
    });
  }

  const prov = input.provenance;
  if (!isObj(prov)) errors.push('chart.provenance must be an object');
  else {
    checkKeys(prov, 'provenance', ['createdBy', 'createdAt', 'updatedAt', 'tool', 'note', 'example'], ['createdBy', 'createdAt'], errors);
    if (!['manual', 'recognizer', 'edited'].includes(prov.createdBy as string)) errors.push('provenance.createdBy must be manual|recognizer|edited');
    if (!isStr(prov.createdAt) || prov.createdAt.length === 0) errors.push('provenance.createdAt must be a non-empty string');
    for (const k of ['updatedAt', 'tool', 'note'] as const) if (prov[k] !== undefined && !isStr(prov[k])) errors.push(`provenance.${k} must be a string`);
    if (prov.example !== undefined && typeof prov.example !== 'boolean') errors.push('provenance.example must be a boolean');
  }

  return errors.length ? { ok: false, errors, warnings } : { ok: true, chart: input as unknown as Chart, errors, warnings };
}
