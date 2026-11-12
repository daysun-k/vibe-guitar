import { describe, expect, it } from 'vitest';
import { OP_CLOSE, OP_PING, OP_TEXT, closeFrame, decodeText, encodeFrame, parseFrames, textFrame } from '../src/phone/ws-frame';
import { encodeQr, qrToTerminal } from '../src/phone/qr';

const te = new TextEncoder();
const mask = new Uint8Array([1, 2, 3, 4]);

describe('websocket frames', () => {
  it('round-trips masked client text frames, including 16-bit lengths and split input', () => {
    const long = 'x'.repeat(300);
    const bytes = new Uint8Array([...encodeFrame(OP_TEXT, te.encode('hi'), mask), ...encodeFrame(OP_TEXT, te.encode(long), mask)]);
    const first = parseFrames(bytes.slice(0, 10), 8192);
    expect(first.frames.map((f) => decodeText(f.payload))).toEqual(['hi']);
    const rest = new Uint8Array([...first.rest, ...bytes.slice(10)]);
    const second = parseFrames(rest, 8192);
    expect(second.frames.map((f) => decodeText(f.payload))).toEqual([long]);
    expect(second.rest.length).toBe(0);
    expect(second.error).toBeNull();
  });

  it('encodes unmasked server frames the client side can read', () => {
    const r = parseFrames(textFrame('héllo'), 8192, false);
    expect(decodeText(r.frames[0]!.payload)).toBe('héllo');
    const c = parseFrames(closeFrame(1008, 'bad'), 8192, false).frames[0]!;
    expect(c.opcode).toBe(OP_CLOSE);
    expect((c.payload[0]! << 8) | c.payload[1]!).toBe(1008);
  });

  it('rejects unmasked, fragmented, binary, oversized and reserved-bit frames', () => {
    expect(parseFrames(textFrame('a'), 8192).error?.code).toBe(1002);
    const frag = encodeFrame(OP_TEXT, te.encode('a'), mask);
    frag[0] = 0x01; // FIN cleared
    expect(parseFrames(frag, 8192).error?.code).toBe(1003);
    expect(parseFrames(encodeFrame(0x2, te.encode('a'), mask), 8192).error?.code).toBe(1003);
    expect(parseFrames(encodeFrame(OP_TEXT, te.encode('x'.repeat(9000)), mask), 8192).error?.code).toBe(1009);
    const rsv = encodeFrame(OP_TEXT, te.encode('a'), mask);
    rsv[0] = rsv[0]! | 0x40;
    expect(parseFrames(rsv, 8192).error?.code).toBe(1002);
    expect(parseFrames(encodeFrame(OP_PING, new Uint8Array(126), mask), 8192).error?.code).toBe(1002);
    // A 64-bit length header is refused before any payload arrives.
    const huge = new Uint8Array([0x81, 0xff, 0, 0, 0, 1, 0, 0, 0, 0]);
    expect(parseFrames(huge, 8192).error?.code).toBe(1009);
  });

  it('rejects invalid UTF-8', () => {
    expect(decodeText(new Uint8Array([0xc3, 0x28]))).toBeNull();
  });
});

describe('QR encoder', () => {
  const url = 'http://192.168.0.23:47822/?t=AbCdEfGhIjKlMnOpQrStUv';

  function finderAt(m: boolean[][], x0: number, y0: number): boolean {
    for (let y = 0; y < 7; y++)
      for (let x = 0; x < 7; x++) {
        const d = Math.max(Math.abs(x - 3), Math.abs(y - 3));
        if (m[y0 + y]![x0 + x] !== (d !== 2)) return false;
      }
    return true;
  }

  it('picks the smallest version that fits and draws the fixed patterns', () => {
    expect(encodeQr('hi').length).toBe(21); // version 1
    const m = encodeQr(url);
    expect(m.length).toBe(33); // 51 bytes -> version 4-M
    const n = m.length;
    expect(finderAt(m, 0, 0) && finderAt(m, n - 7, 0) && finderAt(m, 0, n - 7)).toBe(true);
    for (let i = 8; i < n - 8; i++) {
      expect(m[6]![i]).toBe(i % 2 === 0);
      expect(m[i]![6]).toBe(i % 2 === 0);
    }
    expect(m[n - 8]![8]).toBe(true); // dark module
  });

  it('writes the same valid format information in both copies', () => {
    const m = encodeQr(url);
    const n = m.length;
    const a: boolean[] = [];
    for (let i = 0; i <= 5; i++) a.push(m[i]![8]!);
    a.push(m[7]![8]!, m[8]![8]!, m[8]![7]!);
    for (let i = 9; i < 15; i++) a.push(m[8]![14 - i]!);
    const b: boolean[] = [];
    for (let i = 0; i < 8; i++) b.push(m[8]![n - 1 - i]!);
    for (let i = 8; i < 15; i++) b.push(m[n - 15 + i]![8]!);
    expect(a).toEqual(b);
    const bits = a.reduce((acc, bit, i) => acc | (Number(bit) << i), 0) ^ 0x5412;
    expect(bits >>> 13).toBe(0); // error correction level M = 00
    // BCH(15,5) check: the 10 low bits are the remainder of the 5 data bits.
    let rem = bits >>> 10;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    expect(rem & 0x3ff).toBe(bits & 0x3ff);
  });

  it('handles larger versions and refuses text that does not fit', () => {
    expect(encodeQr('x'.repeat(150)).length).toBe(49); // version 8 (has version information)
    expect(() => encodeQr('x'.repeat(400))).toThrow();
  });

  it('renders two module rows per terminal line', () => {
    const m = encodeQr('hi');
    expect(qrToTerminal(m).split('\n').length).toBe(Math.ceil((21 + 8) / 2));
  });
});
