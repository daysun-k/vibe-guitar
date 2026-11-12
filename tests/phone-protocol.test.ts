import { describe, expect, it } from 'vitest';
import {
  MAX_MESSAGE_BYTES,
  clockSample,
  estimateOffset,
  isNewer,
  matchChange,
  positionAt,
  publisherAllowed,
  summarizeErrors,
  tokenMatches,
  validatePublisherMessage,
  validateViewerMessage,
  viewerHostAllowed,
  viewerOriginAllowed,
  type AnchorMessage,
} from '../src/phone/protocol';
import { unpackedExtensionId } from '../src/phone/relay';

const anchor: AnchorMessage = { t: 'anchor', epoch: 'abcd1234', seq: 3, sampledAt: 1_000_000, position: 10, rate: 1, paused: false, ad: false, loop: null };
const part = { t: 'song', epoch: 'abcd1234', rev: 1, i: 0, n: 2, d: '{"v":1' };

describe('message validation', () => {
  it('accepts valid anchors and song parts and returns copies without extra fields', () => {
    expect(validatePublisherMessage(JSON.stringify(anchor))).toEqual(anchor);
    expect(validatePublisherMessage(JSON.stringify({ ...anchor, loop: { a: 2, b: 6 } }))?.t).toBe('anchor');
    expect(validatePublisherMessage(JSON.stringify(part))).toEqual(part);
  });

  it('rejects unknown fields, bad numbers and bad parts', () => {
    const bad = [
      { ...anchor, extra: 1 },
      { ...anchor, lyrics: 'la la' },
      { ...anchor, seq: 0 },
      { ...anchor, rate: 9 },
      { ...anchor, position: -1 },
      { ...anchor, sampledAt: Number.NaN },
      { ...anchor, ad: 'yes' },
      { ...anchor, epoch: 'BAD EPOCH' },
      { ...anchor, loop: { a: 5, b: 5.1 } },
      { ...anchor, t: 'state' },
      { ...part, i: 2 },
      { ...part, n: 17 },
      { ...part, rev: 0 },
      { ...part, d: '' },
      { ...part, d: 5 },
    ];
    for (const b of bad) expect(validatePublisherMessage(JSON.stringify(b))).toBeNull();
  });

  it('rejects non-JSON and oversized text', () => {
    expect(validatePublisherMessage('{')).toBeNull();
    expect(validatePublisherMessage(' '.repeat(MAX_MESSAGE_BYTES + 1))).toBeNull();
  });

  it('viewers may only send pings', () => {
    expect(validateViewerMessage(JSON.stringify({ t: 'ping', id: 1, c: 12.5 }))).toEqual({ t: 'ping', id: 1, c: 12.5 });
    expect(validateViewerMessage(JSON.stringify(anchor))).toBeNull();
    expect(validateViewerMessage(JSON.stringify({ t: 'ping', id: 1, c: 1, x: 1 }))).toBeNull();
  });

  it('orders by epoch and number', () => {
    expect(isNewer(null, { epoch: 'a', n: 1 })).toBe(true);
    expect(isNewer({ epoch: 'a', n: 5 }, { epoch: 'a', n: 5 })).toBe(false);
    expect(isNewer({ epoch: 'a', n: 5 }, { epoch: 'a', n: 4 })).toBe(false);
    expect(isNewer({ epoch: 'a', n: 5 }, { epoch: 'b', n: 1 })).toBe(true);
  });
});

describe('access checks', () => {
  const token = 'AbCdEfGhIjKlMnOpQrStUv';
  it('token must match exactly', () => {
    expect(tokenMatches(token, token)).toBe(true);
    expect(tokenMatches(token, `${token}x`)).toBe(false);
    expect(tokenMatches(token, token.slice(0, -1))).toBe(false);
    expect(tokenMatches(token, `${token.slice(0, -1)}w`)).toBe(false);
    expect(tokenMatches(token, '')).toBe(false);
    expect(tokenMatches(token, null)).toBe(false);
  });

  it('viewer Host and Origin must be the advertised LAN address', () => {
    const lan = '192.168.0.23:47822';
    expect(viewerHostAllowed({ host: lan, origin: undefined }, lan)).toBe(true);
    expect(viewerHostAllowed({ host: 'evil.example:47822', origin: undefined }, lan)).toBe(false);
    expect(viewerOriginAllowed({ host: lan, origin: `http://${lan}` }, lan)).toBe(true);
    expect(viewerOriginAllowed({ host: lan, origin: 'http://evil.example' }, lan)).toBe(false);
    expect(viewerOriginAllowed({ host: lan, origin: undefined }, lan)).toBe(false);
  });

  it('publisher must be loopback Host with this extension as Origin', () => {
    const id = 'b'.repeat(32);
    const ext = `chrome-extension://${id}`;
    expect(publisherAllowed({ host: '127.0.0.1:47821', origin: ext }, 47821, id)).toBe(true);
    expect(publisherAllowed({ host: 'localhost:47821', origin: ext }, 47821, id)).toBe(true);
    expect(publisherAllowed({ host: '192.168.0.23:47821', origin: ext }, 47821, id)).toBe(false);
    expect(publisherAllowed({ host: '127.0.0.1:47821', origin: 'http://localhost:3000' }, 47821, id)).toBe(false);
    expect(publisherAllowed({ host: '127.0.0.1:47821', origin: undefined }, 47821, id)).toBe(false);
    expect(publisherAllowed({ host: '127.0.0.1:47821', origin: ext }, 47821, 'c'.repeat(32))).toBe(false);
    // --any-extension: any Chrome extension, still loopback only
    expect(publisherAllowed({ host: '127.0.0.1:47821', origin: ext }, 47821)).toBe(true);
  });

  it('derives an unpacked extension id from its folder (32 letters a–p, stable)', () => {
    const id = unpackedExtensionId('/Users/me/vibe-guitar/dist');
    expect(id).toMatch(/^[a-p]{32}$/);
    expect(unpackedExtensionId('/Users/me/vibe-guitar/dist')).toBe(id);
    expect(unpackedExtensionId('/Users/me/other/dist')).not.toBe(id);
  });
});

describe('extrapolation', () => {
  const dur = 200;
  it('advances at the rate and holds while paused or during an ad', () => {
    expect(positionAt(anchor, dur, anchor.sampledAt + 2000)).toBeCloseTo(12);
    expect(positionAt({ ...anchor, rate: 0.5 }, dur, anchor.sampledAt + 2000)).toBeCloseTo(11);
    expect(positionAt({ ...anchor, paused: true }, dur, anchor.sampledAt + 2000)).toBe(10);
    expect(positionAt({ ...anchor, ad: true }, dur, anchor.sampledAt + 2000)).toBe(10);
  });

  it('wraps inside the A/B loop and clamps at the song end', () => {
    const loop = { a: 8, b: 12 };
    expect(positionAt({ ...anchor, loop }, dur, anchor.sampledAt + 1000)).toBeCloseTo(11);
    expect(positionAt({ ...anchor, loop }, dur, anchor.sampledAt + 3000)).toBeCloseTo(9);
    expect(positionAt({ ...anchor, loop }, dur, anchor.sampledAt + 7000)).toBeCloseTo(9);
    // Started after B: no wrap, plays on to the end and stops there.
    expect(positionAt({ ...anchor, position: 20, loop }, dur, anchor.sampledAt + 1e6)).toBe(dur);
  });
});

describe('clock offset', () => {
  it('computes one NTP-style sample', () => {
    // Phone clock 1000 ms behind the Mac, 40 ms symmetric round trip.
    expect(clockSample(5000, 6020, 5040)).toEqual({ rtt: 40, offset: 1000 });
  });

  it('prefers low-RTT samples so a slow asymmetric round trip does not skew the offset', () => {
    const samples = [
      clockSample(0, 1005, 10),
      clockSample(100, 1106, 112),
      clockSample(200, 1290, 400),
      clockSample(300, 1450, 500),
      clockSample(400, 1405, 410),
      clockSample(500, 1600, 700),
    ];
    const est = estimateOffset(samples)!;
    expect(est.offset).toBe(1000);
    expect(est.bound).toBe(6); // rtt 10 / 2 + 1 ms resolution
    expect(est.consistent).toBe(true);
    expect(est.rtt).toBe(10);
    expect(estimateOffset([])).toBeNull();
  });

  it('the bound covers the true offset for any delay asymmetry and floored clocks (randomized)', () => {
    let seed = 42;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    for (let trial = 0; trial < 500; trial++) {
      const theta = (rnd() - 0.5) * 1e6;
      const samples = [];
      let t = 1e6 + rnd() * 1e5;
      for (let i = 0; i < 1 + Math.floor(rnd() * 15); i++) {
        const up = rnd() * (rnd() < 0.2 ? 300 : 20);
        const down = rnd() * (rnd() < 0.2 ? 300 : 20);
        samples.push(clockSample(Math.floor(t), Math.floor(t + up + theta), Math.floor(t + up + down)));
        t += 2000 * rnd();
      }
      const est = estimateOffset(samples)!;
      expect(est.consistent).toBe(true);
      expect(Math.abs(theta - est.offset)).toBeLessThanOrEqual(est.bound + 1e-9);
    }
  });

  it('marks non-overlapping samples as inconsistent and falls back to the fastest one', () => {
    const est = estimateOffset([{ rtt: 2, offset: 0 }, { rtt: 2, offset: 50 }])!;
    expect(est.consistent).toBe(false);
    expect(est.offset).toBe(0);
  });
});

describe('change error bookkeeping (phone-check)', () => {
  it('pairs a reference change with the nearest change of the same event', () => {
    const changes = [{ index: 2, at: 1000 }, { index: 3, at: 2330 }, { index: 2, at: 6400 }];
    expect(matchChange(changes, { index: 3, at: 2300 })).toBe(30);
    expect(matchChange(changes, { index: 2, at: 6420 })).toBe(-20);
    expect(matchChange(changes, { index: 5, at: 2300 })).toBeNull();
    expect(summarizeErrors([10, -30, 20])).toEqual({ n: 3, medianAbs: 20, worstAbs: 30, mean: 0 });
  });
});
