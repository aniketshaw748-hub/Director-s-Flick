/**
 * align.ts — script/voiceover alignment, timeline rule, shot planning.
 *
 * Pipeline: alignScript() spawns scripts/align_cli.py (stable-ts forced
 * alignment of the KNOWN script text) → AlignedLine[] with word timestamps →
 * computeTimeline() applies the TIMELINE RULE → planShots() turns timings
 * into PENDING Shot rows, splitting any line whose targetDuration exceeds
 * MAX_CLIP_SECONDS into sub-shots at word boundaries.
 *
 * TIMELINE RULE (verbatim, binding):
 *   each script line's clip must cover [line.start, nextLine.start) — i.e.
 *   target_duration = next.start - this.start (last line: duration + 0.5s tail).
 *   Generated video duration = clamp(ceil(target_duration), 3, 15) seconds
 *   (kling3_0 range); exact trim to target_duration happens at export.
 *   Lines longer than 15s must be split into sub-shots at word boundaries.
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AlignedLine, LineTiming, Shot, WordTiming } from './types.js';
import { LAST_LINE_TAIL_SECONDS, MAX_CLIP_SECONDS } from './types.js';

/** app/scripts/align_cli.py (this file lives in app/src/). */
const ALIGN_CLI = path.resolve(import.meta.dirname, '..', 'scripts', 'align_cli.py');

const EPS = 1e-9;

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

// ---------------------------------------------------------------------------
// alignScript — spawn the python aligner, parse its JSON output
// ---------------------------------------------------------------------------

/**
 * Spawn `python scripts/align_cli.py --audio <wav> --script <txt> --out <json>`
 * (array args, PYTHONIOENCODING=utf-8), stream its ASCII progress to stdout,
 * then parse the written JSON into AlignedLine[].
 */
export function alignScript(
  scriptPath: string,
  audioPath: string,
  outJsonPath: string,
): Promise<AlignedLine[]> {
  return new Promise((resolve, reject) => {
    try {
      fs.mkdirSync(path.dirname(path.resolve(outJsonPath)), { recursive: true });
    } catch (err) {
      reject(new Error(`alignScript: cannot create output dir for ${outJsonPath}: ${String(err)}`));
      return;
    }

    const args = [ALIGN_CLI, '--audio', audioPath, '--script', scriptPath, '--out', outJsonPath];
    const child = spawn('python', args, {
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      windowsHide: true,
    });

    let stderrBuf = '';
    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');
    child.stdout.on('data', (chunk: string) => {
      process.stdout.write(chunk);
    });
    child.stderr.on('data', (chunk: string) => {
      stderrBuf += chunk;
    });
    child.on('error', (err) => {
      reject(new Error(`alignScript: failed to spawn python: ${err.message}`));
    });
    child.on('close', (code) => {
      if (code !== 0) {
        const detail = stderrBuf.trim().slice(-2000);
        reject(new Error(`alignScript: align_cli.py exited with code ${code}${detail ? `: ${detail}` : ''}`));
        return;
      }
      try {
        resolve(parseAlignmentJson(outJsonPath));
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  });
}

/** Read + validate align_cli.py output ({ lines: AlignedLine[] }). */
function parseAlignmentJson(outJsonPath: string): AlignedLine[] {
  let raw: string;
  try {
    raw = fs.readFileSync(outJsonPath, 'utf-8');
  } catch (err) {
    throw new Error(`alignScript: output file missing at ${outJsonPath}: ${String(err)}`);
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`alignScript: output is not valid JSON: ${outJsonPath}`);
  }
  const lines = (data as { lines?: unknown }).lines;
  if (!Array.isArray(lines) || lines.length === 0) {
    throw new Error(`alignScript: output has no "lines" array: ${outJsonPath}`);
  }
  return lines.map((entry, i): AlignedLine => {
    const e = entry as Partial<AlignedLine> & { words?: unknown };
    if (
      typeof e.index !== 'number' ||
      typeof e.text !== 'string' ||
      typeof e.start !== 'number' ||
      typeof e.end !== 'number' ||
      !Array.isArray(e.words)
    ) {
      throw new Error(`alignScript: line ${i} malformed in ${outJsonPath}`);
    }
    const words: WordTiming[] = e.words.map((w, j): WordTiming => {
      const ww = w as Partial<WordTiming>;
      if (typeof ww.word !== 'string' || typeof ww.start !== 'number' || typeof ww.end !== 'number') {
        throw new Error(`alignScript: line ${i} word ${j} malformed in ${outJsonPath}`);
      }
      return { word: ww.word, start: ww.start, end: ww.end };
    });
    return { index: e.index, text: e.text, start: e.start, end: e.end, words };
  });
}

// ---------------------------------------------------------------------------
// computeTimeline — apply the TIMELINE RULE per line
// ---------------------------------------------------------------------------

/**
 * Apply the timeline rule to raw aligned lines:
 *   duration       = end - start
 *   pauseAfter     = next.start - this.end            (last line: 0)
 *   targetDuration = next.start - this.start          (last line: duration + LAST_LINE_TAIL_SECONDS)
 */
export function computeTimeline(lines: AlignedLine[]): LineTiming[] {
  const sorted = [...lines].sort((a, b) => a.index - b.index);
  return sorted.map((line, i): LineTiming => {
    const next = sorted[i + 1];
    const duration = round3(line.end - line.start);
    const pauseAfter = next ? round3(next.start - line.end) : 0;
    const targetDuration = next
      ? round3(next.start - line.start)
      : round3(duration + LAST_LINE_TAIL_SECONDS);
    return {
      index: line.index,
      text: line.text,
      start: line.start,
      end: line.end,
      duration,
      pauseAfter,
      targetDuration,
    };
  });
}

// ---------------------------------------------------------------------------
// planShots — 1 line -> 1 shot; long lines -> sub-shots at word boundaries
// ---------------------------------------------------------------------------

/**
 * Turn the timeline into PENDING shots ready for ProjectDb.insertShots().
 * Normally 1 line -> 1 shot (subIndex 0). Lines with targetDuration >
 * MAX_CLIP_SECONDS are split into sub-shots at word boundaries (word data
 * from the matching AlignedLine); each sub-shot's LineTiming re-obeys the
 * timeline rule within the line's span [start, start + targetDuration).
 */
export function planShots(projectId: string, timeline: LineTiming[], aligned: AlignedLine[]): Shot[] {
  const wordsByIndex = new Map<number, WordTiming[]>(aligned.map((l) => [l.index, l.words]));
  const nowIso = new Date().toISOString();
  const shots: Shot[] = [];
  for (const line of timeline) {
    const slices =
      line.targetDuration > MAX_CLIP_SECONDS
        ? splitLineAtWordBoundaries(line, wordsByIndex.get(line.index) ?? [])
        : [line];
    slices.forEach((slice, subIndex) => {
      shots.push({
        id: randomUUID(),
        projectId,
        lineIndex: line.index,
        subIndex,
        state: 'PENDING',
        line: slice,
        elementIds: [], // linked later by the prompt stage
        attempts: 0,
        createdAt: nowIso,
        updatedAt: nowIso,
      });
    });
  }
  return shots;
}

/**
 * Split a long line's span [start, start + targetDuration) into contiguous
 * sub-slices, each with targetDuration <= MAX_CLIP_SECONDS, cutting at word
 * boundaries (a sub-shot starts exactly at one of the line's word starts —
 * the same convention as line starts themselves).
 *
 * Strategy: k = ceil(span / MAX) balanced pieces; snap each ideal boundary to
 * the nearest usable word start; if some piece still exceeds MAX (sparse or
 * clustered words), retry with more pieces. Fallback for irreducible cases
 * (e.g. a silent tail longer than MAX with no words to cut at): equal
 * raw-time boundaries.
 */
function splitLineAtWordBoundaries(line: LineTiming, words: WordTiming[]): LineTiming[] {
  const spanEnd = round3(line.start + line.targetDuration);
  const sorted = [...words].sort((a, b) => a.start - b.start);
  const minPieces = Math.ceil(line.targetDuration / MAX_CLIP_SECONDS);

  for (let k = minPieces; k <= Math.max(minPieces, sorted.length); k++) {
    const bounds = snapBoundaries(line.start, spanEnd, k, sorted);
    if (bounds && piecesFit(bounds, spanEnd)) {
      return buildSlices(line, bounds, spanEnd, sorted);
    }
  }

  // Irreducible at word boundaries — split at equal raw times instead.
  const k = minPieces;
  const bounds: number[] = [line.start];
  for (let j = 1; j < k; j++) {
    bounds.push(round3(line.start + (j * line.targetDuration) / k));
  }
  return buildSlices(line, bounds, spanEnd, sorted);
}

/**
 * Pick k-1 interior boundaries, each snapped to the word start nearest the
 * ideal balanced position, strictly increasing. Returns [start, b1..bk-1]
 * or null when there are not enough distinct word starts inside the span.
 */
function snapBoundaries(
  start: number,
  spanEnd: number,
  k: number,
  words: WordTiming[],
): number[] | null {
  const span = spanEnd - start;
  const candidates = [...new Set(words.map((w) => w.start).filter((s) => s > start + EPS && s < spanEnd - EPS))].sort(
    (a, b) => a - b,
  );
  if (candidates.length < k - 1) return null;

  const bounds: number[] = [start];
  let lo = 0;
  for (let j = 1; j < k; j++) {
    const ideal = start + (j * span) / k;
    const maxIdx = candidates.length - (k - 1 - j) - 1; // leave room for the rest
    if (lo > maxIdx) return null;
    let best = lo;
    for (let c = lo; c <= maxIdx; c++) {
      if (Math.abs(candidates[c]! - ideal) <= Math.abs(candidates[best]! - ideal)) best = c;
    }
    bounds.push(candidates[best]!);
    lo = best + 1;
  }
  return bounds;
}

/** Every piece (consecutive boundary gap, last piece up to spanEnd) fits MAX. */
function piecesFit(bounds: number[], spanEnd: number): boolean {
  for (let i = 0; i < bounds.length; i++) {
    const next = i + 1 < bounds.length ? bounds[i + 1]! : spanEnd;
    if (next - bounds[i]! > MAX_CLIP_SECONDS + EPS) return false;
  }
  return true;
}

/**
 * Materialize sub-slice LineTimings from boundary start times. Each slice
 * re-obeys the timeline rule within the line's span:
 *   targetDuration = nextSlice.start - this.start (last: spanEnd - start)
 *   end            = last spoken word end in the slice (capped to the slice)
 *   pauseAfter     = nextSlice.start - end (last: the line's own pauseAfter)
 */
function buildSlices(
  line: LineTiming,
  bounds: number[],
  spanEnd: number,
  words: WordTiming[],
): LineTiming[] {
  return bounds.map((sliceStart, i): LineTiming => {
    const isLast = i === bounds.length - 1;
    const nextStart = isLast ? spanEnd : bounds[i + 1]!;
    const sliceWords = words.filter((w) => w.start >= sliceStart - EPS && w.start < nextStart - EPS);
    const lastWord = sliceWords[sliceWords.length - 1];
    const spokenEnd = lastWord ? Math.min(lastWord.end, nextStart) : sliceStart;
    const end = round3(Math.max(sliceStart, spokenEnd));
    const text = sliceWords.length > 0 ? sliceWords.map((w) => w.word).join(' ') : line.text;
    return {
      index: line.index,
      text,
      start: round3(sliceStart),
      end,
      duration: round3(end - sliceStart),
      pauseAfter: isLast ? line.pauseAfter : round3(nextStart - end),
      targetDuration: round3(nextStart - sliceStart),
    };
  });
}
