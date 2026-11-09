/**
 * After the extension is installed or reloaded, Chrome does not inject content scripts
 * into tabs that are already open, and scripts injected by the previous version lose
 * their connection to the extension. Without this, an open YouTube tab silently stops
 * reporting until the user reloads it.
 */

export interface ManifestContentScript {
  matches?: string[];
  js?: string[];
  world?: string;
  all_frames?: boolean;
}

export interface ReinjectPlan {
  matches: string[];
  files: string[];
  world: 'ISOLATED' | 'MAIN';
}

/**
 * Isolated-world scripts are always reinjected. MAIN-world scripts do not use extension
 * APIs, so they keep working after a reload; reinjecting them on update would run them
 * twice in the page. They are injected only on a fresh install.
 */
export function planReinjection(scripts: ManifestContentScript[] | undefined, reason: string): ReinjectPlan[] {
  if (reason !== 'install' && reason !== 'update') return [];
  const plans: ReinjectPlan[] = [];
  for (const s of scripts ?? []) {
    const world = s.world === 'MAIN' ? 'MAIN' : 'ISOLATED';
    if (world === 'MAIN' && reason !== 'install') continue;
    if (!s.matches?.length || !s.js?.length) continue;
    plans.push({ matches: [...s.matches], files: [...s.js], world });
  }
  return plans;
}

export async function reinjectContentScripts(reason: string): Promise<void> {
  const plans = planReinjection(chrome.runtime.getManifest().content_scripts as ManifestContentScript[] | undefined, reason);
  for (const plan of plans) {
    const tabs = await chrome.tabs.query({ url: plan.matches });
    for (const tab of tabs) {
      if (tab.id === undefined || tab.discarded) continue;
      await chrome.scripting
        .executeScript({ target: { tabId: tab.id }, files: plan.files, world: plan.world })
        .catch((e: unknown) => console.warn('reinject failed', tab.url, e));
    }
  }
}
