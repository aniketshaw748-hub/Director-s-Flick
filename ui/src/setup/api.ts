/**
 * api.ts — typed client for the T-27 setup-flow endpoints (T-28).
 *
 * Server contract: app/src/server.ts ("T-27 setup-flow endpoints" section).
 * Uploads are base64-in-JSON (server decision — no multipart middleware).
 *
 * CAUTION: never GET /api/project/<name> or open a WS for a project that
 * hasn't been created yet — the server's getOrOpenProject/openProjectDb
 * creates the project directory + db as a side effect, so probing a draft
 * name would leave an empty project shell on disk.
 */
import type { ElementRef, Project, Shot, ElementCategory } from '../../../app/src/types';

export interface ProjectState {
  project: Project;
  shots: Shot[];
  elements: ElementRef[];
}

async function j<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((body as { error?: string }).error ?? `${res.status} ${res.statusText}`);
  }
  return body as T;
}

export function listProjects(): Promise<string[]> {
  return fetch('/api/projects').then((r) => j<string[]>(r));
}

export function getProjectState(name: string): Promise<ProjectState> {
  return fetch(`/api/project/${encodeURIComponent(name)}`).then((r) => j<ProjectState>(r));
}

export async function createProject(
  name: string,
  script: string,
  voFile: File,
): Promise<Project> {
  // T-85 (live OOM fix): multipart FormData per the T-84 contract — parts
  // `name`/`script`/`vo`. The File object is appended directly so the browser
  // STREAMS it from disk; the old base64-in-JSON path materialized the whole
  // VO (x1.33) as strings in renderer memory and crashed the tab on real
  // voiceovers. No manual Content-Type: the browser must set the multipart
  // boundary itself.
  const form = new FormData();
  form.append('name', name);
  form.append('script', script);
  form.append('vo', voFile);
  const res = await fetch('/api/projects', {
    method: 'POST',
    body: form,
  });
  return (await j<{ project: Project }>(res)).project;
}

/** Runs segmentation + stable-ts alignment + shot planning; progress arrives
 *  over the project WS as `{type:'alignProgress', line}` messages.
 *  `force` re-aligns an already-planned project — the server only honors it
 *  while every shot is still PENDING (nothing generated can be lost). */
export function alignProject(name: string, force = false): Promise<{ success: boolean; shotCount: number }> {
  return fetch(`/api/project/${encodeURIComponent(name)}/align`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ force }),
  }).then((r) => j<{ success: boolean; shotCount: number }>(r));
}

/** Read the project's actual script.txt (not the segmented shot texts). */
export function fetchScript(name: string): Promise<{ script: string }> {
  return fetch(`/api/project/${encodeURIComponent(name)}/script`).then((r) => j<{ script: string }>(r));
}

/** Overwrite script.txt — takes effect at the next (re-)alignment. */
export function saveScript(name: string, script: string): Promise<{ success: boolean }> {
  return fetch(`/api/project/${encodeURIComponent(name)}/script`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ script }),
  }).then((r) => j<{ success: boolean }>(r));
}

export function startRun(name: string): Promise<{ running: boolean }> {
  return fetch(`/api/project/${encodeURIComponent(name)}/run`, { method: 'POST' }).then((r) =>
    j<{ running: boolean }>(r),
  );
}

export function stopRun(name: string): Promise<{ running: boolean }> {
  return fetch(`/api/project/${encodeURIComponent(name)}/stop`, { method: 'POST' }).then((r) =>
    j<{ running: boolean }>(r),
  );
}

export function listElements(name: string): Promise<ElementRef[]> {
  return fetch(`/api/project/${encodeURIComponent(name)}/elements`).then((r) => j<ElementRef[]>(r));
}

export function upsertElement(name: string, el: ElementRef): Promise<{ success: boolean }> {
  return fetch(`/api/project/${encodeURIComponent(name)}/elements`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(el),
  }).then((r) => j<{ success: boolean }>(r));
}

export const ELEMENT_CATEGORIES: readonly ElementCategory[] = ['character', 'location', 'prop'];

/** Valid project name per the server's create-project validation. */
export function isValidProjectName(name: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(name);
}

// ---------------------------------------------------------------------------
// Cost model (mirrors app/src/types.ts clampVideoSeconds + Phase-0 measured
// rates — source of truth: types.ts / docs/cost-model.md; keep in sync).
// ---------------------------------------------------------------------------

const MIN_CLIP_SECONDS = 3;
const MAX_CLIP_SECONDS = 15;
/** kling3_0 std sound-off: 6.25 cr / 5s  = 1.25 cr/s (measured, Phase 0) */
const VIDEO_CR_PER_SECOND = 1.25;
/** nano_banana_2: 1.5 cr / image (measured, Phase 0) */
const IMAGE_CR = 1.5;
/** re-roll allowance used by the mockup's estimate */
const REROLL_FACTOR = 1.2;

export interface CostEstimate {
  imageCr: number;
  videoCr: number;
  totalCr: number;
  usd: number;
}

export function estimateRunCost(shots: Shot[]): CostEstimate {
  const imageCr = shots.length * IMAGE_CR * REROLL_FACTOR;
  const videoCr = shots.reduce((sum, s) => {
    const secs = Math.min(MAX_CLIP_SECONDS, Math.max(MIN_CLIP_SECONDS, Math.ceil(s.line.targetDuration)));
    return sum + secs * VIDEO_CR_PER_SECOND;
  }, 0);
  const totalCr = imageCr + videoCr;
  return { imageCr, videoCr, totalCr, usd: totalCr * 0.06 };
}
