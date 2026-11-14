/**
 * VGT-19: the optional `uncertain` spans of a chart (docs/uncertainty-protocol.md). Charts without
 * them stay valid; spans are checked by the JSON Schema and the runtime validator alike.
 */
import Ajv from 'ajv';
import { describe, expect, it } from 'vitest';
import schema from '../src/chart/chart.schema.json';
import { EXAMPLE_CHARTS, validateChart } from '../src/chart';
import type { Chart } from '../src/chart/types';

const schemaValidate = new Ajv({ allErrors: true }).compile(schema);
const base = (): Chart => structuredClone(EXAMPLE_CHARTS[0]);

describe('chart.uncertain', () => {
  it('a chart without spans and one with valid spans pass both validators', () => {
    const plain = base();
    expect(plain.uncertain).toBeUndefined();
    expect(validateChart(plain).ok).toBe(true);
    const c = { ...base(), uncertain: [{ fromSec: 2, toSec: 3.5, chord: 'G', alt: 'Em' }, { fromSec: 3.5, toSec: 4, chord: 'C', alt: 'N' }] };
    expect(schemaValidate(c), JSON.stringify(schemaValidate.errors)).toBe(true);
    expect(validateChart(c).errors).toEqual([]);
  });

  it('rejects malformed spans', () => {
    const bad = (uncertain: unknown) => validateChart({ ...base(), uncertain }).errors.join(' | ');
    expect(bad({})).toMatch(/must be an array/);
    expect(bad([{ fromSec: 3, toSec: 3, chord: 'G', alt: 'Em' }])).toMatch(/fromSec < toSec/);
    expect(bad([{ fromSec: 2, toSec: 4, chord: 'G', alt: 'Em' }, { fromSec: 3, toSec: 5, chord: 'G', alt: 'Em' }])).toMatch(/previous span/);
    expect(bad([{ fromSec: 1, toSec: 2, chord: 'G', alt: 'Hm' }])).toMatch(/alt/);
    expect(bad([{ fromSec: 1, toSec: 2, chord: 'G' }])).toMatch(/alt is required/);
    expect(bad([{ fromSec: 1, toSec: 2, chord: 'G', alt: 'Em', p: 0.3 }])).toMatch(/not allowed/);
    expect(schemaValidate({ ...base(), uncertain: [{ fromSec: 1, toSec: 2, chord: 'G' }] })).toBe(false);
  });
});
