/**
 * fal.test.ts — hermetic unit tests for the fal.ai fallback video provider.
 *
 * Every network call is served by an injected `fetchImpl` mock; nothing ever
 * touches the real fal.ai API (NO live calls, no FAL_KEY needed). Verifies the
 * queue submit -> status -> result -> download flow, the 5|10 duration clamp,
 * the dollar-denominated ledger, image-to-video data-URI inlining, and the
 * video-only / auth / error guards.
 */

import { randomUUID } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  FalProvider,
  FalError,
  FalAuthError,
  FAL_KLING_25_TURBO_PRO_I2V,
  FAL_QUEUE_BASE,
  falVideoSeconds,
  falVideoPriceUsd,
} from '../src/providers/fal.js';
import { DEFAULT_CONFIG } from '../src/types.js';
import type { VideoJobSpec, ImageJobSpec } from '../src/types.js';

// --- fake Response builders -------------------------------------------------

function jsonRes(
  body: unknown,
  init: { status?: number; statusText?: string } = {},
): Response {
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

beforeEach(async () => {
  tmpDir = path.join(os.tmpdir(), `fal-test-${randomUUID()}`);
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

function makeProvider(fetchImpl: ReturnType<typeof vi.fn>, apiKey: string | undefined = 'test-key') {
  return new FalProvider(DEFAULT_CONFIG, { apiKey, fetchImpl: fetchImpl as never });
}

const SUBMIT_URL = `${FAL_QUEUE_BASE}/${FAL_KLING_25_TURBO_PRO_I2V}`;

// ---------------------------------------------------------------------------

describe('fal pricing helpers', () => {
  test('falVideoSeconds clamps up to the {5,10} enum', () => {
    expect(falVideoSeconds(3)).toBe(5);
    expect(falVideoSeconds(5)).toBe(5);
    expect(falVideoSeconds(6)).toBe(10);
    expect(falVideoSeconds(10)).toBe(10);
    expect(falVideoSeconds(15)).toBe(10);
  });

  test('falVideoPriceUsd: $0.35 for 5s, $0.70 for 10s', () => {
    expect(falVideoPriceUsd(5)).toBe(0.35);
    expect(falVideoPriceUsd(10)).toBe(0.7);
  });
});

describe('FalProvider.preflightCost (dollar-denominated)', () => {
  test('image jobs are unsupported -> null', async () => {
    const p = makeProvider(vi.fn());
    const imageSpec: ImageJobSpec = {
      kind: 'image',
      prompt: 'x',
      elementIds: [],
      model: 'nano_banana_2',
      aspectRatio: '16:9',
    };
    expect(await p.preflightCost(imageSpec)).toBeNull();
  });

  test('video jobs return the dollar price for the clamped duration', async () => {
    const p = makeProvider(vi.fn());
    expect(await p.preflightCost(videoSpec({ duration: 4 }))).toBe(0.35); // -> 5s
    expect(await p.preflightCost(videoSpec({ duration: 5 }))).toBe(0.35);
    expect(await p.preflightCost(videoSpec({ duration: 7 }))).toBe(0.7); // -> 10s
    expect(await p.preflightCost(videoSpec({ duration: 15 }))).toBe(0.7); // -> 10s (fal max)
  });
});

describe('FalProvider.submitImage', () => {
  test('throws — fal is a video-only fallback', async () => {
    const fetchImpl = vi.fn();
    const p = makeProvider(fetchImpl);
    await expect(
      p.submitImage({
        kind: 'image',
        prompt: 'x',
        elementIds: [],
        model: 'nano_banana_2',
        aspectRatio: '16:9',
      }),
    ).rejects.toBeInstanceOf(FalError);
    expect(fetchImpl).not.toHaveBeenCalled(); // zero network
  });
});

describe('FalProvider.submitVideo', () => {
  test('POSTs to the Kling queue endpoint with auth + data-URI start image, returns request_id', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonRes({
        request_id: 'req-123',
        status_url: `${SUBMIT_URL}/requests/req-123/status`,
        response_url: `${SUBMIT_URL}/requests/req-123`,
      }),
    );
    const p = makeProvider(fetchImpl);

    const id = await p.submitVideo(videoSpec({ duration: 4 }));
    expect(id).toBe('req-123');
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(SUBMIT_URL);
    expect(init.method).toBe('POST');
    expect(init.headers.authorization).toBe('Key test-key');
    const body = JSON.parse(init.body as string);
    expect(body.prompt).toContain('lighthouse');
    expect(body.duration).toBe('5'); // clamped 4 -> 5, sent as a string enum
    expect(body.image_url).toBe(START_IMAGE_DATA_URI); // local path inlined as data URI
  });

  test('clamps duration 9 -> "10" in the request body', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonRes({ request_id: 'r' }));
    const p = makeProvider(fetchImpl);
    await p.submitVideo(videoSpec({ duration: 9 }));
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body as string);
    expect(body.duration).toBe('10');
  });

  test('passes an http(s) start image through as-is (no inlining)', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonRes({ request_id: 'r' }));
    const p = makeProvider(fetchImpl);
    await p.submitVideo(videoSpec({ startImage: 'https://cdn.example.com/frame.png' }));
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body as string);
    expect(body.image_url).toBe('https://cdn.example.com/frame.png');
  });

  test('throws without a startImage', async () => {
    const fetchImpl = vi.fn();
    const p = makeProvider(fetchImpl);
    await expect(p.submitVideo(videoSpec({ startImage: undefined }))).rejects.toBeInstanceOf(FalError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('missing FAL_KEY throws FalError before any network', async () => {
    const saved = process.env.FAL_KEY;
    delete process.env.FAL_KEY;
    try {
      const fetchImpl = vi.fn();
      const p = new FalProvider(DEFAULT_CONFIG, { fetchImpl: fetchImpl as never }); // no apiKey
      await expect(p.submitVideo(videoSpec())).rejects.toBeInstanceOf(FalError);
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      if (saved !== undefined) process.env.FAL_KEY = saved;
    }
  });

  test('401 -> FalAuthError', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonRes({ detail: 'bad key' }, { status: 401 }));
    const p = makeProvider(fetchImpl);
    await expect(p.submitVideo(videoSpec())).rejects.toBeInstanceOf(FalAuthError);
  });
});

describe('FalProvider.poll', () => {
  async function submit(fetchImpl: ReturnType<typeof vi.fn>) {
    fetchImpl.mockResolvedValueOnce(
      jsonRes({
        request_id: 'req-9',
        status_url: `${SUBMIT_URL}/requests/req-9/status`,
        response_url: `${SUBMIT_URL}/requests/req-9`,
      }),
    );
    const p = makeProvider(fetchImpl);
    await p.submitVideo(videoSpec({ duration: 5 }));
    return p;
  }

  test('maps IN_QUEUE / IN_PROGRESS to queued / in_progress (no result fetch)', async () => {
    const fetchImpl = vi.fn();
    const p = await submit(fetchImpl);

    fetchImpl.mockResolvedValueOnce(jsonRes({ status: 'IN_QUEUE' }));
    expect((await p.poll('req-9')).status).toBe('queued');

    fetchImpl.mockResolvedValueOnce(jsonRes({ status: 'IN_PROGRESS' }));
    expect((await p.poll('req-9')).status).toBe('in_progress');
  });

  test('COMPLETED fetches the result and returns url + dollar charge', async () => {
    const fetchImpl = vi.fn();
    const p = await submit(fetchImpl);

    fetchImpl
      .mockResolvedValueOnce(jsonRes({ status: 'COMPLETED' })) // status
      .mockResolvedValueOnce(jsonRes({ video: { url: 'https://cdn.fal.ai/out/req-9.mp4' } })); // result

    const r = await p.poll('req-9');
    expect(r.status).toBe('completed');
    expect(r.resultUrl).toBe('https://cdn.fal.ai/out/req-9.mp4');
    expect(r.creditsCharged).toBe(0.35); // dollars, deterministic for a 5s clip

    // result fetch hit the response_url
    expect(fetchImpl.mock.calls[2][0]).toBe(`${SUBMIT_URL}/requests/req-9`);
  });

  test('COMPLETED without a video url -> failed', async () => {
    const fetchImpl = vi.fn();
    const p = await submit(fetchImpl);
    fetchImpl
      .mockResolvedValueOnce(jsonRes({ status: 'COMPLETED' }))
      .mockResolvedValueOnce(jsonRes({ detail: 'nsfw content filtered' }));
    const r = await p.poll('req-9');
    expect(r.status).toBe('failed');
    expect(r.error).toContain('nsfw');
  });

  test('FAILED status -> failed with error, no result fetch', async () => {
    const fetchImpl = vi.fn();
    const p = await submit(fetchImpl);
    fetchImpl.mockResolvedValueOnce(jsonRes({ status: 'FAILED', error: 'model exploded' }));
    const r = await p.poll('req-9');
    expect(r.status).toBe('failed');
    expect(r.error).toContain('model exploded');
    expect(fetchImpl).toHaveBeenCalledTimes(2); // submit + status only
  });

  test('unknown job id throws', async () => {
    const p = makeProvider(vi.fn());
    await expect(p.poll('nope')).rejects.toBeInstanceOf(FalError);
  });
});

describe('FalProvider.download', () => {
  test('streams an http result url to destPath', async () => {
    const payload = Buffer.from('fake-mp4-bytes');
    const fetchImpl = vi.fn().mockResolvedValueOnce(binRes(payload));
    const p = makeProvider(fetchImpl);

    const dest = path.join(tmpDir, 'clips', 'out.mp4');
    const out = await p.download(
      { jobId: 'req-9', status: 'completed', resultUrl: 'https://cdn.fal.ai/out.mp4' },
      dest,
    );
    expect(out).toBe(dest);
    expect(fetchImpl).toHaveBeenCalledWith('https://cdn.fal.ai/out.mp4');
    const written = await fsp.readFile(dest);
    expect(written.equals(payload)).toBe(true);
  });

  test('throws when the result has no url', async () => {
    const p = makeProvider(vi.fn());
    await expect(
      p.download({ jobId: 'x', status: 'completed' }, path.join(tmpDir, 'x.mp4')),
    ).rejects.toBeInstanceOf(FalError);
  });

  test('download HTTP error surfaces as FalError', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(binRes(Buffer.alloc(0), { status: 500 }));
    const p = makeProvider(fetchImpl);
    await expect(
      p.download(
        { jobId: 'x', status: 'completed', resultUrl: 'https://cdn.fal.ai/out.mp4' },
        path.join(tmpDir, 'x.mp4'),
      ),
    ).rejects.toBeInstanceOf(FalError);
  });
});
