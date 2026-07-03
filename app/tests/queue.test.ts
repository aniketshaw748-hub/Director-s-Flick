import { vi, describe, test, expect, beforeEach, afterEach } from 'vitest';
import { ProjectDb } from '../src/db.js';
import { ShotQueue } from '../src/queue.js';
import type { GenProvider, PromptEngine, Shot, PipelineConfig } from '../src/types.js';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const TEST_PROJECT_NAME = 'temp_test_project_queue';
const TEST_DB_DIR = path.resolve('projects', TEST_PROJECT_NAME);
const TEST_DB_FILE = path.join(TEST_DB_DIR, 'pipeline.db');

describe('queue', () => {
  let db: ProjectDb;

  beforeEach(() => {
    // Stub setTimeout to resolve instantly
    vi.stubGlobal('setTimeout', (fn: Function) => {
      process.nextTick(fn);
    });

    if (fs.existsSync(TEST_DB_DIR)) {
      fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
    }
    fs.mkdirSync(TEST_DB_DIR, { recursive: true });
    db = new ProjectDb(TEST_PROJECT_NAME, TEST_DB_FILE);
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(TEST_DB_DIR)) {
      fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
    }
  });

  test('runs the state machine to completion (auto-approve)', async () => {
    const project = db.ensureProject({
      name: TEST_PROJECT_NAME,
      scriptPath: 'script.txt',
      voPath: 'vo.wav',
    });

    const mockShot: Shot = {
      id: 'shot-queue-1',
      projectId: project.id,
      lineIndex: 0,
      subIndex: 0,
      state: 'PENDING',
      line: {
        index: 0,
        text: 'Hello world.',
        start: 0,
        end: 2.0,
        duration: 2.0,
        pauseAfter: 1.0,
        targetDuration: 3.0,
      },
      elementIds: [],
      attempts: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    db.insertShots([mockShot]);

    // Mock GenProvider with unique job ids
    const mockProvider: GenProvider = {
      name: 'mock',
      preflightCost: async () => 1.5,
      submitImage: async () => `img-job-${randomUUID()}`,
      submitVideo: async () => `vid-job-${randomUUID()}`,
      poll: async (jobId) => ({
        jobId,
        status: 'completed',
        resultUrl: 'file:///mock/result',
        creditsCharged: 1.5,
      }),
      download: async (result, destPath) => destPath,
    };

    // Mock PromptEngine
    const mockPrompts: PromptEngine = {
      imagePromptBatch: async (lines) =>
        lines.map((l) => ({ lineIndex: l.index, imagePrompt: 'mocked image prompt' })),
      animationPrompt: async () => 'mocked animation prompt',
    };

    const config: PipelineConfig = {
      provider: 'mock',
      models: {
        image: 'nano_banana_2',
        video: 'kling3_0',
        videoMode: 'std',
      },
      bufferSize: 5,
      concurrency: 4,
      elementsViaPlaceholders: true,
      aspectRatio: '16:9',
      soundOff: true,
      styleBible: '',
    };

    const queue = new ShotQueue(db, mockProvider, mockPrompts, config);

    // Run queue in auto-approve mode
    await queue.run({ autoApprove: true });

    // Verify all shots are PLACED
    const shots = db.listShots();
    expect(shots).toHaveLength(1);
    expect(shots[0]!.state).toBe('PLACED');
    expect(shots[0]!.imagePrompt).toBe('mocked image prompt');
    expect(shots[0]!.animationPrompt).toBe('mocked animation prompt');

    // Verify EDL is generated
    const edl = db.listEdl();
    expect(edl).toHaveLength(1);
    expect(edl[0]!.shotId).toBe('shot-queue-1');
  });

  test('review verbs: approve, requestEdit, requestRedo, redoAnimation', async () => {
    const project = db.ensureProject({
      name: TEST_PROJECT_NAME,
      scriptPath: 'script.txt',
      voPath: 'vo.wav',
    });

    const mockShot: Shot = {
      id: 'shot-review-1',
      projectId: project.id,
      lineIndex: 1,
      subIndex: 0,
      state: 'IN_REVIEW',
      line: {
        index: 1,
        text: 'Review line text.',
        start: 3.0,
        end: 5.0,
        duration: 2.0,
        pauseAfter: 0.0,
        targetDuration: 2.5,
      },
      elementIds: [],
      attempts: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      imagePrompt: 'original prompt',
      imagePath: 'file:///mock/image.png',
    };

    db.insertShots([mockShot]);

    // Mock GenProvider with unique job ids
    const mockProvider: GenProvider = {
      name: 'mock',
      preflightCost: async () => 1.5,
      submitImage: async () => `img-job-${randomUUID()}`,
      submitVideo: async () => `vid-job-${randomUUID()}`,
      poll: async (jobId) => ({
        jobId,
        status: 'completed',
        resultUrl: 'file:///mock/result',
        creditsCharged: 1.5,
      }),
      download: async (result, destPath) => destPath,
    };

    const mockPrompts: PromptEngine = {
      imagePromptBatch: async (lines) =>
        lines.map((l) => ({ lineIndex: l.index, imagePrompt: 'regenerated image prompt' })),
      animationPrompt: async () => 'anim prompt',
    };

    const config: PipelineConfig = {
      provider: 'mock',
      models: {
        image: 'nano_banana_2',
        video: 'kling3_0',
        videoMode: 'std',
      },
      bufferSize: 5,
      concurrency: 4,
      elementsViaPlaceholders: true,
      aspectRatio: '16:9',
      soundOff: true,
      styleBible: '',
    };

    const queue = new ShotQueue(db, mockProvider, mockPrompts, config);

    // Test approve
    await queue.approve('shot-review-1');
    expect(db.getShot('shot-review-1')!.state).toBe('APPROVED');

    // Reset back to IN_REVIEW for other tests using direct SQL to bypass transition checks
    db.db.prepare("UPDATE shots SET state = 'IN_REVIEW' WHERE id = 'shot-review-1'").run();

    // Test requestEdit
    await queue.requestEdit('shot-review-1', 'make it brighter');
    let shot = db.getShot('shot-review-1')!;
    expect(shot.state).toBe('IMAGE_QUEUED');
    expect(shot.imagePrompt).toBe('original prompt make it brighter');

    // Reset back to IN_REVIEW for other tests
    db.db.prepare("UPDATE shots SET state = 'IN_REVIEW', image_prompt = 'original prompt' WHERE id = 'shot-review-1'").run();

    // Test requestRedo without prompt (should regenerate via PromptEngine)
    await queue.requestRedo('shot-review-1');
    shot = db.getShot('shot-review-1')!;
    expect(shot.state).toBe('IMAGE_QUEUED');
    expect(shot.imagePrompt).toBe('regenerated image prompt');

    // Reset back to IN_REVIEW for other tests
    db.db.prepare("UPDATE shots SET state = 'IN_REVIEW', image_prompt = 'original prompt' WHERE id = 'shot-review-1'").run();

    // Test requestRedo with custom prompt
    await queue.requestRedo('shot-review-1', 'verbatim user prompt');
    shot = db.getShot('shot-review-1')!;
    expect(shot.state).toBe('IMAGE_QUEUED');
    expect(shot.imagePrompt).toBe('verbatim user prompt');

    // Reset back to PLACED to test redoAnimation
    db.db.prepare("UPDATE shots SET state = 'PLACED' WHERE id = 'shot-review-1'").run();

    // Test redoAnimation without prompt
    await queue.redoAnimation('shot-review-1');
    shot = db.getShot('shot-review-1')!;
    expect(shot.state).toBe('VIDEO_QUEUED');
    expect(shot.animationPrompt).toBe('anim prompt');

    // Reset back to PLACED
    db.db.prepare("UPDATE shots SET state = 'PLACED' WHERE id = 'shot-review-1'").run();

    // Test redoAnimation with custom prompt
    await queue.redoAnimation('shot-review-1', 'custom animation prompt');
    shot = db.getShot('shot-review-1')!;
    expect(shot.state).toBe('VIDEO_QUEUED');
    expect(shot.animationPrompt).toBe('custom animation prompt');
  });

  test('constructor throws a clear error for a db with no project row (T-38 BUG 2)', () => {
    // No db.ensureProject() call - simulates openProjectDb() on a name that
    // was never actually created (the queue-poisoning repro: a shell db with
    // schema but no project row). The old `db.getProject()!` non-null
    // assertion let this through silently and crashed much later, deep
    // inside a background run() loop server.ts had already cached.
    const mockProvider: GenProvider = {
      name: 'mock',
      preflightCost: async () => 1.5,
      submitImage: async () => `img-job-${randomUUID()}`,
      submitVideo: async () => `vid-job-${randomUUID()}`,
      poll: async (jobId) => ({ jobId, status: 'completed' }),
      download: async (result, destPath) => destPath,
    };
    const mockPrompts: PromptEngine = {
      imagePromptBatch: async (lines) =>
        lines.map((l) => ({ lineIndex: l.index, imagePrompt: 'x' })),
      animationPrompt: async () => 'x',
    };
    const config: PipelineConfig = {
      provider: 'mock',
      models: { image: 'nano_banana_2', video: 'kling3_0', videoMode: 'std' },
      bufferSize: 5,
      concurrency: 4,
      elementsViaPlaceholders: true,
      aspectRatio: '16:9',
      soundOff: true,
      styleBible: '',
    };

    expect(() => new ShotQueue(db, mockProvider, mockPrompts, config)).toThrow();
  });

  test('tags cost-ledger rows with the servicing provider + currency unit (T-38c)', async () => {
    const project = db.ensureProject({
      name: TEST_PROJECT_NAME,
      scriptPath: 'script.txt',
      voPath: 'vo.wav',
    });

    const mockShot: Shot = {
      id: 'shot-units-1',
      projectId: project.id,
      lineIndex: 0,
      subIndex: 0,
      state: 'PENDING',
      line: {
        index: 0,
        text: 'Unit-tagging test line.',
        start: 0,
        end: 2.0,
        duration: 2.0,
        pauseAfter: 1.0,
        targetDuration: 3.0,
      },
      elementIds: [],
      attempts: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    db.insertShots([mockShot]);

    // A 'fal'-named provider on the video stage should tag video ledger rows
    // 'usd', while the (default 'mock') image stage stays 'credits'.
    const falProvider: GenProvider = {
      name: 'fal',
      preflightCost: async () => 0.35,
      submitImage: async () => {
        throw new Error('fal is video-only');
      },
      submitVideo: async () => `vid-job-${randomUUID()}`,
      poll: async (jobId) => ({ jobId, status: 'completed', creditsCharged: 0.35 }),
      download: async (result, destPath) => destPath,
    };
    const mockImageProvider: GenProvider = {
      name: 'mock',
      preflightCost: async () => 1.5,
      submitImage: async () => `img-job-${randomUUID()}`,
      submitVideo: async () => {
        throw new Error('unused');
      },
      poll: async (jobId) => ({ jobId, status: 'completed', creditsCharged: 1.5 }),
      download: async (result, destPath) => destPath,
    };
    const mockPrompts: PromptEngine = {
      imagePromptBatch: async (lines) =>
        lines.map((l) => ({ lineIndex: l.index, imagePrompt: 'mocked image prompt' })),
      animationPrompt: async () => 'mocked animation prompt',
    };
    const config: PipelineConfig = {
      provider: 'mock',
      models: { image: 'nano_banana_2', video: 'kling3_0', videoMode: 'std' },
      bufferSize: 5,
      concurrency: 4,
      elementsViaPlaceholders: true,
      aspectRatio: '16:9',
      soundOff: true,
      styleBible: '',
    };

    const queue = new ShotQueue(
      db,
      { image: mockImageProvider, video: falProvider },
      mockPrompts,
      config,
    );
    await queue.run({ autoApprove: true });

    const ledger = db.listLedger();
    const imageEntry = ledger.find((e) => e.kind === 'image')!;
    const videoEntry = ledger.find((e) => e.kind === 'video')!;
    expect(imageEntry.provider).toBe('mock');
    expect(imageEntry.unit).toBe('credits');
    expect(videoEntry.provider).toBe('fal');
    expect(videoEntry.unit).toBe('usd');
  });
});
