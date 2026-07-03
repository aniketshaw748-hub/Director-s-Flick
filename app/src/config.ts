/**
 * config.ts — pipeline configuration loading (cli module).
 *
 * Precedence (lowest -> highest):
 *   1. DEFAULT_CONFIG (src/types.ts — the single source of default values:
 *      provider 'mock', image 'nano_banana_2', video 'kling3_0', videoMode
 *      'std', soundOff true, aspectRatio '16:9', bufferSize 5, concurrency 4,
 *      elementsViaPlaceholders true, styleBible '')
 *   2. app/config.json — optional global overrides (same shape, all fields
 *      optional; `models` may be a partial object)
 *   3. project config_json — the config persisted in
 *      app/projects/<name>/pipeline.db, when that project already exists
 *   4. explicit `overrides` argument (e.g. CLI flags)
 */

import fs from 'node:fs';
import path from 'node:path';
import { APP_ROOT, ProjectDb, projectDbPath } from './db.js';
import type { PipelineConfig } from './types.js';
import { DEFAULT_CONFIG } from './types.js';

/** Partial config accepted from app/config.json and from callers. */
export type ConfigOverrides = Partial<Omit<PipelineConfig, 'models'>> & {
  models?: Partial<PipelineConfig['models']>;
};

/** Optional global overrides file. */
export const APP_CONFIG_PATH = path.join(APP_ROOT, 'config.json');

/** Copy of `obj` without keys whose value is undefined (so an override object
 * built from optional CLI flags never clobbers lower-precedence values). */
function definedOnly<T extends object>(obj: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out as Partial<T>;
}

/** Merge one overrides layer onto a full config (models merged one level deep).
 * Exported for reuse by server.ts's PATCH /config endpoint (T-51) - same
 * partial-merge semantics as the app/config.json + project config layering. */
export function mergeLayer(base: PipelineConfig, layer?: ConfigOverrides): PipelineConfig {
  if (!layer) return base;
  const { models, ...rest } = layer;
  return {
    ...base,
    ...definedOnly(rest),
    models: { ...base.models, ...definedOnly(models ?? {}) },
  };
}

/** Read app/config.json if present. Throws on malformed JSON (never silently
 * ignores a broken config file). */
function readAppConfig(): ConfigOverrides | undefined {
  if (!fs.existsSync(APP_CONFIG_PATH)) return undefined;
  const raw = fs.readFileSync(APP_CONFIG_PATH, 'utf8');
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('expected a JSON object');
    }
    return parsed as ConfigOverrides;
  } catch (err) {
    throw new Error(
      `config: failed to parse ${APP_CONFIG_PATH}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Read the persisted project config from the project DB, when it exists.
 * Never creates the project directory as a side effect. */
function readProjectConfig(projectName: string): PipelineConfig | undefined {
  const dbFile = projectDbPath(projectName);
  if (!fs.existsSync(dbFile)) return undefined;
  const db = new ProjectDb(projectName, dbFile);
  try {
    return db.getProject()?.config;
  } finally {
    db.close();
  }
}

/**
 * Resolve the effective PipelineConfig for a project.
 * Contract (ARCHITECTURE.md): project config_json if present, else
 * DEFAULT_CONFIG, in both cases with optional app/config.json overrides.
 * The optional `overrides` argument (CLI flags) has the highest precedence.
 */
export function loadConfig(projectName: string, overrides?: ConfigOverrides): PipelineConfig {
  let config = mergeLayer(DEFAULT_CONFIG, readAppConfig());
  const projectConfig = readProjectConfig(projectName);
  if (projectConfig) config = mergeLayer(config, projectConfig);
  return mergeLayer(config, overrides);
}
