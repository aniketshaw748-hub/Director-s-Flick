/**
 * stage-providers.test.ts — per-stage provider resolution (T-34).
 *
 * (1) createStageProviders: image/video providers from config.imageProvider /
 *     videoProvider (each falling back to config.provider); same name -> one
 *     shared instance.
 * (2) ShotQueue routing: with a { image, video } pair, image jobs submit/poll/
 *     download via the image provider and video jobs via the video provider —
 *     verified end-to-end on an all-mock (but two distinct instrumented
 *     providers) run driving a shot to PLACED.
 *
 * Fully hermetic: mock providers + a temp SQLite db, no network/ffmpeg/CLI.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ProjectDb } from '../src/db.js';
import { ShotQueue } from '../src/queue.js';
import { createStageProviders } from '../src/providers/index.js';
import { DEFAULT_CONFIG } from '../src/types.js';
import type { GenProvider, PromptEngine, Shot, PipelineConfig } from '../src/types.js';

// --- createStageProviders (pure factory) ------------------------------------

describe('createStageProviders', () => {
  test('default config -> one shared mock instance for both stages', () => {
    const { image, video } = createStageProviders(DEFAULT_CONFIG);
    expect(image.name).toBe('mock');
    expect(video.name).toBe('mock');
    expect(image).toBe(video); // same name -> shared instance
  });

  test('per-stage override: mock images + fal video -> distinct instances', () => {
    const cfg: PipelineConfig = { ...DEFAULT_CONFIG, provider: 'mock', videoProvider: 'fal' };
    const { image, video } = createStageProviders(cfg);
    expect(image.name).toBe('mock');
    expect(video.name).toBe('fal');
    expect(image).not.toBe(video);
  });

  test('imageProvider override falls back to provider for the video stage', () => {
    const cfg: PipelineConfig = { ...DEFAULT_CONFIG, provider: 'higgsfield-cli', imageProvider: 'mock' };
    const { image, video } = createStageProviders(cfg);
    expect(image.name).toBe('mock');
    expect(video.name).toBe('higgsfield-cli'); // falls back to config.provider
  });

  test('same explicit name on both stages -> shared instance', () => {
    const cfg: PipelineConfig = {
      ...DEFAULT_CONFIG,
      provider: 'mock',
      imageProvider: 'higgsfield-cli',
      videoProvider: 'higgsfield-cli',
    };
    const { image, video } = createStageProviders(cfg);
    expect(image.name).toBe('higgsfield-cli');
    expect(video).toBe(image);
  });
});

// --- ShotQueue per-stage routing (end-to-end) -------------------------------

interface SpyProvider extends GenProvider {
  submitImageCount: number;
  submitVideoCount: number;
  polledJobIds: string[];
  downloadedJobIds: string[];
}

/** A mock GenProvider that records which methods/jobs it handled. */
function makeSpyProvider(name: string): SpyProvider {
  const spy: SpyProvider = {
    name,
    submitImageCount: 0,
    submitVideoCount: 0,
    polledJobIds: [],
    downloadedJobIds: [],
    preflightCost: async () => 1.5,
    submitImage: async () => {
      spy.submitImageCount++;
      return `${name}-img-${randomUUID()}`;
    },
    submitVideo: async () => {
      spy.submitVideoCount++;
      return `${name}-vid-${randomUUID()}`;
    },
    poll: async (jobId) => {
      spy.polledJobIds.push(jobId);
      return { jobId, status: 'completed', resultUrl: 'file:///mock/result', creditsCharged: 1.5 };
    },
    download: async (result, destPath) => {
      spy.downloadedJobIds.push(result.jobId);
      return destPath;
    },
  };
  return spy;
}

const mockPrompts: PromptEngine = {
  imagePromptBatch: async (lines) =>
    lines.map((l) => ({ lineIndex: l.index, imagePrompt: 'mocked image prompt' })),
  animationPrompt: async () => 'mocked animation prompt',
};

describe('ShotQueue per-stage provider routing', () => {
  const PROJECT = 'temp_test_project_stage';
  const DIR = path.resolve('projects', PROJECT);
  const DB_FILE = path.join(DIR, 'pipeline.db');
  let db: ProjectDb;

  beforeEach(() => {
    vi.stubGlobal('setTimeout', (fn: Function) => {
      process.nextTick(fn);
    });
    if (fs.existsSync(DIR)) fs.rmSync(DIR, { recursive: true, force: true });
    fs.mkdirSync(DIR, { recursive: true });
    db = new ProjectDb(PROJECT, DB_FILE);
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(DIR)) fs.rmSync(DIR, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  test('image stage uses imageProvider, video stage uses videoProvider (submit + poll + download)', async () => {
    const project = db.ensureProject({ name: PROJECT, scriptPath: 'script.txt', voPath: 'vo.wav' });
    const shot: Shot = {
      id: 'stage-shot-1',
      projectId: project.id,
      lineIndex: 0,
      subIndex: 0,
      state: 'PENDING',
      line: { index: 0, text: 'A line.', start: 0, end: 2, duration: 2, pauseAfter: 1, targetDuration: 3 },
      elementIds: [],
      attempts: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    db.insertShots([shot]);

    const imageProvider = makeSpyProvider('image-mock');
    const videoProvider = makeSpyProvider('video-mock');
    const config: PipelineConfig = { ...DEFAULT_CONFIG };

    const queue = new ShotQueue(db, { image: imageProvider, video: videoProvider }, mockPrompts, config);
    await queue.run({ autoApprove: true });

    const placed = db.getShot('stage-shot-1')!;
    expect(placed.state).toBe('PLACED');
    expect(db.listEdl()).toHaveLength(1);

    // submit routing: each provider only handled its own stage
    expect(imageProvider.submitImageCount).toBe(1);
    expect(imageProvider.submitVideoCount).toBe(0);
    expect(videoProvider.submitVideoCount).toBe(1);
    expect(videoProvider.submitImageCount).toBe(0);

    // poll + download routing by job kind (the image job went to imageProvider,
    // the video job to videoProvider — never crossed)
    expect(imageProvider.polledJobIds).toContain(placed.imageJobId);
    expect(imageProvider.polledJobIds).not.toContain(placed.videoJobId);
    expect(videoProvider.polledJobIds).toContain(placed.videoJobId);
    expect(videoProvider.polledJobIds).not.toContain(placed.imageJobId);
    expect(imageProvider.downloadedJobIds).toContain(placed.imageJobId);
    expect(videoProvider.downloadedJobIds).toContain(placed.videoJobId);
  });

  test('a single provider (back-compat) still drives both stages to PLACED', async () => {
    const project = db.ensureProject({ name: PROJECT, scriptPath: 'script.txt', voPath: 'vo.wav' });
    const shot: Shot = {
      id: 'stage-shot-2',
      projectId: project.id,
      lineIndex: 0,
      subIndex: 0,
      state: 'PENDING',
      line: { index: 0, text: 'A line.', start: 0, end: 2, duration: 2, pauseAfter: 1, targetDuration: 3 },
      elementIds: [],
      attempts: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    db.insertShots([shot]);

    const provider = makeSpyProvider('single-mock');
    const queue = new ShotQueue(db, provider, mockPrompts, { ...DEFAULT_CONFIG });
    await queue.run({ autoApprove: true });

    expect(db.getShot('stage-shot-2')!.state).toBe('PLACED');
    expect(provider.submitImageCount).toBe(1);
    expect(provider.submitVideoCount).toBe(1);
  });
});
