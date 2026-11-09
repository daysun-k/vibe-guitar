/**
 * AudioWorklet processor for listening mode: downmixes the captured tab audio to mono
 * (mean of channels, as Beat This! expects) and posts 4096-frame blocks to the
 * offscreen document. Audio stays inside the browser.
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
        this.port.postMessage({ samples: this.buf, sampleRate, frameTime: currentFrameTime() }, [this.buf.buffer]);
        this.buf = new Float32Array(BLOCK);
        this.fill = 0;
      }
    }
    return true;
  }
}

declare const currentFrame: number;
function currentFrameTime(): number {
  return currentFrame / sampleRate;
}

registerProcessor('vibe-mono-tap', MonoTapProcessor);
