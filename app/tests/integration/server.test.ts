import { vi, describe, test, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
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
// T-73: addAccount() spawns the REAL `higgsfield auth login` CLI flow -
// never let that happen from a test. Records calls so POST /api/accounts
// can be verified without any real subprocess.
const mockAddAccountCalls: string[] = [];
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
    addAccount: async (name: string) => {
      mockAddAccountCalls.push(name);
      return { code: 0, stdout: '', stderr: '' };
    },
  };
});

// T-73: alignScript() spawns a real python (stable-ts) subprocess - mock just
// that one function (computeTimeline/planShots are pure and run for real
// against this fake output, exercising the actual timeline-rule logic).
let mockAlignFail: Error | null = null;
vi.mock('../../src/align.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/align.js')>();
  return {
    ...original,
    alignScript: async (_script: string, _audio: string, _out: string, opts?: { onProgress?: (l: string) => void }) => {
      if (mockAlignFail) throw mockAlignFail;
      opts?.onProgress?.('mock alignment progress');
      return [
        { index: 0, text: 'A line.', start: 0, end: 2, words: [] },
        { index: 1, text: 'Another line.', start: 3, end: 5, words: [] },
      ];
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

// T-84: hand-built multipart/form-data POST that streams the file part
// straight from disk (fs.createReadStream) into the HTTP request - never
// holds the whole file in memory client-side either, so an RSS measurement
// around the call reflects genuine server-side (multer) streaming, not just
// "the client already had it buffered anyway".
function postMultipartFile(
  port: number,
  fields: Record<string, string>,
  file?: { fieldName: string; filePath: string; fileName: string },
): Promise<{ status: number; body: any }> {
  const boundary = `----t84boundary${randomUUID()}`;
  const CRLF = '\r\n';
  let preamble = '';
  for (const [key, value] of Object.entries(fields)) {
    preamble += `--${boundary}${CRLF}Content-Disposition: form-data; name="${key}"${CRLF}${CRLF}${value}${CRLF}`;
  }
  if (file) {
    preamble += `--${boundary}${CRLF}Content-Disposition: form-data; name="${file.fieldName}"; filename="${file.fileName}"${CRLF}Content-Type: application/octet-stream${CRLF}${CRLF}`;
  }
  const epilogue = `${CRLF}--${boundary}--${CRLF}`;

  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: 'localhost',
        port,
        path: '/api/projects',
        method: 'POST',
        headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode ?? 0, body: raw ? JSON.parse(raw) : undefined });
          } catch (err) {
            reject(err);
          }
        });
      },
    );
    req.on('error', reject);
    req.write(preamble);
    if (!file) {
      req.end(epilogue);
      return;
    }
    const fileStream = fs.createReadStream(file.filePath);
    fileStream.on('error', reject);
    fileStream.on('data', (chunk) => req.write(chunk));
    fileStream.on('end', () => req.end(epilogue));
  });
}

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
    // T-62: POST /stop now awaits the queue's genuine termination (queue.ts
    // ::stop() docs), so this await alone is sufficient - no more guessing
    // at a safe delay afterward.
    if (port) {
      try {
        await fetch(`http://localhost:${port}/api/project/${tempProjectName}/stop`, { method: 'POST' });
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

  test('POST /export 500s for an unknown project (blanket catch, same pattern as align/cost-summary) and 409s when the EDL is empty', async () => {
    let res = await fetch(`http://localhost:${port}/api/project/temp_proj_bogus_export_${Date.now()}/export`, {
      method: 'POST',
    });
    expect(res.status).toBe(500);

    const emptyName = `temp_proj_export_empty_${Date.now()}`;
    const emptyDir = path.join(PROJECTS_ROOT, emptyName);
    extraDirsToClean.push(emptyDir);
    const createRes = await fetch(`http://localhost:${port}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: emptyName,
        script: 'A line.',
        voiceoverBase64: Buffer.from('fake wav bytes').toString('base64'),
        voiceoverExt: 'wav',
      }),
    });
    expect(createRes.status).toBe(200);
    res = await fetch(`http://localhost:${port}/api/project/${emptyName}/export`, { method: 'POST' });
    expect(res.status).toBe(409);
    await fetch(`http://localhost:${port}/api/project/${emptyName}/stop`, { method: 'POST' }).catch(() => {});
  });

  test('POST /export honors a custom outPath and writes a real .srt sidecar when alignment.json is present (T-68)', async () => {
    const srtName = `temp_proj_export_srt_${Date.now()}`;
    const srtDir = path.join(PROJECTS_ROOT, srtName);
    fs.mkdirSync(srtDir, { recursive: true });
    fs.cpSync(srcDir, srtDir, { recursive: true });
    for (const suffix of ['-wal', '-shm']) {
      const f = path.join(srtDir, `pipeline.db${suffix}`);
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
    extraDirsToClean.push(srtDir);
    try {
      const srtDb = new ProjectDb(srtName, projectDbPath(srtName));
      const project = srtDb.getProject()!;
      // The copied database retains the fixture's original `name` row
      // ('test_project') - server.ts's export handler resolves the
      // alignment.json path via `projectDir(project.name)`, so without this
      // rename it would read test_project's REAL alignment.json (a
      // different, pre-existing fixture) instead of the one this test
      // writes into srtDir below.
      srtDb.db.prepare('UPDATE projects SET name = ? WHERE id = ?').run(srtName, project.id);
      srtDb.db.prepare('DELETE FROM edl').run();
      srtDb.db.prepare('DELETE FROM cost_ledger').run();
      srtDb.db.prepare('DELETE FROM jobs').run();
      srtDb.db.prepare('DELETE FROM shots').run();
      const now = new Date().toISOString();
      const shot: Shot = {
        id: 'srt-shot-0',
        projectId: project.id,
        lineIndex: 0,
        subIndex: 0,
        state: 'PLACED',
        line: { index: 0, text: 'A captioned line.', start: 0, end: 2, duration: 2, pauseAfter: 1, targetDuration: 2 },
        elementIds: [],
        attempts: 0,
        createdAt: now,
        updatedAt: now,
      };
      srtDb.insertShots([shot]);
      const realClip = path.join(srtDir, 'clips', '231fb6e6-74e2-4214-892e-5de028eefc62.mp4');
      srtDb.upsertEdlEntry({
        id: randomUUID(),
        projectId: project.id,
        shotId: shot.id,
        lineIndex: 0,
        clipPath: realClip,
        inPoint: 0,
        outPoint: 2,
        timelineStart: 0,
        duration: 2,
      });
      srtDb.close();

      // A real alignment.json so exportSrtSidecar's SUCCESS path (not just
      // its already-covered swallowed-failure path) gets exercised.
      fs.writeFileSync(
        path.join(srtDir, 'alignment.json'),
        JSON.stringify({ lines: [{ text: 'A captioned line.', start: 0, end: 2 }] }),
        'utf-8',
      );

      const customOutPath = path.join(srtDir, 'export', 'custom-name.mp4');
      const res = await fetch(`http://localhost:${port}/api/project/${srtName}/export`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ outPath: customOutPath }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.outputPath).toBe(path.resolve(customOutPath));
      expect(fs.existsSync(customOutPath)).toBe(true);

      const srtPath = path.join(srtDir, 'export', 'custom-name.srt');
      expect(fs.existsSync(srtPath)).toBe(true);
      const srtContent = fs.readFileSync(srtPath, 'utf-8');
      expect(srtContent).toContain('A captioned line.');
    } finally {
      await fetch(`http://localhost:${port}/api/project/${srtName}/stop`, { method: 'POST' }).catch(() => {});
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
      // T-62: the "valid partial update" test's PATCH used to evict the
      // cached queue entry without stopping its loop first (same gap the
      // account-switch endpoint had), orphaning it beyond this /stop's
      // reach. Both endpoints now stop-before-evict (evictProjectEntry() in
      // server.ts), so this plain /stop reaches whatever's currently cached
      // and genuinely awaits its termination - no more benign teardown
      // stderr to explain away here.
      await fetch(`http://localhost:${port}/api/project/${configProjectName}/stop`, { method: 'POST' }).catch(() => {});
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

    test('PATCH rejects a non-object models value with 400 (T-73)', async () => {
      const res = await fetch(`http://localhost:${port}/api/project/${configProjectName}/config`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ models: 'not-an-object' }),
      });
      expect(res.status).toBe(400);
    });

    test('PATCH rejects a non-string models.image value with 400 (T-73)', async () => {
      const res = await fetch(`http://localhost:${port}/api/project/${configProjectName}/config`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ models: { image: 123 } }),
      });
      expect(res.status).toBe(400);
    });

    test('PATCH rejects a non-string styleBible value with 400 (T-73)', async () => {
      const res = await fetch(`http://localhost:${port}/api/project/${configProjectName}/config`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ styleBible: 123 }),
      });
      expect(res.status).toBe(400);
    });

    test('PATCH rejects a non-string accountName value with 400 (T-73)', async () => {
      const res = await fetch(`http://localhost:${port}/api/project/${configProjectName}/config`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountName: 123 }),
      });
      expect(res.status).toBe(400);
    });

    test('GET /config 404s for an unknown project (T-73)', async () => {
      const res = await fetch(`http://localhost:${port}/api/project/temp_proj_bogus_config_${Date.now()}/config`);
      expect(res.status).toBe(404);
    });

    test('PATCH /config 404s for an unknown project (T-73)', async () => {
      const res = await fetch(`http://localhost:${port}/api/project/temp_proj_bogus_config_${Date.now()}/config`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ styleBible: 'x' }),
      });
      expect(res.status).toBe(404);
    });

    test('PATCH rejects an invalid promptBackend value with 400 (T-62)', async () => {
      const res = await fetch(`http://localhost:${port}/api/project/${configProjectName}/config`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ promptBackend: 'gpt5' }),
      });
      expect(res.status).toBe(400);
    });

    test('PATCH rejects an empty-string llmModel with 400 (T-62)', async () => {
      const res = await fetch(`http://localhost:${port}/api/project/${configProjectName}/config`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ llmModel: '' }),
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
          promptBackend: 'llm',
          llmModel: 'claude-opus-4-8',
        }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.config.videoProvider).toBe('replicate');
      expect(body.config.models.video).toBe('kling2_5');
      expect(body.config.styleBible).toBe('Neon-noir, high contrast.');
      expect(body.config.promptBackend).toBe('llm');
      expect(body.config.llmModel).toBe('claude-opus-4-8');
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

  // --- T-73: server.ts coverage lift ----------------------------------------

  describe('account management endpoints', () => {
    test('GET /api/accounts lists accounts', async () => {
      const res = await fetch(`http://localhost:${port}/api/accounts`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as any[];
      expect(Array.isArray(body)).toBe(true);
    });

    test('GET /api/accounts/:name/status returns 200 with authenticated:false for an unknown account', async () => {
      const res = await fetch(`http://localhost:${port}/api/accounts/no-such-account-xyz/status`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.authenticated).toBe(false);
      expect(body.balance).toBeNull();
    });

    test('GET /api/accounts/:name/status returns 500 when the CLI is genuinely broken', async () => {
      const res = await fetch(`http://localhost:${port}/api/accounts/${THROWING_ACCOUNT}/status`);
      expect(res.status).toBe(500);
      const body = (await res.json()) as any;
      expect(typeof body.error).toBe('string');
    });

    test('POST /api/accounts requires a string name field (400)', async () => {
      const res = await fetch(`http://localhost:${port}/api/accounts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });

    test('POST /api/accounts kicks off addAccount and responds immediately (started:true)', async () => {
      mockAddAccountCalls.length = 0;
      const res = await fetch(`http://localhost:${port}/api/accounts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'new-test-account' }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body).toEqual({ started: true, name: 'new-test-account' });
      expect(mockAddAccountCalls).toContain('new-test-account');
    });

    test('POST /api/project/:name/account requires a string account field (400)', async () => {
      const res = await fetch(`http://localhost:${port}/api/project/${tempProjectName}/account`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });

    test('POST /api/project/:name/account 404s for an account with no credentials', async () => {
      const res = await fetch(`http://localhost:${port}/api/project/${tempProjectName}/account`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account: 'no-such-account-xyz' }),
      });
      expect(res.status).toBe(404);
    });

    test('POST /api/project/:name/account switches successfully for a real (fake-credentialed) account', async () => {
      const accountName = `temp_switch_test_account_${Date.now()}`;
      fs.mkdirSync(accountDir(accountName), { recursive: true });
      fs.writeFileSync(credentialsPath(accountName), '{}');
      try {
        const res = await fetch(`http://localhost:${port}/api/project/${tempProjectName}/account`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ account: accountName }),
        });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ success: true });
      } finally {
        if (fs.existsSync(accountDir(accountName))) {
          fs.rmSync(accountDir(accountName), { recursive: true, force: true });
        }
      }
    });
  });

  describe('lan-info, media, edl, vo endpoints', () => {
    test('GET /api/lan-info always responds with {lanIp, apiPort}, even offline', async () => {
      const res = await fetch(`http://localhost:${port}/api/lan-info`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body).toHaveProperty('lanIp');
      // apiPort reflects the literal argument startServer() was called with
      // (this file passes 0 for "OS picks a free port"), not the OS-resolved
      // actual `port` this test file otherwise uses to reach it.
      expect(body.apiPort).toBe(0);
    });

    test('GET media route serves an existing image file', async () => {
      const res = await fetch(
        `http://localhost:${port}/api/project/${tempProjectName}/media/images/231fb6e6-74e2-4214-892e-5de028eefc62.png`,
      );
      expect(res.status).toBe(200);
    });

    test('GET media route 404s for a missing file', async () => {
      const res = await fetch(`http://localhost:${port}/api/project/${tempProjectName}/media/images/does-not-exist.png`);
      expect(res.status).toBe(404);
    });

    test('GET /edl returns the EDL and 404s for an unknown project', async () => {
      const res = await fetch(`http://localhost:${port}/api/project/${tempProjectName}/edl`);
      expect(res.status).toBe(200);
      expect(Array.isArray(await res.json())).toBe(true);

      const bogusRes = await fetch(`http://localhost:${port}/api/project/temp_proj_bogus_edl_${Date.now()}/edl`);
      expect(bogusRes.status).toBe(404);
    });

    test('GET /vo streams the voiceover and 404s for an unknown project', async () => {
      const res = await fetch(`http://localhost:${port}/api/project/${tempProjectName}/vo`);
      expect(res.status).toBe(200);

      const bogusRes = await fetch(`http://localhost:${port}/api/project/temp_proj_bogus_vo_${Date.now()}/vo`);
      expect(bogusRes.status).toBe(404);
    });

    test('GET /vo 404s when the project exists but its voiceover file is missing', async () => {
      const noVoName = `temp_proj_no_vo_${Date.now()}`;
      const noVoDir = path.join(PROJECTS_ROOT, noVoName);
      extraDirsToClean.push(noVoDir);
      const createRes = await fetch(`http://localhost:${port}/api/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: noVoName,
          script: 'A line.',
          voiceoverBase64: Buffer.from('fake wav bytes').toString('base64'),
          voiceoverExt: 'wav',
        }),
      });
      expect(createRes.status).toBe(200);
      const { project } = (await createRes.json()) as any;
      fs.unlinkSync(project.voPath);

      const res = await fetch(`http://localhost:${port}/api/project/${noVoName}/vo`);
      expect(res.status).toBe(404);
      await fetch(`http://localhost:${port}/api/project/${noVoName}/stop`, { method: 'POST' }).catch(() => {});
    });
  });

  describe('setup-flow endpoints (projects/align/run)', () => {
    const setupProjectName = `temp_proj_setup_${Date.now()}`;
    const runProjectName = `temp_proj_run_${Date.now()}`;

    beforeAll(() => {
      extraDirsToClean.push(path.join(PROJECTS_ROOT, setupProjectName), path.join(PROJECTS_ROOT, runProjectName));
    });

    afterAll(async () => {
      await fetch(`http://localhost:${port}/api/project/${setupProjectName}/stop`, { method: 'POST' }).catch(() => {});
      await fetch(`http://localhost:${port}/api/project/${runProjectName}/stop`, { method: 'POST' }).catch(() => {});
    });

    test('POST /api/projects validates name/script/voiceoverBase64 (400s)', async () => {
      const base = { name: `${setupProjectName}_unused`, script: 'A line.', voiceoverBase64: 'AA==' };
      let res = await fetch(`http://localhost:${port}/api/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...base, name: 'bad name with spaces!' }),
      });
      expect(res.status).toBe(400);

      res = await fetch(`http://localhost:${port}/api/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...base, script: undefined }),
      });
      expect(res.status).toBe(400);

      res = await fetch(`http://localhost:${port}/api/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...base, voiceoverBase64: undefined }),
      });
      expect(res.status).toBe(400);
    });

    test('POST /api/projects (multipart/form-data) creates a project, streaming the vo file to disk (T-84)', async () => {
      const mpName = `${setupProjectName}_mp`;
      const mpDir = path.join(PROJECTS_ROOT, mpName);
      const srcFile = path.join(os.tmpdir(), `t84_src_${randomUUID()}.mp3`);
      const bytes = Buffer.from('FAKE-MP3-BYTES-FOR-MULTIPART-TEST');
      fs.writeFileSync(srcFile, bytes);
      try {
        const { status, body } = await postMultipartFile(
          port,
          { name: mpName, script: 'A multipart-created project.' },
          { fieldName: 'vo', filePath: srcFile, fileName: 'my-voiceover.mp3' },
        );
        expect(status).toBe(200);
        expect(body.project.name).toBe(mpName);
        // extension is derived from the uploaded filename, same convention
        // as the JSON path's voiceoverExt field.
        const voPath = path.join(mpDir, 'voiceover.mp3');
        expect(body.project.voPath).toBe(voPath);
        expect(fs.existsSync(voPath)).toBe(true);
        expect(fs.readFileSync(voPath)).toEqual(bytes);
        expect(fs.existsSync(path.join(mpDir, 'script.txt'))).toBe(true);
      } finally {
        fs.rmSync(srcFile, { force: true });
        if (fs.existsSync(mpDir)) fs.rmSync(mpDir, { recursive: true, force: true });
      }
    });

    test('POST /api/projects (multipart) with no vo file part at all 400s, same as a missing voiceoverBase64', async () => {
      const { status, body } = await postMultipartFile(port, {
        name: `${setupProjectName}_novofile`,
        script: 'A line.',
      });
      expect(status).toBe(400);
      expect(body.error).toMatch(/voiceoverBase64.*or a multipart vo file/);
    });

    test('POST /api/projects (multipart) with an unexpected file field name gets a clean 400, not an HTML error page', async () => {
      const p = path.join(os.tmpdir(), `t84_unused_${randomUUID()}.txt`);
      fs.writeFileSync(p, 'unused');
      try {
        const { status, body } = await postMultipartFile(
          port,
          { name: `${setupProjectName}_wrongfield`, script: 'A line.' },
          { fieldName: 'not-vo', filePath: p, fileName: 'unused.txt' },
        );
        expect(status).toBe(400);
        expect(body.error).toMatch(/multipart upload error/);
      } finally {
        fs.rmSync(p, { force: true });
      }
    });

    test('POST /api/projects (multipart) rejects an invalid name, cleaning up the streamed temp upload (T-84)', async () => {
      const srcFile = path.join(os.tmpdir(), `t84_badname_${randomUUID()}.wav`);
      fs.writeFileSync(srcFile, Buffer.from('irrelevant'));
      try {
        const { status, body } = await postMultipartFile(
          port,
          { name: 'bad name with spaces!', script: 'A line.' },
          { fieldName: 'vo', filePath: srcFile, fileName: 'voiceover.wav' },
        );
        expect(status).toBe(400);
        expect(body.error).toMatch(/name must be/);
        // No orphaned temp upload left behind under app/tmp-uploads.
        const tmpUploadsDir = path.join(PROJECTS_ROOT, '..', 'tmp-uploads');
        const leftover = fs.existsSync(tmpUploadsDir) ? fs.readdirSync(tmpUploadsDir) : [];
        expect(leftover).toHaveLength(0);
      } finally {
        fs.rmSync(srcFile, { force: true });
      }
    });

    test('POST /api/projects (multipart) streams a 200MB file with flat server RSS (T-84)', async () => {
      const bigProjectName = `${setupProjectName}_bigmp`;
      const bigDir = path.join(PROJECTS_ROOT, bigProjectName);
      const bigFile = path.join(os.tmpdir(), `t84_bigvo_${randomUUID()}.wav`);
      const SIZE = 200 * 1024 * 1024;
      const CHUNK = 8 * 1024 * 1024;
      const chunkBuf = Buffer.alloc(CHUNK, 7);
      try {
        // Write the source file in reused-buffer chunks so the test's own
        // setup doesn't hold 200MB in memory either.
        await new Promise<void>((resolve, reject) => {
          const ws = fs.createWriteStream(bigFile);
          ws.on('error', reject);
          let written = 0;
          const writeNext = () => {
            if (written >= SIZE) {
              ws.end(() => resolve());
              return;
            }
            const remaining = Math.min(CHUNK, SIZE - written);
            const slice = remaining === CHUNK ? chunkBuf : chunkBuf.subarray(0, remaining);
            written += remaining;
            if (ws.write(slice)) process.nextTick(writeNext);
            else ws.once('drain', writeNext);
          };
          writeNext();
        });

        const rssBefore = process.memoryUsage().rss;
        const { status, body } = await postMultipartFile(
          port,
          { name: bigProjectName, script: 'A 200MB multipart smoke test.' },
          { fieldName: 'vo', filePath: bigFile, fileName: 'voiceover.wav' },
        );
        const rssAfter = process.memoryUsage().rss;

        expect(status).toBe(200);
        expect(body.project.name).toBe(bigProjectName);
        const voPath = path.join(bigDir, 'voiceover.wav');
        expect(fs.existsSync(voPath)).toBe(true);
        expect(fs.statSync(voPath).size).toBe(SIZE);

        // A buffered (non-streaming) implementation would grow RSS by
        // roughly the file size or more; a true streaming implementation
        // only pays for small internal chunk buffers.
        const growth = rssAfter - rssBefore;
        expect(growth).toBeLessThan(SIZE * 0.5);
      } finally {
        fs.rmSync(bigFile, { force: true });
        if (fs.existsSync(bigDir)) fs.rmSync(bigDir, { recursive: true, force: true });
      }
    }, 60000);

    test('POST /api/projects creates a project, then POST /align plans shots (and 409s once already planned)', async () => {
      const createRes = await fetch(`http://localhost:${port}/api/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: setupProjectName,
          script: 'A line.\nAnother line.',
          voiceoverBase64: Buffer.from('fake wav bytes').toString('base64'),
          voiceoverExt: 'wav',
        }),
      });
      expect(createRes.status).toBe(200);

      const alignRes = await fetch(`http://localhost:${port}/api/project/${setupProjectName}/align`, { method: 'POST' });
      expect(alignRes.status).toBe(200);
      const alignBody = (await alignRes.json()) as any;
      expect(alignBody.success).toBe(true);
      expect(alignBody.shotCount).toBeGreaterThan(0);

      // Already has shots planned - align refuses to re-plan.
      const secondAlignRes = await fetch(`http://localhost:${port}/api/project/${setupProjectName}/align`, { method: 'POST' });
      expect(secondAlignRes.status).toBe(409);
    });

    test('POST /align on an unknown project 500s (its catch is a blanket one, not a dedicated 404)', async () => {
      const res = await fetch(`http://localhost:${port}/api/project/temp_proj_bogus_align_${Date.now()}/align`, {
        method: 'POST',
      });
      expect(res.status).toBe(500);
    });

    test('POST /align surfaces a real alignScript failure as a 500', async () => {
      const failName = `temp_proj_align_fail_${Date.now()}`;
      extraDirsToClean.push(path.join(PROJECTS_ROOT, failName));
      const createRes = await fetch(`http://localhost:${port}/api/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: failName,
          script: 'A line.',
          voiceoverBase64: Buffer.from('fake wav bytes').toString('base64'),
          voiceoverExt: 'wav',
        }),
      });
      expect(createRes.status).toBe(200);

      mockAlignFail = new Error('stable-ts crashed (simulated)');
      try {
        const res = await fetch(`http://localhost:${port}/api/project/${failName}/align`, { method: 'POST' });
        expect(res.status).toBe(500);
        const body = (await res.json()) as any;
        expect(body.error).toContain('stable-ts crashed');
      } finally {
        mockAlignFail = null;
        await fetch(`http://localhost:${port}/api/project/${failName}/stop`, { method: 'POST' }).catch(() => {});
      }
    });

    test('POST /run: cold start builds+starts fresh, is idempotent while running, and rebuilds after /stop', async () => {
      const createRes = await fetch(`http://localhost:${port}/api/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: runProjectName,
          script: 'A line.',
          voiceoverBase64: Buffer.from('fake wav bytes').toString('base64'),
          voiceoverExt: 'wav',
        }),
      });
      expect(createRes.status).toBe(200);

      // Cold start: never opened via GET/align/WS before - exercises the
      // "not yet cached" branch (getOrOpenProject builds + starts fresh).
      let res = await fetch(`http://localhost:${port}/api/project/${runProjectName}/run`, { method: 'POST' });
      expect(res.status).toBe(200);
      expect((await res.json()).running).toBe(true);

      // Idempotent: already cached AND already running - no-op branch.
      res = await fetch(`http://localhost:${port}/api/project/${runProjectName}/run`, { method: 'POST' });
      expect(res.status).toBe(200);
      expect((await res.json()).running).toBe(true);

      // After an explicit stop, /run rebuilds a fresh queue and restarts it.
      await fetch(`http://localhost:${port}/api/project/${runProjectName}/stop`, { method: 'POST' });
      res = await fetch(`http://localhost:${port}/api/project/${runProjectName}/run`, { method: 'POST' });
      expect(res.status).toBe(200);
      expect((await res.json()).running).toBe(true);
    });

    test('POST /run on an unknown project 404s', async () => {
      const res = await fetch(`http://localhost:${port}/api/project/temp_proj_bogus_run_${Date.now()}/run`, {
        method: 'POST',
      });
      expect(res.status).toBe(404);
    });
  });

  describe('elements endpoint', () => {
    test('GET /elements lists elements, 404s for an unknown project', async () => {
      let res = await fetch(`http://localhost:${port}/api/project/${tempProjectName}/elements`);
      expect(res.status).toBe(200);
      expect(Array.isArray(await res.json())).toBe(true);

      res = await fetch(`http://localhost:${port}/api/project/temp_proj_bogus_elements_${Date.now()}/elements`);
      expect(res.status).toBe(404);
    });

    test('POST /elements validates id/name/category/thumbUrl (400s) and succeeds', async () => {
      const base = `http://localhost:${port}/api/project/${tempProjectName}/elements`;
      const post = (body: unknown) =>
        fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

      expect((await post({})).status).toBe(400); // missing id
      expect((await post({ id: 'x' })).status).toBe(400); // missing name
      expect((await post({ id: 'x', name: 'y', category: 'not-a-category' })).status).toBe(400);
      expect((await post({ id: 'x', name: 'y', category: 'character', thumbUrl: 123 })).status).toBe(400);

      const res = await post({ id: randomUUID(), name: 'Test Element', category: 'character' });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ success: true });
    });
  });

  describe('balance and cost-summary endpoints', () => {
    test('GET /balance succeeds (cached:false) then serves from cache (cached:true)', async () => {
      const accountName = `no-such-balance-account-${Date.now()}`;
      let res = await fetch(`http://localhost:${port}/api/accounts/${accountName}/balance`);
      expect(res.status).toBe(200);
      let body = (await res.json()) as any;
      expect(body.cached).toBe(false);
      expect(body.authenticated).toBe(false);

      res = await fetch(`http://localhost:${port}/api/accounts/${accountName}/balance`);
      body = (await res.json()) as any;
      expect(body.cached).toBe(true);
    });

    test('GET /cost-summary returns totals/byAccount for a real project, 500s for an unknown one', async () => {
      let res = await fetch(`http://localhost:${port}/api/project/${tempProjectName}/cost-summary`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body).toHaveProperty('totals');
      expect(body).toHaveProperty('byAccount');

      res = await fetch(`http://localhost:${port}/api/project/temp_proj_bogus_cost_${Date.now()}/cost-summary`);
      expect(res.status).toBe(500);
    });
  });

  describe('shot action endpoint edge cases', () => {
    test('rejects an unknown action with 400', async () => {
      const shots = db.listShots();
      const res = await fetch(`http://localhost:${port}/api/project/${tempProjectName}/shots/${shots[0]!.id}/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'not-a-real-action' }),
      });
      expect(res.status).toBe(400);
    });

    test('edit without instructions returns 400', async () => {
      const shots = db.listShots();
      const res = await fetch(`http://localhost:${port}/api/project/${tempProjectName}/shots/${shots[0]!.id}/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'edit' }),
      });
      expect(res.status).toBe(400);
    });

    test('an unknown shotId causes a 500 (the queue action rejects with "shot not found")', async () => {
      const res = await fetch(`http://localhost:${port}/api/project/${tempProjectName}/shots/does-not-exist/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'approve' }),
      });
      expect(res.status).toBe(500);
    });
  });

  describe('T-67 production static-serving / SPA fallback', () => {
    // These exercise the REAL ui/dist build already present in this repo
    // checkout (confirmed by the "[server] serving ui from ..." startup log)
    // rather than faking one - startServer() decides once, at startup,
    // whether to register this middleware at all, so a dist dir created
    // mid-test would be too late to matter.

    // Express's OWN default 404/error pages are also generic HTML documents
    // (title "error", a <pre> body) - "<!doctype html>" alone doesn't
    // distinguish them from the real SPA shell, so assert on something only
    // the actual built index.html contains.
    const SPA_MARKER = "director's flick";

    test('GET a non-/api/ client-side route serves the built index.html', async () => {
      const res = await fetch(`http://localhost:${port}/some/client/side/route`);
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body.toLowerCase()).toContain(SPA_MARKER);
    });

    test('GET an unmatched /api/ path does NOT get the SPA fallback', async () => {
      const res = await fetch(`http://localhost:${port}/api/this-route-does-not-exist`);
      expect(res.status).not.toBe(200);
      const body = await res.text();
      expect(body.toLowerCase()).not.toContain(SPA_MARKER);
    });

    test('a non-GET request to a client-side path does NOT get the SPA fallback', async () => {
      const res = await fetch(`http://localhost:${port}/some/client/side/route`, { method: 'POST' });
      expect(res.status).not.toBe(200);
      const body = await res.text();
      expect(body.toLowerCase()).not.toContain(SPA_MARKER);
    });
  });

  test('the periodic 2s full-state sync broadcasts to connected clients (T-73)', async () => {
    // setInterval (unlike this file's setTimeout override) genuinely needs
    // real wall-clock time to fire - no way around a real wait here.
    wsMessages.length = 0;
    await new Promise((resolve) => originalSetTimeout(resolve, 2100));
    const syncMsg = wsMessages.find((m) => m.type === 'sync' && !('project' in m));
    expect(syncMsg).toBeDefined();
    expect(Array.isArray(syncMsg.shots)).toBe(true);
  }, 5_000);

  test('onServerError logs and calls process.exit(1) on EADDRINUSE (T-73)', () => {
    // Exercises the REAL error-handling closure via the REAL captured server
    // instance (no source change) - process.exit is mocked so this can't
    // actually kill the test worker; the real code unconditionally re-throws
    // right after (dead code in production, since process.exit(1) never
    // returns there), so the mocked call surfaces as a thrown error here.
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const err = Object.assign(new Error('listen EADDRINUSE: address already in use'), { code: 'EADDRINUSE' });
      expect(() => serverInstance!.emit('error', err)).toThrow();
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(errorSpy.mock.calls.some((call) => String(call[0]).includes('already in use'))).toBe(true);
    } finally {
      exitSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});
