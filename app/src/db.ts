/**
 * db.ts — SQLite persistence (better-sqlite3, WAL mode).
 *
 * One database per project: app/projects/<name>/pipeline.db
 * Tables: projects, shots, jobs, edl, cost_ledger, elements.
 *
 * All accessors are synchronous (better-sqlite3 is sync by design) and typed
 * against src/types.ts. JSON-shaped columns (line timing, specs, config) are
 * stored as TEXT and (de)serialized here — callers only ever see the typed
 * shapes.
 */

import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import type {
  CostLedgerEntry,
  EDLEntry,
  ElementRef,
  JobResult,
  JobSpec,
  JobStatus,
  PipelineConfig,
  Project,
  Shot,
  ShotState,
} from './types.js';
import { DEFAULT_CONFIG, SHOT_TRANSITIONS } from './types.js';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** app/ root (this file lives in app/src/). */
export const APP_ROOT = path.resolve(import.meta.dirname, '..');
export const PROJECTS_ROOT = path.join(APP_ROOT, 'projects');

export function projectDir(name: string): string {
  return path.join(PROJECTS_ROOT, name);
}

export function projectDbPath(name: string): string {
  return path.join(projectDir(name), 'pipeline.db');
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  script_path TEXT NOT NULL,
  vo_path     TEXT NOT NULL,
  config_json TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS shots (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL REFERENCES projects(id),
  line_index       INTEGER NOT NULL,
  sub_index        INTEGER NOT NULL DEFAULT 0,
  state            TEXT NOT NULL,
  line_json        TEXT NOT NULL,
  element_ids_json TEXT NOT NULL DEFAULT '[]',
  image_prompt     TEXT,
  animation_prompt TEXT,
  image_job_id     TEXT,
  video_job_id     TEXT,
  image_path       TEXT,
  video_path       TEXT,
  video_seconds    INTEGER,
  attempts         INTEGER NOT NULL DEFAULT 0,
  last_error       TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  UNIQUE (project_id, line_index, sub_index)
);
CREATE INDEX IF NOT EXISTS idx_shots_state ON shots(project_id, state);

CREATE TABLE IF NOT EXISTS jobs (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id),
  shot_id         TEXT REFERENCES shots(id),
  kind            TEXT NOT NULL CHECK (kind IN ('image','video')),
  model           TEXT NOT NULL,
  spec_json       TEXT NOT NULL,
  status          TEXT NOT NULL,
  result_url      TEXT,
  local_path      TEXT,
  credits_charged REAL,
  error           TEXT,
  submitted_at    TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(project_id, status);

CREATE TABLE IF NOT EXISTS edl (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES projects(id),
  shot_id        TEXT NOT NULL REFERENCES shots(id),
  line_index     INTEGER NOT NULL,
  clip_path      TEXT NOT NULL,
  in_point       REAL NOT NULL DEFAULT 0,
  out_point      REAL NOT NULL,
  timeline_start REAL NOT NULL,
  duration       REAL NOT NULL,
  UNIQUE (project_id, shot_id)
);
CREATE INDEX IF NOT EXISTS idx_edl_timeline ON edl(project_id, timeline_start);

CREATE TABLE IF NOT EXISTS cost_ledger (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id        TEXT NOT NULL REFERENCES projects(id),
  job_id            TEXT NOT NULL,
  shot_id           TEXT,
  kind              TEXT NOT NULL CHECK (kind IN ('image','video','other')),
  model             TEXT NOT NULL,
  preflight_credits REAL,
  charged_credits   REAL,
  account_name      TEXT,
  provider          TEXT,
  unit              TEXT,
  created_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS elements (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  name       TEXT NOT NULL,
  category   TEXT NOT NULL CHECK (category IN ('character','location','prop')),
  thumb_url  TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (project_id, name)
);
`;

/**
 * Add a column to an already-created table if it's missing (SQLite has no
 * `ADD COLUMN IF NOT EXISTS`). Needed because `CREATE TABLE IF NOT EXISTS`
 * only affects brand-new databases — an existing project's db predating a
 * schema addition needs an explicit migration.
 */
function ensureColumn(db: Database.Database, table: string, column: string, definition: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

// ---------------------------------------------------------------------------
// Row <-> type mapping
// ---------------------------------------------------------------------------

function now(): string {
  return new Date().toISOString();
}

interface ShotRow {
  id: string;
  project_id: string;
  line_index: number;
  sub_index: number;
  state: string;
  line_json: string;
  element_ids_json: string;
  image_prompt: string | null;
  animation_prompt: string | null;
  image_job_id: string | null;
  video_job_id: string | null;
  image_path: string | null;
  video_path: string | null;
  video_seconds: number | null;
  attempts: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

function rowToShot(r: ShotRow): Shot {
  const shot: Shot = {
    id: r.id,
    projectId: r.project_id,
    lineIndex: r.line_index,
    subIndex: r.sub_index,
    state: r.state as ShotState,
    line: JSON.parse(r.line_json),
    elementIds: JSON.parse(r.element_ids_json),
    attempts: r.attempts,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
  if (r.image_prompt !== null) shot.imagePrompt = r.image_prompt;
  if (r.animation_prompt !== null) shot.animationPrompt = r.animation_prompt;
  if (r.image_job_id !== null) shot.imageJobId = r.image_job_id;
  if (r.video_job_id !== null) shot.videoJobId = r.video_job_id;
  if (r.image_path !== null) shot.imagePath = r.image_path;
  if (r.video_path !== null) shot.videoPath = r.video_path;
  if (r.video_seconds !== null) shot.videoSeconds = r.video_seconds;
  if (r.last_error !== null) shot.lastError = r.last_error;
  return shot;
}

function rowToElementRef(r: {
  id: string;
  name: string;
  category: ElementRef['category'];
  thumb_url: string | null;
}): ElementRef {
  const el: ElementRef = { id: r.id, name: r.name, category: r.category };
  if (r.thumb_url !== null) el.thumbUrl = r.thumb_url;
  return el;
}

export interface JobRow {
  id: string;
  projectId: string;
  shotId?: string;
  kind: 'image' | 'video';
  model: string;
  spec: JobSpec;
  status: JobStatus;
  resultUrl?: string;
  localPath?: string;
  creditsCharged?: number;
  error?: string;
  submittedAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// ProjectDb
// ---------------------------------------------------------------------------

/**
 * Open (creating if needed) the database for a project. Creates
 * app/projects/<name>/ and enables WAL. Callers should reuse one instance
 * per process; better-sqlite3 handles cross-process WAL safely.
 */
export function openProjectDb(name: string): ProjectDb {
  fs.mkdirSync(projectDir(name), { recursive: true });
  return new ProjectDb(name, projectDbPath(name));
}

export class ProjectDb {
  readonly db: Database.Database;
  readonly projectName: string;

  constructor(projectName: string, dbFile: string) {
    this.projectName = projectName;
    this.db = new Database(dbFile);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(SCHEMA);
    // Migrate columns added after a project's db was first created.
    ensureColumn(this.db, 'cost_ledger', 'account_name', 'TEXT');
    ensureColumn(this.db, 'cost_ledger', 'provider', 'TEXT');
    ensureColumn(this.db, 'cost_ledger', 'unit', 'TEXT');
    ensureColumn(this.db, 'elements', 'thumb_url', 'TEXT');
  }

  close(): void {
    this.db.close();
  }

  // ---- projects -----------------------------------------------------------

  /** Insert the project row if missing; returns the stored Project. */
  ensureProject(input: {
    name: string;
    scriptPath: string;
    voPath: string;
    config?: PipelineConfig;
  }): Project {
    const existing = this.getProject();
    if (existing) return existing;
    const p: Project = {
      id: randomUUID(),
      name: input.name,
      scriptPath: input.scriptPath,
      voPath: input.voPath,
      config: input.config ?? DEFAULT_CONFIG,
      createdAt: now(),
      updatedAt: now(),
    };
    this.db
      .prepare(
        `INSERT INTO projects (id, name, script_path, vo_path, config_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(p.id, p.name, p.scriptPath, p.voPath, JSON.stringify(p.config), p.createdAt, p.updatedAt);
    return p;
  }

  getProject(): Project | undefined {
    const r = this.db.prepare(`SELECT * FROM projects LIMIT 1`).get() as
      | {
          id: string;
          name: string;
          script_path: string;
          vo_path: string;
          config_json: string;
          created_at: string;
          updated_at: string;
        }
      | undefined;
    if (!r) return undefined;
    return {
      id: r.id,
      name: r.name,
      scriptPath: r.script_path,
      voPath: r.vo_path,
      config: JSON.parse(r.config_json),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  saveConfig(projectId: string, config: PipelineConfig): void {
    this.db
      .prepare(`UPDATE projects SET config_json = ?, updated_at = ? WHERE id = ?`)
      .run(JSON.stringify(config), now(), projectId);
  }

  // ---- shots --------------------------------------------------------------

  /**
   * Delete ALL shots for a project (force re-alignment). Callers must gate on
   * every shot still being PENDING — this does not touch generated media.
   */
  deleteAllShots(projectId: string): number {
    return this.db.prepare(`DELETE FROM shots WHERE project_id = ?`).run(projectId).changes;
  }

  /** Insert shots (e.g. after alignment + sub-shot split). Idempotent per (line_index, sub_index). */
  insertShots(shots: Shot[]): void {
    const stmt = this.db.prepare(
      `INSERT OR IGNORE INTO shots
         (id, project_id, line_index, sub_index, state, line_json, element_ids_json,
          image_prompt, animation_prompt, image_job_id, video_job_id, image_path,
          video_path, video_seconds, attempts, last_error, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertAll = this.db.transaction((rows: Shot[]) => {
      for (const s of rows) {
        stmt.run(
          s.id,
          s.projectId,
          s.lineIndex,
          s.subIndex,
          s.state,
          JSON.stringify(s.line),
          JSON.stringify(s.elementIds),
          s.imagePrompt ?? null,
          s.animationPrompt ?? null,
          s.imageJobId ?? null,
          s.videoJobId ?? null,
          s.imagePath ?? null,
          s.videoPath ?? null,
          s.videoSeconds ?? null,
          s.attempts,
          s.lastError ?? null,
          s.createdAt,
          s.updatedAt,
        );
      }
    });
    insertAll(shots);
  }

  getShot(shotId: string): Shot | undefined {
    const r = this.db.prepare(`SELECT * FROM shots WHERE id = ?`).get(shotId) as ShotRow | undefined;
    return r ? rowToShot(r) : undefined;
  }

  /** All shots ordered by (line_index, sub_index); optionally filtered by state. */
  listShots(state?: ShotState): Shot[] {
    const rows = (
      state
        ? this.db
            .prepare(`SELECT * FROM shots WHERE state = ? ORDER BY line_index, sub_index`)
            .all(state)
        : this.db.prepare(`SELECT * FROM shots ORDER BY line_index, sub_index`).all()
    ) as ShotRow[];
    return rows.map(rowToShot);
  }

  countShots(state: ShotState): number {
    const r = this.db.prepare(`SELECT COUNT(*) AS n FROM shots WHERE state = ?`).get(state) as {
      n: number;
    };
    return r.n;
  }

  /**
   * Transition a shot to a new state, optionally patching fields.
   * Throws on an illegal transition (per SHOT_TRANSITIONS in types.ts).
   */
  updateShotState(
    shotId: string,
    state: ShotState,
    patch?: Partial<
      Pick<
        Shot,
        | 'imagePrompt'
        | 'animationPrompt'
        | 'imageJobId'
        | 'videoJobId'
        | 'imagePath'
        | 'videoPath'
        | 'videoSeconds'
        | 'attempts'
        | 'lastError'
      >
    >,
  ): Shot {
    const current = this.getShot(shotId);
    if (!current) throw new Error(`updateShotState: shot not found: ${shotId}`);
    if (current.state !== state && !SHOT_TRANSITIONS[current.state].includes(state)) {
      throw new Error(
        `updateShotState: illegal transition ${current.state} -> ${state} (shot ${shotId})`,
      );
    }
    const merged = { ...current, ...patch, state, updatedAt: now() };
    this.db
      .prepare(
        `UPDATE shots SET
           state = ?, image_prompt = ?, animation_prompt = ?, image_job_id = ?,
           video_job_id = ?, image_path = ?, video_path = ?, video_seconds = ?,
           attempts = ?, last_error = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        merged.state,
        merged.imagePrompt ?? null,
        merged.animationPrompt ?? null,
        merged.imageJobId ?? null,
        merged.videoJobId ?? null,
        merged.imagePath ?? null,
        merged.videoPath ?? null,
        merged.videoSeconds ?? null,
        merged.attempts,
        merged.lastError ?? null,
        merged.updatedAt,
        shotId,
      );
    return merged;
  }

  // ---- jobs ---------------------------------------------------------------

  insertJob(job: JobRow): void {
    this.db
      .prepare(
        `INSERT INTO jobs
           (id, project_id, shot_id, kind, model, spec_json, status, result_url,
            local_path, credits_charged, error, submitted_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        job.id,
        job.projectId,
        job.shotId ?? null,
        job.kind,
        job.model,
        JSON.stringify(job.spec),
        job.status,
        job.resultUrl ?? null,
        job.localPath ?? null,
        job.creditsCharged ?? null,
        job.error ?? null,
        job.submittedAt,
        job.updatedAt,
      );
  }

  /** Merge a poll/download result into the job row. */
  updateJobResult(result: JobResult): void {
    this.db
      .prepare(
        `UPDATE jobs SET
           status = ?,
           result_url = COALESCE(?, result_url),
           local_path = COALESCE(?, local_path),
           credits_charged = COALESCE(?, credits_charged),
           error = COALESCE(?, error),
           updated_at = ?
         WHERE id = ?`,
      )
      .run(
        result.status,
        result.resultUrl ?? null,
        result.localPath ?? null,
        result.creditsCharged ?? null,
        result.error ?? null,
        now(),
        result.jobId,
      );
  }

  getJob(jobId: string): JobRow | undefined {
    const r = this.db.prepare(`SELECT * FROM jobs WHERE id = ?`).get(jobId) as
      | {
          id: string;
          project_id: string;
          shot_id: string | null;
          kind: 'image' | 'video';
          model: string;
          spec_json: string;
          status: JobStatus;
          result_url: string | null;
          local_path: string | null;
          credits_charged: number | null;
          error: string | null;
          submitted_at: string;
          updated_at: string;
        }
      | undefined;
    if (!r) return undefined;
    const job: JobRow = {
      id: r.id,
      projectId: r.project_id,
      kind: r.kind,
      model: r.model,
      spec: JSON.parse(r.spec_json),
      status: r.status,
      submittedAt: r.submitted_at,
      updatedAt: r.updated_at,
    };
    if (r.shot_id !== null) job.shotId = r.shot_id;
    if (r.result_url !== null) job.resultUrl = r.result_url;
    if (r.local_path !== null) job.localPath = r.local_path;
    if (r.credits_charged !== null) job.creditsCharged = r.credits_charged;
    if (r.error !== null) job.error = r.error;
    return job;
  }

  /** Jobs still in flight ('queued' | 'in_progress') — crash-resume entry point. */
  listOpenJobs(): JobRow[] {
    const ids = this.db
      .prepare(`SELECT id FROM jobs WHERE status IN ('queued','in_progress')`)
      .all() as { id: string }[];
    return ids.map((r) => this.getJob(r.id)!) ;
  }

  // ---- edl ----------------------------------------------------------------

  /** Insert or replace the placed clip for a shot (timeline redo replaces). */
  upsertEdlEntry(entry: EDLEntry): void {
    this.db
      .prepare(
        `INSERT INTO edl (id, project_id, shot_id, line_index, clip_path, in_point,
                          out_point, timeline_start, duration)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (project_id, shot_id) DO UPDATE SET
           clip_path = excluded.clip_path,
           in_point = excluded.in_point,
           out_point = excluded.out_point,
           timeline_start = excluded.timeline_start,
           duration = excluded.duration`,
      )
      .run(
        entry.id,
        entry.projectId,
        entry.shotId,
        entry.lineIndex,
        entry.clipPath,
        entry.inPoint,
        entry.outPoint,
        entry.timelineStart,
        entry.duration,
      );
  }

  /** Full EDL in timeline order — the export input. */
  listEdl(): EDLEntry[] {
    const rows = this.db
      .prepare(`SELECT * FROM edl ORDER BY timeline_start`)
      .all() as {
      id: string;
      project_id: string;
      shot_id: string;
      line_index: number;
      clip_path: string;
      in_point: number;
      out_point: number;
      timeline_start: number;
      duration: number;
    }[];
    return rows.map((r) => ({
      id: r.id,
      projectId: r.project_id,
      shotId: r.shot_id,
      lineIndex: r.line_index,
      clipPath: r.clip_path,
      inPoint: r.in_point,
      outPoint: r.out_point,
      timelineStart: r.timeline_start,
      duration: r.duration,
    }));
  }

  // ---- cost ledger --------------------------------------------------------

  insertLedger(entry: CostLedgerEntry): number {
    const info = this.db
      .prepare(
        `INSERT INTO cost_ledger (project_id, job_id, shot_id, kind, model,
                                  preflight_credits, charged_credits, account_name,
                                  provider, unit, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.projectId,
        entry.jobId,
        entry.shotId ?? null,
        entry.kind,
        entry.model,
        entry.preflightCredits,
        entry.chargedCredits,
        entry.accountName ?? null,
        entry.provider ?? null,
        entry.unit ?? null,
        entry.createdAt,
      );
    return Number(info.lastInsertRowid);
  }

  /** Reconcile the actual charge once known (ledger is ground truth). */
  updateLedgerCharge(jobId: string, chargedCredits: number): void {
    this.db
      .prepare(`UPDATE cost_ledger SET charged_credits = ? WHERE job_id = ?`)
      .run(chargedCredits, jobId);
  }

  /** Tag a ledger row's account after the fact (e.g. accounts.ts's job->account
   * map reconciled once a queue's ShotQueue knows the active account). */
  updateLedgerAccount(jobId: string, accountName: string): void {
    this.db
      .prepare(`UPDATE cost_ledger SET account_name = ? WHERE job_id = ?`)
      .run(accountName, jobId);
  }

  listLedger(): CostLedgerEntry[] {
    const rows = this.db
      .prepare(`SELECT * FROM cost_ledger ORDER BY id`)
      .all() as {
      id: number;
      project_id: string;
      job_id: string;
      shot_id: string | null;
      kind: 'image' | 'video' | 'other';
      model: string;
      preflight_credits: number | null;
      charged_credits: number | null;
      account_name: string | null;
      provider: string | null;
      unit: string | null;
      created_at: string;
    }[];
    return rows.map((r) => {
      const e: CostLedgerEntry = {
        id: r.id,
        projectId: r.project_id,
        jobId: r.job_id,
        kind: r.kind,
        model: r.model,
        preflightCredits: r.preflight_credits,
        chargedCredits: r.charged_credits,
        createdAt: r.created_at,
      };
      if (r.shot_id !== null) e.shotId = r.shot_id;
      if (r.account_name !== null) e.accountName = r.account_name;
      if (r.provider !== null) e.provider = r.provider as CostLedgerEntry['provider'];
      if (r.unit !== null) e.unit = r.unit as CostLedgerEntry['unit'];
      return e;
    });
  }

  /** Sum of charged credits (falling back to preflight when charge unknown). */
  totalCredits(): number {
    const r = this.db
      .prepare(
        `SELECT COALESCE(SUM(COALESCE(charged_credits, preflight_credits, 0)), 0) AS total
         FROM cost_ledger`,
      )
      .get() as { total: number };
    return r.total;
  }

  // ---- elements -----------------------------------------------------------

  upsertElement(projectId: string, el: ElementRef): void {
    this.db
      .prepare(
        `INSERT INTO elements (id, project_id, name, category, thumb_url, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           name = excluded.name, category = excluded.category, thumb_url = excluded.thumb_url`,
      )
      .run(el.id, projectId, el.name, el.category, el.thumbUrl ?? null, now());
  }

  listElements(): ElementRef[] {
    const rows = this.db
      .prepare(`SELECT id, name, category, thumb_url FROM elements ORDER BY name`)
      .all() as { id: string; name: string; category: ElementRef['category']; thumb_url: string | null }[];
    return rows.map((r) => rowToElementRef(r));
  }

  getElementByName(name: string): ElementRef | undefined {
    const r = this.db
      .prepare(`SELECT id, name, category, thumb_url FROM elements WHERE name = ?`)
      .get(name) as
      | { id: string; name: string; category: ElementRef['category']; thumb_url: string | null }
      | undefined;
    return r ? rowToElementRef(r) : undefined;
  }
}
