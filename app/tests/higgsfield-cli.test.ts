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
          if (typeof globalMock === 'function') {
            const res = globalMock(args);
            if (res) {
              if (res.stdout) child.stdout.emit('data', res.stdout);
              if (res.stderr) child.stderr.emit('data', res.stderr);
              child.emit('close', res.exitCode ?? 0);
              return;
            }
          } else {
            if (globalMock.stdout) child.stdout.emit('data', globalMock.stdout);
            if (globalMock.stderr) child.stderr.emit('data', globalMock.stderr);
            child.emit('close', globalMock.exitCode ?? 0);
            return;
          }
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

  test('direct pickJobId validation with various formats (T-08 bug-1 lock)', async () => {
    const uuid = 'd002c980-1234-4abc-9def-abcdef123456';
    const p1 = new HiggsfieldCliProvider(makeConfig('kling3_0'));

    // 1. Bare UUID string
    (globalThis as any).mockSpawnConfig = {
      exitCode: 0,
      stdout: JSON.stringify(uuid),
    };
    const jobId1 = await p1.submitVideo({
      kind: 'video',
      prompt: 'A shot',
      elementIds: [],
      model: 'kling3_0',
      duration: 5,
      mode: 'std',
      soundOff: true,
      aspectRatio: '16:9',
    });
    expect(jobId1).toBe(uuid);

    // 2. Object with job_id
    (globalThis as any).mockSpawnConfig = {
      exitCode: 0,
      stdout: JSON.stringify({ job_id: uuid }),
    };
    const jobId2 = await p1.submitVideo({
      kind: 'video',
      prompt: 'A shot',
      elementIds: [],
      model: 'kling3_0',
      duration: 5,
      mode: 'std',
      soundOff: true,
      aspectRatio: '16:9',
    });
    expect(jobId2).toBe(uuid);

    // 3. Object with generationId
    (globalThis as any).mockSpawnConfig = {
      exitCode: 0,
      stdout: JSON.stringify({ generationId: uuid }),
    };
    const jobId3 = await p1.submitVideo({
      kind: 'video',
      prompt: 'A shot',
      elementIds: [],
      model: 'kling3_0',
      duration: 5,
      mode: 'std',
      soundOff: true,
      aspectRatio: '16:9',
    });
    expect(jobId3).toBe(uuid);

    // 4. Nested object: job.id
    (globalThis as any).mockSpawnConfig = {
      exitCode: 0,
      stdout: JSON.stringify({ job: { id: uuid } }),
    };
    const jobId4 = await p1.submitVideo({
      kind: 'video',
      prompt: 'A shot',
      elementIds: [],
      model: 'kling3_0',
      duration: 5,
      mode: 'std',
      soundOff: true,
      aspectRatio: '16:9',
    });
    expect(jobId4).toBe(uuid);

    // 5. Nested array: results[0].uuid
    (globalThis as any).mockSpawnConfig = {
      exitCode: 0,
      stdout: JSON.stringify({ results: [{ uuid }] }),
    };
    const jobId5 = await p1.submitVideo({
      kind: 'video',
      prompt: 'A shot',
      elementIds: [],
      model: 'kling3_0',
      duration: 5,
      mode: 'std',
      soundOff: true,
      aspectRatio: '16:9',
    });
    expect(jobId5).toBe(uuid);

    delete (globalThis as any).mockSpawnConfig;
  });

  test('auth-error classification throws AuthRequiredError / AuthError (alias)', async () => {
    (globalThis as any).mockSpawnConfig = {
      exitCode: 1,
      stdout: '',
      stderr: 'Error: not authenticated. Please run higgsfield auth login.',
    };
    const provider = new HiggsfieldCliProvider(makeConfig('kling3_0'));
    const spec = {
      kind: 'video' as const,
      prompt: 'A shot',
      elementIds: [],
      model: 'kling3_0',
      duration: 5,
      mode: 'std',
      soundOff: true,
      aspectRatio: '16:9',
    };

    await expect(provider.submitVideo(spec)).rejects.toThrowError(
      /Higgsfield CLI is not authenticated/
    );

    // Also verify the thrown error is specifically instance of AuthRequiredError
    try {
      await provider.submitVideo(spec);
    } catch (err: any) {
      expect(err.name).toBe('AuthRequiredError');
    }

    delete (globalThis as any).mockSpawnConfig;
  });

  test('CLI exit-code 4 unknown-param handling', async () => {
    (globalThis as any).mockSpawnConfig = {
      exitCode: 4,
      stdout: '',
      stderr: 'error: unknown option --unsupported-flag',
    };
    const provider = new HiggsfieldCliProvider(makeConfig('kling3_0'));
    const spec = {
      kind: 'video' as const,
      prompt: 'A shot',
      elementIds: [],
      model: 'kling3_0',
      duration: 5,
      mode: 'std',
      soundOff: true,
      aspectRatio: '16:9',
    };

    await expect(provider.submitVideo(spec)).rejects.toThrowError(
      'exited with code 4: error: unknown option --unsupported-flag'
    );

    delete (globalThis as any).mockSpawnConfig;
  });

  test('malformed --json payloads and extractJson behavior under noise', async () => {
    const provider = new HiggsfieldCliProvider(makeConfig('kling3_0'));
    const spec = {
      kind: 'video' as const,
      prompt: 'A shot',
      elementIds: [],
      model: 'kling3_0',
      duration: 5,
      mode: 'std',
      soundOff: true,
      aspectRatio: '16:9',
    };

    // 1. JSON surrounded by noise
    const uuid = 'd002c980-1234-4abc-9def-abcdef123456';
    (globalThis as any).mockSpawnConfig = {
      exitCode: 0,
      stdout: `Some debug noise\n{"id": "${uuid}"}\nMore logging`,
    };
    const jobId = await provider.submitVideo(spec);
    expect(jobId).toBe(uuid);

    // 2. Completely malformed output
    (globalThis as any).mockSpawnConfig = {
      exitCode: 0,
      stdout: 'not-json-at-all',
    };
    await expect(provider.submitVideo(spec)).rejects.toThrowError(
      'returned no job id; stdout: not-json-at-all'
    );

    delete (globalThis as any).mockSpawnConfig;
  });

  test('malformed JSON on wait fallback path', async () => {
    // Make supportsGet return false
    (globalThis as any).mockSpawnConfig = (args: string[]) => {
      if (args.includes('--help')) {
        return { exitCode: 1, stdout: '', stderr: 'unknown command' };
      }
      // Return malformed JSON for create --wait
      return { exitCode: 0, stdout: 'malformed_payload', stderr: '' };
    };

    const provider = new HiggsfieldCliProvider(makeConfig('kling3_0'));
    const spec = {
      kind: 'video' as const,
      prompt: 'A shot',
      elementIds: [],
      model: 'kling3_0',
      duration: 5,
      mode: 'std',
      soundOff: true,
      aspectRatio: '16:9',
    };

    const jobId = await provider.submitVideo(spec);
    expect(jobId).toBeDefined();
    // Verify that a failed status is cached since it had no valid jobId / URL
    const cached = await provider.poll(jobId);
    expect(cached.status).toBe('failed');
    expect(cached.error).toContain('create --wait finished without a terminal status');

    delete (globalThis as any).mockSpawnConfig;
  });

  test('schema-driven paramWhitelist edges', async () => {
    // 1. Schema with a parameters array (Layout A)
    (globalThis as any).mockSpawnConfig = (args: string[]) => {
      if (args.includes('model') && args.includes('get')) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            parameters: [
              { name: 'mode' },
              { key: 'aspect_ratio' }
            ]
          }),
        };
      }
      return {
        exitCode: 0,
        stdout: '["d002c980-1234-4abc-9def-abcdef123456"]',
      };
    };

    const provider1 = new HiggsfieldCliProvider(makeConfig('kling3_0'));
    await provider1.submitVideo({
      kind: 'video',
      prompt: 'A shot',
      elementIds: [],
      model: 'kling3_0',
      duration: 5,
      mode: 'std',
      soundOff: true,
      aspectRatio: '16:9',
    });

    const createArgs1 = capturedArgsByCall.find((a) => a.includes('create'));
    expect(createArgs1).toBeDefined();
    expect(createArgs1).toContain('--mode');
    expect(createArgs1).toContain('--aspect_ratio');
    // resolution was NOT whitelisted, so it should not be present (unlike default fallback)
    expect(createArgs1).not.toContain('--resolution');
    expect(createArgs1).not.toContain('--sound');

    // 2. Schema with properties object (Layout B)
    capturedArgsByCall.length = 0;
    (globalThis as any).mockSpawnConfig = (args: string[]) => {
      if (args.includes('model') && args.includes('get')) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            properties: {
              sound: { type: 'string' },
              resolution: { type: 'string' }
            }
          }),
        };
      }
      return {
        exitCode: 0,
        stdout: '["d002c980-1234-4abc-9def-abcdef123456"]',
      };
    };

    const provider2 = new HiggsfieldCliProvider(makeConfig('kling3_0'));
    await provider2.submitVideo({
      kind: 'video',
      prompt: 'A shot',
      elementIds: [],
      model: 'kling3_0',
      duration: 5,
      mode: 'std',
      soundOff: true,
      aspectRatio: '16:9',
    });

    const createArgs2 = capturedArgsByCall.find((a) => a.includes('create'));
    expect(createArgs2).toBeDefined();
    expect(createArgs2).toContain('--sound');
    expect(createArgs2).toContain('--resolution'); // Now whitelisted!
    expect(createArgs2).not.toContain('--mode');
    expect(createArgs2).not.toContain('--aspect_ratio');

    // 3. Schema command failing (exit code 1) -> should fall back to default behavior
    capturedArgsByCall.length = 0;
    (globalThis as any).mockSpawnConfig = (args: string[]) => {
      if (args.includes('model') && args.includes('get')) {
        return { exitCode: 1, stdout: '', stderr: 'CLI failure' };
      }
      return {
        exitCode: 0,
        stdout: '["d002c980-1234-4abc-9def-abcdef123456"]',
      };
    };

    const provider3 = new HiggsfieldCliProvider(makeConfig('kling3_0_turbo'));
    await provider3.submitVideo({
      kind: 'video',
      prompt: 'A shot',
      elementIds: [],
      model: 'kling3_0_turbo',
      duration: 5,
      mode: 'std',
      soundOff: true,
      aspectRatio: '16:9',
    });

    const createArgs3 = capturedArgsByCall.find((a) => a.includes('create'));
    expect(createArgs3).toBeDefined();
    // Default fallback behaviour: should contain resolution, etc.
    expect(createArgs3).toContain('--resolution');

    delete (globalThis as any).mockSpawnConfig;
  });
});

