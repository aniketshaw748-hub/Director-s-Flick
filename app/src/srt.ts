/**
 * srt.ts — SRT caption sidecar export (T-68).
 *
 * The pipeline already has per-line alignment (align_cli.py -> alignment.json:
 * `{ lines: AlignedLine[] }`, each with first-word `start` and last-word `end`
 * in seconds). A caption track is therefore just a formatting job: emit one SRT
 * cue per line at its spoken start/end. The final video timeline is glued to the
 * VO (EDL timelineStart == line.start), so aligned timings match final.mp4.
 *
 * This module is pure/self-contained (node builtins only) so it is trivially
 * golden-testable. Callers (cli.ts export --srt, and — once T-62 settles — the
 * server export handler) invoke `exportSrtSidecar(finalMp4, alignmentJson)`.
 *
 * Everything here is offline string/file work: no ffmpeg is run. `--burn` only
 * CONSTRUCTS the subtitles-filter args; running them stays with the export
 * pipeline. The gnarly part is escaping a Windows path for an ffmpeg
 * filtergraph — see buildBurnFilterArgs.
 */

import fs from 'node:fs';
import path from 'node:path';

/** One caption: text plus spoken [start,end) in seconds. */
export interface SrtLine {
  text: string;
  start: number;
  end: number;
}

/**
 * Seconds -> `HH:MM:SS,mmm` (SRT uses a comma before milliseconds). Negative or
 * NaN inputs clamp to zero; milliseconds are rounded to the nearest ms so e.g.
 * 4.8 -> `00:00:04,800`, 3661.5 -> `01:01:01,500`.
 */
export function formatTimestamp(seconds: number): string {
  const total = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  const ms = Math.round(total * 1000);
  const hh = Math.floor(ms / 3_600_000);
  const mm = Math.floor((ms % 3_600_000) / 60_000);
  const ss = Math.floor((ms % 60_000) / 1000);
  const mmm = ms % 1000;
  const p2 = (n: number) => String(n).padStart(2, '0');
  return `${p2(hh)}:${p2(mm)}:${p2(ss)},${String(mmm).padStart(3, '0')}`;
}

/**
 * Make line text safe to sit inside a single SRT cue: strip control characters,
 * fold any internal CR/LF/TAB into single spaces (a raw blank line inside a cue
 * would terminate it early and desync every following index), collapse runs of
 * whitespace, and trim. A caption line is a single visual line here.
 */
export function sanitizeText(text: string): string {
  return text
    .replace(/^﻿/, '') // strip a stray BOM
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1F]+/g, ' ') // control chars (incl. CR/LF/TAB) -> space
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Render SRT text (CRLF line endings, sequential 1-based indices, one cue per
 * line). End is clamped to be >= start so a timestamp pair is never inverted.
 * Empty-after-sanitize lines are dropped (they would produce a blank cue).
 */
export function linesToSrt(lines: SrtLine[]): string {
  const CRLF = '\r\n';
  let out = '';
  let idx = 0;
  for (const line of lines) {
    const text = sanitizeText(line.text);
    if (text.length === 0) continue;
    idx += 1;
    const start = Number.isFinite(line.start) && line.start > 0 ? line.start : 0;
    const end = Math.max(line.end, start);
    out += `${idx}${CRLF}`;
    out += `${formatTimestamp(start)} --> ${formatTimestamp(end)}${CRLF}`;
    out += `${text}${CRLF}${CRLF}`;
  }
  return out;
}

/**
 * Read align_cli.py output (`{ lines: [{ text, start, end }] }`) and render SRT.
 * Validates the shape the way align.ts does; only text/start/end are needed here
 * (word timings are ignored for captions).
 */
export function buildSrtFromAlignment(alignmentPath: string): string {
  let raw: string;
  try {
    raw = fs.readFileSync(alignmentPath, 'utf-8');
  } catch (err) {
    throw new Error(`srt: alignment file missing at ${alignmentPath}: ${String(err)}`);
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`srt: alignment is not valid JSON: ${alignmentPath}`);
  }
  const lines = (data as { lines?: unknown }).lines;
  if (!Array.isArray(lines) || lines.length === 0) {
    throw new Error(`srt: alignment has no "lines" array: ${alignmentPath}`);
  }
  const srtLines = lines.map((entry, i): SrtLine => {
    const e = entry as Partial<SrtLine>;
    if (typeof e.text !== 'string' || typeof e.start !== 'number' || typeof e.end !== 'number') {
      throw new Error(`srt: line ${i} malformed (need text/start/end) in ${alignmentPath}`);
    }
    return { text: e.text, start: e.start, end: e.end };
  });
  return linesToSrt(srtLines);
}

/**
 * Path of the SRT sidecar for a final video: same directory + basename, `.srt`
 * extension (`.../export/final.mp4` -> `.../export/final.srt`).
 */
export function srtSidecarPath(finalVideoPath: string): string {
  const parsed = path.parse(finalVideoPath);
  return path.join(parsed.dir, `${parsed.name}.srt`);
}

/** Write SRT content next to the final video and return the sidecar path. */
export function writeSrtSidecar(finalVideoPath: string, srtContent: string): string {
  const srtPath = srtSidecarPath(finalVideoPath);
  fs.mkdirSync(path.dirname(srtPath), { recursive: true });
  fs.writeFileSync(srtPath, srtContent, 'utf-8');
  return srtPath;
}

/**
 * Compose the two: build SRT from alignment.json and write it beside the final
 * video. Returns the sidecar path. This is the single call sites use.
 */
export function exportSrtSidecar(finalVideoPath: string, alignmentPath: string): string {
  return writeSrtSidecar(finalVideoPath, buildSrtFromAlignment(alignmentPath));
}

/**
 * Escape a subtitle-file path for use as the value of an ffmpeg `subtitles=`
 * filter option inside a filtergraph.
 *
 * This is the gnarly part on Windows. A raw path like `C:\Dir\a b\final.srt`
 * breaks a filtergraph two ways: the backslashes are escape characters, and the
 * drive-letter colon is the filter-option separator. The robust, ffmpeg-
 * documented fix (we pass argv directly, so there is NO surrounding shell layer
 * to help):
 *   1. backslashes -> forward slashes  (ffmpeg accepts `/` on Windows)
 *   2. wrap the value in single quotes — a quoted filtergraph token protects the
 *      drive colon AND embedded spaces, so neither needs its own escaping.
 *   3. escape any literal single quote in the path as `\'` so it can't close the
 *      quoted token early.
 * We deliberately do NOT also escape the colon: inside single quotes a `\` is
 * literal, so `C\:` would inject a stray backslash and the file would not open.
 */
export function escapeSubtitlesArg(srtPath: string): string {
  const forward = srtPath.replace(/\\/g, '/'); // Windows backslashes -> forward slashes
  const quoteSafe = forward.replace(/'/g, "\\'"); // protect a literal single quote
  return `subtitles='${quoteSafe}'`;
}

/**
 * Construct the ffmpeg args that burn an SRT into the video: `-vf subtitles=...`
 * with the path escaped for the filtergraph. Execution stays with the export
 * pipeline; this only builds the args.
 */
export function buildBurnFilterArgs(srtPath: string): string[] {
  return ['-vf', escapeSubtitlesArg(srtPath)];
}
