import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ScrubState } from '../src/extension/sidepanel/scrub';

// Codex connector review on PR #4 (finding 4520351216): the slider froze after a click
// because updates were suppressed while the range input had focus.
describe('seek slider follows playback after a click or drag ends', () => {
  it('stops syncing only during an active drag and resumes when it ends', () => {
    const s = new ScrubState();
    expect(s.shouldSync(false)).toBe(true); // playing, never touched
    s.begin();
    expect(s.shouldSync(false)).toBe(false); // dragging: leave the thumb under the pointer
    expect(s.shouldSync(true)).toBe(true); // an explicit jump still moves it
    s.end();
    expect(s.shouldSync(false)).toBe(true); // released (slider may still be focused): follow playback again
  });

  it('play.ts no longer keys thumb updates on focus and ends the drag on release', () => {
    const src = readFileSync(new URL('../src/extension/sidepanel/play.ts', import.meta.url), 'utf8');
    expect(src).not.toContain('document.activeElement !== this.seek');
    expect(src).toContain('this.scrub.shouldSync(jump)');
    expect(src).toContain("'pointerdown', () => this.scrub.begin()");
    expect(src).toMatch(/\['pointerup', 'pointercancel'\][^\n]*this\.scrub\.end\(\)/);
  });
});
