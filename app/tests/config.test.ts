import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig, APP_CONFIG_PATH } from '../src/config.js';
import { ProjectDb, projectDbPath, projectDir } from '../src/db.js';
import { DEFAULT_CONFIG } from '../src/types.js';
import fs from 'node:fs';
import path from 'node:path';

const TEST_PROJECT_NAME = 'temp_test_project_config';
const TEST_DB_DIR = projectDir(TEST_PROJECT_NAME);

describe('config', () => {
  beforeEach(() => {
    // Clean up
    if (fs.existsSync(APP_CONFIG_PATH)) {
      fs.unlinkSync(APP_CONFIG_PATH);
    }
    if (fs.existsSync(TEST_DB_DIR)) {
      fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
    }
  });

  afterEach(() => {
    // Clean up
    if (fs.existsSync(APP_CONFIG_PATH)) {
      fs.unlinkSync(APP_CONFIG_PATH);
    }
    if (fs.existsSync(TEST_DB_DIR)) {
      fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
    }
  });

  test('loadConfig returns default config if no app/config.json or project db exists', () => {
    const config = loadConfig(TEST_PROJECT_NAME);
    expect(config).toEqual(DEFAULT_CONFIG);
  });

  test('loadConfig applies app/config.json overrides', () => {
    const overrides = {
      bufferSize: 99,
      models: {
        image: 'nano_banana_pro',
      },
    };

    fs.writeFileSync(APP_CONFIG_PATH, JSON.stringify(overrides), 'utf8');

    const config = loadConfig(TEST_PROJECT_NAME);
    expect(config.bufferSize).toBe(99);
    expect(config.models.image).toBe('nano_banana_pro');
    expect(config.models.video).toBe(DEFAULT_CONFIG.models.video); // unchanged
  });

  test('loadConfig applies project db config overrides over defaults', () => {
    // Set up project DB with a custom config
    fs.mkdirSync(TEST_DB_DIR, { recursive: true });
    const db = new ProjectDb(TEST_PROJECT_NAME, projectDbPath(TEST_PROJECT_NAME));
    
    const customConfig = {
      ...DEFAULT_CONFIG,
      concurrency: 12,
      models: {
        ...DEFAULT_CONFIG.models,
        video: 'kling2_6',
      },
    };

    db.ensureProject({
      name: TEST_PROJECT_NAME,
      scriptPath: 'script.txt',
      voPath: 'vo.wav',
      config: customConfig,
    });
    db.close();

    const config = loadConfig(TEST_PROJECT_NAME);
    expect(config.concurrency).toBe(12);
    expect(config.models.video).toBe('kling2_6');
  });

  test('loadConfig prioritizes explicit overrides argument', () => {
    // app/config.json override
    fs.writeFileSync(APP_CONFIG_PATH, JSON.stringify({ bufferSize: 20 }), 'utf8');

    // db override
    fs.mkdirSync(TEST_DB_DIR, { recursive: true });
    const db = new ProjectDb(TEST_PROJECT_NAME, projectDbPath(TEST_PROJECT_NAME));
    db.ensureProject({
      name: TEST_PROJECT_NAME,
      scriptPath: 'script.txt',
      voPath: 'vo.wav',
      config: { ...DEFAULT_CONFIG, bufferSize: 30 },
    });
    db.close();

    // explicit overrides (highest precedence)
    const config = loadConfig(TEST_PROJECT_NAME, { bufferSize: 40 });
    expect(config.bufferSize).toBe(40);
  });
});
