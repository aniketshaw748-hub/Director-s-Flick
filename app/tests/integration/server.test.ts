import { vi, describe, test, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { ProjectDb, PROJECTS_ROOT, projectDbPath } from '../../src/db.js';
import { startServer } from '../../src/server.js';
import { credentialsPath, accountDir } from '../../src/accounts.js';
import type { Shot } from '../../src/types.js';

let serverInstance: http.Server | undefined;
const openDbs: ProjectDb[] = [];
// Extra per-test project dirs that the server itself opens (and keeps a live
// ProjectDb handle open for, for the server's lifetime) - Windows locks the
// sqlite file while it's open, so these can only be rm'd AFTER openDbs above
// are closed in the outer afterAll below, not from within the test itself.
const extraDirsToClean: string[] = [];

// Intercept database openings so we can close them at teardown
vi.mock('../../src/db.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/db.js')>();
  return {
    ...original,
    openProjectDb: (name: string) => {
      const dbInstance = original.openProjectDb(name);
      openDbs.push(dbInstance);
      return dbInstance;
    },
  };
});

// Simulate a genuinely broken CLI (T-42/T-41 residual: getAccountStatus()
// throwing, e.g. spawn failure or timeout) for one magic account name, real
// behavior for everything else.
const THROWING_ACCOUNT = '__throws_for_balance_degrade_test__';
vi.mock('../../src/accounts.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/accounts.js')>();
  return {
    ...original,
    getAccountStatus: async (name: string, ...rest: any[]) => {
      if (name === THROWING_ACCOUNT) {
        throw new Error('Failed to spawn Higgsfield CLI: simulated ENOENT');
      }
      return (original.getAccountStatus as any)(name, ...rest);
    },
  };
});

// Mock http.createServer to capture the server instance
vi.mock('node:http', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:http')>();
  return {
    ...original,
    createServer: (...args: any[]) => {
      const srv = original.createServer(...args);
      serverInstance = srv;
      return srv;
    },
  };
});

// Wrap global.setTimeout to automatically unref timers and speed up the queue run loop (2000ms -> 50ms)
const originalSetTimeout = global.setTimeout;
// @ts-ignore
global.setTimeout = (cb: any, ms?: number, ...args: any[]) => {
  const delay = ms === 2000 ? 50 : ms;
  const timer = originalSetTimeout(cb, delay, ...args);
  if (timer && typeof timer.unref === 'function') {
    timer.unref();
  }
  return timer;
};

describe('server integration', () => {
  const tempProjectName = `temp_proj_api_test_${Date.now()}`;
  const srcDir = path.join(PROJECTS_ROOT, 'test_project');
  const destDir = path.join(PROJECTS_ROOT, tempProjectName);
  let db: ProjectDb;
  let port = 0;
  let ws: WebSocket;
  const wsMessages: any[] = [];

  beforeAll(async () => {
    // 1. Copy test_project to temp copy
    fs.mkdirSync(destDir, { recursive: true });
    fs.cpSync(srcDir, destDir, { recursive: true });

    // Clean up temporary SQLite log files if they exist
    const walFile = path.join(destDir, 'pipeline.db-wal');
    if (fs.existsSync(walFile)) fs.unlinkSync(walFile);
    const shmFile = path.join(destDir, 'pipeline.db-shm');
    if (fs.existsSync(shmFile)) fs.unlinkSync(shmFile);

    // Initialize ProjectDb to manipulate state in tests
    db = new ProjectDb(tempProjectName, projectDbPath(tempProjectName));

    // Force mock provider inside project config database
    const row = db.db.prepare("SELECT id, config_json FROM projects LIMIT 1").get() as any;
    if (row) {
      const config = JSON.parse(row.config_json);
      config.provider = 'mock';
      db.db.prepare("UPDATE projects SET config_json = ? WHERE id = ?").run(JSON.stringify(config), row.id);
    }

    // Clear stale jobs from copied database to ensure clean concurrency state
    db.db.prepare("DELETE FROM jobs").run();

    // 2. Start Express server on random port (0)
    startServer(0);

    // Wait briefly for serverInstance to be initialized and listening
    await new Promise<void>((resolve) => {
      const check = () => {
        if (serverInstance && serverInstance.listening) {
          resolve();
        } else {
          originalSetTimeout(check, 50);
        }
      };
      check();
    });

    const addr = serverInstance!.address();
    if (typeof addr === 'object' && addr !== null) {
      port = addr.port;
    } else {
      throw new Error('Failed to resolve server port');
    }

    // 3. Connect WebSocket client
    ws = new WebSocket(`ws://localhost:${port}/?project=${tempProjectName}`);
    ws.on('message', (data) => {
      try {
        const parsed = JSON.parse(data.toString());
        wsMessages.push(parsed);
      } catch (err) {
        // Ignore
      }
    });

    await new Promise<void>((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    });
  });

  afterAll(async () => {
    // Stop the server's background queue.run() loop for this project BEFORE
    // closing anything else. Since T-27/T-09 the loop runs indefinitely for
    // non-autoApprove (review-gate) mode by design - without this it keeps
    // ticking after the db/server below are torn down and throws "database
    // connection is not open" against the just-closed db on its next tick.
    if (port) {
      try {
        await fetch(`http://localhost:${port}/api/project/${tempProjectName}/stop`, { method: 'POST' });
        await new Promise((resolve) => originalSetTimeout(resolve, 100));
      } catch {
        // Server may already be down in some failure paths - fine to ignore.
      }
    }

    // Teardown WS
    if (ws) {
      ws.close();
    }

    // Teardown Server
    if (serverInstance) {
      await new Promise<void>((resolve) => {
        serverInstance!.close(() => resolve());
      });
    }

    // Close db instance opened in test
    if (db) {
      db.close();
    }

    // Close all project databases opened by server
    for (const openedDb of openDbs) {
      try {
        openedDb.close();
      } catch (err) {
        // Ignore
      }
    }

    // Remove temp directory
    if (fs.existsSync(destDir)) {
      fs.rmSync(destDir, { recursive: true, force: true });
    }

    // Remove any other per-test project dirs (only safe now that the dbs
    // the server opened for them are closed, above).
    for (const dir of extraDirsToClean) {
      if (fs.existsSync(dir)) {
        try {
          fs.rmSync(dir, { recursive: true, force: true });
        } catch {
          // Best-effort - a lingering handle here isn't worth failing the suite over.
        }
      }
    }

    // Restore original setTimeout
    global.setTimeout = originalSetTimeout;
  });

  /** Poll db.getShot(shotId) until it reaches `expected` or the timeout
   * elapses (rejects with the last-seen state on timeout). Replaces a fixed
   * sleep for state transitions driven by the background queue.run() loop,
   * which can take a variable number of ticks. */
  async function waitForShotState(shotId: string, expected: string, timeoutMs: number) {
    const start = Date.now();
    let last = db.getShot(shotId)!;
    while (Date.now() - start < timeoutMs) {
      last = db.getShot(shotId)!;
      if (last.state === expected) return last;
      await new Promise((resolve) => originalSetTimeout(resolve, 20));
    }
    throw new Error(`waitForShotState: timed out waiting for '${expected}'; last state was '${last.state}'`);
  }

  test('GET /api/projects returns the list including temp project', async () => {
    const res = await fetch(`http://localhost:${port}/api/projects`);
    expect(res.status).toBe(200);
    const list = await res.json();
    expect(list).toContain(tempProjectName);
  });

  test('GET /api/project/:name returns project details', async () => {
    const res = await fetch(`http://localhost:${port}/api/project/${tempProjectName}`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.project.name).toBe('test_project'); // copied database retains original name row
    expect(data.shots.length).toBeGreaterThan(0);
    expect(data.elements).toBeDefined();
  });

  test('POST /api/project/:name/shots/:shotId/action flow and WS events', async () => {
    const shots = db.listShots();
    const targetShot = shots[0];
    expect(targetShot).toBeDefined();
    const shotId = targetShot!.id;

    // Reset shot state to IN_REVIEW using single quotes for SQLite string literal
    db.db.prepare("UPDATE shots SET state = 'IN_REVIEW' WHERE id = ?").run(shotId);

    wsMessages.length = 0; // Clear WS message buffer

    // A. TEST APPROVE
    let res = await fetch(
      `http://localhost:${port}/api/project/${tempProjectName}/shots/${shotId}/action`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'approve' }),
      }
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });

    // The ShotQueue loop processes IN_REVIEW -> APPROVED -> VIDEO_QUEUED ->
    // VIDEO_READY -> PLACED over multiple ticks (submit, poll, download all
    // take a variable number of 50ms-sped-up iterations) - a fixed sleep here
    // is exactly the flakiness Fable flagged; poll for the terminal state
    // instead, with a generous timeout well above the expected worst case.
    await waitForShotState(shotId, 'PLACED', 5000);
    // DB state and the emit() that fires alongside it happen synchronously in
    // queue.ts, but the WS push to this test's client is a real (loopback)
    // socket round-trip - give it a moment to arrive before asserting on
    // wsMessages, or this races and sometimes reads an empty buffer.
    await new Promise((resolve) => originalSetTimeout(resolve, 100));

    // Assert WebSocket shotEvents were pushed. 'APPROVED' isn't one of them
    // by design (ShotEvent.state is only IMAGE_READY | VIDEO_READY | PLACED -
    // the three states T-04 calls out as needing an immediate push; approve()
    // itself is a synchronous DB write with no async job tied to it yet).
    const shotEventsApprove = wsMessages.filter((m) => m.type === 'shotEvent' && m.shotId === shotId);
    expect(shotEventsApprove.map((e) => e.state)).toContain('VIDEO_READY');
    expect(shotEventsApprove.map((e) => e.state)).toContain('PLACED');

    // B. TEST EDIT
    db.db.prepare("UPDATE shots SET state = 'IN_REVIEW' WHERE id = ?").run(shotId);
    wsMessages.length = 0;

    res = await fetch(
      `http://localhost:${port}/api/project/${tempProjectName}/shots/${shotId}/action`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'edit', instructions: 'make it brighter' }),
      }
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });

    // No delay needed: the server handler `await`s queue.requestEdit() fully
    // (job submitted, state set to IMAGE_QUEUED) before responding, so the
    // state is already correct the instant fetch() resolves. Adding a delay
    // here is actively harmful now that the background loop runs
    // continuously (T-09/T-27) - it can race ahead and advance the shot
    // further (e.g. to IN_REVIEW again once mock "generation" completes)
    // before a fixed-sleep check gets to look.
    const updatedShotEdit = db.getShot(shotId)!;
    expect(updatedShotEdit.state).toBe('IMAGE_QUEUED');
    expect(updatedShotEdit.imagePrompt).toContain('make it brighter');

    // C. TEST REDO WITHOUT PROMPT
    db.db.prepare("UPDATE shots SET state = 'IN_REVIEW' WHERE id = ?").run(shotId);
    wsMessages.length = 0;

    res = await fetch(
      `http://localhost:${port}/api/project/${tempProjectName}/shots/${shotId}/action`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'redo' }),
      }
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });

    // Same reasoning as the edit case above: requestRedo() is fully awaited
    // (including the PromptEngine regeneration + submit) before responding.
    const updatedShotRedoGen = db.getShot(shotId)!;
    expect(updatedShotRedoGen.state).toBe('IMAGE_QUEUED');
    expect(updatedShotRedoGen.imagePrompt).toBeDefined();

    // D. TEST REDO WITH CUSTOM PROMPT
    db.db.prepare("UPDATE shots SET state = 'IN_REVIEW' WHERE id = ?").run(shotId);
    wsMessages.length = 0;

    res = await fetch(
      `http://localhost:${port}/api/project/${tempProjectName}/shots/${shotId}/action`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'redo', prompt: 'custom exact prompt' }),
      }
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });

    const updatedShotRedoCustom = db.getShot(shotId)!;
    expect(updatedShotRedoCustom.state).toBe('IMAGE_QUEUED');
    expect(updatedShotRedoCustom.imagePrompt).toBe('custom exact prompt');

    // E. TEST REDO ANIMATION
    db.db.prepare("UPDATE shots SET state = 'PLACED' WHERE id = ?").run(shotId);
    wsMessages.length = 0;

    res = await fetch(
      `http://localhost:${port}/api/project/${tempProjectName}/shots/${shotId}/action`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'redoAnimation', prompt: 'custom anim prompt' }),
      }
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });

    const updatedShotAnim = db.getShot(shotId)!;
    expect(updatedShotAnim.state).toBe('VIDEO_QUEUED');
    expect(updatedShotAnim.animationPrompt).toBe('custom anim prompt');
  });

  // --- T-38 BUG 1: 413 on real VOs -----------------------------------------

  test('POST /api/projects accepts a large, real-VO-sized base64 body (T-38 BUG 1 regression)', async () => {
    const bigProjectName = `temp_proj_bigvo_${Date.now()}`;
    const bigDir = path.join(PROJECTS_ROOT, bigProjectName);
    try {
      // ~4MB of raw bytes -> ~5.3MB base64. Comfortably bigger than both
      // Express's original ~100KB default AND the new small (2mb) global
      // limit that now applies to every OTHER JSON endpoint - this can only
      // succeed because POST /api/projects gets its own much larger parser.
      const rawBytes = Buffer.alloc(4 * 1024 * 1024, 1);
      const res = await fetch(`http://localhost:${port}/api/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: bigProjectName,
          script: 'A large voiceover regression test.',
          voiceoverBase64: rawBytes.toString('base64'),
          voiceoverExt: 'wav',
        }),
      });
      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.project.name).toBe(bigProjectName);

      const voPath = path.join(bigDir, 'voiceover.wav');
      expect(fs.existsSync(voPath)).toBe(true);
      expect(fs.statSync(voPath).size).toBe(rawBytes.length);
    } finally {
      if (fs.existsSync(bigDir)) fs.rmSync(bigDir, { recursive: true, force: true });
    }
  });

  test('other POST endpoints keep the small global body limit (T-38 BUG 1 scoping)', async () => {
    // Proves the large limit is scoped to POST /api/projects only, not
    // applied blanket-wide (the downside of T-27's original fix that T-38
    // corrects). /account is a safe target either way: even if this request
    // were NOT rejected, the handler only does an fs-based accountExists()
    // check - no process is ever spawned.
    const oversized = 'x'.repeat(3 * 1024 * 1024); // 3MB > the 2mb global default
    const res = await fetch(`http://localhost:${port}/api/project/${tempProjectName}/account`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ account: oversized }),
    });
    expect(res.status).toBe(413);
  });

  // --- T-38 BUG 2: queue-poisoning on GET/WS-before-create -----------------

  test('GET /api/project/:name for a nonexistent project 404s and leaves no shell db behind (T-38 BUG 2 regression)', async () => {
    const bogusName = `temp_proj_bogus_${Date.now()}`;
    const bogusDir = path.join(PROJECTS_ROOT, bogusName);
    expect(fs.existsSync(bogusDir)).toBe(false);

    const res = await fetch(`http://localhost:${port}/api/project/${bogusName}`);
    expect(res.status).toBe(404);

    // No shell directory/db left behind - the old bug's telltale debris, and
    // the reason a later legitimate creation of this same name must not find
    // a pre-existing (project-row-less) pipeline.db in its way.
    expect(fs.existsSync(bogusDir)).toBe(false);
  });

  test('WS connect for a nonexistent project closes gracefully instead of crashing the server (T-38 BUG 2)', async () => {
    const bogusName = `temp_proj_bogus_ws_${Date.now()}`;
    const bogusDir = path.join(PROJECTS_ROOT, bogusName);

    const bogusWs = new WebSocket(`ws://localhost:${port}/?project=${bogusName}`);
    const closeCode: number = await new Promise((resolve, reject) => {
      const timer = originalSetTimeout(() => reject(new Error('timed out waiting for ws close')), 3000);
      bogusWs.on('close', (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
    expect(closeCode).toBe(1008);
    expect(fs.existsSync(bogusDir)).toBe(false);

    // The server itself must still be healthy afterward - the original bug's
    // real danger was an uncaught throw inside the WS 'connection' callback
    // (not an Express request handler, so Express's error handling never
    // catches it), which would otherwise take down the whole process.
    const healthRes = await fetch(`http://localhost:${port}/api/projects`);
    expect(healthRes.status).toBe(200);
  });

  // --- T-42 (T-40 finding H3): export partial-placement guard --------------

  test('POST /export 409s on a partial timeline without force, includes placed/total, force:true bypasses (T-42)', async () => {
    const partialName = `temp_proj_partial_${Date.now()}`;
    const partialDir = path.join(PROJECTS_ROOT, partialName);
    fs.mkdirSync(partialDir, { recursive: true });
    fs.cpSync(srcDir, partialDir, { recursive: true });
    for (const suffix of ['-wal', '-shm']) {
      const f = path.join(partialDir, `pipeline.db${suffix}`);
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
    extraDirsToClean.push(partialDir);
    try {
      const partialDb = new ProjectDb(partialName, projectDbPath(partialName));
      const project = partialDb.getProject()!;
      // Deterministic 2-shot scenario: 1 placed, 1 not - independent of
      // whatever state the shared tempProjectName fixture is in by now.
      // jobs/cost_ledger both FK shots(id) - clear them first.
      partialDb.db.prepare('DELETE FROM edl').run();
      partialDb.db.prepare('DELETE FROM cost_ledger').run();
      partialDb.db.prepare('DELETE FROM jobs').run();
      partialDb.db.prepare('DELETE FROM shots').run();
      const now = new Date().toISOString();
      const shots: Shot[] = [0, 1].map((i) => ({
        id: `partial-shot-${i}`,
        projectId: project.id,
        lineIndex: i,
        subIndex: 0,
        state: i === 0 ? 'PLACED' : 'IMAGE_QUEUED',
        line: { index: i, text: `Line ${i}.`, start: i * 3, end: i * 3 + 2, duration: 2, pauseAfter: 1, targetDuration: 3 },
        elementIds: [],
        attempts: 0,
        createdAt: now,
        updatedAt: now,
      }));
      partialDb.insertShots(shots);
      const realClip = path.join(partialDir, 'clips', '231fb6e6-74e2-4214-892e-5de028eefc62.mp4');
      partialDb.upsertEdlEntry({
        id: randomUUID(),
        projectId: project.id,
        shotId: 'partial-shot-0',
        lineIndex: 0,
        clipPath: realClip,
        inPoint: 0,
        outPoint: 2,
        timelineStart: 0,
        duration: 2,
      });
      partialDb.close();

      let res = await fetch(`http://localhost:${port}/api/project/${partialName}/export`, { method: 'POST' });
      expect(res.status).toBe(409);
      let body = (await res.json()) as any;
      expect(body.placed).toBe(1);
      expect(body.total).toBe(2);

      res = await fetch(`http://localhost:${port}/api/project/${partialName}/export`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ force: true }),
      });
      body = (await res.json()) as any;
      expect(res.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.placed).toBe(1);
      expect(body.total).toBe(2);
    } finally {
      // getOrOpenProject started this project's own background queue loop -
      // stop it (same reasoning as the shared tempProjectName's /stop in
      // afterAll) so it doesn't keep ticking against a soon-to-be-closed db.
      // Directory cleanup itself is deferred to the outer afterAll
      // (extraDirsToClean, above) - Windows locks the sqlite file while the
      // server's ProjectDb handle for it is still open.
      await fetch(`http://localhost:${port}/api/project/${partialName}/stop`, { method: 'POST' }).catch(() => {});
    }
  }, 20_000); // real ffmpeg trim+concat+mux of one short real clip

  // --- T-42 residual (T-41 note): balance endpoint graceful degrade --------

  test('GET /balance degrades gracefully (200, authenticated:false) instead of 500 when the CLI is broken', async () => {
    const res = await fetch(`http://localhost:${port}/api/accounts/${THROWING_ACCOUNT}/balance`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.authenticated).toBe(false);
    expect(body.balance).toBeNull();
    expect(typeof body.error).toBe('string');
  });

  // --- T-51: project-config GET/PATCH ---------------------------------------

  describe('GET/PATCH /api/project/:name/config', () => {
    const configProjectName = `temp_proj_config_${Date.now()}`;
    const configDir = path.join(PROJECTS_ROOT, configProjectName);
    const fakeAccountName = `temp_config_test_account_${Date.now()}`;

    beforeAll(async () => {
      extraDirsToClean.push(configDir);
      const res = await fetch(`http://localhost:${port}/api/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: configProjectName,
          script: 'A config-endpoint test project.',
          voiceoverBase64: Buffer.from('fake wav bytes').toString('base64'),
          voiceoverExt: 'wav',
        }),
      });
      expect(res.status).toBe(200);

      // Fake account credentials file so accountExists()/setActiveAccount()
      // succeed without any real CLI auth (mirrors accounts.test.ts's pattern).
      fs.mkdirSync(accountDir(fakeAccountName), { recursive: true });
      fs.writeFileSync(credentialsPath(fakeAccountName), '{}');
    });

    afterAll(async () => {
      // Best-effort: the "valid partial update" test's PATCH evicts the
      // cached queue entry (same openProjects.delete() pattern as the
      // pre-existing account-switch endpoint) without stopping its loop -
      // by design, so a later request rebuilds fresh rather than reusing a
      // stale provider/config. That orphaned loop instance is then
      // unreachable via /stop (openProjects.get() finds nothing). In
      // production this is harmless (the loop just keeps polling against a
      // db file that's still open); in this test it surfaces as a benign,
      // caught-and-logged "database connection is not open" stderr once the
      // outer afterAll closes every db this file ever opened. Same class of
      // artifact as the pre-existing "illegal transition" noise from the
      // shared tempProjectName project elsewhere in this file - not fixing,
      // just documenting so it doesn't look like an unexplained flake.
      await fetch(`http://localhost:${port}/api/project/${configProjectName}/stop`, { method: 'POST' }).catch(() => {});
      await new Promise((resolve) => originalSetTimeout(resolve, 100));
      if (fs.existsSync(accountDir(fakeAccountName))) {
        fs.rmSync(accountDir(fakeAccountName), { recursive: true, force: true });
      }
    });

    test('GET returns the default config and null accountName for a fresh project', async () => {
      const res = await fetch(`http://localhost:${port}/api/project/${configProjectName}/config`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.config.provider).toBe('mock');
      expect(body.config.bufferSize).toBe(5);
      expect(body.accountName).toBeNull();
    });

    test('PATCH rejects an unknown top-level key with 400', async () => {
      const res = await fetch(`http://localhost:${port}/api/project/${configProjectName}/config`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notAField: 'x' }),
      });
      expect(res.status).toBe(400);
    });

    test('PATCH rejects an invalid provider value with 400', async () => {
      const res = await fetch(`http://localhost:${port}/api/project/${configProjectName}/config`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ videoProvider: 'not-a-real-provider' }),
      });
      expect(res.status).toBe(400);
    });

    test('PATCH rejects an unknown models sub-key with 400', async () => {
      const res = await fetch(`http://localhost:${port}/api/project/${configProjectName}/config`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ models: { resolution: '1080p' } }),
      });
      expect(res.status).toBe(400);
    });

    test('PATCH rejects an accountName with no matching credentials with 404', async () => {
      const res = await fetch(`http://localhost:${port}/api/project/${configProjectName}/config`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountName: 'no-such-account' }),
      });
      expect(res.status).toBe(404);
    });

    test('PATCH applies a valid partial update, merges (not overwrites), and broadcasts a WS sync', async () => {
      const configWs = new WebSocket(`ws://localhost:${port}/?project=${configProjectName}`);
      const configWsMessages: any[] = [];
      configWs.on('message', (data) => {
        try {
          configWsMessages.push(JSON.parse(data.toString()));
        } catch {
          // ignore
        }
      });
      await new Promise<void>((resolve, reject) => {
        configWs.on('open', resolve);
        configWs.on('error', reject);
      });

      const res = await fetch(`http://localhost:${port}/api/project/${configProjectName}/config`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          videoProvider: 'replicate',
          models: { video: 'kling2_5' },
          styleBible: 'Neon-noir, high contrast.',
          accountName: fakeAccountName,
        }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.config.videoProvider).toBe('replicate');
      expect(body.config.models.video).toBe('kling2_5');
      expect(body.config.styleBible).toBe('Neon-noir, high contrast.');
      // Untouched fields survive the partial merge - proves it's a merge, not
      // a full overwrite (models.image and bufferSize were never in the body).
      expect(body.config.models.image).toBe('nano_banana_2');
      expect(body.config.bufferSize).toBe(5);
      expect(body.accountName).toBe(fakeAccountName);

      // GET reflects the persisted change.
      const getRes = await fetch(`http://localhost:${port}/api/project/${configProjectName}/config`);
      const getBody = (await getRes.json()) as any;
      expect(getBody.config.videoProvider).toBe('replicate');
      expect(getBody.accountName).toBe(fakeAccountName);

      // WS sync broadcast fired with the updated project.
      await new Promise((resolve) => originalSetTimeout(resolve, 100));
      const syncMsg = configWsMessages.find((m) => m.type === 'sync' && m.project);
      expect(syncMsg).toBeDefined();
      expect(syncMsg.project.config.videoProvider).toBe('replicate');

      configWs.close();
    });
  });
});
