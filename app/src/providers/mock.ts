/**
 * providers/mock.ts — MockProvider: instant, zero-credit fake GenProvider.
 *
 * The ONLY provider used in development runs and tests (never spends credits).
 * Simulates the async queue model: submit*() returns a UUID job id, poll()
 * flips queued -> in_progress -> completed after a short configurable delay,
 * download() copies a rotating sample from the read-only Phase 0 folder to
 * destPath.
 *
 * Also home of the Phase 0 measured credit table (`measuredPreflightCredits`),
 * used by both providers for preflight estimates.
 */

import { randomUUID } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type {
  GenProvider,
  ImageJobSpec,
  JobResult,
  JobSpec,
  VideoJobSpec,
} from '../types.js';

/** Read-only sample media source (Phase 0 calibration artifacts). */
export const PHASE0_SAMPLE_DIR = path.resolve('C:/Coding/Video Automation/phase0');

const SAMPLE_IMAGES = [
  'A_character_element.png',
  'B_location.png',
  'C_two_elements.png',
] as const;

const SAMPLE_VIDEOS = [
  'V1_kling3_turbo.mp4',
  'V2_kling2_6.mp4',
  'V3_kling3_element.mp4',
] as const;

// ---------------------------------------------------------------------------
// Phase 0 measured credit table (research-and-plan.md, "MEASURED RESULTS",
// reconciled against the transactions ledger on 2026-07-03).
// ---------------------------------------------------------------------------

/** Flat credits per image, by model. */
const IMAGE_CREDITS: Readonly<Record<string, number>> = {
  soul_2: 0.12,
  z_image: 0.15,
  'gpt_image_2-low': 0.5,
  seedream: 1,
  nano_banana_2: 1.5,
  // Requesting nano_banana_2 routes to internal nano_banana_flash (same model/price).
  nano_banana_flash: 1.5,
  nano_banana_pro: 2,
  cinematic_studio_2_5: 2,
};

/** Credits per second of generated video, by model. */
const VIDEO_CREDITS_PER_SECOND: Readonly<Record<string, number>> = {
  kling3_0: 1.25, // std, sound off: charged 6.25/5s (ledger ground truth)
  kling3_0_turbo: 1.5, // linear, 3-15s
  kling2_6: 1, // 5cr/5s, native 1080p
  veo3_1_lite: 1,
  minimax: 1,
  seedance_2_0: 4.5, // std 22.5/5s
  seedance_2_0_mini: 2.5, // mini 12.5/5s
};

/**
 * Expected credits for a job per the Phase 0 measured table, or null for
 * models that were not measured.
 */
export function measuredPreflightCredits(spec: JobSpec): number | null {
  if (spec.kind === 'image') {
    return IMAGE_CREDITS[spec.model] ?? null;
  }
  const perSecond = VIDEO_CREDITS_PER_SECOND[spec.model];
  return perSecond === undefined ? null : perSecond * spec.duration;
}

// ---------------------------------------------------------------------------
// MockProvider
// ---------------------------------------------------------------------------

export interface MockProviderOptions {
  /** ms after submit before poll() reports 'completed' (default 100). */
  pollDelayMs?: number;
  /** Override the sample media folder (default PHASE0_SAMPLE_DIR). */
  sampleDir?: string;
}

interface MockJob {
  id: string;
  kind: 'image' | 'video';
  spec: JobSpec;
  samplePath: string;
  submittedAt: number;
}

function rotate<T>(arr: readonly T[], n: number): T {
  return arr[n % arr.length]!;
}

export class MockProvider implements GenProvider {
  readonly name = 'mock';

  private readonly pollDelayMs: number;
  private readonly sampleDir: string;
  private readonly jobs = new Map<string, MockJob>();
  private imageCount = 0;
  private videoCount = 0;

  constructor(opts: MockProviderOptions = {}) {
    this.pollDelayMs = opts.pollDelayMs ?? 100;
    this.sampleDir = opts.sampleDir ? path.resolve(opts.sampleDir) : PHASE0_SAMPLE_DIR;
  }

  /** Estimates from the Phase 0 measured table; nothing is ever charged. */
  async preflightCost(spec: JobSpec): Promise<number | null> {
    return measuredPreflightCredits(spec);
  }

  async submitImage(spec: ImageJobSpec): Promise<string> {
    const sample = rotate(SAMPLE_IMAGES, this.imageCount++);
    return this.enqueue('image', spec, sample);
  }

  async submitVideo(spec: VideoJobSpec): Promise<string> {
    const sample = rotate(SAMPLE_VIDEOS, this.videoCount++);
    return this.enqueue('video', spec, sample);
  }

  async poll(jobId: string): Promise<JobResult> {
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new Error(`MockProvider.poll: unknown job id ${jobId}`);
    }
    const elapsed = Date.now() - job.submittedAt;
    if (elapsed < this.pollDelayMs) {
      return {
        jobId,
        status: elapsed < this.pollDelayMs / 2 ? 'queued' : 'in_progress',
      };
    }
    return {
      jobId,
      status: 'completed',
      resultUrl: pathToFileURL(job.samplePath).href,
      creditsCharged: 0, // mock never spends credits
    };
  }

  async download(result: JobResult, destPath: string): Promise<string> {
    let src = this.jobs.get(result.jobId)?.samplePath ?? null;
    if (src === null && result.resultUrl) {
      src = result.resultUrl.startsWith('file:')
        ? fileURLToPath(result.resultUrl)
        : result.resultUrl;
    }
    if (src === null) {
      throw new Error(
        `MockProvider.download: unknown job id ${result.jobId} and no resultUrl to copy from`,
      );
    }
    await fsp.mkdir(path.dirname(destPath), { recursive: true });
    await fsp.copyFile(src, destPath); // read-only source, copy to destPath
    result.localPath = destPath;
    return destPath;
  }

  private enqueue(kind: 'image' | 'video', spec: JobSpec, sampleFile: string): string {
    const id = randomUUID();
    this.jobs.set(id, {
      id,
      kind,
      spec,
      samplePath: path.join(this.sampleDir, sampleFile),
      submittedAt: Date.now(),
    });
    return id;
  }
}
