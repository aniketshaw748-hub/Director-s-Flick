/**
 * providers/fal.ts — FalProvider: fal.ai fallback video GenProvider (Phase 4).
 *
 * A VIDEO-ONLY fallback that runs image-to-video on fal.ai's hosted
 * **Kling 2.5 Turbo Pro** endpoint via fal's async **queue** REST API. Image
 * generation stays on the Higgsfield path — `submitImage()` throws.
 *
 * Queue REST model (https://queue.fal.run):
 *   submit  POST {base}/{model}                                  -> { request_id, status_url, response_url }
 *   status  GET  {base}/{model}/requests/{id}/status             -> { status: IN_QUEUE|IN_PROGRESS|COMPLETED }
 *   result  GET  {base}/{model}/requests/{id}                    -> { video: { url } }
 *   auth    header  Authorization: Key {FAL_KEY}
 *
 * Pricing (verified 2026-07-03, research-and-plan.md Part 1 §3): **$0.35 per 5s
 * clip + $0.07 per extra second**. fal's Kling duration is enum-locked to
 * **5 or 10 seconds**, so a shot's requested duration is clamped UP to the
 * nearest of {5,10} and the exact per-line trim happens at export (media.ts).
 * The cost ledger for this provider is denominated in **US dollars**, not
 * Higgsfield credits (preflightCost + poll().creditsCharged both return $).
 *
 * Hermetic by construction: every network call goes through an injectable
 * `fetch` (default: global `fetch`). Tests pass a mock — NO live calls happen
 * from tests or default runs; live validation is Fable's, behind FAL_KEY.
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

/** fal async queue base. */
export const FAL_QUEUE_BASE = 'https://queue.fal.run';

/** Kling 2.5 Turbo Pro image-to-video model id on fal. */
export const FAL_KLING_25_TURBO_PRO_I2V = 'fal-ai/kling-video/v2.5-turbo/pro/image-to-video';

/** $0.35 base (covers the first 5s) + $0.07 per second beyond 5. */
const FAL_BASE_PRICE_USD = 0.35;
const FAL_PER_EXTRA_SECOND_USD = 0.07;

/**
 * fal's Kling image-to-video duration is enum-locked to 5 or 10 seconds.
 * Clamp the requested (kling3_0 3–15s) duration UP to the nearest legal value;
 * the export step trims each clip to its exact fractional targetDuration.
 */
export function falVideoSeconds(requested: number): 5 | 10 {
  return requested <= 5 ? 5 : 10;
}

/** Deterministic dollar price for a fal Kling clip of the given (5|10) seconds. */
export function falVideoPriceUsd(seconds: 5 | 10): number {
  return Number((FAL_BASE_PRICE_USD + FAL_PER_EXTRA_SECOND_USD * (seconds - 5)).toFixed(2));
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class FalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FalError';
  }
}

/** 401/403 from fal — a bad/missing FAL_KEY. Distinct so callers can surface re-auth. */
export class FalAuthError extends FalError {
  constructor(detail?: string) {
    super(`fal.ai authentication failed${detail ? ` (${detail})` : ''}. Check FAL_KEY.`);
    this.name = 'FalAuthError';
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

/** fal status string -> our JobStatus. */
function mapStatus(raw: string | null): JobStatus {
  switch ((raw ?? '').toUpperCase()) {
    case 'IN_QUEUE':
    case 'QUEUED':
      return 'queued';
    case 'IN_PROGRESS':
    case 'PROCESSING':
      return 'in_progress';
    case 'COMPLETED':
    case 'OK':
      return 'completed';
    case 'ERROR':
    case 'FAILED':
      return 'failed';
    case 'CANCELED':
    case 'CANCELLED':
      return 'canceled';
    default:
      return 'in_progress';
  }
}

/** Find the media URL in a fal result payload ({ video: { url } }, video_url, …). */
function pickVideoUrl(json: unknown): string | null {
  if (!isRecord(json)) return null;
  const video = json['video'];
  if (isRecord(video)) {
    const u = str(video['url']);
    if (u) return u;
  }
  for (const key of ['video_url', 'url', 'output_url']) {
    const u = str(json[key]);
    if (u) return u;
  }
  // { videos: [{ url }] } / { output: { video: { url } } }
  const videos = json['videos'];
  if (Array.isArray(videos) && isRecord(videos[0])) {
    const u = str(videos[0]['url']);
    if (u) return u;
  }
  const output = json['output'];
  if (isRecord(output)) return pickVideoUrl(output);
  return null;
}

function pickError(json: unknown): string | null {
  if (!isRecord(json)) return null;
  for (const key of ['error', 'detail', 'message', 'reason']) {
    const v = json[key];
    if (typeof v === 'string' && v.length > 0) return v;
    // fal validation errors: { detail: [{ msg }] }
    if (Array.isArray(v) && isRecord(v[0]) && typeof v[0]['msg'] === 'string') {
      return v[0]['msg'] as string;
    }
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

export interface FalProviderOptions {
  /** fal API key. Default: process.env.FAL_KEY. */
  apiKey?: string;
  /** Injected fetch (default: global fetch). Tests pass a mock — no live calls. */
  fetchImpl?: FetchImpl;
  /** Override the video model id (default: Kling 2.5 Turbo Pro image-to-video). */
  videoModelId?: string;
  /** Override the queue base URL (default: https://queue.fal.run). */
  queueBase?: string;
}

interface FalJob {
  requestId: string;
  statusUrl: string;
  responseUrl: string;
  /** deterministic dollar price for this clip (fal pricing is fixed by duration). */
  priceUsd: number;
}

export class FalProvider implements GenProvider {
  readonly name = 'fal';

  private readonly config: PipelineConfig;
  private readonly apiKey: string | undefined;
  private readonly fetchImpl: FetchImpl;
  private readonly videoModelId: string;
  private readonly queueBase: string;
  private readonly jobs = new Map<string, FalJob>();

  constructor(config: PipelineConfig, opts: FalProviderOptions = {}) {
    this.config = config;
    this.apiKey = opts.apiKey ?? process.env.FAL_KEY;
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
    this.videoModelId = opts.videoModelId ?? FAL_KLING_25_TURBO_PRO_I2V;
    this.queueBase = (opts.queueBase ?? FAL_QUEUE_BASE).replace(/\/+$/, '');
  }

  /**
   * Dollar-denominated preflight. Image jobs are unsupported by this fallback
   * (null); video jobs cost `falVideoPriceUsd(falVideoSeconds(duration))`.
   */
  async preflightCost(spec: JobSpec): Promise<number | null> {
    if (spec.kind === 'image') return null;
    return falVideoPriceUsd(falVideoSeconds(spec.duration));
  }

  async submitImage(_spec: ImageJobSpec): Promise<string> {
    throw new FalError(
      'FalProvider is a video-only fallback (Kling 2.5 Turbo Pro image-to-video). ' +
        'Image generation stays on the Higgsfield provider.',
    );
  }

  async submitVideo(spec: VideoJobSpec): Promise<string> {
    if (!spec.startImage) {
      throw new FalError(
        'FalProvider video jobs require a startImage (Kling image-to-video needs a first frame).',
      );
    }
    const seconds = falVideoSeconds(spec.duration);
    const input = {
      prompt: spec.prompt,
      image_url: await this.imageInput(spec.startImage),
      duration: String(seconds), // fal duration enum is a string: "5" | "10"
      // fal ignores aspect_ratio when image_url is provided; omit it.
    };

    const submitUrl = `${this.queueBase}/${this.videoModelId}`;
    const res = await this.fetchImpl(submitUrl, {
      method: 'POST',
      headers: { ...this.authHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
    const json = await this.readJson(res, 'submit');

    const requestId = isRecord(json) ? str(json['request_id']) : null;
    if (!requestId) {
      throw new FalError(`fal submit returned no request_id: ${JSON.stringify(json).slice(0, 200)}`);
    }
    const base = `${submitUrl}/requests/${requestId}`;
    const statusUrl = (isRecord(json) && str(json['status_url'])) || `${base}/status`;
    const responseUrl = (isRecord(json) && str(json['response_url'])) || base;

    this.jobs.set(requestId, {
      requestId,
      statusUrl,
      responseUrl,
      priceUsd: falVideoPriceUsd(seconds),
    });
    return requestId;
  }

  async poll(jobId: string): Promise<JobResult> {
    const job = this.jobs.get(jobId);
    if (!job) throw new FalError(`FalProvider.poll: unknown job id ${jobId}`);

    const res = await this.fetchImpl(job.statusUrl, { headers: this.authHeaders() });
    const statusJson = await this.readJson(res, 'status');
    const status = mapStatus(isRecord(statusJson) ? str(statusJson['status']) : null);

    if (status === 'failed' || status === 'canceled') {
      return { jobId, status, error: pickError(statusJson) ?? `fal reported ${status}` };
    }
    if (status !== 'completed') {
      return { jobId, status };
    }

    // Completed: fetch the result payload for the media URL.
    const resultRes = await this.fetchImpl(job.responseUrl, { headers: this.authHeaders() });
    const resultJson = await this.readJson(resultRes, 'result');
    const url = pickVideoUrl(resultJson);
    if (!url) {
      return {
        jobId,
        status: 'failed',
        error: pickError(resultJson) ?? 'fal COMPLETED but the result carried no video url',
      };
    }
    // fal pricing is deterministic (fixed per duration), so the preflight price
    // IS the charge — record it in dollars for ledger reconciliation.
    return { jobId, status: 'completed', resultUrl: url, creditsCharged: job.priceUsd };
  }

  async download(result: JobResult, destPath: string): Promise<string> {
    const url = result.resultUrl;
    if (!url) {
      throw new FalError(
        `FalProvider.download: job ${result.jobId} has no resultUrl (status=${result.status})`,
      );
    }
    await fsp.mkdir(path.dirname(destPath), { recursive: true });
    if (/^https?:\/\//i.test(url)) {
      const res = await this.fetchImpl(url);
      if (!res.ok) {
        throw new FalError(`fal download failed: HTTP ${res.status} ${res.statusText} for ${url}`);
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
    if (!this.apiKey) {
      throw new FalError('FAL_KEY is not set — cannot call fal.ai. Set the FAL_KEY environment variable.');
    }
    return { authorization: `Key ${this.apiKey}` };
  }

  /**
   * fal needs `image_url` as a URL. http(s) URLs and data: URIs pass through;
   * a local path is read and inlined as a base64 data URI (no separate upload
   * round-trip, and fully mockable in tests).
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
      throw new FalAuthError(`HTTP ${res.status} on ${phase}`);
    }
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      /* non-JSON body */
    }
    if (!res.ok) {
      throw new FalError(
        `fal ${phase} failed: HTTP ${res.status} ${res.statusText}` +
          (pickError(body) ? ` — ${pickError(body)}` : ''),
      );
    }
    return body;
  }
}
