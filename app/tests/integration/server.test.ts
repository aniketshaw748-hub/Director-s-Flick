import { vi, describe, test, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocket } from 'ws';
import { ProjectDb, PROJECTS_ROOT, projectDbPath } from '../../src/db.js';
import { startServer } from '../../src/server.js';

let serverInstance: http.Server | undefined;
const openDbs: ProjectDb[] = [];

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
});
