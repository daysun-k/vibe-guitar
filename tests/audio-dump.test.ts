import { describe, expect, it, vi } from 'vitest';
import * as esbuild from 'esbuild';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Chart } from '../src/chart/types';
import { createAudioDumpHooks, RecordingCache } from '../src/extension/dump/audio-dump';
import type { AutoChartInput } from '../src/recognize/autochart';
import { analyzeClosedSegments, type Segment } from '../src/recognize/session';
import { liveLikeSession, testAudio } from './replay-helpers';
import { CAPTURE_SCHEMA, captureFolderName, decodeCaptureBody, encodeCaptureBody, samplesFromBytes, type CaptureMeta, type CaptureSegment } from '../src/replay/capture';
// @ts-expect-error plain .mjs without types
import { audioDumpPlugin, buildDefine, buildFlags } from '../scripts/build-config.mjs';
// @ts-expect-error plain .mjs without types
import { createReceiver, isInsideRepo, parseArgs, saveCapture } from '../scripts/audio-dump-receiver.mjs';

const root = path.resolve(__dirname, '..');

function fakeChart(input: AutoChartInput): Chart {
  return {
    schemaVersion: 1,
    recording: { ...input.recording },
    timing: { bpm: 120, beatsPerBar: 4, beatUnit: 4, firstDownbeatSec: 0 },
    events: [{ startSec: 0, chord: 'C', confidence: 0.5, source: 'auto' }],
    coverage: input.segments.map((s) => ({ fromSec: (s as unknown as { startSec: number }).startSec, toSec: (s as unknown as { endSec: number }).endSec })),
    provenance: { createdBy: 'recognizer', createdAt: '2026-11-14T00:00:00.000Z', tool: input.tool },
  };
}

const recording = { source: 'youtube' as const, id: 'abcdefghijk', title: 'T', artist: 'A' };
const info = { commit: 'c0ffee', dirty: false, models: { 'beat_this_small.onnx': 'aa' } };

describe('audio dump hooks', () => {
  it('posts exactly the analysed closed-segment snapshot, in order, cached segments included', async () => {
    const session = liveLikeSession();
    const posts: { meta: CaptureMeta; segments: CaptureSegment[] }[] = [];
    const deferred: (() => void)[] = [];
    const hooks = createAudioDumpHooks({ analyzeClosedSegments, buildAutoChart: fakeChart }, info, async (meta, segments) => void posts.push({ meta, segments }), (f) => deferred.push(f));
    const cache = new WeakMap<Segment, { startSec: number; endSec: number }>();
    // The first segment was analysed by an earlier request: it comes from the cache.
    cache.set(session.segments[0], { startSec: session.segments[0].startSec, endSec: session.segments[0].endSec });
    const analyze = vi.fn(async (seg: Segment) => ({ startSec: seg.startSec, endSec: seg.endSec }));
    const analyses = await hooks.analyzeClosedSegments(session, cache, analyze);
    expect(analyze).toHaveBeenCalledTimes(1);
    const chart = hooks.buildAutoChart({ recording, segments: analyses as never, tool: 't', durationSec: 30 });
    expect(posts).toHaveLength(0); // never inside the chart path
    deferred.forEach((f) => f());
    expect(posts).toHaveLength(1);
    const expected = session.segments.filter((g) => g.closed && g.durationSec >= 1);
    expect(expected).toHaveLength(2);
    expect(posts[0].segments.map((g) => g.startSec)).toEqual(expected.map((g) => g.startSec));
    posts[0].segments.forEach((g, i) => expect(g.samples).toEqual(expected[i].audio.view()));
    expect(posts[0].meta.chart).toBe(chart);
    expect(posts[0].meta).toMatchObject({ schema: CAPTURE_SCHEMA, recordingKey: 'youtube:abcdefghijk', durationSec: 30, build: { commit: 'c0ffee', dirty: false }, models: info.models });
    expect(posts[0].meta.sessionCoverage).toHaveLength(3);
    expect(posts[0].meta.capturedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
  });

  it('returns the same analyses as the unwrapped function', async () => {
    const analyze = async (seg: Segment) => seg.startSec;
    const a = await analyzeClosedSegments(liveLikeSession(), new WeakMap(), analyze);
    const hooks = createAudioDumpHooks({ analyzeClosedSegments, buildAutoChart: fakeChart }, info, async () => {}, () => {});
    expect(await hooks.analyzeClosedSegments(liveLikeSession(), new WeakMap(), analyze)).toEqual(a);
  });

  it('a failing POST (rejected or thrown) never reaches the chart path', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const post of [async () => Promise.reject(new Error('refused')), () => { throw new Error('sync'); }]) {
      const deferred: (() => void)[] = [];
      const hooks = createAudioDumpHooks({ analyzeClosedSegments, buildAutoChart: fakeChart }, info, post as never, (f) => deferred.push(f));
      const analyses = await hooks.analyzeClosedSegments(liveLikeSession(), new WeakMap(), async (seg: Segment) => ({ startSec: seg.startSec, endSec: seg.endSec }));
      expect(hooks.buildAutoChart({ recording, segments: analyses as never, tool: 't' }).events).toHaveLength(1);
      expect(() => deferred.forEach((f) => f())).not.toThrow();
      await new Promise((r) => setTimeout(r, 0));
    }
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it('does not post for a buildAutoChart call that is not fed by the recorded analysis', () => {
    const deferred: (() => void)[] = [];
    const hooks = createAudioDumpHooks({ analyzeClosedSegments, buildAutoChart: fakeChart }, info, async () => {}, (f) => deferred.push(f));
    hooks.buildAutoChart({ recording, segments: [], tool: 't' });
    expect(deferred).toHaveLength(0);
  });

  it('RecordingCache records lookups and delegates storage', () => {
    const inner = new WeakMap<Segment, number>();
    const c = new RecordingCache(inner);
    const s = liveLikeSession().segments;
    c.set(s[0], 1);
    expect(inner.get(s[0])).toBe(1);
    expect(c.get(s[0])).toBe(1);
    expect(c.get(s[1])).toBeUndefined();
    expect(c.seen).toEqual([s[0], s[1]]);
  });
});

describe('capture format', () => {
  const meta = (): CaptureMeta => ({
    schema: CAPTURE_SCHEMA,
    recordingKey: 'youtube:abcdefghijk',
    recording,
    durationSec: 30,
    sessionCoverage: [],
    chart: fakeChart({ recording, segments: [], tool: 't' }),
    build: { commit: 'x', dirty: true },
    models: {},
    capturedAt: '2026-11-14T00:00:00.000Z',
    sampleRate: 22050,
  });

  it('round-trips header and little-endian Float32 samples', () => {
    const segs = [
      { startSec: 0.123456789, samples: testAudio(0.1, 4) },
      { startSec: 12.5, samples: testAudio(0.05, 5).subarray(3) },
    ];
    const parts = encodeCaptureBody(meta(), segs);
    const body = Buffer.concat(parts.map((p) => Buffer.from(p.buffer, p.byteOffset, p.byteLength)));
    const { header, segmentBytes } = decodeCaptureBody(new Uint8Array(body));
    expect(header.segments).toEqual(segs.map((s) => ({ startSec: s.startSec, samples: s.samples.length })));
    segmentBytes.forEach((b, i) => expect(samplesFromBytes(b)).toEqual(segs[i].samples));
    expect(() => decodeCaptureBody(new Uint8Array(body.subarray(0, body.length - 4)))).toThrow(/shorter/);
  });

  it('names folders by YouTube id or a safe key', () => {
    expect(captureFolderName(recording)).toBe('abcdefghijk');
    expect(captureFolderName({ source: 'applemusic', id: '123/../x' } as never)).toBe('applemusic_123____x');
  });
});

describe('audio dump receiver', () => {
  const body = (id = 'abcdefghijk') => {
    const m = { ...{ schema: CAPTURE_SCHEMA, recordingKey: `youtube:${id}`, recording: { ...recording, id }, durationSec: 30, sessionCoverage: [], chart: fakeChart({ recording, segments: [], tool: 't' }), build: { commit: 'x', dirty: true }, models: {}, capturedAt: 'now', sampleRate: 22050 } } as CaptureMeta;
    const parts = encodeCaptureBody(m, [{ startSec: 1, samples: testAudio(0.01) }]);
    return new Uint8Array(Buffer.concat(parts.map((p) => Buffer.from(p.buffer, p.byteOffset, p.byteLength))));
  };

  it('refuses an output folder inside the repository', () => {
    expect(() => parseArgs(['--out', 'captures'])).toThrow(/inside the repository/);
    expect(() => parseArgs(['--out', path.join(root, 'tests', 'x', 'y')])).toThrow(/inside the repository/);
    expect(() => parseArgs(['--out', root])).toThrow(/inside the repository/);
    expect(() => parseArgs([])).toThrow(/--out is required/);
    const outside = mkdtempSync(path.join(tmpdir(), 'vg-dump-'));
    expect(parseArgs(['--out', path.join(outside, 'new')]).out).toBe(path.join(outside, 'new'));
    expect(isInsideRepo(outside)).toBe(false);
  });

  it('writes seg-<i>.f32 + meta.json and never overwrites a capture', async () => {
    const out = mkdtempSync(path.join(tmpdir(), 'vg-dump-'));
    const r = await saveCapture(out, body(), { captureId: 'fixed-1' });
    expect(readdirSync(r.dir).sort()).toEqual(['meta.json', 'seg-0.f32']);
    const meta = JSON.parse(readFileSync(path.join(r.dir, 'meta.json'), 'utf8'));
    expect(meta).toMatchObject({ captureId: 'fixed-1', recordingKey: 'youtube:abcdefghijk', segments: [{ startSec: 1, samples: 221, file: 'seg-0.f32' }] });
    writeFileSync(path.join(r.dir, 'seg-0.f32'), 'original');
    await expect(saveCapture(out, body(), { captureId: 'fixed-1' })).rejects.toThrow(/already exists/);
    expect(readFileSync(path.join(r.dir, 'seg-0.f32'), 'utf8')).toBe('original');
    // No temporary folder left behind.
    expect(readdirSync(path.join(out, 'abcdefghijk'))).toEqual(['fixed-1']);
  });

  it('serves 127.0.0.1 with CORS for extension origins only', async () => {
    const out = mkdtempSync(path.join(tmpdir(), 'vg-dump-'));
    const saved: unknown[] = [];
    const server = createReceiver(out, (r: unknown) => saved.push(r));
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/capture`;
    const ext = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
    try {
      const pre = await fetch(url, { method: 'OPTIONS', headers: { Origin: ext } });
      expect(pre.status).toBe(204);
      expect(pre.headers.get('access-control-allow-origin')).toBe(ext);
      expect(pre.headers.get('access-control-allow-private-network')).toBe('true');
      const ok = await fetch(url, { method: 'POST', headers: { Origin: ext }, body: body() });
      expect(ok.status).toBe(201);
      expect(saved).toHaveLength(1);
      expect((await fetch(url, { method: 'POST', headers: { Origin: 'https://evil.example' }, body: body() })).status).toBe(403);
      expect((await fetch(url, { method: 'POST', headers: { Origin: ext }, body: new Uint8Array([1, 2, 3]) })).status).toBe(400);
      expect(saved).toHaveLength(1);
    } finally {
      await new Promise((ok) => server.close(ok));
    }
  });
});

describe('build flags', () => {
  it('the default build defines __AUDIO_DUMP__ false and adds no plugin', () => {
    const f = buildFlags(['node', 'build.mjs']);
    expect(f).toMatchObject({ probe: false, dump: false, outDir: 'dist' });
    expect(buildDefine(f)).toMatchObject({ __AUDIO_DUMP__: 'false', __AUDIO_DUMP_INFO__: 'null', __LATENCY_PROBE__: 'false' });
    const d = buildFlags(['--audio-dump']);
    expect(d).toMatchObject({ dump: true, outDir: 'dist-dump' });
    expect(buildDefine(d, info).__AUDIO_DUMP__).toBe('true');
    expect(JSON.parse(buildDefine(d, info).__AUDIO_DUMP_INFO__)).toEqual(info);
    expect(() => buildFlags(['--audio-dump', '--latency-probe'])).toThrow();
  });

  it('bundles the dump hooks into offscreen.js only with the plugin', async () => {
    const bundle = async (dump: boolean) => {
      const flags = buildFlags(dump ? ['--audio-dump'] : []);
      const r = await esbuild.build({
        absWorkingDir: root,
        entryPoints: ['src/extension/offscreen/offscreen.ts'],
        bundle: true,
        format: 'iife',
        target: 'chrome116',
        write: false,
        define: buildDefine(flags, dump ? info : null),
        plugins: dump ? [audioDumpPlugin(root)] : [],
        logLevel: 'silent',
      });
      return r.outputFiles[0].text;
    };
    const plain = await bundle(false);
    const dumped = await bundle(true);
    expect(plain).not.toMatch(/createAudioDumpHooks|audio dump/);
    expect(dumped).toMatch(/createAudioDumpHooks/);
    // listen.ts calls the hooks, not the originals, in the dump build.
    expect(dumped).toMatch(/await analyzeClosedSegments\d\(session, this\.analysisCache/);
    expect(plain).toMatch(/await analyzeClosedSegments\(session, this\.analysisCache/);
  });
});
