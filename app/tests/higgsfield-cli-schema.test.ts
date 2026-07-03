/**
 * higgsfield-cli-schema.test.ts — schema-driven CLI param whitelists (T-35).
 *
 * Hermetic: node:child_process.spawn is mocked. The mock serves per-model
 * `higgsfield model get <model> --json` schemas (set per test via schemaByModel;
 * absent -> the CLI "errors", exercising graceful fallback), the `generate get
 * --help` probe, and `generate create` (bare uuid-array stdout). No real CLI.
 *
 * Verifies: only model-declared tunable flags are passed (kills the hard-coded
 * guard class); kling3_0 (no resolution) / kling3_0_turbo (resolution, no mode)
 * / nano (image, no resolution); fallback == prior behavior; parser shape
 * tolerance; per-model schema caching.
 */

import { vi, describe, test, expect, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { HiggsfieldCliProvider } from '../src/providers/higgsfield-cli.js';
import type { PipelineConfig, VideoJobSpec, ImageJobSpec } from '../src/types.js';

let capturedArgs: string[][] = [];
/** model -> `model get --json` stdout, or null/absent -> simulate CLI error. */
let schemaByModel: Record<string, string | null> = {};

vi.mock('node:child_process', () => ({
  spawn: (_command: string, args: string[]) => {
    capturedArgs.push(args);
    const child: any = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stdout.setEncoding = () => {};
    child.stderr = new EventEmitter();
    child.stderr.setEncoding = () => {};
    process.nextTick(() => {
      // Windows resolveCliInvocation prepends `cmd /d /s /c …`, so match by
      // token presence, not fixed positions.
      const isModelGet = args.includes('model') && args.includes('get') && !args.includes('create');
      if (isModelGet) {
        const model = args[args.indexOf('get') + 1];
        const schema = model ? schemaByModel[model] : null;
        if (schema) {
          child.stdout.emit('data', schema);
          child.emit('close', 0);
        } else {
          child.stderr.emit('data', 'Error: unknown model\n');
          child.emit('close', 4); // non-zero -> whitelist null -> fallback
        }
      } else if (args.includes('--help')) {
        child.stdout.emit('data', 'Usage: higgsfield generate get [options]\n');
        child.emit('close', 0);
      } else if (args.includes('create')) {
        child.stdout.emit('data', '["d002c980-1234-4abc-9def-abcdef123456"]\n');
        child.emit('close', 0);
      } else {
        child.emit('close', 0);
      }
    });
    return child;
  },
}));

function makeConfig(video: string): PipelineConfig {
  return {
    provider: 'higgsfield-cli',
    models: { image: 'nano_banana_2', video, videoMode: 'std' },
    bufferSize: 5,
    concurrency: 4,
    elementsViaPlaceholders: true,
    aspectRatio: '16:9',
    soundOff: true,
    styleBible: '',
  };
}

function videoSpec(model: string): VideoJobSpec {
  return { kind: 'video', prompt: 'A shot', elementIds: [], model, duration: 5, mode: 'std', soundOff: true, aspectRatio: '16:9' };
}
function imageSpec(model: string, resolution?: string): ImageJobSpec {
  return { kind: 'image', prompt: 'A still', elementIds: [], model, aspectRatio: '16:9', ...(resolution ? { resolution } : {}) };
}
function createArgs(): string[] {
  const a = capturedArgs.find((x) => x.includes('create'));
  expect(a).toBeDefined();
  return a!;
}

// declared-param schemas in several shapes
const KLING3_0 = JSON.stringify({
  params: [
    { name: 'prompt' }, { name: 'start_image' }, { name: 'duration' },
    { name: 'mode' }, { name: 'sound' }, { name: 'aspect_ratio' },
  ], // NO resolution (quality via --mode std/pro/4k)
});
const KLING3_0_TURBO = JSON.stringify({
  parameters: { prompt: {}, start_image: {}, duration: {}, resolution: {}, sound: {}, aspect_ratio: {} },
  // NO mode (quality via --resolution 720p/1080p)
});
const NANO = JSON.stringify({ inputs: [{ name: 'prompt' }, { name: 'aspect_ratio' }, { name: 'image' }] }); // NO resolution

describe('HiggsfieldCliProvider schema-driven param whitelist (T-35)', () => {
  beforeEach(() => {
    capturedArgs = [];
    schemaByModel = {};
  });

  test('kling3_0: declares mode/sound/aspect_ratio but NOT resolution', async () => {
    schemaByModel['kling3_0'] = KLING3_0;
    await new HiggsfieldCliProvider(makeConfig('kling3_0')).submitVideo(videoSpec('kling3_0'));
    const a = createArgs();
    expect(a).toContain('--mode');
    expect(a).toContain('--sound');
    expect(a).toContain('--aspect_ratio');
    expect(a).not.toContain('--resolution');
  });

  test('kling3_0_turbo: declares resolution but NOT mode (fixes the always-send-mode bug)', async () => {
    schemaByModel['kling3_0_turbo'] = KLING3_0_TURBO;
    await new HiggsfieldCliProvider(makeConfig('kling3_0_turbo')).submitVideo(videoSpec('kling3_0_turbo'));
    const a = createArgs();
    const ri = a.indexOf('--resolution');
    expect(ri).toBeGreaterThanOrEqual(0);
    expect(a[ri + 1]).toBe('720p');
    expect(a).not.toContain('--mode'); // turbo would reject --mode; schema suppresses it
    expect(a).toContain('--sound');
  });

  test('nano image: model without a resolution param never gets --resolution, even if the spec sets one', async () => {
    schemaByModel['nano_banana_2'] = NANO;
    await new HiggsfieldCliProvider(makeConfig('kling3_0')).submitImage(imageSpec('nano_banana_2', '1080p'));
    const a = createArgs();
    expect(a).not.toContain('--resolution');
    expect(a).toContain('--aspect_ratio');
  });

  test('fallback (schema unavailable) preserves prior behavior: kling3_0 no --resolution, still --mode', async () => {
    // schemaByModel empty -> `model get` errors -> whitelist null -> fallback
    await new HiggsfieldCliProvider(makeConfig('kling3_0')).submitVideo(videoSpec('kling3_0'));
    const a = createArgs();
    expect(a).not.toContain('--resolution'); // old guard (model === kling3_0)
    expect(a).toContain('--mode'); // fallback always sends
    expect(a).toContain('--sound');
  });

  test('fallback for other models still gets --resolution 720p (matches the T-32 guard)', async () => {
    await new HiggsfieldCliProvider(makeConfig('kling3_0_turbo')).submitVideo(videoSpec('kling3_0_turbo'));
    const a = createArgs();
    const ri = a.indexOf('--resolution');
    expect(ri).toBeGreaterThanOrEqual(0);
    expect(a[ri + 1]).toBe('720p');
    expect(a).toContain('--mode'); // fallback always sends
  });

  test('parser tolerates a JSON-schema { schema: { properties } } shape', async () => {
    schemaByModel['kling3_0'] = JSON.stringify({
      schema: { properties: { prompt: {}, duration: {}, mode: {}, sound: {}, aspect_ratio: {} } },
    }); // nested, no resolution
    await new HiggsfieldCliProvider(makeConfig('kling3_0')).submitVideo(videoSpec('kling3_0'));
    const a = createArgs();
    expect(a).toContain('--mode');
    expect(a).not.toContain('--resolution');
  });

  test('schema is fetched once per model and cached', async () => {
    schemaByModel['kling3_0'] = KLING3_0;
    const provider = new HiggsfieldCliProvider(makeConfig('kling3_0'));
    await provider.submitVideo(videoSpec('kling3_0'));
    await provider.submitVideo(videoSpec('kling3_0'));
    const modelGets = capturedArgs.filter(
      (a) => a.includes('model') && a.includes('get') && a[a.indexOf('get') + 1] === 'kling3_0',
    );
    expect(modelGets).toHaveLength(1);
  });
});
