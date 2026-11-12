import { describe, expect, it } from 'vitest';
import {
  MAX_MESSAGE_BYTES,
  chordIndexAt,
  clockSample,
  estimateOffset,
  isNewer,
  matchChange,
  positionAt,
  publisherAllowed,
  summarizeErrors,
  tokenMatches,
  upcoming,
  validatePublisherMessage,
  validateViewerMessage,
  viewerHostAllowed,
  viewerOriginAllowed,
  type Anchor,
  type StateMessage,
} from '../src/phone/protocol';
import { syntheticSong } from '../src/phone/synthetic';

const song = syntheticSong();
const anchor: Anchor = { id: 3, at: 1_000_000, position: 10, rate: 1, paused: false };
const state = (over: Partial<StateMessage> = {}): StateMessage => ({ t: 'state', epoch: 'abcd1234', seq: 1, song, anchor, loop: null, ...over });

describe('synthetic song', () => {
  it('starts at 0, is sorted and ends inside the duration', () => {
    expect(song.chords[0]!.at).toBe(0);
    for (let i = 1; i < song.chords.length; i++) expect(song.chords[i]!.at).toBeGreaterThan(song.chords[i - 1]!.at);
    expect(song.duration).toBeCloseTo(80 * (60 / 90), 2);
  });
});

describe('message validation', () => {
  it('accepts a valid state and returns a copy without extra fields', () => {
    const m = validatePublisherMessage(JSON.stringify(state()));
    expect(m).toEqual(state());
  });

  it('rejects unknown fields, bad numbers, unsorted chords and markup in names', () => {
    const bad = [
      { ...state(), extra: 1 },
      state({ seq: -1 }),
      state({ anchor: { ...anchor, rate: 3 } }),
      state({ anchor: { ...anchor, position: song.duration + 1 } }),
      state({ anchor: { ...anchor, at: Number.NaN } }),
      state({ epoch: 'BAD EPOCH' }),
      state({ loop: { a: 5, b: 5.2 } }),
      state({ song: { ...song, chords: [{ at: 1, name: 'C' }] } }),
      state({ song: { ...song, chords: [{ at: 0, name: 'C' }, { at: 0, name: 'G' }] } }),
      state({ song: { ...song, chords: [{ at: 0, name: '<img src=x>' }] } }),
      state({ song: { ...song, chords: Array.from({ length: 65 }, (_, i) => ({ at: i * 0.1, name: 'C' })) } }),
    ];
    for (const b of bad) expect(validatePublisherMessage(JSON.stringify(b))).toBeNull();
  });

  it('rejects non-JSON and oversized text', () => {
    expect(validatePublisherMessage('{')).toBeNull();
    expect(validatePublisherMessage(' '.repeat(MAX_MESSAGE_BYTES + 1))).toBeNull();
  });

  it('validates marks', () => {
    expect(validatePublisherMessage(JSON.stringify({ t: 'mark', epoch: 'abcd1234', index: 2, at: 5 }))).toEqual({ t: 'mark', epoch: 'abcd1234', index: 2, at: 5 });
    expect(validatePublisherMessage(JSON.stringify({ t: 'mark', epoch: 'abcd1234', index: 1.5, at: 5 }))).toBeNull();
  });

  it('viewers may only send pings', () => {
    expect(validateViewerMessage(JSON.stringify({ t: 'ping', id: 1, c: 12.5 }))).toEqual({ t: 'ping', id: 1, c: 12.5 });
    expect(validateViewerMessage(JSON.stringify(state()))).toBeNull();
    expect(validateViewerMessage(JSON.stringify({ t: 'ping', id: 1, c: 1, x: 1 }))).toBeNull();
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

  it('publisher must be loopback Host with a Chrome extension Origin', () => {
    const ext = `chrome-extension://${'b'.repeat(32)}`;
    expect(publisherAllowed({ host: '127.0.0.1:47821', origin: ext }, 47821)).toBe(true);
    expect(publisherAllowed({ host: 'localhost:47821', origin: ext }, 47821)).toBe(true);
    expect(publisherAllowed({ host: '192.168.0.23:47821', origin: ext }, 47821)).toBe(false);
    expect(publisherAllowed({ host: '127.0.0.1:47821', origin: 'http://localhost:3000' }, 47821)).toBe(false);
    expect(publisherAllowed({ host: '127.0.0.1:47821', origin: undefined }, 47821)).toBe(false);
    expect(publisherAllowed({ host: '127.0.0.1:47821', origin: ext }, 47821, 'c'.repeat(32))).toBe(false);
  });
});

describe('extrapolation', () => {
  it('advances at the rate and holds when paused', () => {
    expect(positionAt(anchor, null, song.duration, anchor.at + 2000)).toBeCloseTo(12);
    expect(positionAt({ ...anchor, rate: 0.5 }, null, song.duration, anchor.at + 2000)).toBeCloseTo(11);
    expect(positionAt({ ...anchor, paused: true }, null, song.duration, anchor.at + 2000)).toBe(10);
  });

  it('wraps inside the A/B loop and clamps at the song end', () => {
    const loop = { a: 8, b: 12 };
    expect(positionAt(anchor, loop, song.duration, anchor.at + 1000)).toBeCloseTo(11);
    expect(positionAt(anchor, loop, song.duration, anchor.at + 3000)).toBeCloseTo(9);
    expect(positionAt(anchor, loop, song.duration, anchor.at + 7000)).toBeCloseTo(9);
    // Started after B: no wrap, plays on to the end and stops there.
    expect(positionAt({ ...anchor, position: 20 }, loop, song.duration, anchor.at + 1e6)).toBe(song.duration);
  });

  it('finds the chord at a position, including exact boundaries', () => {
    const chords = [{ at: 0, name: 'C' }, { at: 2, name: 'G' }, { at: 4, name: 'Am' }];
    expect(chordIndexAt(chords, 0)).toBe(0);
    expect(chordIndexAt(chords, 1.999)).toBe(0);
    expect(chordIndexAt(chords, 2)).toBe(1);
    expect(chordIndexAt(chords, 99)).toBe(2);
  });

  it('reports the next chord and the wall time to the change, honoring rate and loop', () => {
    const s = { bpm: 90, beatsPerBar: 4, duration: 8, chords: [{ at: 0, name: 'C' }, { at: 2, name: 'G' }, { at: 4, name: 'Am' }, { at: 6, name: 'F' }] };
    const a: Anchor = { id: 1, at: 0, position: 1, rate: 0.5, paused: false };
    const u = upcoming(s, a, null, 1);
    expect(u).toMatchObject({ index: 0, nextIndex: 1, songSeconds: 1, wallSeconds: 2, beats: 1.5 });
    // Loop 2..4: at 3.5 the next chord is the loop start (G), 0.5 s away.
    expect(upcoming(s, a, { a: 2, b: 4 }, 3.5)).toMatchObject({ index: 1, nextIndex: 1, songSeconds: 0.5 });
    expect(upcoming(s, a, { a: 0, b: 4 }, 3.5)).toMatchObject({ index: 1, nextIndex: 0 });
    expect(upcoming(s, { ...a, paused: true }, null, 1).wallSeconds).toBe(Infinity);
  });
});

describe('clock offset', () => {
  it('computes one NTP-style sample', () => {
    // Phone clock 1000 ms behind the Mac, 40 ms symmetric round trip.
    expect(clockSample(5000, 6020, 5040)).toEqual({ rtt: 40, offset: 1000 });
  });

  it('prefers low-RTT samples so a slow asymmetric round trip does not skew the offset', () => {
    const samples = [
      clockSample(0, 1005, 10), // rtt 10, offset 1000
      clockSample(100, 1106, 112), // rtt 12, offset 1000
      clockSample(200, 1290, 400), // rtt 200, slow return: offset 990
      clockSample(300, 1450, 500), // rtt 200, slow request: offset 1050
      clockSample(400, 1405, 410), // rtt 10, offset 1000
      clockSample(500, 1600, 700), // rtt 200
    ];
    const est = estimateOffset(samples)!;
    expect(est.offset).toBe(1000);
    expect(est.bound).toBe(6); // rtt 10 / 2 + 1 ms resolution
    expect(est.consistent).toBe(true);
    expect(est.rtt).toBe(10);
    expect(est.samples).toBe(6);
    expect(estimateOffset([])).toBeNull();
  });

  it('review s3-r1 F3: the shown bound covers the true offset', () => {
    // True offset 0: one fast symmetric round trip, five slow ones that returned late.
    const samples = [
      { rtt: 2, offset: 0 },
      { rtt: 100, offset: 40 },
      { rtt: 100, offset: 40 },
      { rtt: 102, offset: 40 },
      { rtt: 104, offset: 40 },
      { rtt: 106, offset: 40 },
    ];
    const est = estimateOffset(samples)!;
    expect(Math.abs(0 - est.offset)).toBeLessThanOrEqual(est.bound);
    expect(est.offset).toBe(0);
    expect(est.bound).toBe(2);
  });

  it('bound holds for any delay asymmetry and floored clocks (randomized)', () => {
    let seed = 42;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let trial = 0; trial < 500; trial++) {
      const theta = (rnd() - 0.5) * 1e6; // relay clock minus phone clock
      const samples = [];
      let t = 1e6 + rnd() * 1e5; // phone true time
      for (let i = 0; i < 1 + Math.floor(rnd() * 15); i++) {
        const up = rnd() * (rnd() < 0.2 ? 300 : 20);
        const down = rnd() * (rnd() < 0.2 ? 300 : 20);
        const c0 = Math.floor(t);
        const s = Math.floor(t + up + theta); // relay Date.now() floors
        const c1 = Math.floor(t + up + down);
        samples.push(clockSample(c0, s, c1));
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
    expect(est.bound).toBe(2);
  });
});

describe('change error bookkeeping', () => {
  it('pairs a mark with the nearest viewer change of the same chord', () => {
    const changes = [{ index: 2, at: 1000 }, { index: 3, at: 2330 }, { index: 2, at: 6400 }];
    expect(matchChange(changes, { index: 3, at: 2300 })).toBe(30);
    expect(matchChange(changes, { index: 2, at: 6420 })).toBe(-20);
    expect(matchChange(changes, { index: 5, at: 2300 })).toBeNull();
    expect(matchChange(changes, { index: 3, at: 9000 })).toBeNull();
  });

  it('summarizes absolute error', () => {
    expect(summarizeErrors([10, -30, 20])).toEqual({ n: 3, medianAbs: 20, worstAbs: 30, mean: 0 });
    expect(summarizeErrors([]).n).toBe(0);
  });

  it('orders states by epoch and seq', () => {
    expect(isNewer(null, { epoch: 'a', seq: 1 })).toBe(true);
    expect(isNewer({ epoch: 'a', seq: 5 }, { epoch: 'a', seq: 5 })).toBe(false);
    expect(isNewer({ epoch: 'a', seq: 5 }, { epoch: 'a', seq: 4 })).toBe(false);
    expect(isNewer({ epoch: 'a', seq: 5 }, { epoch: 'b', seq: 1 })).toBe(true);
  });
});
