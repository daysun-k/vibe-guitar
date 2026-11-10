/**
 * Which tab the panel's play/pause/seek commands may go to: the tab whose player reported last,
 * and only while it is still the active tab of the panel's window. An unknown active tab blocks
 * every command (a stale player never gets controlled behind the user's back).
 */
export function controlTabId(playerTabId: number | null, activeTabId: number | null): number | null {
  return playerTabId !== null && playerTabId === activeTabId ? playerTabId : null;
}

/**
 * Leaving demo playback (tab switches are not followed during the demo): keep the last player
 * only when its tab is still the active one; otherwise forget it until the active tab reports.
 */
export function keepPlayerAfterDemo(playerTabId: number | null, activeTabId: number | null): boolean {
  return controlTabId(playerTabId, activeTabId) !== null;
}
