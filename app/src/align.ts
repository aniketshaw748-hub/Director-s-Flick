/**
 * align.ts — script/voiceover alignment, timeline rule, shot planning.
 *
 * Pipeline: alignScript() hardens + spawns scripts/align_cli.py (stable-ts
 * forced alignment of the KNOWN script text) → AlignedLine[] with word
 * timestamps → computeTimeline() applies the TIMELINE RULE → planShots()
 * turns timings into PENDING Shot rows, splitting any line whose
 * targetDuration exceeds MAX_CLIP_SECONDS into sub-shots at word boundaries.
 *
 * TIMELINE RULE (verbatim, binding):
 *   each script line's clip must cover [line.start, nextLine.start) — i.e.
 *   target_duration = next.start - this.start (last line: duration + 0.5s tail).
 *   Generated video duration = clamp(ceil(target_duration), 3, 15) seconds
 *   (kling3_0 range); exact trim to target_duration happens at export.
 *   Lines longer than 15s must be split into sub-shots at word boundaries.
 *
 * INPUT HARDENING (T-78): this is the one surface that sees the product
 * owner's own files, so alignScript() pre-flights both inputs BEFORE ever
 * spawning the (slow, model-loading) python process — missing/empty/
 * unsupported-format audio and empty scripts fail fast with a one-line
 * message, never a python traceback. Non-wav audio is transcoded to a
 * normalized 16kHz mono wav via ffmpeg; scripts with "smart" unicode
 * punctuation are rewritten to a normalized temp file — align_cli.py itself
 * is untouched. The parsed alignment result is also sanity-gated (0-word
 * lines, inverted/out-of-order timestamps) so corrupt aligner output can't
 * silently propagate into the timeline rule.
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AlignedLine, LineTiming, Shot, WordTiming } from './types.js';
import { LAST_LINE_TAIL_SECONDS, MAX_CLIP_SECONDS } from './types.js';
import { probeDuration } from './media.js';

/** app/scripts/align_cli.py (this file lives in app/src/). */
const ALIGN_CLI = path.resolve(import.meta.dirname, '..', 'scripts', 'align_cli.py');

const EPS = 1e-9;

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

// ---------------------------------------------------------------------------
// Audio input hardening
// ---------------------------------------------------------------------------

const ALLOWED_AUDIO_EXTENSIONS = new Set(['.wav', '.mp3', '.m4a', '.flac', '.ogg']);

/** Sync, cheap checks that reject an unusable audio file before any process spawn. */
function checkAudioFileSane(audioPath: string): void {
  if (!fs.existsSync(audioPath)) {
    throw new Error(`alignScript: audio file not found: ${audioPath}`);
  }
  const ext = path.extname(audioPath).toLowerCase();
  if (!ALLOWED_AUDIO_EXTENSIONS.has(ext)) {
    throw new Error(
      `alignScript: unsupported audio format "${ext || '(none)'}" for ${audioPath} — accepted formats: ${[...ALLOWED_AUDIO_EXTENSIONS].join(', ')}`,
    );
  }
  if (fs.statSync(audioPath).size === 0) {
    throw new Error(`alignScript: audio file is empty (0 bytes): ${audioPath}`);
  }
}

/** ffprobe-backed duration check — catches corrupt/undecodable audio before python does. */
async function probeAudioDurationSeconds(audioPath: string): Promise<number> {
  try {
    return await probeDuration(audioPath);
  } catch (err) {
    throw new Error(
      `alignScript: audio file could not be read (corrupt or unsupported): ${audioPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Transcode `inputPath` to a 16kHz mono wav at `outputPath` via ffmpeg. */
function transcodeToWav(inputPath: string, outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', inputPath, '-ar', '16000', '-ac', '1', outputPath];
    const child = spawn('ffmpeg', args, { windowsHide: true });
    let stderrBuf = '';
    child.stderr.setEncoding('utf-8');
    child.stderr.on('data', (chunk: string) => {
      stderrBuf += chunk;
    });
    child.on('error', (err) => {
      reject(new Error(`alignScript: failed to spawn ffmpeg for audio transcode: ${err.message}`));
    });
    child.on('close', (code) => {
      if (code !== 0) {
        const detail = stderrBuf.trim().slice(-1000);
        reject(new Error(`alignScript: ffmpeg transcode failed for ${inputPath}${detail ? `: ${detail}` : ''}`));
        return;
      }
      let size = 0;
      try {
        size = fs.statSync(outputPath).size;
      } catch {
        // size stays 0 -> handled by the check below
      }
      if (size === 0) {
        reject(new Error(`alignScript: ffmpeg produced no output while transcoding ${inputPath}`));
        return;
      }
      resolve();
    });
  });
}

// ---------------------------------------------------------------------------
// Script input hardening
// ---------------------------------------------------------------------------

/** Unicode "smart" punctuation -> plain ASCII equivalents, applied before python sees the script. */
const SMART_PUNCTUATION_MAP: Array<[RegExp, string]> = [
  [/[‘’‚‛]/g, "'"],
  [/[“”„‟]/g, '"'],
  [/[–—―]/g, '-'],
  [/…/g, '...'],
  [/[  -   　]/g, ' '],
];

/** Non-empty, trimmed lines only — mirrors align_cli.py's own `[l.strip() for l in f if l.strip()]`. */
function trimmedNonEmptyLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/**
 * Decorative separator lines ("________", "-----", "====", "***") carry no
 * letters or digits — they are script FORMATTING, not narration, and would
 * otherwise become 0-second garbage shots (observed live on the owner's
 * script, 2026-07-04).
 */
function isDecorativeLine(line: string): boolean {
  return !/[\p{L}\p{N}]/u.test(line);
}

/** Normalize unicode punctuation/whitespace and drop empty lines. Empty in -> empty out (caller checks). */
export function normalizeScriptText(raw: string): string {
  let text = raw.normalize('NFKC');
  for (const [pattern, replacement] of SMART_PUNCTUATION_MAP) {
    text = text.replace(pattern, replacement);
  }
  return trimmedNonEmptyLines(text)
    .filter((l) => !isDecorativeLine(l))
    .join('\n');
}

function readScriptFileSane(scriptPath: string): string {
  try {
    return fs.readFileSync(scriptPath, 'utf-8');
  } catch (err) {
    throw new Error(`alignScript: script file not found or unreadable: ${scriptPath}: ${String(err)}`);
  }
}

function countWords(normalizedText: string): number {
  return normalizedText.length === 0 ? 0 : normalizedText.split(/\s+/).filter(Boolean).length;
}

const AVG_WORDS_PER_SECOND = 2.5; // ~150 wpm average narration pace
const MISMATCH_RATIO_LOW = 0.25;
const MISMATCH_RATIO_HIGH = 4;

/**
 * Gross script-vs-audio length sanity check (warning, never fatal — a real
 * pilot script may legitimately read slow/fast). Returns null when within
 * [0.25x, 4x] of the word-count-implied duration, else an actionable
 * warning string carrying both measured numbers.
 */
export function checkScriptAudioLengthMatch(wordCount: number, audioDurationSeconds: number): string | null {
  if (wordCount <= 0 || !Number.isFinite(audioDurationSeconds) || audioDurationSeconds <= 0) return null;
  const expectedSeconds = wordCount / AVG_WORDS_PER_SECOND;
  const ratio = audioDurationSeconds / expectedSeconds;
  if (ratio >= MISMATCH_RATIO_LOW && ratio <= MISMATCH_RATIO_HIGH) return null;
  return (
    `alignScript: warning - script has ${wordCount} words (~${expectedSeconds.toFixed(1)}s expected at avg speaking pace) ` +
    `but audio is ${audioDurationSeconds.toFixed(1)}s long — verify these files match`
  );
}

// ---------------------------------------------------------------------------
// Alignment result sanity gate
// ---------------------------------------------------------------------------

/** 0-word lines and inverted/out-of-order timestamps become actionable errors, not silent bad data. */
function validateAlignedLines(lines: AlignedLine[], sourcePath: string): void {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.words.length === 0) {
      throw new Error(`alignScript: line ${line.index} ("${line.text}") has zero aligned words: ${sourcePath}`);
    }
    if (line.end < line.start - EPS) {
      throw new Error(
        `alignScript: line ${line.index} has inverted timestamps (start ${line.start}s > end ${line.end}s): ${sourcePath}`,
      );
    }
    for (let j = 0; j < line.words.length; j++) {
      const word = line.words[j]!;
      if (word.end < word.start - EPS) {
        throw new Error(
          `alignScript: line ${line.index} word ${j} ("${word.word}") has inverted timestamps (start ${word.start}s > end ${word.end}s): ${sourcePath}`,
        );
      }
      if (j > 0 && word.start < line.words[j - 1]!.start - EPS) {
        throw new Error(
          `alignScript: line ${line.index} word ${j} ("${word.word}") starts before the previous word in the same line: ${sourcePath}`,
        );
      }
    }
    if (i > 0) {
      const prev = lines[i - 1]!;
      if (line.start < prev.start - EPS) {
        throw new Error(
          `alignScript: line ${prev.index} starts at ${prev.start}s but line ${line.index} starts at ${line.start}s — timestamps are out of order: ${sourcePath}`,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// alignScript — harden inputs, spawn the python aligner, parse its output
// ---------------------------------------------------------------------------

/**
 * Every error alignScript() produces (input validation, ffprobe/ffmpeg/python
 * spawn failures, result sanity-gate violations) is already a deliberate,
 * actionable one-liner — see T-78/T-81. Callers (cli.ts) use this class to
 * print that message alone, without a JS stack trace burying it (T-83).
 */
export class AlignInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AlignInputError';
  }
}

/**
 * Validate + normalize script and audio inputs, spawn
 * `python scripts/align_cli.py --audio <wav> --script <txt> --out <json>`
 * (array args, PYTHONIOENCODING=utf-8), stream its ASCII progress to stdout,
 * then parse + sanity-check the written JSON into AlignedLine[].
 *
 * Thin wrapper: every error alignScriptInner() throws already carries the
 * `alignScript: ...` prefix (all ~22 throw/reject sites in this file use it),
 * so any such error is by construction one of our own crafted one-liners —
 * re-thrown as AlignInputError so callers can print message-only. Anything
 * else (a genuine bug) passes through unchanged, stack intact.
 */
export async function alignScript(
  scriptPath: string,
  audioPath: string,
  outJsonPath: string,
  opts?: AlignOptions,
): Promise<AlignedLine[]> {
  return (await alignScriptEx(scriptPath, audioPath, outJsonPath, opts)).lines;
}

export interface AlignOptions {
  onProgress?: (line: string) => void;
  /**
   * Shot-boundary source (owner-directed, 2026-07-04). 'llm': divide the
   * narration into one-visual-idea segments via segment-llm.ts BEFORE the
   * aligner (the owner's newlines and all duration/pause heuristics are
   * ignored — meaning decides the cuts, alignment only times them). Falls
   * back to 'heuristic' (script lines + T-88 splitter) with a warning.
   */
  segmentation?: 'llm' | 'heuristic';
  /** Anthropic model for segmentation:'llm' (default claude-opus-4-8). */
  llmModel?: string;
  /** Test injection: mock Anthropic client for segmentation (hermetic tests). */
  llmClient?: import('./segment-llm.js').SegmentLlmClient | null;
}

export interface AlignResultEx {
  lines: AlignedLine[];
  /** The segmentation source actually used ('llm' may fall back to 'heuristic'). */
  segmentationUsed: 'llm' | 'heuristic';
  /** Present when 'llm' was requested but the heuristic fallback was used. */
  segmentationFallbackReason?: string;
}

/** alignScript + which segmentation source actually produced the line boundaries. */
export async function alignScriptEx(
  scriptPath: string,
  audioPath: string,
  outJsonPath: string,
  opts?: AlignOptions,
): Promise<AlignResultEx> {
  try {
    return await alignScriptInner(scriptPath, audioPath, outJsonPath, opts);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('alignScript:')) {
      throw new AlignInputError(err.message);
    }
    throw err;
  }
}

async function alignScriptInner(
  scriptPath: string,
  audioPath: string,
  outJsonPath: string,
  opts?: AlignOptions,
): Promise<AlignResultEx> {
  const rawScript = readScriptFileSane(scriptPath);
  const normalizedScript = normalizeScriptText(rawScript);
  if (normalizedScript.length === 0) {
    throw new Error(`alignScript: script has no non-empty lines: ${scriptPath}`);
  }
  const wordCount = countWords(normalizedScript);

  checkAudioFileSane(audioPath);
  const audioDurationSeconds = await probeAudioDurationSeconds(audioPath);

  const mismatchWarning = checkScriptAudioLengthMatch(wordCount, audioDurationSeconds);
  if (mismatchWarning) {
    if (opts?.onProgress) opts.onProgress(mismatchWarning);
    else console.warn(mismatchWarning);
  }

  const workDir = path.dirname(path.resolve(outJsonPath));
  try {
    fs.mkdirSync(workDir, { recursive: true });
  } catch (err) {
    throw new Error(`alignScript: cannot create output dir for ${outJsonPath}: ${String(err)}`);
  }

  // ---- Shot-boundary source (owner-directed, 2026-07-04) -----------------
  // segmentation:'llm' — the LLM cuts the FULL narration (newlines flattened;
  // no gap/duration heuristics) into one-visual-idea segments, which become
  // the aligner's lines. Any failure falls back to the script's own lines
  // (heuristic path) with a warning — the pipeline never stalls.
  let segmentationUsed: 'llm' | 'heuristic' = 'heuristic';
  let segmentationFallbackReason: string | undefined;
  let scriptTextForAligner = normalizedScript;
  if (opts?.segmentation === 'llm') {
    const flatNarration = normalizedScript.split('\n').join(' ').replace(/\s+/g, ' ').trim();
    try {
      const { llmSegmentScript } = await import('./segment-llm.js');
      opts.onProgress?.(
        `segmentation: llm — dividing the narration into one-visual-idea shots (${opts.llmModel ?? 'sonnet'}; ~30-90s for long scripts)…`,
      );
      const segments = await llmSegmentScript(flatNarration, {
        model: opts.llmModel,
        client: opts.llmClient,
        warn: opts.onProgress,
      });
      scriptTextForAligner = segments.join('\n');
      segmentationUsed = 'llm';
      opts.onProgress?.(`segmentation: llm (${segments.length} one-visual-idea segments)`);
    } catch (err) {
      segmentationFallbackReason = err instanceof Error ? err.message : String(err);
      opts.onProgress?.(
        `segmentation: heuristic FALLBACK — ${segmentationFallbackReason} (set ANTHROPIC_API_KEY and re-run alignment for LLM segmentation)`,
      );
    }
  }

  let scriptForPython = scriptPath;
  let tempScriptPath: string | null = null;
  // Write a temp script only when the aligner's line division differs from the
  // file's own trimmed lines (always true for LLM segments, and exactly the
  // original T-78 normalization condition on the heuristic path).
  if (trimmedNonEmptyLines(rawScript).join('\n') !== scriptTextForAligner) {
    tempScriptPath = path.join(workDir, `align-script.normalized.${randomUUID()}.txt`);
    fs.writeFileSync(tempScriptPath, scriptTextForAligner, 'utf-8');
    scriptForPython = tempScriptPath;
  }

  let audioForPython = audioPath;
  let tempAudioPath: string | null = null;
  if (path.extname(audioPath).toLowerCase() !== '.wav') {
    tempAudioPath = path.join(workDir, `align-audio.transcoded.${randomUUID()}.wav`);
    await transcodeToWav(audioPath, tempAudioPath);
    audioForPython = tempAudioPath;
  }

  try {
    const aligned = await spawnAligner(scriptForPython, audioForPython, outJsonPath, opts);
    // UNSPOKEN-LINE FILTER (owner's script, 2026-07-04): section headers and
    // other written-but-never-narrated lines align to ~0s — as shots they
    // would each burn a generation on content the video never needs. Any
    // line under 0.3s of aligned audio is dropped with a visible note.
    const MIN_SPOKEN_SECONDS = 0.3;
    const lines = aligned.filter((l) => l.end - l.start >= MIN_SPOKEN_SECONDS);
    for (const dropped of aligned.filter((l) => l.end - l.start < MIN_SPOKEN_SECONDS)) {
      opts?.onProgress?.(
        `dropped unspoken line (${(dropped.end - dropped.start).toFixed(2)}s): "${dropped.text.slice(0, 60)}"`,
      );
    }
    if (lines.length === 0) {
      throw new Error('alignScript: every line aligned to near-zero duration — do the script and voiceover match?');
    }
    return { lines, segmentationUsed, segmentationFallbackReason };
  } finally {
    if (tempScriptPath) {
      try {
        fs.unlinkSync(tempScriptPath);
      } catch {
        // best-effort cleanup only
      }
    }
    if (tempAudioPath) {
      try {
        fs.unlinkSync(tempAudioPath);
      } catch {
        // best-effort cleanup only
      }
    }
  }
}

function spawnAligner(
  scriptPath: string,
  audioPath: string,
  outJsonPath: string,
  opts?: { onProgress?: (line: string) => void },
): Promise<AlignedLine[]> {
  return new Promise((resolve, reject) => {
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
      if (opts?.onProgress) {
        for (const line of chunk.split(/\r?\n/)) {
          const trimmed = line.trim();
          if (trimmed) opts.onProgress(trimmed);
        }
      }
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

/** Read + validate align_cli.py output ({ lines: AlignedLine[] }), then sanity-gate the result. */
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
  const result = lines.map((entry, i): AlignedLine => {
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
  validateAlignedLines(result, outJsonPath);
  return result;
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
// Phrase-level segmentation (T-88, owner-directed) — sentence split, then
// duration-capped phrase split, before the MAX_CLIP_SECONDS safety net below
// ---------------------------------------------------------------------------

/** PipelineConfig.maxShotSeconds documented default (types.ts, T-88 contract). */
const DEFAULT_MAX_SHOT_SECONDS = 8;
/** Never produce a sub-shot shorter than this — a boundary that would is rejected, not split. */
const MIN_SUB_SHOT_SECONDS = 1.2;
const SENTENCE_END_RE = /[.!?…]+$/;
/** Hinglish-aware phrase conjunctions: starting one of these words is a valid split point. */
const HINGLISH_CONJUNCTIONS = new Set(['par', 'aur', 'toh', 'lekin']);

function bareWord(word: string): string {
  return word.replace(/^[^a-zA-Z]+|[^a-zA-Z]+$/g, '');
}

function wordIsSentenceEnd(word: string): boolean {
  return SENTENCE_END_RE.test(word.replace(/["')\]]+$/, ''));
}

function wordIsConjunction(word: string): boolean {
  return HINGLISH_CONJUNCTIONS.has(bareWord(word).toLowerCase());
}

function wordEndsWithComma(word: string): boolean {
  return /,$/.test(word);
}

/** Sort + greedily drop any boundary that would leave a piece under MIN_SUB_SHOT_SECONDS. */
function filterBoundariesForMinDuration(boundaries: number[], spanEnd: number): number[] {
  const sorted = [...new Set(boundaries)].sort((a, b) => a - b);
  const kept: number[] = [sorted[0]!];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]! - kept[kept.length - 1]! >= MIN_SUB_SHOT_SECONDS - EPS) {
      kept.push(sorted[i]!);
    }
    // else: drop it — equivalent to merging this would-be runt into the previous piece.
  }
  while (kept.length > 1 && spanEnd - kept[kept.length - 1]! < MIN_SUB_SHOT_SECONDS - EPS) {
    kept.pop(); // final piece would be a runt — merge it back into the previous one.
  }
  return kept;
}

/**
 * Split one line's full span at sentence-ending punctuation (unconditional —
 * every sentence becomes its own piece regardless of duration, per the
 * owner's stated rule order), then recursively phrase-split any resulting
 * piece still longer than `maxShotSeconds`. Reuses buildSlices() for the
 * actual piece materialization so contiguity/pauseAfter/text conventions
 * exactly match the existing MAX_CLIP_SECONDS splitter below.
 */
function segmentLineByPhrase(line: LineTiming, words: WordTiming[], maxShotSeconds: number): LineTiming[] {
  const spanEnd = round3(line.start + line.targetDuration);
  const sorted = [...words].sort((a, b) => a.start - b.start);
  if (sorted.length === 0) return [line];

  const sentenceBounds: number[] = [line.start];
  for (let i = 0; i < sorted.length - 1; i++) {
    if (wordIsSentenceEnd(sorted[i]!.word)) {
      sentenceBounds.push(sorted[i + 1]!.start);
    }
  }
  const sentencePieces = buildSlices(line, filterBoundariesForMinDuration(sentenceBounds, spanEnd), spanEnd, sorted);

  const result: LineTiming[] = [];
  for (const piece of sentencePieces) {
    result.push(...phraseSplitRecursive(piece, sorted, maxShotSeconds));
  }
  return result;
}

/** Recursively split `piece` at the phrase boundary nearest its midpoint until it fits maxShotSeconds. */
function phraseSplitRecursive(piece: LineTiming, words: WordTiming[], maxShotSeconds: number): LineTiming[] {
  if (piece.targetDuration <= maxShotSeconds + EPS) return [piece];

  const pieceEnd = round3(piece.start + piece.targetDuration);
  const pieceWords = words
    .filter((w) => w.start >= piece.start - EPS && w.start < pieceEnd - EPS)
    .sort((a, b) => a.start - b.start);
  if (pieceWords.length < 2) return [piece]; // nothing left to split on

  const mid = piece.start + piece.targetDuration / 2;
  const nearestToMid = (candidates: number[]): number =>
    candidates.reduce((best, c) => (Math.abs(c - mid) < Math.abs(best - mid) ? c : best));
  const validCandidate = (boundary: number): boolean =>
    boundary - piece.start >= MIN_SUB_SHOT_SECONDS - EPS && pieceEnd - boundary >= MIN_SUB_SHOT_SECONDS - EPS;

  const phraseCandidates: number[] = [];
  for (let i = 1; i < pieceWords.length; i++) {
    const w = pieceWords[i]!;
    const prev = pieceWords[i - 1]!;
    if ((wordIsConjunction(w.word) || wordEndsWithComma(prev.word)) && validCandidate(w.start)) {
      phraseCandidates.push(w.start);
    }
  }

  let boundary: number | null = null;
  if (phraseCandidates.length > 0) {
    boundary = nearestToMid(phraseCandidates);
  } else {
    const wordCandidates = pieceWords.slice(1).map((w) => w.start).filter(validCandidate);
    if (wordCandidates.length > 0) boundary = nearestToMid(wordCandidates);
  }

  if (boundary === null) return [piece]; // no split point respects the 1.2s floor — accept as-is

  const [left, right] = buildSlices(piece, [piece.start, boundary], pieceEnd, words);
  return [...phraseSplitRecursive(left!, words, maxShotSeconds), ...phraseSplitRecursive(right!, words, maxShotSeconds)];
}

// ---------------------------------------------------------------------------
// planShots — 1 line -> 1+ shots via phrase segmentation, then long-piece
// safety net at word boundaries
// ---------------------------------------------------------------------------

/**
 * Turn the timeline into PENDING shots ready for ProjectDb.insertShots().
 * Each line is first phrase-segmented (sentence split, then duration-capped
 * phrase split at `maxShotSeconds` — default 8, see DEFAULT_MAX_SHOT_SECONDS)
 * via segmentLineByPhrase(); any resulting piece whose targetDuration STILL
 * exceeds the hard MAX_CLIP_SECONDS generation ceiling (15s) is further split
 * at plain word boundaries by the pre-existing safety net.
 */
export function planShots(
  projectId: string,
  timeline: LineTiming[],
  aligned: AlignedLine[],
  maxShotSeconds?: number,
): Shot[] {
  const effectiveMaxShotSeconds = maxShotSeconds ?? DEFAULT_MAX_SHOT_SECONDS;
  const wordsByIndex = new Map<number, WordTiming[]>(aligned.map((l) => [l.index, l.words]));
  const nowIso = new Date().toISOString();
  const shots: Shot[] = [];
  for (const line of timeline) {
    const words = wordsByIndex.get(line.index) ?? [];
    const phrasePieces = segmentLineByPhrase(line, words, effectiveMaxShotSeconds);
    let subIndex = 0;
    for (const piece of phrasePieces) {
      const slices =
        piece.targetDuration > MAX_CLIP_SECONDS ? splitLineAtWordBoundaries(piece, words) : [piece];
      for (const slice of slices) {
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
        subIndex++;
      }
    }
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
