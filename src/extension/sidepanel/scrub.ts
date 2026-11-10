/**
 * Seek-slider interaction state. The slider follows playback except while the user is
 * actively dragging it. Focus is not used: a clicked range input stays focused after the
 * pointer is released, which would otherwise freeze the thumb for the rest of playback and
 * make keyboard seeking start from a stale value.
 */
export class ScrubState {
  private dragging = false;

  begin(): void {
    this.dragging = true;
  }

  end(): void {
    this.dragging = false;
  }

  get active(): boolean {
    return this.dragging;
  }

  /** Whether the slider should be moved to the playback position on this frame. */
  shouldSync(jump: boolean): boolean {
    return jump || !this.dragging;
  }
}
