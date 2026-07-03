/**
 * types.ts — the COMPLETE shared contracts for the video pipeline.
 *
 * Every module (align, providers, prompts, queue, media, cli, db) imports from
 * this file and ONLY from this file for cross-module data shapes. Do not
 * redefine these shapes locally. See ARCHITECTURE.md for module ownership.
 *
 * TIMELINE RULE (critical — binding on align.ts, queue.ts, media.ts):
 * each script line's clip must cover [line.start, nextLine.start) — i.e.
 * target_duration = next.start - this.start (last line: duration + 0.5s tail).
 * Generated video duration = clamp(ceil(target_duration), 3, 15) seconds
 * (kling3_0 range); exact trim to target_duration happens at export.
 * Lines longer than 15s must be split into sub-shots at word boundaries.
 */

// ---------------------------------------------------------------------------
// Timeline constants + pure helpers (the single source of truth for the rule)
// ---------------------------------------------------------------------------

/** kling3_0 accepts integer durations in [3, 15] seconds. */
export const MIN_CLIP_SECONDS = 3;
export const MAX_CLIP_SECONDS = 15;
/** Tail padding appended to the last line's target duration. */
export const LAST_LINE_TAIL_SECONDS = 0.5;

/**
 * Generated video duration for a shot:
 * clamp(ceil(targetDuration), MIN_CLIP_SECONDS, MAX_CLIP_SECONDS), integer seconds.
 */
export function clampVideoSeconds(targetDuration: number): number {
  return Math.min(MAX_CLIP_SECONDS, Math.max(MIN_CLIP_SECONDS, Math.ceil(targetDuration)));
}

// ---------------------------------------------------------------------------
// Alignment / timing
// ---------------------------------------------------------------------------

/** A single word timestamp from the aligner (scripts/align_cli.py output). */
export interface WordTiming {
  word: string;
  /** seconds from start of voiceover */
  start: number;
  end: number;
}

/**
 * Raw per-line alignment as emitted by scripts/align_cli.py, BEFORE the
 * timeline rule is applied. Word timings are retained so lines > 15s can be
 * split into sub-shots at word boundaries.
 */
export interface AlignedLine {
  /** 0-based index of the line in script.txt */
  index: number;
  text: string;
  /** first-word start, seconds */
  start: number;
  /** last-word end, seconds */
  end: number;
  words: WordTiming[];
}

/**
 * Line timing AFTER the timeline rule is applied (align.ts::computeTimeline).
 * Invariants:
 *   duration       = end - start                      (spoken duration)
 *   pauseAfter     = next.start - this.end            (last line: 0)
 *   targetDuration = next.start - this.start          (last line: duration + LAST_LINE_TAIL_SECONDS)
 * The clip covering this line spans [start, start + targetDuration) on the timeline.
 */
export interface LineTiming {
  index: number;
  text: string;
  start: number;
  end: number;
  duration: number;
  pauseAfter: number;
  targetDuration: number;
}

// ---------------------------------------------------------------------------
// Elements (Higgsfield reference elements — characters / locations / props)
// ---------------------------------------------------------------------------

export type ElementCategory = 'character' | 'location' | 'prop';

/**
 * A Higgsfield Element. `id` is the provider-side UUID; it is embedded into
 * prompts as a `<<<element_id>>>` placeholder when
 * PipelineConfig.elementsViaPlaceholders is true.
 */
export interface ElementRef {
  /**
   * Optional thumbnail URL for UI display (autocomplete popover, registry
   * cards). Populated from the element's first media when known. (Contract
   * addition approved by Fable after Opus's T-26 note, 2026-07-03.)
   */
  thumbUrl?: string;
  id: string;
  name: string;
  category: ElementCategory;
}

/** Render the prompt placeholder for an element id: `<<<uuid>>>`. */
export function elementPlaceholder(elementId: string): string {
  return `<<<${elementId}>>>`;
}

// ---------------------------------------------------------------------------
// Shot state machine
// ---------------------------------------------------------------------------

export type ShotState =
  | 'PENDING'
  | 'PROMPTED'
  | 'IMAGE_QUEUED'
  | 'IMAGE_READY'
  | 'IN_REVIEW'
  | 'APPROVED'
  | 'VIDEO_QUEUED'
  | 'VIDEO_READY'
  | 'PLACED'
  | 'FAILED';

/** Legal forward transitions; queue.ts enforces these. */
export const SHOT_TRANSITIONS: Readonly<Record<ShotState, readonly ShotState[]>> = {
  PENDING: ['PROMPTED', 'FAILED'],
  PROMPTED: ['IMAGE_QUEUED', 'FAILED'],
  IMAGE_QUEUED: ['IMAGE_READY', 'FAILED'],
  IMAGE_READY: ['IN_REVIEW', 'FAILED'],
  IN_REVIEW: ['APPROVED', 'PROMPTED', 'IMAGE_QUEUED', 'FAILED'], // left-swipe: Redo -> PROMPTED, Edit -> IMAGE_QUEUED
  APPROVED: ['VIDEO_QUEUED', 'FAILED'],
  VIDEO_QUEUED: ['VIDEO_READY', 'FAILED'],
  VIDEO_READY: ['PLACED', 'VIDEO_QUEUED', 'FAILED'], // timeline redo re-enters VIDEO_QUEUED
  PLACED: ['VIDEO_QUEUED'], // timeline redo from a placed clip
  FAILED: ['PENDING', 'PROMPTED', 'IMAGE_QUEUED', 'VIDEO_QUEUED'], // retry re-entry points
};

/**
 * One shot = one clip on the timeline. Normally 1 line -> 1 shot
 * (subIndex = 0). A line whose targetDuration exceeds MAX_CLIP_SECONDS is
 * split into sub-shots at word boundaries: same lineIndex, subIndex 0..n,
 * each with its own LineTiming slice obeying the timeline rule.
 */
export interface Shot {
  /** app-generated UUID, primary key */
  id: string;
  projectId: string;
  lineIndex: number;
  subIndex: number;
  state: ShotState;
  /** timing slice this shot must cover (already sub-shot-split if needed) */
  line: LineTiming;
  /** elements referenced by this shot's prompts */
  elementIds: string[];
  imagePrompt?: string;
  animationPrompt?: string;
  /** provider job ids (FK jobs.id) */
  imageJobId?: string;
  videoJobId?: string;
  /** local artifact paths once downloaded */
  imagePath?: string;
  videoPath?: string;
  /** generated clip length = clampVideoSeconds(line.targetDuration) */
  videoSeconds?: number;
  attempts: number;
  lastError?: string;
  /** ISO 8601 */
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Generation jobs
// ---------------------------------------------------------------------------

/**
 * Spec for an image generation job.
 * Prompt already contains `<<<element_id>>>` placeholders when
 * elementsViaPlaceholders is true; elementIds lists them redundantly so
 * providers that need explicit reference-image params can use them.
 */
export interface ImageJobSpec {
  kind: 'image';
  prompt: string;
  elementIds: string[];
  /**
   * Local path to the previous image when this job is an Edit (image-to-image
   * with reference). Providers pass it as a reference input (higgsfield CLI:
   * --image <path>; mock: return a variant of the referenced sample).
   * Absent = fresh text-to-image. (Contract change approved by Fable,
   * T-01 finding 2, 2026-07-03.)
   */
  referenceImagePath?: string;
  /** e.g. 'nano_banana_2' (default image model, 1.5 credits, element-capable) */
  model: string;
  /** e.g. '1080p' — provider-specific, optional */
  resolution?: string;
  /** e.g. '16:9' */
  aspectRatio: string;
}

/** Spec for a video generation job (image-to-video). */
export interface VideoJobSpec {
  kind: 'video';
  prompt: string;
  elementIds: string[];
  /** local file path or provider media UUID used as the first frame */
  startImage?: string;
  /** e.g. 'kling3_0' (workhorse: mode std, sound off, 6.25 credits/5s) */
  model: string;
  /** integer seconds, MIN_CLIP_SECONDS..MAX_CLIP_SECONDS */
  duration: number;
  /** 'std' | 'pro' | '4k' for kling3_0 */
  mode?: string;
  resolution?: string;
  /** true -> pass sound off (cheaper; VO is muxed at export anyway) */
  soundOff: boolean;
  aspectRatio: string;
}

export type JobSpec = ImageJobSpec | VideoJobSpec;

export type JobStatus = 'queued' | 'in_progress' | 'completed' | 'failed' | 'nsfw' | 'canceled';

export interface JobResult {
  jobId: string;
  status: JobStatus;
  /** remote artifact URL when completed */
  resultUrl?: string;
  /** set once download() has fetched the artifact */
  localPath?: string;
  /** actual credits charged (ledger ground truth), when knowable */
  creditsCharged?: number;
  /** provider error message on failed/nsfw */
  error?: string;
}

// ---------------------------------------------------------------------------
// Provider interface (src/providers/*)
// ---------------------------------------------------------------------------

/**
 * A generation backend. Implementations: HiggsfieldCliProvider (real, spawns
 * `higgsfield` with ARRAY args), MockProvider (copies phase0 sample media —
 * the ONLY provider that runs during development; the real one spends credits).
 *
 * Contract:
 *  - submit*() returns a provider job id immediately (async queue model).
 *  - poll(jobId) is cheap and idempotent; callers poll until status is
 *    terminal ('completed' | 'failed' | 'nsfw' | 'canceled').
 *  - preflightCost() returns expected credits or null when the provider
 *    cannot preflight (mock returns 0-cost estimates from the measured table).
 *  - download() writes the artifact to destPath and returns the final path.
 */
export interface GenProvider {
  readonly name: string;
  preflightCost(spec: JobSpec): Promise<number | null>;
  submitImage(spec: ImageJobSpec): Promise<string>;
  submitVideo(spec: VideoJobSpec): Promise<string>;
  poll(jobId: string): Promise<JobResult>;
  download(result: JobResult, destPath: string): Promise<string>;
}

// ---------------------------------------------------------------------------
// Prompt engine (src/prompts.ts)
// ---------------------------------------------------------------------------

/**
 * LLM prompt generation. Implementations: ClaudePromptEngine (Agent SDK,
 * Sonnet, ~5-line batches), TemplatePromptEngine (deterministic, offline —
 * used with MockProvider in tests).
 * imagePromptBatch returns prompts already tagged with `<<<element_id>>>`
 * placeholders for the elements relevant to each line.
 */
export interface PromptEngine {
  imagePromptBatch(
    lines: LineTiming[],
    elements: ElementRef[],
    styleBible: string,
  ): Promise<{ lineIndex: number; imagePrompt: string }[]>;
  animationPrompt(shot: Shot, elements: ElementRef[]): Promise<string>;
}

// ---------------------------------------------------------------------------
// EDL (edit decision list)
// ---------------------------------------------------------------------------

/**
 * One placed clip on the timeline. Invariants (timeline rule):
 *   timelineStart = shot.line.start
 *   duration      = shot.line.targetDuration
 *   outPoint      = inPoint + duration  (<= generated clip length)
 * Export trims clipPath to [inPoint, outPoint) and places it at timelineStart.
 */
export interface EDLEntry {
  /** app-generated UUID */
  id: string;
  projectId: string;
  shotId: string;
  lineIndex: number;
  /** local path of the generated clip */
  clipPath: string;
  /** seconds into the source clip (default 0) */
  inPoint: number;
  outPoint: number;
  /** seconds on the master timeline (== line.start) */
  timelineStart: number;
  /** == targetDuration */
  duration: number;
}

// ---------------------------------------------------------------------------
// Cost ledger
// ---------------------------------------------------------------------------

export interface CostLedgerEntry {
  /** autoincrement row id (assigned by db.ts on insert) */
  id?: number;
  projectId: string;
  jobId: string;
  shotId?: string;
  kind: 'image' | 'video' | 'other';
  model: string;
  /** preflight estimate (get_cost) — null if preflight unavailable */
  preflightCredits: number | null;
  /** actual charge reconciled from the provider ledger — null until known */
  chargedCredits: number | null;
  /** ISO 8601 */
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Pipeline configuration
// ---------------------------------------------------------------------------

export type ProviderName = 'mock' | 'higgsfield-cli' | 'fal';

export interface PipelineConfig {
  /** which GenProvider to instantiate */
  provider: ProviderName;
  /**
   * Optional per-stage overrides (Contract change approved by Fable with
   * T-30, 2026-07-03): fal is a VIDEO-ONLY fallback (its submitImage throws),
   * so mixed pipelines set e.g. imageProvider:'higgsfield-cli' +
   * videoProvider:'fal'. Absent -> both stages use provider.
   */
  imageProvider?: ProviderName;
  videoProvider?: ProviderName;
  models: {
    /** default 'nano_banana_2' */
    image: string;
    /** default 'kling3_0' */
    video: string;
    /** kling3_0 mode, default 'std' */
    videoMode: string;
  };
  /** review-ahead buffer: keep N shots at IMAGE_READY (default 5) */
  bufferSize: number;
  /** max concurrent provider jobs (default 4; Phase 0 measured 6 OK) */
  concurrency: number;
  /**
   * true (default): embed elements as `<<<element_id>>>` placeholders in
   * prompts. false: adapters pass element reference images explicitly
   * (fallback if the CLI does not honor placeholders).
   */
  elementsViaPlaceholders: boolean;
  /** default '16:9' */
  aspectRatio: string;
  /** pass sound off on video jobs (default true) */
  soundOff: boolean;
  /** per-project style bible injected into every prompt batch */
  styleBible: string;
}

export const DEFAULT_CONFIG: PipelineConfig = {
  provider: 'mock',
  models: {
    image: 'nano_banana_2',
    video: 'kling3_0',
    videoMode: 'std',
  },
  bufferSize: 5,
  concurrency: 4,
  elementsViaPlaceholders: true,
  aspectRatio: '16:9',
  soundOff: true,
  styleBible: '',
};

// ---------------------------------------------------------------------------
// Project
// ---------------------------------------------------------------------------

export interface Project {
  /** app-generated UUID */
  id: string;
  /** folder name under app/projects/ */
  name: string;
  scriptPath: string;
  voPath: string;
  config: PipelineConfig;
  createdAt: string;
  updatedAt: string;
}
