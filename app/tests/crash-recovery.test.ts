/**
 * crash-recovery.test.ts — the queue resumes cleanly from DB state after a hard
 * interrupt (T-63). Read-only on queue.ts/db.ts; hermetic (mock provider, no
 * network/ffmpeg, temp SQLite).
 *
 * Model of a crash: an instrumented provider throws on the Nth submit, which
 * propagates out of ShotQueue.run() (submit calls are not caught in the loop) —
 * exactly what a process death mid-flight looks like to the persisted state. We
 * then CLOSE the db (proving the state hit disk), REOPEN it, build a FRESH
 * ShotQueue + provider, and run to completion.
 *
 * Invariants asserted for both interrupt points (image stage + video stage):
 *  - No duplicate provider submissions: total image submits across the crashed +
 *    resumed runs == shot count, same for video (a re-submitted already-queued
 *    shot would push the total over N — i.e. double spend).
 *  - Terminal state identical to an uninterrupted run: all shots PLACED, one EDL
 *    entry per shot.
 *  - Ledger sane: exactly one image + one video ledger row per shot, and
 *    totalCredits matches the uninterrupted baseline (no phantom charges).
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ProjectDb } from '../src/db.js';
import { ShotQueue } from '../src/queue.js';
import { DEFAULT_CONFIG } from '../src/types.js';
import type { GenProvider, PromptEngine, Shot } from '../src/types.js';

const N = 5;
const CREDITS_PER_JOB = 1.5;

const prompts: PromptEngine = {
  imagePromptBatch: async (lines) =>
    lines.map((l) => ({ lineIndex: l.index, imagePrompt: `image prompt for line ${l.index}` })),
  animationPrompt: async () => 'animation prompt',
};

/** Instrumented mock provider. Throws on the (failXAfter+1)th submit to simulate a crash. */
function crashProvider(opts: { failImageAfter?: number; failVideoAfter?: number } = {}) {
  const state = { imageSubmits: 0, videoSubmits: 0, polls: 0, downloads: 0 };
  const provider: GenProvider = {
    name: 'crash-mock',
    preflightCost: async () => CREDITS_PER_JOB,
    submitImage: async () => {
      state.imageSubmits += 1;
      if (opts.failImageAfter !== undefined && state.imageSubmits > opts.failImageAfter) {
        throw new Error('SIMULATED CRASH (image submit)');
      }
      return `img-${randomUUID()}`;
    },
    submitVideo: async () => {
      state.videoSubmits += 1;
      if (opts.failVideoAfter !== undefined && state.videoSubmits > opts.failVideoAfter) {
        throw new Error('SIMULATED CRASH (video submit)');
      }
      return `vid-${randomUUID()}`;
    },
    poll: async (jobId) => {
      state.polls += 1;
      return { jobId, status: 'completed', resultUrl: 'file:///mock/result', creditsCharged: CREDITS_PER_JOB };
    },
    download: async (_result, destPath) => {
      state.downloads += 1;
      return destPath;
    },
  };
  return { provider, state };
}

function makeShots(projectId: string): Shot[] {
  return Array.from({ length: N }, (_, i) => ({
    id: `shot-${i}`,
    projectId,
    lineIndex: i,
    subIndex: 0,
    state: 'PENDING' as const,
    line: {
      index: i,
      text: `Line ${i}.`,
      start: i * 3,
      end: i * 3 + 2,
      duration: 2,
      pauseAfter: 1,
      targetDuration: 3,
    },
    elementIds: [],
    attempts: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }));
}

describe('crash recovery', () => {
  const PROJECT = 'temp_test_project_crash';
  const DIR = path.resolve('projects', PROJECT);
  const DB_FILE = path.join(DIR, 'pipeline.db');

  function freshDb(): ProjectDb {
    if (fs.existsSync(DIR)) fs.rmSync(DIR, { recursive: true, force: true });
    fs.mkdirSync(DIR, { recursive: true });
    const db = new ProjectDb(PROJECT, DB_FILE);
    const project = db.ensureProject({ name: PROJECT, scriptPath: 'script.txt', voPath: 'vo.wav' });
    db.insertShots(makeShots(project.id));
    return db;
  }

  beforeEach(() => {
    // Run the queue's 2s inter-tick sleep instantly.
    vi.stubGlobal('setTimeout', (fn: Function) => process.nextTick(fn));
  });

  afterEach(() => {
    if (fs.existsSync(DIR)) fs.rmSync(DIR, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  test('uninterrupted baseline reaches the reference terminal state', async () => {
    const db = freshDb();
    const { provider, state } = crashProvider();
    await new ShotQueue(db, provider, prompts, { ...DEFAULT_CONFIG }).run({ autoApprove: true });

    expect(db.listShots().every((s) => s.state === 'PLACED')).toBe(true);
    expect(db.listEdl()).toHaveLength(N);
    expect(db.listLedger()).toHaveLength(2 * N); // one image + one video row per shot
    expect(db.totalCredits()).toBeCloseTo(2 * N * CREDITS_PER_JOB, 5);
    // one submit per shot per stage — nothing spurious even without a crash
    expect(state.imageSubmits).toBe(N);
    expect(state.videoSubmits).toBe(N);
    db.close();
  });

  test('crash during the IMAGE stage: resume completes with no double image submission', async () => {
    // --- crash run: throw on the 3rd image submit ---
    let db = freshDb();
    const crashed = crashProvider({ failImageAfter: 2 });
    await expect(
      new ShotQueue(db, crashed.provider, prompts, { ...DEFAULT_CONFIG }).run({ autoApprove: true }),
    ).rejects.toThrow(/SIMULATED CRASH \(image submit\)/);

    // meaningful mid-flight crash: some image jobs are open, not everything is done
    expect(db.listOpenJobs().length).toBeGreaterThan(0);
    expect(db.listShots().some((s) => s.state !== 'PLACED')).toBe(true);
    const submittedBeforeCrash = crashed.state.imageSubmits - 1; // the throwing call did not persist a job

    // --- crash: close the db (state must survive to disk), reopen, resume ---
    db.close();
    db = new ProjectDb(PROJECT, DB_FILE);
    const resumed = crashProvider();
    await new ShotQueue(db, resumed.provider, prompts, { ...DEFAULT_CONFIG }).run({ autoApprove: true });

    // terminal state identical to the uninterrupted baseline
    expect(db.listShots().every((s) => s.state === 'PLACED')).toBe(true);
    expect(db.listEdl()).toHaveLength(N);
    // no double image submission: the already-IMAGE_QUEUED shots are polled, not resubmitted
    expect(submittedBeforeCrash + resumed.state.imageSubmits).toBe(N);
    // video only ever submitted once per shot (all in the resumed run here)
    expect(resumed.state.videoSubmits).toBe(N);
    // ledger sane: exactly one image + one video row per shot, no phantom charges
    expect(db.listLedger()).toHaveLength(2 * N);
    expect(db.totalCredits()).toBeCloseTo(2 * N * CREDITS_PER_JOB, 5);
    db.close();
  });

  test('crash during the VIDEO stage: resume completes with no double video submission', async () => {
    // --- crash run: image stage fine, throw on the 3rd video submit ---
    let db = freshDb();
    const crashed = crashProvider({ failVideoAfter: 2 });
    await expect(
      new ShotQueue(db, crashed.provider, prompts, { ...DEFAULT_CONFIG }).run({ autoApprove: true }),
    ).rejects.toThrow(/SIMULATED CRASH \(video submit\)/);

    expect(db.listOpenJobs().length).toBeGreaterThan(0);
    expect(db.listShots().some((s) => s.state !== 'PLACED')).toBe(true);
    const videoSubmittedBeforeCrash = crashed.state.videoSubmits - 1;

    // --- reopen + resume ---
    db.close();
    db = new ProjectDb(PROJECT, DB_FILE);
    const resumed = crashProvider();
    await new ShotQueue(db, resumed.provider, prompts, { ...DEFAULT_CONFIG }).run({ autoApprove: true });

    expect(db.listShots().every((s) => s.state === 'PLACED')).toBe(true);
    expect(db.listEdl()).toHaveLength(N);
    // images were fully submitted in the crash run; not resubmitted on resume
    expect(crashed.state.imageSubmits).toBe(N);
    expect(resumed.state.imageSubmits).toBe(0);
    // no double video submission across the two runs
    expect(videoSubmittedBeforeCrash + resumed.state.videoSubmits).toBe(N);
    expect(db.listLedger()).toHaveLength(2 * N);
    expect(db.totalCredits()).toBeCloseTo(2 * N * CREDITS_PER_JOB, 5);
    db.close();
  });
});
