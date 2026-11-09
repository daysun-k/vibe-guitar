/**
 * AudioWorklet processor for listening mode: downmixes the captured tab audio to mono
 * (mean of channels, as Beat This! expects) and posts 4096-frame blocks to the
 * offscreen document, each stamped with the AudioContext frame just after its last
 * sample so the receiver can place it by sample time. Audio stays inside the browser.
 */

declare const sampleRate: number;
declare function registerProcessor(name: string, ctor: unknown): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}

const BLOCK = 4096;

class MonoTapProcessor extends AudioWorkletProcessor {
  private buf = new Float32Array(BLOCK);
  private fill = 0;

  process(inputs: Float32Array[][]): boolean {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const n = input[0].length;
    const ch = input.length;
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let c = 0; c < ch; c++) s += input[c][i];
      this.buf[this.fill++] = s / ch;
      if (this.fill === BLOCK) {
        const endFrame = currentFrame + i + 1;
        this.port.postMessage({ samples: this.buf, sampleRate, endFrame }, [this.buf.buffer]);
        this.buf = new Float32Array(BLOCK);
        this.fill = 0;
      }
    }
    return true;
  }
}

/** AudioContext frame of the first sample of the current render quantum. */
declare const currentFrame: number;

registerProcessor('vibe-mono-tap', MonoTapProcessor);
