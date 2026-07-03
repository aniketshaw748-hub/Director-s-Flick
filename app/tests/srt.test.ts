/**
 * srt.test.ts — SRT caption export (T-68). Fully hermetic: pure string/file
 * work, no ffmpeg is ever run. Covers timestamp formatting, text sanitization,
 * golden SRT content (CRLF + sequential indices), reading alignment.json, the
 * sidecar path/write, and — the gnarly bit — ffmpeg subtitles-filter arg
 * construction with Windows path escaping incl. spaces-in-path.
 */

import { afterEach, describe, expect, test } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildBurnFilterArgs,
  buildSrtFromAlignment,
  escapeSubtitlesArg,
  exportSrtSidecar,
  formatTimestamp,
  linesToSrt,
  sanitizeText,
  srtSidecarPath,
  writeSrtSidecar,
  type SrtLine,
} from '../src/srt.js';

const tmpDirs: string[] = [];
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'srt-'));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop()!;
    if (fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// formatTimestamp
// ---------------------------------------------------------------------------

describe('formatTimestamp', () => {
  test('formats seconds as HH:MM:SS,mmm', () => {
    expect(formatTimestamp(0)).toBe('00:00:00,000');
    expect(formatTimestamp(0.1)).toBe('00:00:00,100');
    expect(formatTimestamp(4.8)).toBe('00:00:04,800');
    expect(formatTimestamp(65.25)).toBe('00:01:05,250');
    expect(formatTimestamp(3661.5)).toBe('01:01:01,500'); // 1h 1m 1.5s
  });

  test('clamps negatives and non-finite to zero', () => {
    expect(formatTimestamp(-5)).toBe('00:00:00,000');
    expect(formatTimestamp(NaN)).toBe('00:00:00,000');
    expect(formatTimestamp(Infinity)).toBe('00:00:00,000');
  });

  test('rounds milliseconds to the nearest ms', () => {
    expect(formatTimestamp(1.2345)).toBe('00:00:01,235');
    expect(formatTimestamp(1.2344)).toBe('00:00:01,234');
  });
});

// ---------------------------------------------------------------------------
// sanitizeText
// ---------------------------------------------------------------------------

describe('sanitizeText', () => {
  test('collapses whitespace and trims', () => {
    expect(sanitizeText('  hello   world  ')).toBe('hello world');
  });
  test('folds internal newlines/tabs into single spaces (never split a cue)', () => {
    expect(sanitizeText('line one\nline two')).toBe('line one line two');
    expect(sanitizeText('a\r\nb')).toBe('a b');
    expect(sanitizeText('tab\there')).toBe('tab here');
  });
  test('strips other control characters', () => {
    expect(sanitizeText('a\x07b\x00c')).toBe('a b c'); // bell + NUL -> spaces
  });
});

// ---------------------------------------------------------------------------
// linesToSrt — golden content
// ---------------------------------------------------------------------------

describe('linesToSrt', () => {
  const GOLDEN =
    '1\r\n' +
    '00:00:00,100 --> 00:00:04,800\r\n' +
    'The storm had finally passed.\r\n' +
    '\r\n' +
    '2\r\n' +
    '00:00:05,000 --> 00:00:09,200\r\n' +
    'Second line here.\r\n' +
    '\r\n';

  test('matches the golden SRT (CRLF, sequential indices, blank-line separators)', () => {
    const lines: SrtLine[] = [
      { text: 'The storm had finally passed.', start: 0.1, end: 4.8 },
      { text: 'Second line here.', start: 5.0, end: 9.2 },
    ];
    expect(linesToSrt(lines)).toBe(GOLDEN);
  });

  test('uses CRLF line endings throughout', () => {
    const out = linesToSrt([{ text: 'x', start: 0, end: 1 }]);
    expect(out).toContain('\r\n');
    expect(out.replace(/\r\n/g, '')).not.toContain('\n'); // no bare LF
  });

  test('numbers cues sequentially regardless of source order, skipping empty text', () => {
    const out = linesToSrt([
      { text: 'A', start: 0, end: 1 },
      { text: '   ', start: 1, end: 2 }, // empty after sanitize -> dropped
      { text: 'B', start: 2, end: 3 },
    ]);
    expect(out.startsWith('1\r\n')).toBe(true);
    expect(out).toContain('\nA\r\n'); // cue 1 text
    expect(out).toContain('2\r\n');
    expect(out).toContain('\nB\r\n'); // cue 2 text
    expect(out).not.toContain('3\r\n'); // the blank line never became a cue
  });

  test('clamps an inverted end time to the start', () => {
    const out = linesToSrt([{ text: 'X', start: 5, end: 3 }]);
    expect(out).toContain('00:00:05,000 --> 00:00:05,000');
  });

  test('empty input yields empty output', () => {
    expect(linesToSrt([])).toBe('');
  });
});

// ---------------------------------------------------------------------------
// buildSrtFromAlignment — reads align_cli.py output
// ---------------------------------------------------------------------------

describe('buildSrtFromAlignment', () => {
  function writeAlignment(dir: string, data: unknown): string {
    const p = path.join(dir, 'alignment.json');
    fs.writeFileSync(p, JSON.stringify(data), 'utf-8');
    return p;
  }

  test('renders SRT from an alignment fixture, ignoring word timings/extra fields', () => {
    const dir = tmp();
    const p = writeAlignment(dir, {
      lines: [
        {
          index: 0,
          text: 'The storm had finally passed.',
          start: 0.1,
          end: 4.8,
          duration: 4.7,
          words: [{ word: 'The', start: 0.1, end: 0.2 }],
        },
        { index: 1, text: 'Second line here.', start: 5.0, end: 9.2, duration: 4.2, words: [] },
      ],
    });
    const expected = linesToSrt([
      { text: 'The storm had finally passed.', start: 0.1, end: 4.8 },
      { text: 'Second line here.', start: 5.0, end: 9.2 },
    ]);
    expect(buildSrtFromAlignment(p)).toBe(expected);
    expect(buildSrtFromAlignment(p)).toContain('00:00:00,100 --> 00:00:04,800');
  });

  test('throws on a missing file', () => {
    expect(() => buildSrtFromAlignment(path.join(tmp(), 'nope.json'))).toThrow(/missing/);
  });
  test('throws on invalid JSON', () => {
    const dir = tmp();
    const p = path.join(dir, 'alignment.json');
    fs.writeFileSync(p, '{not json', 'utf-8');
    expect(() => buildSrtFromAlignment(p)).toThrow(/not valid JSON/);
  });
  test('throws when the lines array is absent or empty', () => {
    expect(() => buildSrtFromAlignment(writeAlignment(tmp(), { lines: [] }))).toThrow(/no "lines"/);
    expect(() => buildSrtFromAlignment(writeAlignment(tmp(), {}))).toThrow(/no "lines"/);
  });
  test('throws on a malformed line (missing start/end/text)', () => {
    const p = writeAlignment(tmp(), { lines: [{ index: 0, text: 'x' }] });
    expect(() => buildSrtFromAlignment(p)).toThrow(/malformed/);
  });
});

// ---------------------------------------------------------------------------
// sidecar path + write
// ---------------------------------------------------------------------------

describe('srt sidecar', () => {
  test('srtSidecarPath swaps the video extension for .srt, same dir + basename', () => {
    const dir = path.join('x', 'proj', 'export');
    expect(srtSidecarPath(path.join(dir, 'final.mp4'))).toBe(path.join(dir, 'final.srt'));
    expect(srtSidecarPath(path.join(dir, 'my.render.mov'))).toBe(path.join(dir, 'my.render.srt'));
  });

  test('writeSrtSidecar writes the content next to the video and returns the path', () => {
    const dir = tmp();
    const finalMp4 = path.join(dir, 'export', 'final.mp4');
    const written = writeSrtSidecar(finalMp4, 'CONTENT');
    expect(written).toBe(path.join(dir, 'export', 'final.srt'));
    expect(fs.readFileSync(written, 'utf-8')).toBe('CONTENT');
  });

  test('exportSrtSidecar composes alignment.json -> final.srt beside the video', () => {
    const dir = tmp();
    const align = path.join(dir, 'alignment.json');
    fs.writeFileSync(
      align,
      JSON.stringify({ lines: [{ index: 0, text: 'Hello world.', start: 0.1, end: 4.8, words: [] }] }),
      'utf-8',
    );
    const finalMp4 = path.join(dir, 'export', 'final.mp4');
    const written = exportSrtSidecar(finalMp4, align);
    expect(written).toBe(path.join(dir, 'export', 'final.srt'));
    const body = fs.readFileSync(written, 'utf-8');
    expect(body).toContain('00:00:00,100 --> 00:00:04,800');
    expect(body).toContain('Hello world.');
    expect(body).toContain('\r\n'); // CRLF preserved on disk
  });
});

// ---------------------------------------------------------------------------
// burn args — the gnarly Windows filtergraph path escaping
// ---------------------------------------------------------------------------

describe('buildBurnFilterArgs / escapeSubtitlesArg', () => {
  test('escapes a plain Windows path (backslashes -> forward slashes, quoted)', () => {
    expect(escapeSubtitlesArg('C:\\out\\final.srt')).toBe("subtitles='C:/out/final.srt'");
  });

  test('handles spaces in the path (the acceptance case)', () => {
    expect(escapeSubtitlesArg('C:\\Users\\me\\My Videos\\final.srt')).toBe(
      "subtitles='C:/Users/me/My Videos/final.srt'",
    );
    expect(buildBurnFilterArgs('C:\\a b\\final.srt')).toEqual(['-vf', "subtitles='C:/a b/final.srt'"]);
  });

  test('does NOT escape the drive colon (single quotes protect it)', () => {
    expect(escapeSubtitlesArg('C:\\out\\final.srt')).not.toContain('\\:');
  });

  test('leaves an already-forward-slash path (posix) intact', () => {
    expect(escapeSubtitlesArg('/home/me/a b/final.srt')).toBe("subtitles='/home/me/a b/final.srt'");
  });

  test('escapes a literal single quote in the path so it cannot close the token early', () => {
    expect(escapeSubtitlesArg("C:\\o'brien\\final.srt")).toBe("subtitles='C:/o\\'brien/final.srt'");
  });

  test('buildBurnFilterArgs returns a -vf argv pair', () => {
    const args = buildBurnFilterArgs('C:\\x\\final.srt');
    expect(args[0]).toBe('-vf');
    expect(args[1]).toMatch(/^subtitles='.*final\.srt'$/);
    expect(args).toHaveLength(2);
  });
});
