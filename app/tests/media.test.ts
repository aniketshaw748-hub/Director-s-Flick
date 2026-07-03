import { vi, describe, test, expect, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { probeDuration, trimNormalize, concatClips, muxVoiceover, exportTimeline } from '../src/media.js';
import type { EDLEntry } from '../src/types.js';

// Mock node:child_process
const mockSpawnCalls: { command: string; args: string[] }[] = [];
let mockFfprobeDuration = 10.0;

vi.mock('node:child_process', () => {
  return {
    spawn: (command: string, args: string[], options: any) => {
      mockSpawnCalls.push({ command, args });

      const child: any = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();

      process.nextTick(() => {
        if (command === 'ffprobe') {
          child.stdout.emit('data', Buffer.from(`${mockFfprobeDuration}\n`));
        }
        child.emit('close', 0);
      });

      return child;
    }
  };
});

// Mock fs/promises so we don't write anything to disk
vi.mock('node:fs/promises', () => {
  return {
    default: {
      mkdir: async () => {},
      unlink: async () => {},
      writeFile: async () => {},
    },
    promises: {
      mkdir: async () => {},
      unlink: async () => {},
      writeFile: async () => {},
    }
  };
});

describe('media', () => {
  beforeEach(() => {
    mockSpawnCalls.length = 0;
    mockFfprobeDuration = 10.0;
  });

  test('probeDuration builds correct arguments and parses output', async () => {
    mockFfprobeDuration = 12.345;
    const path = await import('node:path');
    const dur = await probeDuration('test-video.mp4');

    expect(dur).toBe(12.345);
    expect(mockSpawnCalls).toHaveLength(1);
    expect(mockSpawnCalls[0]!.command).toBe('ffprobe');
    expect(mockSpawnCalls[0]!.args).toContain(path.resolve('test-video.mp4'));
  });

  test('trimNormalize builds correct FFmpeg command', async () => {
    mockFfprobeDuration = 10.0;
    const path = await import('node:path');
    // inPoint = 2.0, duration = 5.0. Total available = 8.0, so no padding needed.
    await trimNormalize('input.mp4', 'output.mp4', 2.0, 5.0);

    expect(mockSpawnCalls).toHaveLength(2); // 1 for ffprobe, 1 for ffmpeg
    
    const ffmpegCall = mockSpawnCalls.find(c => c.command === 'ffmpeg');
    expect(ffmpegCall).toBeDefined();
    
    // Check parameters
    expect(ffmpegCall!.args).toContain('-ss');
    expect(ffmpegCall!.args).toContain('2.000');
    expect(ffmpegCall!.args).toContain('-t');
    expect(ffmpegCall!.args).toContain('5.000');
    expect(ffmpegCall!.args).toContain('-i');
    expect(ffmpegCall!.args).toContain(path.resolve('input.mp4'));
    expect(ffmpegCall!.args).toContain('scale=1920:1080,setsar=1,fps=30');
    expect(ffmpegCall!.args).toContain('-c:v');
    expect(ffmpegCall!.args).toContain('h264_nvenc');
  });

  test('trimNormalize adds tpad stop_mode=clone when source is too short', async () => {
    mockFfprobeDuration = 5.0;
    // inPoint = 1.0, duration = 6.0. Available is 4.0, shortfall is 2.0.
    await trimNormalize('input.mp4', 'output.mp4', 1.0, 6.0);

    const ffmpegCall = mockSpawnCalls.find(c => c.command === 'ffmpeg');
    expect(ffmpegCall).toBeDefined();

    // Check filter graph has tpad
    const vfArg = ffmpegCall!.args[ffmpegCall!.args.indexOf('-vf') + 1]!;
    expect(vfArg).toContain('tpad=stop_mode=clone:stop_duration=3.000'); // 2.0 shortfall + 1.0 safety
  });

  test('concatClips builds correct FFmpeg command', async () => {
    await concatClips(['clip1.mp4', 'clip2.mp4'], 'output.mp4');

    const ffmpegCall = mockSpawnCalls.find(c => c.command === 'ffmpeg');
    expect(ffmpegCall).toBeDefined();
    expect(ffmpegCall!.args).toContain('-f');
    expect(ffmpegCall!.args).toContain('concat');
    expect(ffmpegCall!.args).toContain('-c');
    expect(ffmpegCall!.args).toContain('copy');
  });

  test('muxVoiceover builds correct FFmpeg command', async () => {
    const path = await import('node:path');
    await muxVoiceover('video.mp4', 'vo.wav', 'final.mp4');

    const ffmpegCall = mockSpawnCalls.find(c => c.command === 'ffmpeg');
    expect(ffmpegCall).toBeDefined();
    expect(ffmpegCall!.args).toContain('-i');
    expect(ffmpegCall!.args).toContain(path.resolve('video.mp4'));
    expect(ffmpegCall!.args).toContain(path.resolve('vo.wav'));
    expect(ffmpegCall!.args).toContain('-shortest');
    expect(ffmpegCall!.args).toContain('aac');
  });

  test('exportTimeline trims, normalizes, concats, and muxes correctly', async () => {
    mockFfprobeDuration = 20.0;
    const path = await import('node:path');
    const entries: EDLEntry[] = [
      {
        id: 'entry-1',
        projectId: 'proj-1',
        shotId: 'shot-1',
        lineIndex: 0,
        clipPath: 'clip0.mp4',
        inPoint: 0.0,
        outPoint: 4.5,
        timelineStart: 0.0,
        duration: 4.5,
      },
      {
        id: 'entry-2',
        projectId: 'proj-1',
        shotId: 'shot-2',
        lineIndex: 1,
        clipPath: 'clip1.mp4',
        inPoint: 1.0,
        outPoint: 4.0,
        timelineStart: 4.5,
        duration: 3.0,
      },
    ];

    const progressEvents: any[] = [];
    const finalPath = await exportTimeline(entries, 'vo.wav', 'final.mp4', {
      concurrency: 1,
      onProgress: (evt) => progressEvents.push(evt),
    });
    expect(finalPath).toBe(path.resolve('final.mp4'));

    // Expected spawn calls:
    // For each entry:
    //   1. ffprobe on clipPath (2 calls, inside trimNormalize)
    //   2. ffmpeg trimNormalize (2 calls)
    // Then:
    //   3. ffmpeg concatClips (1 call)
    //   4. ffmpeg muxVoiceover (1 call)
    //   5. ffprobe on the final output (1 call, for the 'done' progress event - T-36)
    const ffprobeCalls = mockSpawnCalls.filter(c => c.command === 'ffprobe');
    const ffmpegCalls = mockSpawnCalls.filter(c => c.command === 'ffmpeg');

    expect(ffprobeCalls).toHaveLength(3);
    expect(ffmpegCalls).toHaveLength(4); // 2 trimNormalizes + 1 concat + 1 mux

    // T-36: per-stage progress events fired in order.
    expect(progressEvents.map((e) => e.stage)).toEqual(['trim', 'trim', 'concat', 'mux', 'done']);
    const doneEvent = progressEvents[progressEvents.length - 1];
    expect(doneEvent.outputPath).toBe(path.resolve('final.mp4'));
    expect(doneEvent.durationSeconds).toBe(mockFfprobeDuration);
  });
});
