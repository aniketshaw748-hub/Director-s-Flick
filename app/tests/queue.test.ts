import { vi, describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { ProjectDb } from '../src/db.js';
import { ShotQueue } from '../src/queue.js';
import type { GenProvider, PromptEngine, Shot, PipelineConfig } from '../src/types.js';
import fs from 'node:fs';
import path from 'node:path';

const TEST_PROJECT_NAME = 'temp_test_project_queue';
const TEST_DB_DIR = path.resolve('projects', TEST_PROJECT_NAME);
const TEST_DB_FILE = path.join(TEST_DB_DIR, 'pipeline.db');

describe('queue', () => {
  let db: ProjectDb;

  beforeAll(() => {
    if (fs.existsSync(TEST_DB_DIR)) {
      fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
    }
    fs.mkdirSync(TEST_DB_DIR, { recursive: true });
    db = new ProjectDb(TEST_PROJECT_NAME, TEST_DB_FILE);
  });

  afterAll(() => {
    db.close();
    if (fs.existsSync(TEST_DB_DIR)) {
      fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
    }
  });

  beforeEach(() => {
    // Stub setTimeout to resolve instantly
    vi.stubGlobal('setTimeout', (fn: Function) => {
      process.nextTick(fn);
    });
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

    // Mock GenProvider
    const mockProvider: GenProvider = {
      name: 'mock',
      preflightCost: async () => 1.5,
      submitImage: async () => 'img-job-uuid',
      submitVideo: async () => 'vid-job-uuid',
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
    const project = db.getProject()!;
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
    };

    db.insertShots([mockShot]);

    // Mock GenProvider
    const mockProvider: GenProvider = {
      name: 'mock',
      preflightCost: async () => 1.5,
      submitImage: async () => 'img-job-uuid',
      submitVideo: async () => 'vid-job-uuid-2',
      poll: async (jobId) => ({
        jobId,
        status: 'completed',
        resultUrl: 'file:///mock/result',
        creditsCharged: 1.5,
      }),
      download: async (result, destPath) => destPath,
    };

    const mockPrompts: PromptEngine = {
      imagePromptBatch: async (lines) => [],
      animationPrompt: async () => 'anim prompt',
    };

    const config = db.getProject()!.config;
    const queue = new ShotQueue(db, mockProvider, mockPrompts, config);

    // Test approve
    await queue.approve('shot-review-1');
    expect(db.getShot('shot-review-1')!.state).toBe('APPROVED');

    // Reset back to IN_REVIEW for other tests using direct SQL to bypass transition checks
    db.db.prepare("UPDATE shots SET state = 'IN_REVIEW' WHERE id = 'shot-review-1'").run();

    // Test requestEdit
    await queue.requestEdit('shot-review-1', 'make it brighter');
    let shot = db.getShot('shot-review-1')!;
    expect(shot.state).toBe('PROMPTED');
    expect(shot.imagePrompt).toContain('make it brighter');

    // Reset back to IN_REVIEW for other tests
    db.db.prepare("UPDATE shots SET state = 'IN_REVIEW', image_prompt = NULL WHERE id = 'shot-review-1'").run();

    // Test requestRedo
    await queue.requestRedo('shot-review-1');
    shot = db.getShot('shot-review-1')!;
    expect(shot.state).toBe('PROMPTED');
    expect(shot.imagePrompt).toBeUndefined();

    // Reset back to PLACED to test redoAnimation
    db.db.prepare("UPDATE shots SET state = 'PLACED' WHERE id = 'shot-review-1'").run();

    // Test redoAnimation
    await queue.redoAnimation('shot-review-1', 'new motion');
    shot = db.getShot('shot-review-1')!;
    expect(shot.state).toBe('VIDEO_QUEUED');
    expect(shot.animationPrompt).toBe('new motion');
  });
});
