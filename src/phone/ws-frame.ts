/**
 * Minimal RFC 6455 framing for the VGT-13 relay (server side), pure and dependency-free.
 * Supports what browsers send for small text messages: single-frame (FIN) masked text,
 * ping, pong and close. Fragmented, binary, unmasked or oversized frames are protocol errors.
 */

export const OP_TEXT = 0x1;
export const OP_CLOSE = 0x8;
export const OP_PING = 0x9;
export const OP_PONG = 0xa;

export interface Frame {
  opcode: number;
  payload: Uint8Array;
}

export interface ParseResult {
  frames: Frame[];
  /** Bytes not yet forming a whole frame. */
  rest: Uint8Array;
  /** Set when the peer broke the protocol; the caller closes with this code. */
  error: { code: number; reason: string } | null;
}

export function parseFrames(buf: Uint8Array, maxPayload: number, requireMask = true): ParseResult {
  const frames: Frame[] = [];
  let off = 0;
  const fail = (code: number, reason: string): ParseResult => ({ frames, rest: new Uint8Array(0), error: { code, reason } });
  while (buf.length - off >= 2) {
    const b0 = buf[off]!;
    const b1 = buf[off + 1]!;
    const fin = (b0 & 0x80) !== 0;
    const rsv = b0 & 0x70;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let p = off + 2;
    if (rsv) return fail(1002, 'reserved bits');
    if (requireMask && !masked) return fail(1002, 'unmasked client frame');
    if (![OP_TEXT, OP_CLOSE, OP_PING, OP_PONG].includes(opcode)) return fail(1003, 'unsupported opcode');
    if (!fin) return fail(1003, 'fragmented message');
    if (len === 126) {
      if (buf.length - p < 2) break;
      len = (buf[p]! << 8) | buf[p + 1]!;
      p += 2;
    } else if (len === 127) {
      if (buf.length - p < 8) break;
      // Anything needing more than 32 bits is far beyond the limit.
      if (buf[p]! | buf[p + 1]! | buf[p + 2]! | buf[p + 3]!) return fail(1009, 'message too big');
      len = ((buf[p + 4]! << 24) >>> 0) + (buf[p + 5]! << 16) + (buf[p + 6]! << 8) + buf[p + 7]!;
      p += 8;
    }
    if (opcode >= 0x8 && len > 125) return fail(1002, 'control frame too long');
    if (len > maxPayload) return fail(1009, 'message too big');
    const maskLen = masked ? 4 : 0;
    if (buf.length - p < maskLen + len) break;
    const payload = buf.slice(p + maskLen, p + maskLen + len);
    if (masked) for (let i = 0; i < len; i++) payload[i] ^= buf[p + (i & 3)]!;
    frames.push({ opcode, payload });
    off = p + maskLen + len;
  }
  return { frames, rest: buf.slice(off), error: null };
}

/** Encodes one unmasked server frame (or a masked client frame when `mask` is given). */
export function encodeFrame(opcode: number, payload: Uint8Array, mask?: Uint8Array): Uint8Array {
  const len = payload.length;
  const ext = len < 126 ? 0 : len < 65536 ? 2 : 8;
  const out = new Uint8Array(2 + ext + (mask ? 4 : 0) + len);
  out[0] = 0x80 | opcode;
  out[1] = (mask ? 0x80 : 0) | (ext === 0 ? len : ext === 2 ? 126 : 127);
  if (ext === 2) {
    out[2] = len >> 8;
    out[3] = len & 0xff;
  } else if (ext === 8) {
    out[6] = (len >>> 24) & 0xff;
    out[7] = (len >>> 16) & 0xff;
    out[8] = (len >>> 8) & 0xff;
    out[9] = len & 0xff;
  }
  let p = 2 + ext;
  if (mask) {
    out.set(mask, p);
    p += 4;
    for (let i = 0; i < len; i++) out[p + i] = payload[i]! ^ mask[i & 3]!;
  } else out.set(payload, p);
  return out;
}

const enc = new TextEncoder();

export function textFrame(text: string): Uint8Array {
  return encodeFrame(OP_TEXT, enc.encode(text));
}

export function closeFrame(code: number, reason = ''): Uint8Array {
  const r = enc.encode(reason).slice(0, 123);
  const payload = new Uint8Array(2 + r.length);
  payload[0] = code >> 8;
  payload[1] = code & 0xff;
  payload.set(r, 2);
  return encodeFrame(OP_CLOSE, payload);
}

/** Strict UTF-8 decode; null on invalid text (close code 1007). */
export function decodeText(payload: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(payload);
  } catch {
    return null;
  }
}
