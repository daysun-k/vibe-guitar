import { describe, expect, it } from 'vitest';
import { planReinjection } from '../src/extension/reinject';
import manifest from '../src/extension/static/manifest.json';

const scripts = manifest.content_scripts;

describe('content script reinjection after install or reload', () => {
  it('reinjects isolated-world scripts on update but not MAIN-world ones', () => {
    const plans = planReinjection(scripts, 'update');
    expect(plans.length).toBeGreaterThan(0);
    expect(plans.every((p) => p.world === 'ISOLATED')).toBe(true);
    expect(plans.flatMap((p) => p.files)).toEqual(expect.arrayContaining(['content-youtube.js', 'content-applemusic.js']));
    expect(plans.flatMap((p) => p.files)).not.toContain('youtube-main.js');
  });

  it('injects every content script, including MAIN-world ones, on a fresh install', () => {
    const files = planReinjection(scripts, 'install').flatMap((p) => p.files);
    expect(files).toEqual(expect.arrayContaining(['content-youtube.js', 'youtube-main.js', 'content-applemusic.js', 'applemusic-main.js']));
    expect(planReinjection(scripts, 'install').find((p) => p.files.includes('youtube-main.js'))?.world).toBe('MAIN');
  });

  it('does nothing on a browser update or shared-module update', () => {
    expect(planReinjection(scripts, 'chrome_update')).toEqual([]);
    expect(planReinjection(scripts, 'shared_module_update')).toEqual([]);
  });

  it('declares the scripting permission the reinjection needs', () => {
    expect(manifest.permissions).toContain('scripting');
  });
});

import { claimInstance, onRuntimeMessage } from '../src/extension/content/instance';

describe('content script instance takeover (double injection)', () => {
  it('a second injection aborts the first, so only one timer and listener set stays alive', () => {
    const scope: Record<string, unknown> = {};
    const first = claimInstance('__test', scope);
    let timers = 0;
    let firstTimerCleared = false;
    timers++;
    first.addEventListener('abort', () => {
      timers--;
      firstTimerCleared = true;
    });
    const second = claimInstance('__test', scope);
    timers++;
    expect(first.aborted).toBe(true);
    expect(firstTimerCleared).toBe(true);
    expect(second.aborted).toBe(false);
    expect(timers).toBe(1);
  });

  it('removes the runtime message listener of the replaced copy', () => {
    const listeners = new Set<unknown>();
    (globalThis as unknown as { chrome: unknown }).chrome = {
      runtime: { onMessage: { addListener: (l: unknown) => listeners.add(l), removeListener: (l: unknown) => listeners.delete(l) } },
    };
    const scope: Record<string, unknown> = {};
    onRuntimeMessage(claimInstance('__msg', scope), () => undefined);
    expect(listeners.size).toBe(1);
    onRuntimeMessage(claimInstance('__msg', scope), () => undefined);
    expect(listeners.size).toBe(1);
  });

  it('ignores an orphaned context where chrome.runtime throws', () => {
    (globalThis as unknown as { chrome: unknown }).chrome = {
      runtime: { onMessage: { addListener: () => { throw new Error('Extension context invalidated.'); }, removeListener: () => { throw new Error('x'); } } },
    };
    const scope: Record<string, unknown> = {};
    expect(() => onRuntimeMessage(claimInstance('__o', scope), () => undefined)).not.toThrow();
    expect(() => claimInstance('__o', scope)).not.toThrow();
  });
});
