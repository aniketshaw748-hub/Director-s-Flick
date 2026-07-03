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

  function baseConfig(overrides?: Partial<PipelineConfig>): PipelineConfig {
    return {
      provider: 'mock',
      models: { image: 'nano_banana_2', video: 'kling3_0', videoMode: 'std' },
      bufferSize: 20,
      concurrency: 4,
      elementsViaPlaceholders: true,
      aspectRatio: '16:9',
      soundOff: true,
      styleBible: '',
      ...overrides,
    };
  }

  test('nsfw: one sanitized retry succeeds and the sanitized prompt sticks (T-37)', async () => {
    const project = db.ensureProject({
      name: TEST_PROJECT_NAME,
      scriptPath: 'script.txt',
      voPath: 'vo.wav',
    });
    const mockShot: Shot = {
      id: 'shot-nsfw-1',
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
    db.insertShots([mockShot]);

    let imageJobCount = 0;
    const provider: GenProvider = {
      name: 'mock',
      preflightCost: async () => 1.5,
      submitImage: async () => {
        imageJobCount++;
        return `img-job-${imageJobCount}`;
      },
      submitVideo: async () => `vid-job-${randomUUID()}`,
      poll: async (jobId) =>
        jobId === 'img-job-1'
          ? { jobId, status: 'nsfw', error: 'flagged' }
          : { jobId, status: 'completed', resultUrl: 'file:///mock/result', creditsCharged: 1.5 },
      download: async (result, destPath) => destPath,
    };
    const prompts: PromptEngine = {
      imagePromptBatch: async (lines) =>
        lines.map((l) => ({
          lineIndex: l.index,
          imagePrompt: l.text.includes('keep the depiction strictly modest') ? 'SANITIZED PROMPT' : 'original prompt',
        })),
      animationPrompt: async () => 'anim prompt',
    };

    const queue = new ShotQueue(db, provider, prompts, baseConfig());
    await queue.run({ autoApprove: true });

    const shot = db.getShot('shot-nsfw-1')!;
    expect(shot.state).toBe('PLACED');
    expect(shot.imagePrompt).toBe('SANITIZED PROMPT');
    expect(shot.lastError).toBeUndefined();
    expect(imageJobCount).toBe(2); // 1 original (nsfw) + 1 sanitized retry
  });

  test('nsfw: a second flag after the sanitized retry gives up permanently with a clear error (T-37)', async () => {
    const project = db.ensureProject({
      name: TEST_PROJECT_NAME,
      scriptPath: 'script.txt',
      voPath: 'vo.wav',
    });
    const mockShot: Shot = {
      id: 'shot-nsfw-2',
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
    db.insertShots([mockShot]);

    let imageJobCount = 0;
    const provider: GenProvider = {
      name: 'mock',
      preflightCost: async () => 1.5,
      submitImage: async () => {
        imageJobCount++;
        return `img-job-${imageJobCount}`;
      },
      submitVideo: async () => `vid-job-${randomUUID()}`,
      poll: async (jobId) => ({ jobId, status: 'nsfw', error: 'flagged' }), // always flagged
      download: async (result, destPath) => destPath,
    };
    const prompts: PromptEngine = {
      imagePromptBatch: async (lines) => lines.map((l) => ({ lineIndex: l.index, imagePrompt: 'a prompt' })),
      animationPrompt: async () => 'anim prompt',
    };

    const queue = new ShotQueue(db, provider, prompts, baseConfig());
    await queue.run({ autoApprove: true });

    const shot = db.getShot('shot-nsfw-2')!;
    expect(shot.state).toBe('FAILED');
    expect(shot.attempts).toBe(3); // short-circuits the generic FAILED-retry loop
    expect(shot.lastError).toContain('manual review');
    expect(imageJobCount).toBe(2); // exactly one sanitized retry attempted, never more
  });

  test('adaptive concurrency backs off a stage under repeated failures and restores once it recovers (T-37)', async () => {
    const project = db.ensureProject({
      name: TEST_PROJECT_NAME,
      scriptPath: 'script.txt',
      voPath: 'vo.wav',
    });
    const shots: Shot[] = Array.from({ length: 6 }, (_, i) => ({
      id: `shot-backoff-${i}`,
      projectId: project.id,
      lineIndex: i,
      subIndex: 0,
      state: 'PROMPTED',
      line: { index: i, text: `Line ${i}.`, start: i * 3, end: i * 3 + 2, duration: 2, pauseAfter: 1, targetDuration: 3 },
      elementIds: [],
      imagePrompt: `prompt ${i}`,
      attempts: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }));
    db.insertShots(shots);

    let imageJobCounter = 0;
    let imagePollInvocations = 0;
    // Fails the first 10 image polls (spread across however many jobs are
    // open at the time - the backoff cap itself controls that), then
    // succeeds forever after - lets one run exercise both "engage" (a
    // sustained run of failures) and "restore" (concurrency opens back up
    // the moment a success lands).
    const FAIL_UNTIL = 10;
    const openCountAtSubmitTime: number[] = [];
    const provider: GenProvider = {
      name: 'mock',
      preflightCost: async () => 1.5,
      submitImage: async () => {
        openCountAtSubmitTime.push(db.listOpenJobs().filter((j) => j.kind === 'image').length);
        imageJobCounter++;
        return `img-job-${imageJobCounter}`;
      },
      submitVideo: async () => `vid-job-${randomUUID()}`,
      poll: async (jobId) => {
        if (jobId.startsWith('img-job-')) {
          imagePollInvocations++;
          if (imagePollInvocations <= FAIL_UNTIL) {
            return { jobId, status: 'failed', error: 'simulated provider error' };
          }
          return { jobId, status: 'completed', resultUrl: 'file:///mock/result', creditsCharged: 1.5 };
        }
        return { jobId, status: 'completed', resultUrl: 'file:///mock/result', creditsCharged: 1.5 };
      },
      download: async (result, destPath) => destPath,
    };
    const prompts: PromptEngine = {
      imagePromptBatch: async (lines) => lines.map((l) => ({ lineIndex: l.index, imagePrompt: 'x' })),
      animationPrompt: async () => 'anim prompt',
    };

    const queue = new ShotQueue(db, provider, prompts, baseConfig());
    await queue.run({ autoApprove: true });

    // Engage: somewhere in the middle there must be a sustained run of
    // submissions that see 0 other same-stage jobs open at once (proves the
    // stage was throttled to 1-at-a-time despite several eligible shots
    // waiting), well short of the full 6-shot concurrency the config allows.
    let zeroRunStart = -1;
    let zeroRunLen = 0;
    for (let i = 0; i < openCountAtSubmitTime.length; i++) {
      if (openCountAtSubmitTime[i] === 0) {
        if (zeroRunStart === -1) zeroRunStart = i;
        zeroRunLen++;
        if (zeroRunLen >= 3) break;
      } else {
        zeroRunStart = -1;
        zeroRunLen = 0;
      }
    }
    expect(zeroRunLen).toBeGreaterThanOrEqual(3);

    // Restore: once a success lands, later submissions burst back to more
    // than 1 concurrently open same-stage job - the cap was lifted, not
    // permanently stuck.
    const afterZeroRun = openCountAtSubmitTime.slice(zeroRunStart + zeroRunLen);
    expect(afterZeroRun.some((c) => c >= 2)).toBe(true);
  });

  test('video-provider fallback hook fails over after repeated video failures when configured (T-37)', async () => {
    const project = db.ensureProject({
      name: TEST_PROJECT_NAME,
      scriptPath: 'script.txt',
      voPath: 'vo.wav',
    });
    // Two APPROVED shots so consecutive video failures can accumulate past
    // the failover threshold before either shot exhausts its own 3-attempt
    // retry cap (a single shot alone would give up too soon to reach it).
    const shots: Shot[] = ['a', 'b'].map((suffix, i) => ({
      id: `shot-fallback-${suffix}`,
      projectId: project.id,
      lineIndex: i,
      subIndex: 0,
      state: 'APPROVED',
      line: { index: i, text: `Line ${i}.`, start: i * 3, end: i * 3 + 2, duration: 2, pauseAfter: 1, targetDuration: 3 },
      elementIds: [],
      imagePath: 'file:///mock/image.png',
      animationPrompt: `anim ${i}`,
      attempts: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }));
    db.insertShots(shots);

    const primaryProvider: GenProvider = {
      name: 'higgsfield-cli',
      preflightCost: async () => 6.25,
      submitImage: async () => {
        throw new Error('unused');
      },
      submitVideo: async () => `vid-job-${randomUUID()}`,
      poll: async (jobId) => ({ jobId, status: 'failed', error: 'simulated provider outage' }),
      download: async (result, destPath) => destPath,
    };
    const fallbackProvider: GenProvider = {
      name: 'fal',
      preflightCost: async () => 0.35,
      submitImage: async () => {
        throw new Error('fal is video-only');
      },
      submitVideo: async () => `fal-job-${randomUUID()}`,
      poll: async (jobId) => ({ jobId, status: 'completed', resultUrl: 'file:///mock/result', creditsCharged: 0.35 }),
      download: async (result, destPath) => destPath,
    };
    const prompts: PromptEngine = {
      imagePromptBatch: async (lines) => lines.map((l) => ({ lineIndex: l.index, imagePrompt: 'x' })),
      animationPrompt: async () => 'anim prompt',
    };

    const queue = new ShotQueue(
      db,
      primaryProvider,
      prompts,
      baseConfig(),
      undefined, // accountName
      fallbackProvider, // T-37 videoProviderFallback
    );
    await queue.run({ autoApprove: true });

    // The fallback must actually have been used for at least one video job
    // (visible via the T-38c provider tag on the ledger row it wrote).
    const videoLedgerEntries = db.listLedger().filter((e) => e.kind === 'video');
    expect(videoLedgerEntries.some((e) => e.provider === 'fal')).toBe(true);
  });

  test('H4: review-ahead buffer never overshoots bufferSize even with ample concurrency (T-40 finding)', async () => {
    const project = db.ensureProject({
      name: TEST_PROJECT_NAME,
      scriptPath: 'script.txt',
      voPath: 'vo.wav',
    });
    const shots: Shot[] = Array.from({ length: 12 }, (_, i) => ({
      id: `shot-buffer-${i}`,
      projectId: project.id,
      lineIndex: i,
      subIndex: 0,
      state: 'PENDING',
      line: { index: i, text: `Line ${i}.`, start: i * 3, end: i * 3 + 2, duration: 2, pauseAfter: 1, targetDuration: 3 },
      elementIds: [],
      attempts: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }));
    db.insertShots(shots);

    // Measured live (Fable-2's T-40 walkthrough): bufferSize=5 but 8 shots
    // reached IN_REVIEW - the old undercounted, frozen-per-tick budget check
    // let a whole burst of submissions land before any were visible in it.
    const inBufferStates = new Set(['IMAGE_QUEUED', 'IMAGE_READY', 'IN_REVIEW']);
    let maxInBuffer = 0;
    const provider: GenProvider = {
      name: 'mock',
      preflightCost: async () => 1.5,
      submitImage: async () => {
        const before = db.listShots().filter((s) => inBufferStates.has(s.state)).length;
        maxInBuffer = Math.max(maxInBuffer, before + 1); // +1: this submission is about to join the buffer
        return `img-job-${randomUUID()}`;
      },
      submitVideo: async () => `vid-job-${randomUUID()}`,
      poll: async (jobId) => ({ jobId, status: 'completed', resultUrl: 'file:///mock/result', creditsCharged: 1.5 }),
      download: async (result, destPath) => destPath,
    };
    const prompts: PromptEngine = {
      imagePromptBatch: async (lines) => lines.map((l) => ({ lineIndex: l.index, imagePrompt: 'x' })),
      animationPrompt: async () => 'anim prompt',
    };

    const queue = new ShotQueue(db, provider, prompts, baseConfig({ bufferSize: 3, concurrency: 8 }));
    await queue.run({ autoApprove: true });

    expect(maxInBuffer).toBeLessThanOrEqual(3);
    // Sanity: the whole 12-shot pipeline still fully drains despite the
    // tighter budget - throttled, not stuck.
    expect(db.listShots().every((s) => s.state === 'PLACED')).toBe(true);
  });
});
