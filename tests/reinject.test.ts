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
