/**
 * providers/replicate.ts — ReplicateProvider: Replicate fallback video
 * GenProvider (Phase 4). Mirrors FalProvider — a VIDEO-ONLY fallback running
 * image-to-video on Replicate's hosted **Kling 2.5 Turbo Pro**
 * (`kwaivgi/kling-v2.5-turbo-pro`) via the prediction REST API. Image
 * generation stays on the Higgsfield path — `submitImage()` throws.
 *
 * Prediction REST model (https://api.replicate.com/v1):
 *   submit  POST /v1/models/{owner}/{name}/predictions  -> { id, status, urls:{ get } }
 *   poll    GET  {urls.get}                             -> { status, output, error }
 *   auth    header  Authorization: Bearer {REPLICATE_API_TOKEN}
 *   status  starting|processing -> queued/in_progress; succeeded -> completed;
 *           failed/canceled -> failed/canceled. `output` is the mp4 URL (string,
 *           or array/{url}).
 *
 * Pricing (verified 2026-07-03, research-and-plan.md Part 1 §3 — Replicate and
 * fal host this model at IDENTICAL pricing): **$0.35 per 5s clip + $0.07 per
 * extra second**. Replicate's Kling duration is enum-locked to **5 or 10s**, so
 * a shot's requested duration is clamped UP to the nearest of {5,10} and the
 * exact per-line trim happens at export (media.ts). This provider's ledger is
 * denominated in **US dollars** (preflightCost + poll().creditsCharged).
 *
 * Hermetic by construction: every network call goes through an injectable
 * `fetch` (default: global `fetch`). Tests pass a mock — NO live calls; live
 * validation is Fable's, behind REPLICATE_API_TOKEN.
 */

import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  GenProvider,
  ImageJobSpec,
  JobResult,
  JobSpec,
  JobStatus,
  PipelineConfig,
  VideoJobSpec,
} from '../types.js';

// ---------------------------------------------------------------------------
// Constants + pricing
// ---------------------------------------------------------------------------

/** Replicate REST base. */
export const REPLICATE_API_BASE = 'https://api.replicate.com/v1';

/** Kling 2.5 Turbo Pro image-to-video model on Replicate (owner/name). */
export const REPLICATE_KLING_25_TURBO_PRO = 'kwaivgi/kling-v2.5-turbo-pro';

/** $0.35 base (covers the first 5s) + $0.07 per second beyond 5. */
const REPLICATE_BASE_PRICE_USD = 0.35;
const REPLICATE_PER_EXTRA_SECOND_USD = 0.07;

/**
 * Replicate's Kling image-to-video duration is enum-locked to 5 or 10 seconds.
 * Clamp the requested (kling3_0 3–15s) duration UP to the nearest legal value;
 * the export step trims each clip to its exact fractional targetDuration.
 */
export function replicateVideoSeconds(requested: number): 5 | 10 {
  return requested <= 5 ? 5 : 10;
}

/** Deterministic dollar price for a Replicate Kling clip of the given (5|10) seconds. */
export function replicateVideoPriceUsd(seconds: 5 | 10): number {
  return Number(
    (REPLICATE_BASE_PRICE_USD + REPLICATE_PER_EXTRA_SECOND_USD * (seconds - 5)).toFixed(2),
  );
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class ReplicateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReplicateError';
  }
}

/** 401/403 from Replicate — a bad/missing token. Distinct so callers can surface re-auth. */
export class ReplicateAuthError extends ReplicateError {
  constructor(detail?: string) {
    super(`Replicate authentication failed${detail ? ` (${detail})` : ''}. Check REPLICATE_API_TOKEN.`);
    this.name = 'ReplicateAuthError';
  }
}

// ---------------------------------------------------------------------------
// Small JSON helpers
// ---------------------------------------------------------------------------

type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** Replicate prediction status -> our JobStatus. */
function mapStatus(raw: string | null): JobStatus {
  switch ((raw ?? '').toLowerCase()) {
    case 'starting':
      return 'queued';
    case 'processing':
      return 'in_progress';
    case 'succeeded':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'canceled':
    case 'cancelled':
      return 'canceled';
    default:
      return 'in_progress';
  }
}

/**
 * The video URL from a Replicate prediction's `output`, which for a video model
 * is a URL string, an array of URL strings, or an object with a `url`.
 */
function pickOutputUrl(json: unknown): string | null {
  if (!isRecord(json)) return null;
  const out = json['output'];
  const fromValue = (v: unknown): string | null => {
    if (typeof v === 'string') return /^https?:\/\//i.test(v) ? v : null;
    if (Array.isArray(v)) {
      for (const item of v) {
        const u = fromValue(item);
        if (u) return u;
      }
      return null;
    }
    if (isRecord(v)) return str(v['url']);
    return null;
  };
  return fromValue(out);
}

function pickError(json: unknown): string | null {
  if (!isRecord(json)) return null;
  for (const key of ['error', 'detail', 'title']) {
    const v = json[key];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}

function mimeForExt(ext: string): string {
  switch (ext.toLowerCase()) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.webp':
      return 'image/webp';
    default:
      return 'image/png';
  }
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export interface ReplicateProviderOptions {
  /** Replicate API token. Default: process.env.REPLICATE_API_TOKEN. */
  apiToken?: string;
  /** Injected fetch (default: global fetch). Tests pass a mock — no live calls. */
  fetchImpl?: FetchImpl;
  /** Override the model (owner/name, default: Kling 2.5 Turbo Pro). */
  videoModel?: string;
  /** Override the REST base URL (default: https://api.replicate.com/v1). */
  apiBase?: string;
}

interface ReplicateJob {
  id: string;
  getUrl: string;
  /** deterministic dollar price for this clip (Replicate pricing is fixed by duration). */
  priceUsd: number;
}

export class ReplicateProvider implements GenProvider {
  readonly name = 'replicate';

  private readonly config: PipelineConfig;
  private readonly apiToken: string | undefined;
  private readonly fetchImpl: FetchImpl;
  private readonly videoModel: string;
  private readonly apiBase: string;
  private readonly jobs = new Map<string, ReplicateJob>();

  constructor(config: PipelineConfig, opts: ReplicateProviderOptions = {}) {
    this.config = config;
    this.apiToken = opts.apiToken ?? process.env.REPLICATE_API_TOKEN;
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
    this.videoModel = opts.videoModel ?? REPLICATE_KLING_25_TURBO_PRO;
    this.apiBase = (opts.apiBase ?? REPLICATE_API_BASE).replace(/\/+$/, '');
  }

  /**
   * Dollar-denominated preflight. Image jobs are unsupported by this fallback
   * (null); video jobs cost `replicateVideoPriceUsd(replicateVideoSeconds(duration))`.
   */
  async preflightCost(spec: JobSpec): Promise<number | null> {
    if (spec.kind === 'image') return null;
    return replicateVideoPriceUsd(replicateVideoSeconds(spec.duration));
  }

  async submitImage(_spec: ImageJobSpec): Promise<string> {
    throw new ReplicateError(
      'ReplicateProvider is a video-only fallback (Kling 2.5 Turbo Pro image-to-video). ' +
        'Image generation stays on the Higgsfield provider.',
    );
  }

  async submitVideo(spec: VideoJobSpec): Promise<string> {
    if (!spec.startImage) {
      throw new ReplicateError(
        'ReplicateProvider video jobs require a startImage (Kling image-to-video needs a first frame).',
      );
    }
    const seconds = replicateVideoSeconds(spec.duration);
    const body = {
      input: {
        prompt: spec.prompt,
        start_image: await this.imageInput(spec.startImage),
        duration: seconds, // Replicate Kling duration is an integer enum: 5 | 10
      },
    };

    const submitUrl = `${this.apiBase}/models/${this.videoModel}/predictions`;
    const res = await this.fetchImpl(submitUrl, {
      method: 'POST',
      headers: { ...this.authHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await this.readJson(res, 'submit');

    const id = isRecord(json) ? str(json['id']) : null;
    if (!id) {
      throw new ReplicateError(
        `Replicate submit returned no prediction id: ${JSON.stringify(json).slice(0, 200)}`,
      );
    }
    const urls = isRecord(json) ? json['urls'] : null;
    const getUrl = (isRecord(urls) && str(urls['get'])) || `${this.apiBase}/predictions/${id}`;

    this.jobs.set(id, { id, getUrl, priceUsd: replicateVideoPriceUsd(seconds) });
    return id;
  }

  async poll(jobId: string): Promise<JobResult> {
    const job = this.jobs.get(jobId);
    if (!job) throw new ReplicateError(`ReplicateProvider.poll: unknown job id ${jobId}`);

    const res = await this.fetchImpl(job.getUrl, { headers: this.authHeaders() });
    const json = await this.readJson(res, 'status');
    const status = mapStatus(isRecord(json) ? str(json['status']) : null);

    if (status === 'failed' || status === 'canceled') {
      return { jobId, status, error: pickError(json) ?? `Replicate reported ${status}` };
    }
    if (status !== 'completed') {
      return { jobId, status };
    }

    // Succeeded: the prediction payload carries the output url inline.
    const url = pickOutputUrl(json);
    if (!url) {
      return {
        jobId,
        status: 'failed',
        error: pickError(json) ?? 'Replicate succeeded but the output carried no video url',
      };
    }
    // Replicate pricing is deterministic (fixed per duration), so the preflight
    // price IS the charge — record it in dollars for ledger reconciliation.
    return { jobId, status: 'completed', resultUrl: url, creditsCharged: job.priceUsd };
  }

  async download(result: JobResult, destPath: string): Promise<string> {
    const url = result.resultUrl;
    if (!url) {
      throw new ReplicateError(
        `ReplicateProvider.download: job ${result.jobId} has no resultUrl (status=${result.status})`,
      );
    }
    await fsp.mkdir(path.dirname(destPath), { recursive: true });
    if (/^https?:\/\//i.test(url)) {
      const res = await this.fetchImpl(url);
      if (!res.ok) {
        throw new ReplicateError(
          `Replicate download failed: HTTP ${res.status} ${res.statusText} for ${url}`,
        );
      }
      const buf = Buffer.from(await res.arrayBuffer());
      await fsp.writeFile(destPath, buf);
    } else {
      const src = url.startsWith('file:') ? fileURLToPath(url) : url;
      await fsp.copyFile(src, destPath);
    }
    result.localPath = destPath;
    return destPath;
  }

  // -- internals --------------------------------------------------------------

  private authHeaders(): Record<string, string> {
    if (!this.apiToken) {
      throw new ReplicateError(
        'REPLICATE_API_TOKEN is not set — cannot call Replicate. Set the REPLICATE_API_TOKEN environment variable.',
      );
    }
    return { authorization: `Bearer ${this.apiToken}` };
  }

  /**
   * Replicate needs `start_image` as a URL. http(s) URLs and data: URIs pass
   * through; a local path is read and inlined as a base64 data URI (no separate
   * upload round-trip, and fully mockable in tests).
   */
  private async imageInput(startImage: string): Promise<string> {
    if (/^https?:\/\//i.test(startImage) || startImage.startsWith('data:')) {
      return startImage;
    }
    const abs = startImage.startsWith('file:') ? fileURLToPath(startImage) : startImage;
    const buf = await fsp.readFile(abs);
    const mime = mimeForExt(path.extname(abs));
    return `data:${mime};base64,${buf.toString('base64')}`;
  }

  private async readJson(res: Response, phase: string): Promise<unknown> {
    if (res.status === 401 || res.status === 403) {
      throw new ReplicateAuthError(`HTTP ${res.status} on ${phase}`);
    }
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      /* non-JSON body */
    }
    // Replicate returns 201 on create, 200 on get.
    if (!res.ok) {
      throw new ReplicateError(
        `Replicate ${phase} failed: HTTP ${res.status} ${res.statusText}` +
          (pickError(body) ? ` — ${pickError(body)}` : ''),
      );
    }
    return body;
  }
}
