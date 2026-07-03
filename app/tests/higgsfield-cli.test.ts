import { vi, describe, test, expect, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { HiggsfieldCliProvider } from '../src/providers/higgsfield-cli.js';
import type { PipelineConfig, VideoJobSpec, ImageJobSpec } from '../src/types.js';

// Regression tests for the two T-08 live-run hotfixes (see BOARD.md T-32):
//  1. `generate create --json` WITHOUT --wait can return a bare array of
//     job-id strings (e.g. ["d002c980-..."]), not an object - pickJobId must
//     handle it.
//  2. kling3_0 has no `--resolution` param and the CLI hard-errors on unknown
//     params - buildCreateArgs must never pass --resolution for kling3_0,
//     while still passing it (with its old '720p' default) for other models.

let capturedArgsByCall: string[][] = [];

vi.mock('node:child_process', () => {
  const { EventEmitter } = require('node:events');
  return {
    spawn: (_command: string, args: string[]) => {
      capturedArgsByCall.push(args);
      const child: any = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stdout.setEncoding = () => {};
      child.stderr = new EventEmitter();
      child.stderr.setEncoding = () => {};
      process.nextTick(() => {
        const globalMock = (globalThis as any).mockSpawnConfig;
        if (globalMock) {
          if (globalMock.stdout) child.stdout.emit('data', globalMock.stdout);
          if (globalMock.stderr) child.stderr.emit('data', globalMock.stderr);
          child.emit('close', globalMock.exitCode ?? 0);
          return;
        }

        if (args.includes('--help')) {
          // `generate get --help` probe: CLI recognizes the command.
          child.stdout.emit('data', 'Usage: higgsfield generate get [options]\n');
          child.emit('close', 0);
        } else if (args.includes('create')) {
          // Bare uuid-string-array, exactly as observed live in T-08.
          child.stdout.emit('data', '["d002c980-1234-4abc-9def-abcdef123456"]\n');
          child.emit('close', 0);
        } else {
          child.emit('close', 0);
        }
      });
      return child;
    },
  };
});

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

describe('HiggsfieldCliProvider (T-08 hotfix regressions)', () => {
  beforeEach(() => {
    capturedArgsByCall.length = 0;
  });

  test('submitVideo resolves the job id from a bare uuid-string-array stdout (hotfix 1)', async () => {
    const provider = new HiggsfieldCliProvider(makeConfig('kling3_0'));
    const spec: VideoJobSpec = {
      kind: 'video',
      prompt: 'A shot',
      elementIds: [],
      model: 'kling3_0',
      duration: 5,
      mode: 'std',
      soundOff: true,
      aspectRatio: '16:9',
    };
    const jobId = await provider.submitVideo(spec);
    expect(jobId).toBe('d002c980-1234-4abc-9def-abcdef123456');
  });

  test('submitImage resolves the job id from a bare uuid-string-array stdout (hotfix 1)', async () => {
    const provider = new HiggsfieldCliProvider(makeConfig('kling3_0'));
    const spec: ImageJobSpec = {
      kind: 'image',
      prompt: 'A still',
      elementIds: [],
      model: 'nano_banana_2',
      aspectRatio: '16:9',
    };
    const jobId = await provider.submitImage(spec);
    expect(jobId).toBe('d002c980-1234-4abc-9def-abcdef123456');
  });

  test('kling3_0 video submit never passes --resolution (hotfix 2)', async () => {
    const provider = new HiggsfieldCliProvider(makeConfig('kling3_0'));
    const spec: VideoJobSpec = {
      kind: 'video',
      prompt: 'A shot',
      elementIds: [],
      model: 'kling3_0',
      duration: 5,
      mode: 'std',
      soundOff: true,
      aspectRatio: '16:9',
    };
    await provider.submitVideo(spec);
    const createArgs = capturedArgsByCall.find((a) => a.includes('create'));
    expect(createArgs).toBeDefined();
    expect(createArgs).not.toContain('--resolution');
  });

  test('other video models still get --resolution, defaulting to 720p (review fix)', async () => {
    const provider = new HiggsfieldCliProvider(makeConfig('kling3_0_turbo'));
    const spec: VideoJobSpec = {
      kind: 'video',
      prompt: 'A shot',
      elementIds: [],
      model: 'kling3_0_turbo',
      duration: 5,
      mode: 'std',
      soundOff: true,
      aspectRatio: '16:9',
    };
    await provider.submitVideo(spec);
    const createArgs = capturedArgsByCall.find((a) => a.includes('create'));
    expect(createArgs).toBeDefined();
    const idx = createArgs!.indexOf('--resolution');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(createArgs![idx + 1]).toBe('720p');
  });

  test('runCli throws error on non-zero exit code when check is true', async () => {
    (globalThis as any).mockSpawnConfig = {
      exitCode: 1,
      stdout: '',
      stderr: 'CLI internal failure description'
    };
    const provider = new HiggsfieldCliProvider(makeConfig('kling3_0'));
    const spec: VideoJobSpec = {
      kind: 'video',
      prompt: 'A shot',
      elementIds: [],
      model: 'kling3_0',
      duration: 5,
      mode: 'std',
      soundOff: true,
      aspectRatio: '16:9',
    };
    await expect(provider.submitVideo(spec)).rejects.toThrow(
      'exited with code 1: CLI internal failure description'
    );
    delete (globalThis as any).mockSpawnConfig;
  });

  test('poll extracts error description correctly for failed/nsfw/canceled status', async () => {
    (globalThis as any).mockSpawnConfig = {
      exitCode: 0,
      stdout: JSON.stringify({
        status: 'failed',
        error: 'NSFW content detected',
        credits_charged: 0.0
      }),
      stderr: ''
    };
    const provider = new HiggsfieldCliProvider(makeConfig('kling3_0'));
    const res = await provider.poll('job-123');
    expect(res.status).toBe('failed');
    expect(res.error).toBe('NSFW content detected');

    (globalThis as any).mockSpawnConfig = {
      exitCode: 0,
      stdout: JSON.stringify({
        status: 'nsfw'
      }),
      stderr: 'CLI warning output'
    };
    const res2 = await provider.poll('job-456');
    expect(res2.status).toBe('nsfw');
    expect(res2.error).toBe('CLI warning output');

    delete (globalThis as any).mockSpawnConfig;
  });
});

