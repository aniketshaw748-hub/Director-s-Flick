/**
 * media.ts — FFmpeg helpers + HTTP download for the video pipeline.
 *
 * Owner: media module. See ARCHITECTURE.md ("media — src/media.ts").
 *
 * All external processes are spawned via child_process.spawn with ARRAY args
 * (never shell-string interpolation). All paths go through node:path.
 *
 * TIMELINE RULE (binding): export trims each EDL entry to its exact
 * fractional `duration` — the generated clip is intentionally longer
 * (integer-clamped at generation). If a source clip is SHORTER than the
 * required duration, the trim filter chain extends it with
 * tpad=stop_mode=clone (hold last frame) and a warning is logged.
 */

import { spawn } from 'node:child_process';
import { createWriteStream, promises as fsp } from 'node:fs';
import * as http from 'node:http';
import * as https from 'node:https';
import * as path from 'node:path';
import type { EDLEntry } from './types.js';

// ---------------------------------------------------------------------------
// Normalization constants (1080p30 CFR, NVENC)
// ---------------------------------------------------------------------------

const DEFAULT_FPS = 30;
const DEFAULT_WIDTH = 1920;
const DEFAULT_HEIGHT = 1080;
const NVENC_PRESET = 'p4';
const VIDEO_BITRATE = '12M';
/** Tolerance (seconds) when comparing source length against required duration. */
const DURATION_EPSILON = 0.001;
/** Extra tpad beyond the computed shortfall; output is cut exactly by -t. */
const TPAD_SAFETY_SECONDS = 1.0;
/** Max HTTP redirects followed by download(). */
const MAX_REDIRECTS = 10;

export interface NormalizeOptions {
  fps?: number;
  width?: number;
  height?: number;
}

// ---------------------------------------------------------------------------
// Process helper
// ---------------------------------------------------------------------------

function runProcess(
  command: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => {
      reject(new Error(`[media] failed to spawn ${command}: ${err.message}`));
    });
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        const tail = stderr.trim().split(/\r?\n/).slice(-8).join('\n');
        reject(
          new Error(
            `[media] ${command} exited with code ${String(code)}: ${command} ${args.join(' ')}\n${tail}`,
          ),
        );
      }
    });
  });
}

function runFfmpeg(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return runProcess('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
}

async function ensureParentDir(filePath: string): Promise<void> {
  await fsp.mkdir(path.dirname(path.resolve(filePath)), { recursive: true });
}

/** Format a number of seconds for an ffmpeg arg (no exponent notation). */
function sec(n: number): string {
  return n.toFixed(3);
}

// ---------------------------------------------------------------------------
// download — HTTP(S) with redirect handling
// ---------------------------------------------------------------------------

/**
 * Download `url` to `destPath` via node:https / node:http, following up to
 * MAX_REDIRECTS redirects. Creates the parent directory. Returns destPath.
 */
export function download(url: string, destPath: string): Promise<string> {
  const resolvedDest = path.resolve(destPath);

  const fetchOnce = (currentUrl: string, redirectsLeft: number): Promise<string> =>
    new Promise((resolve, reject) => {
      let parsed: URL;
      try {
        parsed = new URL(currentUrl);
      } catch {
        reject(new Error(`[media] download: invalid URL: ${currentUrl}`));
        return;
      }
      const lib = parsed.protocol === 'https:' ? https : parsed.protocol === 'http:' ? http : null;
      if (!lib) {
        reject(new Error(`[media] download: unsupported protocol: ${parsed.protocol}`));
        return;
      }
      const req = lib.get(parsed, (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume(); // drain
          if (redirectsLeft <= 0) {
            reject(new Error(`[media] download: too many redirects for ${url}`));
            return;
          }
          const nextUrl = new URL(res.headers.location, parsed).toString();
          resolve(fetchOnce(nextUrl, redirectsLeft - 1));
          return;
        }
        if (status < 200 || status >= 300) {
          res.resume();
          reject(new Error(`[media] download: HTTP ${String(status)} for ${currentUrl}`));
          return;
        }
        const out = createWriteStream(resolvedDest);
        const cleanup = (err: Error) => {
          out.destroy();
          void fsp.unlink(resolvedDest).catch(() => undefined);
          reject(err);
        };
        res.on('error', (err) => cleanup(new Error(`[media] download: response error: ${err.message}`)));
        out.on('error', (err) => cleanup(new Error(`[media] download: write error: ${err.message}`)));
        out.on('finish', () => resolve(resolvedDest));
        res.pipe(out);
      });
      req.on('error', (err) => {
        reject(new Error(`[media] download: request error for ${currentUrl}: ${err.message}`));
      });
    });

  return ensureParentDir(resolvedDest).then(() => fetchOnce(url, MAX_REDIRECTS));
}

// ---------------------------------------------------------------------------
// probeDuration — ffprobe
// ---------------------------------------------------------------------------

/** Duration of a media file in seconds, via ffprobe format=duration. */
export async function probeDuration(mediaPath: string): Promise<number> {
  const { stdout } = await runProcess('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'default=noprint_wrappers=1:nokey=1',
    path.resolve(mediaPath),
  ]);
  const duration = Number.parseFloat(stdout.trim());
  if (!Number.isFinite(duration)) {
    throw new Error(`[media] probeDuration: could not parse duration for ${mediaPath}: "${stdout.trim()}"`);
  }
  return duration;
}

// ---------------------------------------------------------------------------
// trimNormalize — trim to [inPoint, inPoint+duration), normalize 1080p30 CFR
// ---------------------------------------------------------------------------

/**
 * Trim `srcPath` to [inPoint, inPoint + duration), normalize to 1080p30 CFR
 * (scale=1920:1080,setsar=1,fps=30), encode with h264_nvenc (-preset p4
 * -b:v 12M), strip audio (-an). If the source has less material than
 * `duration` after inPoint, the last frame is held via
 * tpad=stop_mode=clone and a warning is logged. Returns destPath.
 */
export async function trimNormalize(
  srcPath: string,
  destPath: string,
  inPoint: number,
  duration: number,
  opts?: NormalizeOptions,
): Promise<string> {
  if (!(duration > 0)) {
    throw new Error(`[media] trimNormalize: duration must be > 0, got ${String(duration)}`);
  }
  const fps = opts?.fps ?? DEFAULT_FPS;
  const width = opts?.width ?? DEFAULT_WIDTH;
  const height = opts?.height ?? DEFAULT_HEIGHT;
  const src = path.resolve(srcPath);
  const dest = path.resolve(destPath);
  await ensureParentDir(dest);

  const srcDuration = await probeDuration(src);
  const available = srcDuration - inPoint;

  const filters = [`scale=${String(width)}:${String(height)}`, 'setsar=1', `fps=${String(fps)}`];
  if (available + DURATION_EPSILON < duration) {
    const shortfall = duration - Math.max(available, 0);
    console.warn(
      `[media] WARN: source ${srcPath} has ${sec(Math.max(available, 0))}s available from inPoint ` +
        `${sec(inPoint)} but ${sec(duration)}s is required; extending ${sec(shortfall)}s ` +
        `with tpad=stop_mode=clone (hold last frame).`,
    );
    filters.push(`tpad=stop_mode=clone:stop_duration=${sec(shortfall + TPAD_SAFETY_SECONDS)}`);
  }

  await runFfmpeg([
    '-ss',
    sec(inPoint),
    '-i',
    src,
    '-t',
    sec(duration),
    '-vf',
    filters.join(','),
    '-c:v',
    'h264_nvenc',
    '-preset',
    NVENC_PRESET,
    '-b:v',
    VIDEO_BITRATE,
    '-an',
    dest,
  ]);
  return dest;
}

// ---------------------------------------------------------------------------
// concatClips — concat demuxer, stream copy
// ---------------------------------------------------------------------------

/** Escape a path for an ffmpeg concat list entry (single-quoted). */
function concatListEntry(clipPath: string): string {
  const posix = path.resolve(clipPath).split(path.sep).join('/');
  return `file '${posix.replaceAll("'", "'\\''")}'`;
}

/**
 * Concatenate pre-normalized clips (same codec/params) with the concat
 * demuxer and -c copy. Writes a temporary concat list file (forward-slash
 * paths) next to destPath. Returns destPath.
 */
export async function concatClips(clipPaths: string[], destPath: string): Promise<string> {
  if (clipPaths.length === 0) {
    throw new Error('[media] concatClips: clipPaths is empty');
  }
  const dest = path.resolve(destPath);
  await ensureParentDir(dest);
  const listPath = `${dest}.concat.txt`;
  const listBody = clipPaths.map(concatListEntry).join('\n') + '\n';
  await fsp.writeFile(listPath, listBody, 'utf8');
  try {
    await runFfmpeg(['-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', dest]);
  } finally {
    await fsp.unlink(listPath).catch(() => undefined);
  }
  return dest;
}

// ---------------------------------------------------------------------------
// muxVoiceover — VO WAV over concatenated video
// ---------------------------------------------------------------------------

/**
 * Mux the voiceover WAV over the video: -map 0:v -map 1:a -c:v copy
 * -c:a aac -b:a 192k -shortest. Returns destPath.
 */
export async function muxVoiceover(
  videoPath: string,
  voPath: string,
  destPath: string,
): Promise<string> {
  const dest = path.resolve(destPath);
  await ensureParentDir(dest);
  await runFfmpeg([
    '-i',
    path.resolve(videoPath),
    '-i',
    path.resolve(voPath),
    '-map',
    '0:v',
    '-map',
    '1:a',
    '-c:v',
    'copy',
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    '-shortest',
    dest,
  ]);
  return dest;
}

// ---------------------------------------------------------------------------
// exportTimeline — EDL -> parallel trims -> concat -> VO mux -> final MP4
// ---------------------------------------------------------------------------

/** Simple bounded-concurrency map preserving input order in the result. */
async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= items.length) return;
      results[i] = await fn(items[i] as T, i);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Full export per the timeline rule:
 *   1. Sort EDL entries by timelineStart (timeline order).
 *   2. trimNormalize each entry's clip to its exact fractional duration
 *      ([inPoint, inPoint + duration)), in parallel (opts.concurrency,
 *      default 2 — NVENC session limit safety).
 *   3. concatClips the normalized trims (-c copy).
 *   4. muxVoiceover the VO WAV over the result.
 * Trims are written as trim_<n>.mp4 in outPath's directory (the export
 * working dir per the project artifact layout). Returns the final MP4 path.
 */
export async function exportTimeline(
  entries: EDLEntry[],
  voPath: string,
  outPath: string,
  opts?: { concurrency?: number },
): Promise<string> {
  if (entries.length === 0) {
    throw new Error('[media] exportTimeline: EDL is empty');
  }
  const concurrency = opts?.concurrency ?? 2;
  const finalPath = path.resolve(outPath);
  const workDir = path.dirname(finalPath);
  await fsp.mkdir(workDir, { recursive: true });

  const ordered = [...entries].sort((a, b) => a.timelineStart - b.timelineStart);

  // Sanity: the timeline rule guarantees contiguous coverage. Warn on drift.
  for (let i = 1; i < ordered.length; i++) {
    const prev = ordered[i - 1] as EDLEntry;
    const cur = ordered[i] as EDLEntry;
    const expectedStart = prev.timelineStart + prev.duration;
    const drift = cur.timelineStart - expectedStart;
    if (Math.abs(drift) > 0.05) {
      console.warn(
        `[media] WARN: EDL entries ${String(prev.lineIndex)} -> ${String(cur.lineIndex)} are not ` +
          `contiguous (${drift > 0 ? 'gap' : 'overlap'} of ${sec(Math.abs(drift))}s); ` +
          `export concatenates back-to-back and may drift from the VO here.`,
      );
    }
  }

  const trimPaths = await mapLimit(ordered, concurrency, async (entry, i) => {
    const trimPath = path.join(workDir, `trim_${String(i)}.mp4`);
    return trimNormalize(entry.clipPath, trimPath, entry.inPoint, entry.duration);
  });

  const concatPath = path.join(workDir, '_concat_video.mp4');
  await concatClips(trimPaths, concatPath);
  await muxVoiceover(concatPath, path.resolve(voPath), finalPath);
  await fsp.unlink(concatPath).catch(() => undefined);
  return finalPath;
}
