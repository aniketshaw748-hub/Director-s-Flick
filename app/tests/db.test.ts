import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { ProjectDb } from '../src/db.js';
import type { Shot, JobRow, CostLedgerEntry, EDLEntry, ElementRef } from '../src/types.js';
import fs from 'node:fs';
import path from 'node:path';

const TEST_PROJECT_NAME = 'temp_test_project_db';
const TEST_DB_DIR = path.resolve('projects', TEST_PROJECT_NAME);
const TEST_DB_FILE = path.join(TEST_DB_DIR, 'pipeline.db');

describe('db', () => {
  let db: ProjectDb;

  beforeAll(() => {
    // Ensure clean state
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

  test('ensureProject and getProject work correctly', () => {
    const project = db.ensureProject({
      name: TEST_PROJECT_NAME,
      scriptPath: 'script.txt',
      voPath: 'vo.wav',
    });

    expect(project).toBeDefined();
    expect(project.name).toBe(TEST_PROJECT_NAME);
    expect(project.scriptPath).toBe('script.txt');

    const project2 = db.getProject();
    expect(project2).toBeDefined();
    expect(project2!.id).toBe(project.id);
  });

  test('saveConfig updates project config', () => {
    const project = db.getProject()!;
    const newConfig = {
      ...project.config,
      bufferSize: 10,
      concurrency: 8,
    };

    db.saveConfig(project.id, newConfig);
    const updated = db.getProject()!;
    expect(updated.config.bufferSize).toBe(10);
    expect(updated.config.concurrency).toBe(8);
  });

  test('insertShots and listShots work correctly', () => {
    const project = db.getProject()!;
    const mockShot: Shot = {
      id: 'shot-uuid-1',
      projectId: project.id,
      lineIndex: 0,
      subIndex: 0,
      state: 'PENDING',
      line: {
        index: 0,
        text: 'Test shot line text.',
        start: 0,
        end: 3.0,
        duration: 3.0,
        pauseAfter: 1.0,
        targetDuration: 4.0,
      },
      elementIds: [],
      attempts: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    db.insertShots([mockShot]);

    const shots = db.listShots();
    expect(shots).toHaveLength(1);
    expect(shots[0]!.id).toBe('shot-uuid-1');
    expect(shots[0]!.line.text).toBe('Test shot line text.');

    const count = db.countShots('PENDING');
    expect(count).toBe(1);
  });

  test('updateShotState enforces legal transitions and rejects illegal ones', () => {
    const shotId = 'shot-uuid-1';
    
    // Legal transition: PENDING -> PROMPTED
    const updated = db.updateShotState(shotId, 'PROMPTED', { imagePrompt: 'Generated prompt' });
    expect(updated.state).toBe('PROMPTED');
    expect(updated.imagePrompt).toBe('Generated prompt');

    // Illegal transition: PROMPTED -> APPROVED (not allowed by SHOT_TRANSITIONS)
    expect(() => {
      db.updateShotState(shotId, 'APPROVED');
    }).toThrow();

    // Verify state did not change to APPROVED
    const shot = db.getShot(shotId);
    expect(shot!.state).toBe('PROMPTED');
  });

  test('jobs CRUD functions work correctly', () => {
    const project = db.getProject()!;
    const mockJob: JobRow = {
      id: 'job-uuid-1',
      projectId: project.id,
      shotId: 'shot-uuid-1',
      kind: 'image',
      model: 'nano_banana_2',
      spec: {
        kind: 'image',
        prompt: 'Generated prompt',
        elementIds: [],
        model: 'nano_banana_2',
        aspectRatio: '16:9',
      },
      status: 'queued',
      submittedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    db.insertJob(mockJob);

    const openJobs = db.listOpenJobs();
    expect(openJobs).toHaveLength(1);
    expect(openJobs[0]!.id).toBe('job-uuid-1');

    db.updateJobResult({
      jobId: 'job-uuid-1',
      status: 'completed',
      resultUrl: 'http://example.com/result.png',
      creditsCharged: 1.5,
    });

    const job = db.getJob('job-uuid-1');
    expect(job!.status).toBe('completed');
    expect(job!.resultUrl).toBe('http://example.com/result.png');
    expect(job!.creditsCharged).toBe(1.5);

    const openJobsAfter = db.listOpenJobs();
    expect(openJobsAfter).toHaveLength(0); // since status is now completed
  });

  test('edl CRUD functions work correctly', () => {
    const project = db.getProject()!;
    const mockEdl: EDLEntry = {
      id: 'edl-uuid-1',
      projectId: project.id,
      shotId: 'shot-uuid-1',
      lineIndex: 0,
      clipPath: 'projects/temp_test_project_db/clips/shot-uuid-1.mp4',
      inPoint: 0.0,
      outPoint: 4.0,
      timelineStart: 0.0,
      duration: 4.0,
    };

    db.upsertEdlEntry(mockEdl);

    const edl = db.listEdl();
    expect(edl).toHaveLength(1);
    expect(edl[0]!.id).toBe('edl-uuid-1');
    expect(edl[0]!.duration).toBe(4.0);

    // Update clipPath
    mockEdl.clipPath = 'new/path.mp4';
    db.upsertEdlEntry(mockEdl);

    const edlAfter = db.listEdl();
    expect(edlAfter[0]!.clipPath).toBe('new/path.mp4');
  });

  test('ledger and elements CRUD work correctly', () => {
    const project = db.getProject()!;
    
    // Ledger
    const mockLedger: CostLedgerEntry = {
      projectId: project.id,
      jobId: 'job-uuid-1',
      shotId: 'shot-uuid-1',
      kind: 'image',
      model: 'nano_banana_2',
      preflightCredits: 1.5,
      chargedCredits: null,
      createdAt: new Date().toISOString(),
    };

    const ledgerId = db.insertLedger(mockLedger);
    expect(ledgerId).toBeTypeOf('number');

    expect(db.totalCredits()).toBe(1.5);

    db.updateLedgerCharge('job-uuid-1', 1.25);
    expect(db.totalCredits()).toBe(1.25);

    const ledgerList = db.listLedger();
    expect(ledgerList).toHaveLength(1);
    expect(ledgerList[0]!.chargedCredits).toBe(1.25);

    // Elements
    const mockElement: ElementRef = {
      id: 'element-uuid-1',
      name: 'Hapie-character',
      category: 'character',
    };

    db.upsertElement(project.id, mockElement);

    const elList = db.listElements();
    expect(elList).toHaveLength(1);
    expect(elList[0]!.id).toBe('element-uuid-1');

    const retrieved = db.getElementByName('Hapie-character');
    expect(retrieved).toBeDefined();
    expect(retrieved!.id).toBe('element-uuid-1');
  });
});
