// VGT-19 follow-up: the phone music stand shows a small "?" after the current and next chord when that
// chord holds a visible uncertain stretch. Only a yes/no per chord travels (no second choice), the
// 불확실한 곳 표시 switch turns it off, and old relays (which reject unknown song view fields) never get it.
import { describe, expect, it } from 'vitest';
import { PhoneLink, type SocketLike } from '../src/extension/sidepanel/phone-link';
import { validatePublisherMessage, validateRelayToPanel, type SongPartMessage } from '../src/phone/protocol';
import { buildSongView, phoneFrame, readSongView, uncertainEvents, validateSongView, withoutUncertain, type SongView } from '../src/phone/song-view';
import { UNCERTAIN_LABEL, chordNameHTML } from '../src/phone/stand';
import { demoChart } from '../src/play/demo';
import { buildPlayModel } from '../src/play/model';

const model = (showUncertain = true) => buildPlayModel(demoChart(), { level: 'beginner', capo: 'auto', showUncertain }, null);
const viewOf = (showUncertain = true) => buildSongView(model(showUncertain), { title: 't', artist: 'a', showSounding: false })!;

describe('song view: per-chord "?" flags', () => {
  it('flags the arranged events under the demo chord marks, never the no-chord one, and nothing else', () => {
    const m = model();
    const v = viewOf();
    const ev = m.arrangement.events;
    // four chord marks (verse Fm, verse C♯ second half, Fm7, chorus C♯, respelled D♭ for the key); the ringing-end N has no name on the phone
    expect(v.uncertain).toHaveLength(4);
    expect(v.uncertain!.map((i) => [ev[i]!.startSec, ev[i]!.original])).toEqual([
      [11.6, 'Fm'],
      [13.6, 'Db'],
      [19.6, 'Fm7'],
      [27.6, 'Db'],
    ]);
    // a yes/no only: no chord names or second choices beyond the shapes already in the view
    expect(Object.keys(v)).not.toContain('alt');
    expect(JSON.stringify(v.uncertain)).toMatch(/^\[[\d,]+\]$/);
  });

  it('the 불확실한 곳 표시 switch off leaves the field out (the view is the one before VGT-19)', () => {
    const off = viewOf(false);
    expect('uncertain' in off).toBe(false);
    expect(withoutUncertain(viewOf())).toEqual(off);
  });

  it('uncertainEvents skips rests and marks outside every event', () => {
    const events = [
      { startSec: 0, endSec: 2, rest: false },
      { startSec: 2, endSec: 4, rest: true },
      { startSec: 4, endSec: 6, rest: false },
    ];
    expect(uncertainEvents(events, [{ fromSec: 4.5, toSec: 5, noChord: false }, { fromSec: 2, toSec: 3, noChord: false }, { fromSec: 0, toSec: 1, noChord: false }, { fromSec: 9, toSec: 10, noChord: false }, { fromSec: 0, toSec: 2, noChord: true }])).toEqual([0, 2]);
  });

  it('validation: optional, ascending unique event indices in range', () => {
    const v = viewOf();
    const n = v.events.length / 3;
    expect(validateSongView(v)).toEqual(v);
    expect(validateSongView(withoutUncertain(v))).toEqual(withoutUncertain(v));
    for (const bad of [[n], [-1], [3, 3], [5, 2], [1.5], ['1'], 'x', Array.from({ length: n + 1 }, (_, i) => i)]) expect(validateSongView({ ...v, uncertain: bad }), JSON.stringify(bad)).toBeNull();
    expect(validateSongView({ ...v, uncertain: [] })?.uncertain).toEqual([]);
  });
});

describe('phone frame and drawing', () => {
  it('the current and next chord carry the flag of their own event', () => {
    const s = readSongView(viewOf());
    // 12.5 s: verse Fm (shape Em with capo 1) now, C♯ (shape C) next, both flagged
    const f = phoneFrame(s, 12.5);
    expect([f.nowUncertain, f.nextUncertain]).toEqual([true, true]);
    expect(s.view.shapes[s.events[f.nowEvent]!.shape]!.name).toBe('Em');
    expect(s.view.shapes[s.events[f.nextEvent]!.shape]!.name).toBe('C');
    // 10.5 s: verse G♯ (shape G) now, Fm next: only the next one
    const g = phoneFrame(s, 10.5);
    expect([g.nowUncertain, g.nextUncertain]).toEqual([false, true]);
    // intro: none
    const h = phoneFrame(s, 2);
    expect([h.nowUncertain, h.nextUncertain]).toEqual([false, false]);
  });

  it('a view without the field (old panel, switch off) shows no "?"', () => {
    for (const v of [viewOf(false), withoutUncertain(viewOf())]) {
      const s = readSongView(v);
      expect(s.events.every((e) => !e.uncertain)).toBe(true);
      const f = phoneFrame(s, 12.5);
      expect([f.nowUncertain, f.nextUncertain]).toEqual([false, false]);
    }
  });

  it('chordNameHTML adds the quiet "?" after the (slash) name only when flagged', () => {
    expect(chordNameHTML('Em', false)).toBe('Em');
    expect(chordNameHTML('Em', true)).toBe(`Em<i class="unc-q" role="img" aria-label="${UNCERTAIN_LABEL}">?</i>`);
    expect(chordNameHTML('D/F♯', true)).toBe(`D<span class="slash-bass">/F♯</span><i class="unc-q" role="img" aria-label="확실하지 않아요">?</i>`);
    expect(chordNameHTML('<b>', true)).toContain('&lt;b&gt;');
  });
});

describe('relay caps: the panel sends the flags only to a relay that announced them', () => {
  it('validateRelayToPanel reads caps (extra keys ignored)', () => {
    expect(validateRelayToPanel('{"t":"caps","uncertain":true}')).toEqual({ t: 'caps', uncertain: true });
    expect(validateRelayToPanel('{"t":"caps","uncertain":true,"later":1}')).toEqual({ t: 'caps', uncertain: true });
    expect(validateRelayToPanel('{"t":"caps"}')).toEqual({ t: 'caps', uncertain: false });
  });

  class Sock implements SocketLike {
    readyState = 0;
    sent: string[] = [];
    onopen: SocketLike['onopen'] = null;
    onmessage: SocketLike['onmessage'] = null;
    onclose: SocketLike['onclose'] = null;
    onerror: SocketLike['onerror'] = null;
    send(t: string) {
      this.sent.push(t);
    }
    close() {}
    open() {
      this.readyState = 1;
      this.onopen?.(new Event('open'));
    }
    msg(o: unknown) {
      this.onmessage?.({ data: JSON.stringify(o) } as MessageEvent);
    }
    drop() {
      this.readyState = 3;
      this.onclose?.({ code: 1006 } as CloseEvent);
    }
  }

  function setup() {
    let now = 1_000_000;
    const timers: { at: number; fn: () => void; id: number }[] = [];
    let id = 1;
    const socks: Sock[] = [];
    const link = new PhoneLink({
      onStatus: () => {},
      sample: () => null,
      makeSocket: () => {
        const s = new Sock();
        socks.push(s);
        return s;
      },
      now: () => now,
      setTimer: (fn, ms) => {
        timers.push({ at: now + ms, fn, id });
        return id++;
      },
      clearTimer: (x) => {
        const i = timers.findIndex((t) => t.id === x);
        if (i >= 0) timers.splice(i, 1);
      },
    });
    const advance = (ms: number) => {
      const end = now + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const t = timers[0];
        if (!t || t.at > end) break;
        timers.shift();
        now = t.at;
        t.fn();
      }
      now = end;
    };
    /** The song views a socket received, joined from its parts, with their revision. */
    const songs = (s: Sock): { rev: number; view: SongView }[] => {
      const parts = s.sent.map((x) => validatePublisherMessage(x)).filter((m): m is SongPartMessage => m?.t === 'song');
      const byRev = new Map<number, SongPartMessage[]>();
      for (const p of parts) byRev.set(p.rev, [...(byRev.get(p.rev) ?? []), p]);
      return [...byRev].map(([rev, ps]) => ({ rev, view: JSON.parse(ps.sort((a, b) => a.i - b.i).map((p) => p.d).join('')) as SongView }));
    };
    return { link, socks, advance, songs };
  }

  it('an old relay (no caps) never receives the field; a new one gets the song again with it', () => {
    const { link, socks, advance, songs } = setup();
    link.setEnabled(true);
    link.setSong(viewOf(), 'tab:1');
    advance(1000);
    socks[0]!.open();
    expect(songs(socks[0]!).map((x) => 'uncertain' in x.view)).toEqual([false]);
    // the old relay would have closed the panel for an unknown field; it stays without it
    advance(5000);
    expect(songs(socks[0]!).every((x) => !('uncertain' in x.view))).toBe(true);
    socks[0]!.msg({ t: 'caps', uncertain: true });
    const after = songs(socks[0]!);
    expect(after.map((x) => 'uncertain' in x.view)).toEqual([false, true]);
    expect(after[1]!.rev).toBeGreaterThan(after[0]!.rev);
    expect(after[1]!.view).toEqual(viewOf());
    // a later song goes out with its flags at once
    link.setSong(viewOf(), 'tab:2');
    advance(1000);
    expect(songs(socks[0]!).at(-1)!.view.uncertain).toEqual(viewOf().uncertain);
  });

  it('a reconnect starts without the field until the new relay announces it', () => {
    const { link, socks, advance, songs } = setup();
    link.setEnabled(true);
    link.setSong(viewOf(), 'tab:1');
    advance(1000);
    socks[0]!.open();
    socks[0]!.msg({ t: 'caps', uncertain: true });
    socks[0]!.drop();
    advance(20_000);
    socks[1]!.open();
    expect(songs(socks[1]!).map((x) => 'uncertain' in x.view)).toEqual([false]);
  });

  it('a song without flags is sent once, also after caps (no extra revision)', () => {
    const { link, socks, advance, songs } = setup();
    link.setEnabled(true);
    link.setSong(viewOf(false), 'tab:1');
    advance(1000);
    socks[0]!.open();
    socks[0]!.msg({ t: 'caps', uncertain: true });
    expect(songs(socks[0]!)).toHaveLength(1);
  });
});
