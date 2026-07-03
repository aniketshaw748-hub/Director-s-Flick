/**
 * replicate.test.ts — hermetic unit tests for the Replicate fallback video provider.
 *
 * Every network call is served by an injected `fetchImpl` mock; nothing touches
 * the real Replicate API (NO live calls, no REPLICATE_API_TOKEN needed).
 * Verifies the prediction submit -> poll -> download flow, the 5|10 duration
 * clamp, the dollar ledger, image-to-video data-URI inlining, output-url
 * extraction, and the video-only / auth / error guards.
 */

import { randomUUID } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  ReplicateProvider,
  ReplicateError,
  ReplicateAuthError,
  REPLICATE_API_BASE,
  REPLICATE_KLING_25_TURBO_PRO,
  replicateVideoSeconds,
  replicateVideoPriceUsd,
} from '../src/providers/replicate.js';
import { DEFAULT_CONFIG } from '../src/types.js';
import type { VideoJobSpec, ImageJobSpec } from '../src/types.js';

// --- fake Response builders -------------------------------------------------

function jsonRes(body: unknown, init: { status?: number; statusText?: string } = {}): Response {
  const status = init.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: init.statusText ?? '',
    json: async () => body,
    arrayBuffer: async () => new ArrayBuffer(0),
  } as unknown as Response;
}

function binRes(bytes: Uint8Array, init: { status?: number } = {}): Response {
  const status = init.status ?? 200;
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: '',
    json: async () => {
      throw new Error('binary body is not JSON');
    },
    arrayBuffer: async () => ab,
  } as unknown as Response;
}

// --- fixtures ---------------------------------------------------------------

let tmpDir: string;
let startImagePath: string;
const START_IMAGE_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); // PNG magic
const START_IMAGE_DATA_URI = `data:image/png;base64,${START_IMAGE_BYTES.toString('base64')}`;

const SUBMIT_URL = `${REPLICATE_API_BASE}/models/${REPLICATE_KLING_25_TURBO_PRO}/predictions`;
const GET_URL = `${REPLICATE_API_BASE}/predictions/pred-1`;

beforeEach(async () => {
  tmpDir = path.join(os.tmpdir(), `replicate-test-${randomUUID()}`);
  await fsp.mkdir(tmpDir, { recursive: true });
  startImagePath = path.join(tmpDir, 'start.png');
  await fsp.writeFile(startImagePath, START_IMAGE_BYTES);
});

afterEach(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

function videoSpec(overrides: Partial<VideoJobSpec> = {}): VideoJobSpec {
  return {
    kind: 'video',
    prompt: 'a lighthouse keeper climbs the stairs',
    elementIds: [],
    startImage: startImagePath,
    model: 'kling3_0',
    duration: 5,
    soundOff: true,
    aspectRatio: '16:9',
    ...overrides,
  };
}

function makeProvider(fetchImpl: ReturnType<typeof vi.fn>, apiToken: string | undefined = 'test-token') {
  return new ReplicateProvider(DEFAULT_CONFIG, { apiToken, fetchImpl: fetchImpl as never });
}

function submitRes(id = 'pred-1') {
  return jsonRes({ id, status: 'starting', urls: { get: GET_URL } }, { status: 201 });
}

// ---------------------------------------------------------------------------

describe('replicate pricing helpers', () => {
  test('replicateVideoSeconds clamps up to the {5,10} enum', () => {
    expect(replicateVideoSeconds(3)).toBe(5);
    expect(replicateVideoSeconds(5)).toBe(5);
    expect(replicateVideoSeconds(6)).toBe(10);
    expect(replicateVideoSeconds(15)).toBe(10);
  });

  test('replicateVideoPriceUsd: $0.35 for 5s, $0.70 for 10s', () => {
    expect(replicateVideoPriceUsd(5)).toBe(0.35);
    expect(replicateVideoPriceUsd(10)).toBe(0.7);
  });
});

describe('ReplicateProvider.preflightCost (dollar-denominated)', () => {
  test('image jobs -> null; video jobs -> dollar price for the clamped duration', async () => {
    const p = makeProvider(vi.fn());
    const imageSpec: ImageJobSpec = { kind: 'image', prompt: 'x', elementIds: [], model: 'nano_banana_2', aspectRatio: '16:9' };
    expect(await p.preflightCost(imageSpec)).toBeNull();
    expect(await p.preflightCost(videoSpec({ duration: 4 }))).toBe(0.35); // -> 5s
    expect(await p.preflightCost(videoSpec({ duration: 8 }))).toBe(0.7); // -> 10s
  });
});

describe('ReplicateProvider.submitImage', () => {
  test('throws — Replicate is a video-only fallback', async () => {
    const fetchImpl = vi.fn();
    const p = makeProvider(fetchImpl);
    await expect(
      p.submitImage({ kind: 'image', prompt: 'x', elementIds: [], model: 'nano_banana_2', aspectRatio: '16:9' }),
    ).rejects.toBeInstanceOf(ReplicateError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('ReplicateProvider.submitVideo', () => {
  test('POSTs a prediction with Bearer auth + data-URI start image + integer duration, returns prediction id', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(submitRes());
    const p = makeProvider(fetchImpl);

    const id = await p.submitVideo(videoSpec({ duration: 4 }));
    expect(id).toBe('pred-1');
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(SUBMIT_URL);
    expect(init.method).toBe('POST');
    expect(init.headers.authorization).toBe('Bearer test-token');
    const body = JSON.parse(init.body as string);
    expect(body.input.prompt).toContain('lighthouse');
    expect(body.input.duration).toBe(5); // clamped 4 -> 5, sent as an INTEGER
    expect(typeof body.input.duration).toBe('number');
    expect(body.input.start_image).toBe(START_IMAGE_DATA_URI); // local path inlined
  });

  test('clamps duration 9 -> 10 in the request body', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(submitRes());
    const p = makeProvider(fetchImpl);
    await p.submitVideo(videoSpec({ duration: 9 }));
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body as string).input.duration).toBe(10);
  });

  test('passes an http(s) start image through as-is', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(submitRes());
    const p = makeProvider(fetchImpl);
    await p.submitVideo(videoSpec({ startImage: 'https://cdn.example.com/frame.png' }));
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body as string).input.start_image).toBe(
      'https://cdn.example.com/frame.png',
    );
  });

  test('throws without a startImage', async () => {
    const fetchImpl = vi.fn();
    const p = makeProvider(fetchImpl);
    await expect(p.submitVideo(videoSpec({ startImage: undefined }))).rejects.toBeInstanceOf(ReplicateError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('missing REPLICATE_API_TOKEN throws before any network', async () => {
    const saved = process.env.REPLICATE_API_TOKEN;
    delete process.env.REPLICATE_API_TOKEN;
    try {
      const fetchImpl = vi.fn();
      const p = new ReplicateProvider(DEFAULT_CONFIG, { fetchImpl: fetchImpl as never });
      await expect(p.submitVideo(videoSpec())).rejects.toBeInstanceOf(ReplicateError);
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      if (saved !== undefined) process.env.REPLICATE_API_TOKEN = saved;
    }
  });

  test('401 -> ReplicateAuthError', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonRes({ detail: 'bad token' }, { status: 401 }));
    const p = makeProvider(fetchImpl);
    await expect(p.submitVideo(videoSpec())).rejects.toBeInstanceOf(ReplicateAuthError);
  });
});

describe('ReplicateProvider.poll', () => {
  async function submit(fetchImpl: ReturnType<typeof vi.fn>) {
    fetchImpl.mockResolvedValueOnce(submitRes());
    const p = makeProvider(fetchImpl);
    await p.submitVideo(videoSpec({ duration: 5 }));
    return p;
  }

  test('maps starting/processing to queued/in_progress and polls the urls.get', async () => {
    const fetchImpl = vi.fn();
    const p = await submit(fetchImpl);

    fetchImpl.mockResolvedValueOnce(jsonRes({ status: 'starting' }));
    expect((await p.poll('pred-1')).status).toBe('queued');
    expect(fetchImpl.mock.calls[1][0]).toBe(GET_URL); // polled the get url

    fetchImpl.mockResolvedValueOnce(jsonRes({ status: 'processing' }));
    expect((await p.poll('pred-1')).status).toBe('in_progress');
  });

  test('succeeded with a string output url -> completed + dollar charge', async () => {
    const fetchImpl = vi.fn();
    const p = await submit(fetchImpl);
    fetchImpl.mockResolvedValueOnce(
      jsonRes({ status: 'succeeded', output: 'https://replicate.delivery/out/pred-1.mp4' }),
    );
    const r = await p.poll('pred-1');
    expect(r.status).toBe('completed');
    expect(r.resultUrl).toBe('https://replicate.delivery/out/pred-1.mp4');
    expect(r.creditsCharged).toBe(0.35); // dollars, deterministic for a 5s clip
  });

  test('succeeded with an array output extracts the first url', async () => {
    const fetchImpl = vi.fn();
    const p = await submit(fetchImpl);
    fetchImpl.mockResolvedValueOnce(
      jsonRes({ status: 'succeeded', output: ['https://replicate.delivery/out/a.mp4'] }),
    );
    expect((await p.poll('pred-1')).resultUrl).toBe('https://replicate.delivery/out/a.mp4');
  });

  test('succeeded with an { url } object output', async () => {
    const fetchImpl = vi.fn();
    const p = await submit(fetchImpl);
    fetchImpl.mockResolvedValueOnce(
      jsonRes({ status: 'succeeded', output: { url: 'https://replicate.delivery/out/o.mp4' } }),
    );
    expect((await p.poll('pred-1')).resultUrl).toBe('https://replicate.delivery/out/o.mp4');
  });

  test('succeeded without an output url -> failed', async () => {
    const fetchImpl = vi.fn();
    const p = await submit(fetchImpl);
    fetchImpl.mockResolvedValueOnce(jsonRes({ status: 'succeeded', output: null }));
    const r = await p.poll('pred-1');
    expect(r.status).toBe('failed');
  });

  test('failed status -> failed with the error message', async () => {
    const fetchImpl = vi.fn();
    const p = await submit(fetchImpl);
    fetchImpl.mockResolvedValueOnce(jsonRes({ status: 'failed', error: 'NSFW content detected' }));
    const r = await p.poll('pred-1');
    expect(r.status).toBe('failed');
    expect(r.error).toContain('NSFW');
  });

  test('unknown job id throws', async () => {
    const p = makeProvider(vi.fn());
    await expect(p.poll('nope')).rejects.toBeInstanceOf(ReplicateError);
  });
});

describe('ReplicateProvider.download', () => {
  test('streams an http result url to destPath', async () => {
    const payload = Buffer.from('fake-mp4-bytes');
    const fetchImpl = vi.fn().mockResolvedValueOnce(binRes(payload));
    const p = makeProvider(fetchImpl);

    const dest = path.join(tmpDir, 'clips', 'out.mp4');
    const out = await p.download(
      { jobId: 'pred-1', status: 'completed', resultUrl: 'https://replicate.delivery/out.mp4' },
      dest,
    );
    expect(out).toBe(dest);
    expect(fetchImpl).toHaveBeenCalledWith('https://replicate.delivery/out.mp4');
    expect((await fsp.readFile(dest)).equals(payload)).toBe(true);
  });

  test('throws when the result has no url', async () => {
    const p = makeProvider(vi.fn());
    await expect(
      p.download({ jobId: 'x', status: 'completed' }, path.join(tmpDir, 'x.mp4')),
    ).rejects.toBeInstanceOf(ReplicateError);
  });

  test('download HTTP error surfaces as ReplicateError', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(binRes(Buffer.alloc(0), { status: 500 }));
    const p = makeProvider(fetchImpl);
    await expect(
      p.download(
        { jobId: 'x', status: 'completed', resultUrl: 'https://replicate.delivery/out.mp4' },
        path.join(tmpDir, 'x.mp4'),
      ),
    ).rejects.toBeInstanceOf(ReplicateError);
  });
});
