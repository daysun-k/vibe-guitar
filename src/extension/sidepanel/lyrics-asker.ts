/**
 * When the side panel asks the service worker for lyrics: once per visit of a recording for
 * each (fetch on/off, duration known) state. A failed attempt (error, 429, cancelled) stays
 * recorded, so player updates never turn into a retry loop; a new visit asks again.
 */
export class LyricsAsker {
  private recording = '';
  private asked = new Set<string>();

  shouldAsk(recordingKey: string, allowFetch: boolean, durationKnown: boolean): boolean {
    if (!recordingKey) return false;
    if (recordingKey !== this.recording) this.reset(recordingKey);
    const k = `${allowFetch ? 'fetch' : 'cache'}|${durationKnown ? 'd' : '-'}`;
    if (this.asked.has(k)) return false;
    this.asked.add(k);
    return true;
  }

  /** A new visit (recording change, tab switch): ask again once. */
  reset(recordingKey = ''): void {
    this.recording = recordingKey;
    this.asked.clear();
  }
}
