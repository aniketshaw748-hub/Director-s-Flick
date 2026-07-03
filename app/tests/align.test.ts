import { vi, describe, test, expect, beforeEach, afterEach } from 'vitest';
import { computeTimeline, planShots, alignScript, normalizeScriptText, checkScriptAudioLengthMatch } from '../src/align.js';
import type { AlignedLine } from '../src/types.js';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';

const mockSpawnCalls: { command: string; args: string[] }[] = [];

// Configurable mock behavior, reset in beforeEach. The mock branches by
// command name so align.ts's own spawn('python'/'ffmpeg', ...) calls AND
// media.ts's probeDuration() -> spawn('ffprobe', ...) call (media.ts is NOT
// mocked — its real code runs against this same child_process mock) are all
// exercised hermetically, with zero real processes launched.
let mockFfprobeExitCode = 0;
let mockFfprobeDuration: number | string = 1.5;
let mockFfmpegExitCode = 0;
let mockFfmpegSpawnError = false;
let mockFfmpegWriteOutput = true;
let mockFfmpegStderr = '';
let mockPythonExitCode = 0;
let mockPythonSpawnError = false;
let mockPythonStdoutChunk = '';
let mockPythonStderr = '';
// Captured at the moment python "runs", before alignScript's cleanup unlinks
// any temp script/audio files it created.
let capturedScriptContentAtPythonSpawn: string | null = null;

vi.mock('node:child_process', () => {
  return {
    spawn: (command: string, args: string[], _options: any) => {
      mockSpawnCalls.push({ command, args });
      const child: any = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stdout.setEncoding = () => {};
      child.stderr = new EventEmitter();
      child.stderr.setEncoding = () => {};

      if (command === 'ffprobe') {
        process.nextTick(() => {
          if (mockFfprobeExitCode !== 0) {
            child.emit('close', mockFfprobeExitCode);
            return;
          }
          child.stdout.emit('data', String(mockFfprobeDuration));
          child.emit('close', 0);
        });
        return child;
      }

      if (command === 'ffmpeg') {
        process.nextTick(() => {
          if (mockFfmpegSpawnError) {
            child.emit('error', new Error('ENOENT: spawn ffmpeg'));
            return;
          }
          if (mockFfmpegStderr) child.stderr.emit('data', mockFfmpegStderr);
          if (mockFfmpegExitCode !== 0) {
            child.emit('close', mockFfmpegExitCode);
            return;
          }
          if (mockFfmpegWriteOutput) {
            const outPath = args[args.length - 1]!;
            fs.mkdirSync(path.dirname(outPath), { recursive: true });
            fs.writeFileSync(outPath, 'FAKE-WAV-BYTES');
          }
          child.emit('close', 0);
        });
        return child;
      }

      // default: python
      process.nextTick(() => {
        if (mockPythonSpawnError) {
          child.emit('error', new Error('ENOENT: spawn python'));
          return;
        }
        const scriptArgIdx = args.indexOf('--script');
        if (scriptArgIdx !== -1) {
          try {
            capturedScriptContentAtPythonSpawn = fs.readFileSync(args[scriptArgIdx + 1]!, 'utf-8');
          } catch {
            capturedScriptContentAtPythonSpawn = null;
          }
        }
        if (mockPythonStdoutChunk) child.stdout.emit('data', mockPythonStdoutChunk);
        if (mockPythonStderr) child.stderr.emit('data', mockPythonStderr);
        child.emit('close', mockPythonExitCode);
      });
      return child;
    },
  };
});

const TMP_DIR = path.resolve('tests/tmp_align_hardening');

function writeScript(name: string, content: string): string {
  const p = path.join(TMP_DIR, name);
  fs.writeFileSync(p, content, 'utf-8');
  return p;
}

function writeAudio(name: string, bytes = 'FAKE-AUDIO-BYTES'): string {
  const p = path.join(TMP_DIR, name);
  fs.writeFileSync(p, bytes);
  return p;
}

function writeAlignmentFixture(outPath: string, lines: unknown[]): void {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify({ lines }));
}

describe('align', () => {
  describe('alignScript', () => {
    beforeEach(() => {
      mockSpawnCalls.length = 0;
      mockFfprobeExitCode = 0;
      mockFfprobeDuration = 1.5;
      mockFfmpegExitCode = 0;
      mockFfmpegSpawnError = false;
      mockFfmpegWriteOutput = true;
      mockFfmpegStderr = '';
      mockPythonExitCode = 0;
      mockPythonSpawnError = false;
      mockPythonStdoutChunk = '';
      mockPythonStderr = '';
      capturedScriptContentAtPythonSpawn = null;
    });

    test('spawns Python aligner and parses written JSON output', async () => {
      const scriptPath = path.resolve('tests/fixtures/script.txt');
      const audioPath = path.resolve('tests/fixtures/dummy_align_audio.wav');
      const outJsonPath = path.resolve('projects/test_align_out/alignment.json');

      fs.writeFileSync(audioPath, 'FAKE-WAV-BYTES');
      fs.mkdirSync(path.dirname(outJsonPath), { recursive: true });
      fs.writeFileSync(outJsonPath, JSON.stringify({
        lines: [
          {
            index: 0,
            text: 'Hello world.',
            start: 1.0,
            end: 3.5,
            words: [
              { word: 'Hello', start: 1.0, end: 2.0 },
              { word: 'world.', start: 2.5, end: 3.5 },
            ],
          }
        ]
      }));

      try {
        const result = await alignScript(scriptPath, audioPath, outJsonPath);
        expect(result).toHaveLength(1);
        expect(result[0]!.text).toBe('Hello world.');
        const pythonCall = mockSpawnCalls.find((c) => c.command === 'python');
        expect(pythonCall).toBeDefined();
        expect(pythonCall!.args).toContain(scriptPath);
        // plain-ASCII single-word-heavy script needs no rewrite; wav needs no transcode
        expect(mockSpawnCalls.some((c) => c.command === 'ffmpeg')).toBe(false);
      } finally {
        fs.rmSync(path.dirname(outJsonPath), { recursive: true, force: true });
        fs.rmSync(audioPath, { force: true });
      }
    });

    describe('input hardening', () => {
      beforeEach(() => {
        fs.mkdirSync(TMP_DIR, { recursive: true });
      });
      afterEach(() => {
        fs.rmSync(TMP_DIR, { recursive: true, force: true });
      });

      test('rejects a missing audio file before spawning anything', async () => {
        const scriptPath = writeScript('s.txt', 'Hello world.\n');
        const audioPath = path.join(TMP_DIR, 'does-not-exist.wav');
        const outJsonPath = path.join(TMP_DIR, 'out.json');
        await expect(alignScript(scriptPath, audioPath, outJsonPath)).rejects.toThrow(/audio file not found/);
        expect(mockSpawnCalls).toHaveLength(0);
      });

      test('rejects a zero-length audio file before spawning anything', async () => {
        const scriptPath = writeScript('s.txt', 'Hello world.\n');
        const audioPath = writeAudio('empty.wav', '');
        const outJsonPath = path.join(TMP_DIR, 'out.json');
        await expect(alignScript(scriptPath, audioPath, outJsonPath)).rejects.toThrow(/empty \(0 bytes\)/);
        expect(mockSpawnCalls).toHaveLength(0);
      });

      test('rejects an unsupported audio extension before spawning anything', async () => {
        const scriptPath = writeScript('s.txt', 'Hello world.\n');
        const audioPath = writeAudio('clip.txt', 'not audio');
        const outJsonPath = path.join(TMP_DIR, 'out.json');
        await expect(alignScript(scriptPath, audioPath, outJsonPath)).rejects.toThrow(/unsupported audio format/);
        expect(mockSpawnCalls).toHaveLength(0);
      });

      test('rejects an empty (whitespace-only) script before spawning anything', async () => {
        const scriptPath = writeScript('empty.txt', '   \n\n  \t\n');
        const audioPath = writeAudio('a.wav');
        const outJsonPath = path.join(TMP_DIR, 'out.json');
        await expect(alignScript(scriptPath, audioPath, outJsonPath)).rejects.toThrow(/no non-empty lines/);
        expect(mockSpawnCalls).toHaveLength(0);
      });

      test('rejects a missing script file before spawning anything', async () => {
        const scriptPath = path.join(TMP_DIR, 'nope.txt');
        const audioPath = writeAudio('a.wav');
        const outJsonPath = path.join(TMP_DIR, 'out.json');
        await expect(alignScript(scriptPath, audioPath, outJsonPath)).rejects.toThrow(/script file not found/);
        expect(mockSpawnCalls).toHaveLength(0);
      });

      test('surfaces a corrupt/undecodable audio file via ffprobe, never reaching python', async () => {
        mockFfprobeExitCode = 1;
        const scriptPath = writeScript('s.txt', 'Hello world.\n');
        const audioPath = writeAudio('a.wav');
        const outJsonPath = path.join(TMP_DIR, 'out.json');
        await expect(alignScript(scriptPath, audioPath, outJsonPath)).rejects.toThrow(/corrupt or unsupported/);
        expect(mockSpawnCalls.some((c) => c.command === 'python')).toBe(false);
      });

      test('transcodes a non-wav audio file to wav before invoking python, then cleans up', async () => {
        const scriptPath = writeScript('s.txt', 'Hello world.\n');
        const audioPath = writeAudio('voice.mp3');
        const outJsonPath = path.join(TMP_DIR, 'out.json');
        writeAlignmentFixture(outJsonPath, [
          { index: 0, text: 'Hello world.', start: 0, end: 1, words: [{ word: 'Hello', start: 0, end: 0.5 }, { word: 'world.', start: 0.5, end: 1 }] },
        ]);

        await alignScript(scriptPath, audioPath, outJsonPath);

        const ffmpegCall = mockSpawnCalls.find((c) => c.command === 'ffmpeg');
        expect(ffmpegCall).toBeDefined();
        expect(ffmpegCall!.args).toContain(audioPath);

        const pythonCall = mockSpawnCalls.find((c) => c.command === 'python');
        const audioArgIdx = pythonCall!.args.indexOf('--audio');
        const audioArgUsed = pythonCall!.args[audioArgIdx + 1]!;
        expect(audioArgUsed).not.toBe(audioPath);
        expect(audioArgUsed.endsWith('.wav')).toBe(true);
        // temp transcoded file is cleaned up after alignScript resolves
        expect(fs.existsSync(audioArgUsed)).toBe(false);
      });

      test('does not transcode a wav input', async () => {
        const scriptPath = writeScript('s.txt', 'Hello world.\n');
        const audioPath = writeAudio('voice.wav');
        const outJsonPath = path.join(TMP_DIR, 'out.json');
        writeAlignmentFixture(outJsonPath, [
          { index: 0, text: 'Hello world.', start: 0, end: 1, words: [{ word: 'Hello', start: 0, end: 0.5 }, { word: 'world.', start: 0.5, end: 1 }] },
        ]);
        await alignScript(scriptPath, audioPath, outJsonPath);
        expect(mockSpawnCalls.some((c) => c.command === 'ffmpeg')).toBe(false);
      });

      test('rejects when ffmpeg transcode exits non-zero, surfacing its stderr', async () => {
        mockFfmpegExitCode = 1;
        mockFfmpegStderr = 'Invalid data found when processing input\n';
        const scriptPath = writeScript('s.txt', 'Hello world.\n');
        const audioPath = writeAudio('voice.mp3');
        const outJsonPath = path.join(TMP_DIR, 'out.json');
        await expect(alignScript(scriptPath, audioPath, outJsonPath)).rejects.toThrow(/ffmpeg transcode failed.*Invalid data found/s);
        expect(mockSpawnCalls.some((c) => c.command === 'python')).toBe(false);
      });

      test('rejects when ffmpeg fails to spawn at all', async () => {
        mockFfmpegSpawnError = true;
        const scriptPath = writeScript('s.txt', 'Hello world.\n');
        const audioPath = writeAudio('voice.mp3');
        const outJsonPath = path.join(TMP_DIR, 'out.json');
        await expect(alignScript(scriptPath, audioPath, outJsonPath)).rejects.toThrow(/failed to spawn ffmpeg/);
      });

      test('rejects when ffmpeg exits 0 but produces no output', async () => {
        mockFfmpegWriteOutput = false;
        const scriptPath = writeScript('s.txt', 'Hello world.\n');
        const audioPath = writeAudio('voice.mp3');
        const outJsonPath = path.join(TMP_DIR, 'out.json');
        await expect(alignScript(scriptPath, audioPath, outJsonPath)).rejects.toThrow(/produced no output/);
      });

      test('normalizes smart-punctuation scripts into a temp file for python, then cleans up', async () => {
        const scriptPath = writeScript('smart.txt', '“Hello” — world…\n');
        const audioPath = writeAudio('a.wav');
        const outJsonPath = path.join(TMP_DIR, 'out.json');
        writeAlignmentFixture(outJsonPath, [
          { index: 0, text: 'x', start: 0, end: 1, words: [{ word: 'x', start: 0, end: 1 }] },
        ]);

        await alignScript(scriptPath, audioPath, outJsonPath);

        const pythonCall = mockSpawnCalls.find((c) => c.command === 'python');
        const scriptArgIdx = pythonCall!.args.indexOf('--script');
        const scriptArgUsed = pythonCall!.args[scriptArgIdx + 1]!;
        expect(scriptArgUsed).not.toBe(scriptPath);
        expect(capturedScriptContentAtPythonSpawn).toBe('"Hello" - world...');
        expect(fs.existsSync(scriptArgUsed)).toBe(false); // cleaned up after resolve
      });

      test('passes the original script path through unchanged when no normalization is needed', async () => {
        const scriptPath = writeScript('plain.txt', 'Hello world.\n');
        const audioPath = writeAudio('a.wav');
        const outJsonPath = path.join(TMP_DIR, 'out.json');
        writeAlignmentFixture(outJsonPath, [
          { index: 0, text: 'Hello world.', start: 0, end: 1, words: [{ word: 'Hello', start: 0, end: 0.5 }, { word: 'world.', start: 0.5, end: 1 }] },
        ]);
        await alignScript(scriptPath, audioPath, outJsonPath);
        const pythonCall = mockSpawnCalls.find((c) => c.command === 'python');
        expect(pythonCall!.args).toContain(scriptPath);
      });

      test('emits a non-fatal warning on gross script-vs-audio length mismatch, alignment still proceeds', async () => {
        mockFfprobeDuration = 200; // way longer than a 2-word script implies
        const scriptPath = writeScript('short.txt', 'Hi there.\n');
        const audioPath = writeAudio('a.wav');
        const outJsonPath = path.join(TMP_DIR, 'out.json');
        writeAlignmentFixture(outJsonPath, [
          { index: 0, text: 'Hi there.', start: 0, end: 1, words: [{ word: 'Hi', start: 0, end: 0.5 }, { word: 'there.', start: 0.5, end: 1 }] },
        ]);
        const progress: string[] = [];
        const result = await alignScript(scriptPath, audioPath, outJsonPath, { onProgress: (l) => progress.push(l) });
        expect(result).toHaveLength(1);
        expect(progress.some((l) => l.includes('warning') && l.includes('200.0s'))).toBe(true);
      });

      test('surfaces python spawn failure', async () => {
        mockPythonSpawnError = true;
        const scriptPath = writeScript('s.txt', 'Hello world.\n');
        const audioPath = writeAudio('a.wav');
        const outJsonPath = path.join(TMP_DIR, 'out.json');
        await expect(alignScript(scriptPath, audioPath, outJsonPath)).rejects.toThrow(/failed to spawn python/);
      });

      test('surfaces a non-zero align_cli.py exit code, including its stderr tail', async () => {
        mockPythonExitCode = 2;
        mockPythonStderr = 'ERROR: alignment produced no words\n';
        const scriptPath = writeScript('s.txt', 'Hello world.\n');
        const audioPath = writeAudio('a.wav');
        const outJsonPath = path.join(TMP_DIR, 'out.json');
        await expect(alignScript(scriptPath, audioPath, outJsonPath)).rejects.toThrow(/exited with code 2.*alignment produced no words/s);
      });

      test('relays align_cli.py stdout progress lines via onProgress', async () => {
        mockPythonStdoutChunk = 'progress: loading model\nprogress: aligning\n\n';
        const scriptPath = writeScript('s.txt', 'Hello world.\n');
        const audioPath = writeAudio('a.wav');
        const outJsonPath = path.join(TMP_DIR, 'out.json');
        writeAlignmentFixture(outJsonPath, [
          { index: 0, text: 'Hello world.', start: 0, end: 1, words: [{ word: 'Hello', start: 0, end: 0.5 }, { word: 'world.', start: 0.5, end: 1 }] },
        ]);
        const progress: string[] = [];
        await alignScript(scriptPath, audioPath, outJsonPath, { onProgress: (l) => progress.push(l) });
        expect(progress).toContain('progress: loading model');
        expect(progress).toContain('progress: aligning');
      });

      test('falls back to console.warn for the mismatch warning when no onProgress is given', async () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
          mockFfprobeDuration = 200;
          const scriptPath = writeScript('short.txt', 'Hi there.\n');
          const audioPath = writeAudio('a.wav');
          const outJsonPath = path.join(TMP_DIR, 'out.json');
          writeAlignmentFixture(outJsonPath, [
            { index: 0, text: 'Hi there.', start: 0, end: 1, words: [{ word: 'Hi', start: 0, end: 0.5 }, { word: 'there.', start: 0.5, end: 1 }] },
          ]);
          await alignScript(scriptPath, audioPath, outJsonPath);
          expect(warnSpy).toHaveBeenCalledTimes(1);
          expect(warnSpy.mock.calls[0]![0]).toContain('200.0s');
        } finally {
          warnSpy.mockRestore();
        }
      });

      test('rejects with a friendly message when the output directory cannot be created', async () => {
        const mkdirSpy = vi.spyOn(fs, 'mkdirSync').mockImplementationOnce(() => {
          throw new Error('EACCES: permission denied');
        });
        try {
          const scriptPath = writeScript('s.txt', 'Hello world.\n');
          const audioPath = writeAudio('a.wav');
          const outJsonPath = path.join(TMP_DIR, 'nested', 'out.json');
          await expect(alignScript(scriptPath, audioPath, outJsonPath)).rejects.toThrow(/cannot create output dir/);
        } finally {
          mkdirSpy.mockRestore();
        }
      });

      test('rejects when align_cli.py reports success but wrote no output file', async () => {
        const scriptPath = writeScript('s.txt', 'Hello world.\n');
        const audioPath = writeAudio('a.wav');
        const outJsonPath = path.join(TMP_DIR, 'never-written.json');
        await expect(alignScript(scriptPath, audioPath, outJsonPath)).rejects.toThrow(/output file missing/);
      });

      test('rejects malformed (non-JSON) alignment output', async () => {
        const scriptPath = writeScript('s.txt', 'Hello world.\n');
        const audioPath = writeAudio('a.wav');
        const outJsonPath = path.join(TMP_DIR, 'out.json');
        fs.mkdirSync(path.dirname(outJsonPath), { recursive: true });
        fs.writeFileSync(outJsonPath, 'not json');
        await expect(alignScript(scriptPath, audioPath, outJsonPath)).rejects.toThrow(/not valid JSON/);
      });

      test('rejects alignment output with no "lines" array', async () => {
        const scriptPath = writeScript('s.txt', 'Hello world.\n');
        const audioPath = writeAudio('a.wav');
        const outJsonPath = path.join(TMP_DIR, 'out.json');
        fs.mkdirSync(path.dirname(outJsonPath), { recursive: true });
        fs.writeFileSync(outJsonPath, JSON.stringify({}));
        await expect(alignScript(scriptPath, audioPath, outJsonPath)).rejects.toThrow(/no "lines" array/);
      });

      test('rejects a malformed line entry', async () => {
        const scriptPath = writeScript('s.txt', 'Hello world.\n');
        const audioPath = writeAudio('a.wav');
        const outJsonPath = path.join(TMP_DIR, 'out.json');
        writeAlignmentFixture(outJsonPath, [{ index: 0, text: 'x' /* missing start/end/words */ }]);
        await expect(alignScript(scriptPath, audioPath, outJsonPath)).rejects.toThrow(/line 0 malformed/);
      });

      test('rejects a malformed word entry', async () => {
        const scriptPath = writeScript('s.txt', 'Hello world.\n');
        const audioPath = writeAudio('a.wav');
        const outJsonPath = path.join(TMP_DIR, 'out.json');
        writeAlignmentFixture(outJsonPath, [
          { index: 0, text: 'x', start: 0, end: 1, words: [{ word: 'x' /* missing start/end */ }] },
        ]);
        await expect(alignScript(scriptPath, audioPath, outJsonPath)).rejects.toThrow(/word 0 malformed/);
      });

      describe('alignment result sanity gate', () => {
        test('rejects a line with zero aligned words', async () => {
          const scriptPath = writeScript('s.txt', 'Hello world.\n');
          const audioPath = writeAudio('a.wav');
          const outJsonPath = path.join(TMP_DIR, 'out.json');
          writeAlignmentFixture(outJsonPath, [{ index: 0, text: 'Hello world.', start: 0, end: 1, words: [] }]);
          await expect(alignScript(scriptPath, audioPath, outJsonPath)).rejects.toThrow(/zero aligned words/);
        });

        test('rejects a line with inverted timestamps', async () => {
          const scriptPath = writeScript('s.txt', 'Hello world.\n');
          const audioPath = writeAudio('a.wav');
          const outJsonPath = path.join(TMP_DIR, 'out.json');
          writeAlignmentFixture(outJsonPath, [
            { index: 0, text: 'Hello world.', start: 5, end: 2, words: [{ word: 'Hello', start: 5, end: 2 }] },
          ]);
          await expect(alignScript(scriptPath, audioPath, outJsonPath)).rejects.toThrow(/inverted timestamps/);
        });

        test('rejects a word with inverted timestamps', async () => {
          const scriptPath = writeScript('s.txt', 'Hello world.\n');
          const audioPath = writeAudio('a.wav');
          const outJsonPath = path.join(TMP_DIR, 'out.json');
          writeAlignmentFixture(outJsonPath, [
            { index: 0, text: 'Hello world.', start: 0, end: 3, words: [{ word: 'Hello', start: 2, end: 1 }] },
          ]);
          await expect(alignScript(scriptPath, audioPath, outJsonPath)).rejects.toThrow(/word 0 \("Hello"\) has inverted timestamps/);
        });

        test('rejects out-of-order words within a line', async () => {
          const scriptPath = writeScript('s.txt', 'Hello world.\n');
          const audioPath = writeAudio('a.wav');
          const outJsonPath = path.join(TMP_DIR, 'out.json');
          writeAlignmentFixture(outJsonPath, [
            {
              index: 0,
              text: 'Hello world.',
              start: 0,
              end: 3,
              words: [
                { word: 'Hello', start: 2, end: 2.5 },
                { word: 'world.', start: 1, end: 1.5 },
              ],
            },
          ]);
          await expect(alignScript(scriptPath, audioPath, outJsonPath)).rejects.toThrow(/starts before the previous word/);
        });

        test('rejects out-of-order line starts', async () => {
          const scriptPath = writeScript('s.txt', 'Hello world.\n');
          const audioPath = writeAudio('a.wav');
          const outJsonPath = path.join(TMP_DIR, 'out.json');
          writeAlignmentFixture(outJsonPath, [
            { index: 0, text: 'A', start: 5, end: 6, words: [{ word: 'A', start: 5, end: 6 }] },
            { index: 1, text: 'B', start: 2, end: 3, words: [{ word: 'B', start: 2, end: 3 }] },
          ]);
          await expect(alignScript(scriptPath, audioPath, outJsonPath)).rejects.toThrow(/timestamps are out of order/);
        });

        test('accepts well-formed multi-line alignment output', async () => {
          const scriptPath = writeScript('s.txt', 'Hello world.\nBye now.\n');
          const audioPath = writeAudio('a.wav');
          const outJsonPath = path.join(TMP_DIR, 'out.json');
          writeAlignmentFixture(outJsonPath, [
            { index: 0, text: 'Hello world.', start: 0, end: 1, words: [{ word: 'Hello', start: 0, end: 0.5 }, { word: 'world.', start: 0.5, end: 1 }] },
            { index: 1, text: 'Bye now.', start: 1.5, end: 2.5, words: [{ word: 'Bye', start: 1.5, end: 2 }, { word: 'now.', start: 2, end: 2.5 }] },
          ]);
          const result = await alignScript(scriptPath, audioPath, outJsonPath);
          expect(result).toHaveLength(2);
        });
      });
    });
  });

  describe('normalizeScriptText', () => {
    test('converts smart quotes, dashes and ellipsis to ASCII', () => {
      expect(normalizeScriptText('‘a’ “b” – — …')).toBe("'a' \"b\" - - ...");
    });

    test('collapses unicode whitespace (nbsp etc.) to a regular space', () => {
      expect(normalizeScriptText('a b　c')).toBe('a b c');
    });

    test('drops empty lines and trims each line', () => {
      expect(normalizeScriptText('  line one  \n\n\n   \n  line two')).toBe('line one\nline two');
    });

    test('returns empty string for whitespace-only input', () => {
      expect(normalizeScriptText('   \n  \n')).toBe('');
    });
  });

  describe('checkScriptAudioLengthMatch', () => {
    test('returns null when audio duration is within range of the word-count estimate', () => {
      // 15 words -> ~6s expected at 2.5 words/sec; 8s is within [0.25x, 4x]
      expect(checkScriptAudioLengthMatch(15, 8)).toBeNull();
    });

    test('warns with both numbers when audio is much longer than the script implies', () => {
      const warning = checkScriptAudioLengthMatch(10, 200);
      expect(warning).not.toBeNull();
      expect(warning).toContain('10 words');
      expect(warning).toContain('200.0s');
    });

    test('warns with both numbers when audio is much shorter than the script implies', () => {
      const warning = checkScriptAudioLengthMatch(1000, 5);
      expect(warning).not.toBeNull();
      expect(warning).toContain('1000 words');
      expect(warning).toContain('5.0s');
    });

    test('returns null for zero word count or non-finite duration (nothing meaningful to compare)', () => {
      expect(checkScriptAudioLengthMatch(0, 10)).toBeNull();
      expect(checkScriptAudioLengthMatch(10, NaN)).toBeNull();
      expect(checkScriptAudioLengthMatch(10, 0)).toBeNull();
    });
  });

  describe('computeTimeline', () => {
    test('applies TIMELINE RULE correctly to multiple lines', () => {
      const mockAlignedLines: AlignedLine[] = [
        {
          index: 0,
          text: 'Hello world.',
          start: 1.0,
          end: 3.5,
          words: [
            { word: 'Hello', start: 1.0, end: 2.0 },
            { word: 'world.', start: 2.5, end: 3.5 },
          ],
        },
        {
          index: 1,
          text: 'This is a test script.',
          start: 5.0,
          end: 8.0,
          words: [
            { word: 'This', start: 5.0, end: 5.5 },
            { word: 'is', start: 5.6, end: 6.0 },
            { word: 'a', start: 6.1, end: 6.5 },
            { word: 'test', start: 6.6, end: 7.2 },
            { word: 'script.', start: 7.3, end: 8.0 },
          ],
        },
      ];

      const result = computeTimeline(mockAlignedLines);

      expect(result).toHaveLength(2);

      // First line
      expect(result[0]!.index).toBe(0);
      expect(result[0]!.text).toBe('Hello world.');
      expect(result[0]!.start).toBe(1.0);
      expect(result[0]!.end).toBe(3.5);
      expect(result[0]!.duration).toBe(2.5); // 3.5 - 1.0
      expect(result[0]!.pauseAfter).toBe(1.5); // 5.0 - 3.5
      expect(result[0]!.targetDuration).toBe(4.0); // 5.0 - 1.0

      // Last line
      expect(result[1]!.index).toBe(1);
      expect(result[1]!.text).toBe('This is a test script.');
      expect(result[1]!.start).toBe(5.0);
      expect(result[1]!.end).toBe(8.0);
      expect(result[1]!.duration).toBe(3.0); // 8.0 - 5.0
      expect(result[1]!.pauseAfter).toBe(0); // last line pauseAfter is always 0
      expect(result[1]!.targetDuration).toBe(3.5); // duration + 0.5s tail
    });
  });

  describe('planShots', () => {
    test('creates 1 shot for normal short lines', () => {
      const mockAligned: AlignedLine[] = [
        {
          index: 0,
          text: 'Short line.',
          start: 0.0,
          end: 2.0,
          words: [
            { word: 'Short', start: 0.0, end: 0.8 },
            { word: 'line.', start: 1.0, end: 2.0 },
          ],
        },
      ];
      const timeline = computeTimeline(mockAligned);
      const shots = planShots('proj-1', timeline, mockAligned);

      expect(shots).toHaveLength(1);
      expect(shots[0]!.projectId).toBe('proj-1');
      expect(shots[0]!.lineIndex).toBe(0);
      expect(shots[0]!.subIndex).toBe(0);
      expect(shots[0]!.state).toBe('PENDING');
      expect(shots[0]!.line.targetDuration).toBe(2.5); // 2.0 + 0.5 tail
    });

    test('splits long lines (>15s) at word boundaries', () => {
      // Create a line that takes 20 seconds.
      // We will place words such that it splits.
      // Ideal split is at 10s.
      // Words are at:
      // Word 1: 0-1
      // Word 2: 4-5
      // Word 3: 9-10  (word start 9.0)
      // Word 4: 11-12 (word start 11.0)
      // Word 5: 18-19
      const mockAligned: AlignedLine[] = [
        {
          index: 0,
          text: 'One Two Three Four Five',
          start: 0.0,
          end: 19.0,
          words: [
            { word: 'One', start: 0.0, end: 1.0 },
            { word: 'Two', start: 4.0, end: 5.0 },
            { word: 'Three', start: 9.0, end: 10.0 },
            { word: 'Four', start: 11.0, end: 12.0 },
            { word: 'Five', start: 18.0, end: 19.0 },
          ],
        },
      ];
      const timeline = computeTimeline(mockAligned); // targetDuration = 19.5s
      const shots = planShots('proj-1', timeline, mockAligned);

      expect(shots.length).toBeGreaterThan(1);
      // Verify that every shot's targetDuration is <= 15s
      for (const shot of shots) {
        expect(shot.line.targetDuration).toBeLessThanOrEqual(15.0);
        expect(shot.state).toBe('PENDING');
        expect(shot.lineIndex).toBe(0);
      }

      // Let's check subIndex ordering
      expect(shots[0]!.subIndex).toBe(0);
      expect(shots[1]!.subIndex).toBe(1);
    });

    test('falls back to equal raw splits if irreducible at word boundaries', () => {
      // Line with targetDuration = 20s, but no words in between to cut
      const mockAligned: AlignedLine[] = [
        {
          index: 0,
          text: 'Silent line',
          start: 0.0,
          end: 19.5,
          words: [], // no words
        },
      ];
      const timeline = computeTimeline(mockAligned);
      const shots = planShots('proj-1', timeline, mockAligned);

      expect(shots).toHaveLength(2);
      expect(shots[0]!.line.targetDuration).toBe(10.0);
      expect(shots[1]!.line.targetDuration).toBe(10.0);
    });
  });
});
