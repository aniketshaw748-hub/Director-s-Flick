import { vi, describe, test, expect, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { probeDuration, trimNormalize, concatClips, muxVoiceover, exportTimeline, download } from '../src/media.js';
import type { EDLEntry } from '../src/types.js';

// Mock node:child_process
const mockSpawnCalls: { command: string; args: string[] }[] = [];
let mockFfprobeDuration = 10.0;
let mockFfprobeStdout: string | undefined; // when set, overrides mockFfprobeDuration verbatim (T-70: malformed-output cases)
// T-70: let exactly the NEXT spawned process fail with a given exit code/stderr,
// then reset - so any single ffmpeg/ffprobe call in a test can be made to fail
// without needing a dedicated mock per test.
let mockNextFailure: { code: number; stderr: string } | null = null;
// T-70: simulates the spawn itself failing (e.g. binary not found / ENOENT) -
// distinct from a non-zero exit code, which is a process that DID start.
let mockNextSpawnError: Error | null = null;

vi.mock('node:child_process', () => {
  return {
    spawn: (command: string, args: string[], options: any) => {
      mockSpawnCalls.push({ command, args });

      const child: any = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();

      const failure = mockNextFailure;
      mockNextFailure = null;
      const spawnError = mockNextSpawnError;
      mockNextSpawnError = null;

      process.nextTick(() => {
        if (spawnError) {
          child.emit('error', spawnError);
          return;
        }
        if (failure) {
          if (failure.stderr) child.stderr.emit('data', Buffer.from(failure.stderr));
          child.emit('close', failure.code);
          return;
        }
        if (command === 'ffprobe') {
          child.stdout.emit('data', Buffer.from(mockFfprobeStdout ?? `${mockFfprobeDuration}\n`));
        }
        child.emit('close', 0);
      });

      return child;
    }
  };
});

// Mock node:fs so we don't write anything to disk - also records writeFile
// calls (T-70: concat list file content, e.g. path escaping). media.ts
// imports `promises` FROM 'node:fs' directly (`import {promises as fsp}
// from 'node:fs'`), NOT from the separate 'node:fs/promises' specifier - so
// this is the module that actually needs mocking for mkdir/unlink/writeFile;
// spreading `...original` here would silently re-introduce the real,
// unmocked promises API (and did, until this was caught by a failing test).
const mockWriteFileCalls: { path: string; content: string }[] = [];
let mockWriteStreams: EventEmitter[] = [];

vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs')>();
  const writeFile = async (path: string, content: string) => {
    mockWriteFileCalls.push({ path, content });
  };
  return {
    ...original,
    promises: {
      mkdir: async () => {},
      unlink: async () => {},
      writeFile,
    },
    createWriteStream: (_dest: string) => {
      const out: any = new EventEmitter();
      out.destroy = () => {};
      mockWriteStreams.push(out);
      return out;
    },
  };
});

// Mock node:http/node:https (T-70: download()'s redirect/status/error paths).
// A queue of scripted responses consumed one per request; each entry drives a
// fake ClientRequest + IncomingMessage pair via EventEmitter, matching exactly
// the events/methods download() actually uses (on/pipe/resume).
interface MockHttpResponse {
  /** Omit to simulate a response with no statusCode at all (media.ts falls back to 0). */
  statusCode?: number;
  headers?: Record<string, string>;
  requestError?: Error;
  responseError?: Error;
  writeError?: Error;
}
let mockHttpQueue: MockHttpResponse[] = [];
const mockHttpRequests: { protocol: 'http' | 'https'; url: string }[] = [];

function makeFakeGet(protocol: 'http' | 'https') {
  return (urlObj: URL, callback: (res: any) => void) => {
    mockHttpRequests.push({ protocol, url: urlObj.toString() });
    const req: any = new EventEmitter();
    const next = mockHttpQueue.shift();
    process.nextTick(() => {
      if (!next) throw new Error('mockHttpQueue exhausted - test scripted too few responses');
      if (next.requestError) {
        req.emit('error', next.requestError);
        return;
      }
      const res: any = new EventEmitter();
      res.statusCode = next.statusCode;
      res.headers = next.headers ?? {};
      res.resume = () => {};
      res.pipe = (dest: any) => {
        process.nextTick(() => {
          if (next.responseError) {
            res.emit('error', next.responseError);
          } else if (next.writeError) {
            dest.emit('error', next.writeError);
          } else {
            dest.emit('finish');
          }
        });
      };
      callback(res);
    });
    return req;
  };
}

vi.mock('node:http', () => ({ get: makeFakeGet('http') }));
vi.mock('node:https', () => ({ get: makeFakeGet('https') }));

describe('media', () => {
  beforeEach(() => {
    mockSpawnCalls.length = 0;
    mockFfprobeDuration = 10.0;
    mockFfprobeStdout = undefined;
    mockNextFailure = null;
    mockNextSpawnError = null;
    mockWriteFileCalls.length = 0;
    mockWriteStreams = [];
    mockHttpQueue = [];
    mockHttpRequests.length = 0;
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

  test('exportTimeline throws on empty EDL entries', async () => {
    await expect(exportTimeline([], 'vo.wav', 'final.mp4')).rejects.toThrow(
      '[media] exportTimeline: EDL is empty'
    );
  });

  test('exportTimeline warns on non-contiguous EDL entries', async () => {
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    
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
        timelineStart: 8.0, // gap of 3.5s (prev end is 4.5)
        duration: 3.0,
      },
    ];

    await exportTimeline(entries, 'vo.wav', 'final.mp4');

    expect(consoleWarnSpy).toHaveBeenCalled();
    const warnCall = consoleWarnSpy.mock.calls[0]![0];
    expect(warnCall).toContain('are not contiguous');

    consoleWarnSpy.mockRestore();
  });

  test('exportTimeline warns "overlap" (not "gap") when EDL entries overlap in time', async () => {
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

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
        timelineStart: 3.0, // overlaps the previous entry's end (4.5) by 1.5s
        duration: 3.0,
      },
    ];

    await exportTimeline(entries, 'vo.wav', 'final.mp4');

    const warnCall = consoleWarnSpy.mock.calls[0]![0];
    expect(warnCall).toContain('overlap');
    expect(warnCall).not.toContain('gap');

    consoleWarnSpy.mockRestore();
  });

  // --- T-70 coverage lift ----------------------------------------------------

  test('probeDuration throws when ffprobe output is not a parseable number', async () => {
    mockFfprobeStdout = 'N/A\n';
    await expect(probeDuration('broken.mp4')).rejects.toThrow('could not parse duration');
  });

  test('probeDuration throws on empty ffprobe output', async () => {
    mockFfprobeStdout = '';
    await expect(probeDuration('empty.mp4')).rejects.toThrow('could not parse duration');
  });

  test('trimNormalize rejects a non-positive duration', async () => {
    await expect(trimNormalize('input.mp4', 'output.mp4', 0, 0)).rejects.toThrow('duration must be > 0');
    await expect(trimNormalize('input.mp4', 'output.mp4', 0, -1)).rejects.toThrow('duration must be > 0');
    // Neither call should have spawned anything - validation happens first.
    expect(mockSpawnCalls).toHaveLength(0);
  });

  test('trimNormalize honors custom fps/width/height overrides (odd fps sources)', async () => {
    mockFfprobeDuration = 10.0;
    await trimNormalize('input.mp4', 'output.mp4', 0, 5.0, { fps: 24, width: 1280, height: 720 });
    const ffmpegCall = mockSpawnCalls.find((c) => c.command === 'ffmpeg')!;
    const vfArg = ffmpegCall.args[ffmpegCall.args.indexOf('-vf') + 1]!;
    expect(vfArg).toContain('scale=1280:720');
    expect(vfArg).toContain('fps=24');
  });

  test('concatClips rejects an empty clip list', async () => {
    await expect(concatClips([], 'output.mp4')).rejects.toThrow('clipPaths is empty');
    expect(mockSpawnCalls).toHaveLength(0);
  });

  test('concatClips escapes single quotes and preserves spaces in the concat list file', async () => {
    await concatClips(["my clip's name.mp4"], 'output.mp4');
    expect(mockWriteFileCalls).toHaveLength(1);
    const content = mockWriteFileCalls[0]!.content;
    // The literal apostrophe must be escaped as '\'' (close-quote, escaped
    // literal quote, reopen-quote - the standard shell-safe single-quote
    // escape) while the space in "name.mp4" stays untouched (the surrounding
    // single quotes already protect spaces in a concat-demuxer list entry).
    expect(content).toContain("my clip'\\''s name.mp4");
    expect(content.startsWith("file '")).toBe(true);
    expect(content.trimEnd().endsWith("'")).toBe(true);
  });

  test('muxVoiceover maps video/audio streams and sets codecs precisely', async () => {
    await muxVoiceover('video.mp4', 'vo.wav', 'final.mp4');
    const ffmpegCall = mockSpawnCalls.find((c) => c.command === 'ffmpeg')!;
    expect(ffmpegCall.args).toContain('-map');
    expect(ffmpegCall.args).toContain('0:v');
    expect(ffmpegCall.args).toContain('1:a');
    expect(ffmpegCall.args).toContain('-c:v');
    expect(ffmpegCall.args).toContain('copy');
    expect(ffmpegCall.args).toContain('-b:a');
    expect(ffmpegCall.args).toContain('192k');
  });

  test('a failing ffmpeg process rejects with the exit code and a stderr tail', async () => {
    mockNextFailure = { code: 1, stderr: 'Error: no such filter\nmore detail\n' };
    await expect(concatClips(['clip1.mp4'], 'output.mp4')).rejects.toThrow(/exited with code 1/);
  });

  test('the failure message includes the command and args, not just the exit code', async () => {
    mockNextFailure = { code: 1, stderr: 'boom\n' };
    await expect(concatClips(['clip1.mp4'], 'output.mp4')).rejects.toThrow(/ffmpeg.*-f.*concat/);
  });

  test('a spawn that fails to start at all (e.g. binary not found) rejects distinctly from a bad exit code', async () => {
    mockNextSpawnError = new Error('ENOENT');
    await expect(concatClips(['clip1.mp4'], 'output.mp4')).rejects.toThrow('failed to spawn ffmpeg: ENOENT');
  });

  test('download fetches an http:// URL and resolves the destination path', async () => {
    mockHttpQueue = [{ statusCode: 200 }];
    const path = await import('node:path');
    const result = await download('http://example.com/file.mp4', 'dest/file.mp4');
    expect(result).toBe(path.resolve('dest/file.mp4'));
    expect(mockHttpRequests).toHaveLength(1);
    expect(mockHttpRequests[0]!.protocol).toBe('http');
  });

  test('download uses https for an https:// URL', async () => {
    mockHttpQueue = [{ statusCode: 200 }];
    await download('https://example.com/file.mp4', 'dest/file.mp4');
    expect(mockHttpRequests[0]!.protocol).toBe('https');
  });

  test('download follows a redirect (3xx + location) to completion', async () => {
    mockHttpQueue = [
      { statusCode: 302, headers: { location: 'http://example.com/redirected.mp4' } },
      { statusCode: 200 },
    ];
    await download('http://example.com/file.mp4', 'dest/file.mp4');
    expect(mockHttpRequests).toHaveLength(2);
    expect(mockHttpRequests[1]!.url).toBe('http://example.com/redirected.mp4');
  });

  test('download rejects after exceeding the redirect limit', async () => {
    // MAX_REDIRECTS = 10: redirectsLeft counts 10,9,...,0 (11 hops total)
    // before the 12th would-be hop is rejected instead of followed.
    mockHttpQueue = Array.from({ length: 11 }, (_, i) => ({
      statusCode: 302,
      headers: { location: `http://example.com/hop-${i}.mp4` },
    }));
    await expect(download('http://example.com/file.mp4', 'dest/file.mp4')).rejects.toThrow('too many redirects');
  });

  test('download rejects on a non-2xx/3xx status', async () => {
    mockHttpQueue = [{ statusCode: 404 }];
    await expect(download('http://example.com/missing.mp4', 'dest/file.mp4')).rejects.toThrow('HTTP 404');
  });

  test('download treats a response with no statusCode at all as HTTP 0', async () => {
    mockHttpQueue = [{}];
    await expect(download('http://example.com/weird.mp4', 'dest/file.mp4')).rejects.toThrow('HTTP 0');
  });

  test('download rejects an unparseable URL', async () => {
    await expect(download('not a url', 'dest/file.mp4')).rejects.toThrow('invalid URL');
  });

  test('download rejects an unsupported protocol', async () => {
    await expect(download('ftp://example.com/file.mp4', 'dest/file.mp4')).rejects.toThrow('unsupported protocol');
  });

  test('download rejects when the request itself errors', async () => {
    mockHttpQueue = [{ statusCode: 200, requestError: new Error('ECONNREFUSED') }];
    await expect(download('http://example.com/file.mp4', 'dest/file.mp4')).rejects.toThrow('request error');
  });

  test('download rejects when the response stream errors mid-transfer', async () => {
    mockHttpQueue = [{ statusCode: 200, responseError: new Error('stream reset') }];
    await expect(download('http://example.com/file.mp4', 'dest/file.mp4')).rejects.toThrow('response error');
  });

  test('download rejects when the destination write stream errors', async () => {
    mockHttpQueue = [{ statusCode: 200, writeError: new Error('disk full') }];
    await expect(download('http://example.com/file.mp4', 'dest/file.mp4')).rejects.toThrow('write error');
  });
});

