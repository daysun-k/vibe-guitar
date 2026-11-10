import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { demoChart } from '../src/play/demo';
import { buildPlayModel, frameAt } from '../src/play/model';

// Codex connector review on PR #4 (head a2d8d4f): two P2 findings.
describe('connector review: no bar after the chart ends', () => {
  it('returns bar -1 past the end of the last bar, so count-in resumes near the playhead', () => {
    const m = buildPlayModel(demoChart(), { level: 'novice', capo: 0 }, null);
    const last = m.bars[m.bars.length - 1];
    expect(frameAt(m, last.startSec + 0.01).bar).toBe(m.bars.length - 1);
    expect(frameAt(m, last.endSec + 0.5).bar).toBe(-1);
    expect(frameAt(m, last.endSec + 120).bar).toBe(-1);
  });
});

describe('connector review: count-in never outlives its model', () => {
  const src = readFileSync(new URL('../src/extension/sidepanel/sidepanel.ts', import.meta.url), 'utf8');
  const body = (name: string): string => {
    const start = src.indexOf(`function ${name}(`);
    expect(start).toBeGreaterThanOrEqual(0);
    const open = src.indexOf('{', start);
    let depth = 0;
    for (let i = open; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}' && --depth === 0) return src.slice(open, i + 1);
    }
    throw new Error('unbalanced');
  };

  it('forgetting the player and changing recordings cancel a pending count-in', () => {
    expect(body('forgetPlayer')).toContain('stopCountIn()');
    const onState = src.slice(src.indexOf('if (key !== chartKey) {'), src.indexOf('if (key !== chartKey) {') + 80);
    expect(onState).toContain('stopCountIn()');
  });

  it('togglePlay uses a local copy of the model after its first await', () => {
    const t = body('togglePlay');
    const afterCopy = t.slice(t.indexOf('const m = model;'));
    expect(t).toContain('const m = model;');
    expect(afterCopy).not.toMatch(/\bmodel\./);
  });
});
