# Director's Flick — Architecture & Module Contracts (Phase 1 headless core)

Node.js 22+ / TypeScript, executed via **tsx** (no bundler, no dist build).
`npm run cli -- <command>` runs `src/cli.ts`. `npm run typecheck` runs `tsc --noEmit`.

**SQLite library: `better-sqlite3`** (prebuilt binary verified loading on Node v24.12.0,
WAL smoke-tested). No fallback to `node:sqlite` was needed.

All cross-module data shapes live in **`src/types.ts`** and only there.
All persistence goes through **`src/db.ts`** (`ProjectDb`). DB file:
`app/projects/<name>/pipeline.db` (WAL mode).

## Hard rules (apply to every module)

- **Never spend credits in development.** `MockProvider` is the only provider used in
  runs/tests; `HiggsfieldCliProvider` is exercised only by explicit user action.
- Windows-safe: `node:path` for all paths; `child_process.spawn` with **ARRAY args**
  (never shell-string interpolation); set `PYTHONIOENCODING=utf-8` when spawning
  python; python scripts print **ASCII-only** to the console.
- Write files only inside `app/` (project artifacts under `app/projects/<name>/`).

## TIMELINE RULE (critical — verbatim, binding on align, queue, media)

> each script line's clip must cover [line.start, nextLine.start) - i.e.
> target_duration = next.start - this.start (last line: duration + 0.5s tail).
> Generated video duration = clamp(ceil(target_duration), 3, 15) seconds
> (kling3_0 range); exact trim to target_duration happens at export.
> Lines longer than 15s must be split into sub-shots at word boundaries.

Constants and the clamp helper live in `src/types.ts`
(`MIN_CLIP_SECONDS`, `MAX_CLIP_SECONDS`, `LAST_LINE_TAIL_SECONDS`, `clampVideoSeconds`).
`align.ts` computes `targetDuration` and performs sub-shot splitting; `queue.ts` uses
`clampVideoSeconds(shot.line.targetDuration)` for `VideoJobSpec.duration`; `media.ts`
trims to the exact (fractional) `targetDuration` at export.

## Module map & ownership

| Module | Files (owner has exclusive write access) |
|---|---|
| align | `scripts/align_cli.py`, `src/align.ts` |
| providers | `src/providers/higgsfield-cli.ts`, `src/providers/mock.ts`, `src/providers/index.ts` |
| prompts | `src/prompts.ts` |
| queue | `src/queue.ts` |
| media | `src/media.ts` |
| cli | `src/cli.ts`, `src/config.ts` |
| shared (ARCHITECT-owned, change by contract review only) | `src/types.ts`, `src/db.ts`, `tsconfig.json`, `package.json`, this file |

Dependency direction (no cycles):
`cli` → `queue`, `align`, `media`, `providers`, `prompts`, `config`, `db` ·
`queue` → `providers`, `prompts`, `db`, `types` ·
everything → `types`. Nothing imports `cli`.

---

## align — `scripts/align_cli.py` + `src/align.ts`

`align_cli.py` (python 3.12, stable-ts, CPU ~15 sec-of-audio/sec):
CLI: `python scripts/align_cli.py --audio <wav> --script <txt> --out <json>`.
Uses stable-ts `align()` with the known script text (never plain transcription).
Writes JSON `{ lines: AlignedLine[] }` (per-line + per-word timestamps, seconds).
Console output ASCII-only; data goes to the `--out` file, never stdout.

`src/align.ts` MUST export:

```ts
/** Spawn align_cli.py (spawn with array args, PYTHONIOENCODING=utf-8), parse output. */
export function alignScript(scriptPath: string, audioPath: string, outJsonPath: string): Promise<AlignedLine[]>;

/** Apply the TIMELINE RULE: duration, pauseAfter, targetDuration per line. */
export function computeTimeline(lines: AlignedLine[]): LineTiming[];

/**
 * 1 line -> 1 shot normally; lines with targetDuration > MAX_CLIP_SECONDS are
 * split into sub-shots at word boundaries (words from AlignedLine), each
 * sub-shot's LineTiming re-obeying the timeline rule within the line's span.
 * Returns state='PENDING' shots ready for ProjectDb.insertShots().
 */
export function planShots(projectId: string, timeline: LineTiming[], aligned: AlignedLine[]): Shot[];
```

## providers — `src/providers/*.ts`

Both providers implement `GenProvider` (types.ts):
`{ name; preflightCost(spec): Promise<number|null>; submitImage(spec): Promise<string>; submitVideo(spec): Promise<string>; poll(jobId): Promise<JobResult>; download(result, destPath): Promise<string> }`.

`src/providers/index.ts` MUST export:

```ts
export function createProvider(config: PipelineConfig): GenProvider; // 'mock' | 'higgsfield-cli'
```

`src/providers/mock.ts` — `export class MockProvider implements GenProvider`.
Simulates the async queue (submit → jobId; poll flips to 'completed' after a short
configurable delay); `download()` copies sample media from
`C:/Coding/Video Automation/phase0/` (images: `A_character_element.png`,
`B_location.png`, `C_two_elements.png`; videos: `V1_kling3_turbo.mp4`,
`V2_kling2_6.mp4`, `V3_kling3_element.mp4`) — read-only source, copy to destPath.
`preflightCost()` returns the measured table: nano_banana_2 = 1.5/image;
kling3_0 std sound-off = 1.25 × duration credits (6.25/5s).

`src/providers/higgsfield-cli.ts` — `export class HiggsfieldCliProvider implements GenProvider`.
Spawns `higgsfield` (on PATH) with ARRAY args:
`higgsfield generate create <model> --prompt "..." [--start-image <path-or-uuid>] [--image <path-or-uuid>] [--duration 5 --mode std --sound off --aspect_ratio 16:9] --json --wait`.
Elements: when `config.elementsViaPlaceholders` is true, `<<<element_id>>>` placeholders
are already embedded in `spec.prompt` (pass through untouched); else pass
`spec.elementIds` via explicit image-reference flags. Must detect the
"Session expired" stderr and throw a typed `AuthError` so the queue pauses instead
of retrying. **Never invoked by tests or default runs** (unauthenticated anyway).

## prompts — `src/prompts.ts`

MUST export both engines implementing `PromptEngine` (types.ts):

```ts
/** Claude Agent SDK (@anthropic-ai/claude-agent-sdk), Sonnet, ~5-line batches, style bible injected. */
export class ClaudePromptEngine implements PromptEngine { constructor(opts?: { model?: string }) }

/** Deterministic, offline, zero-token engine for MockProvider runs and tests. */
export class TemplatePromptEngine implements PromptEngine {}

export function createPromptEngine(config: PipelineConfig): PromptEngine; // mock provider -> Template, else Claude
```

`imagePromptBatch(lines, elements, styleBible)` returns
`{ lineIndex, imagePrompt }[]` with `<<<element_id>>>` placeholders already embedded
for each line's relevant elements (use `elementPlaceholder()` from types.ts).
`animationPrompt(shot, elements)` returns a single motion prompt for the approved image.

## queue — `src/queue.ts`

Owns the shot state machine (`ShotState`, transitions per `SHOT_TRANSITIONS`) and the
review-ahead buffer. MUST export:

```ts
export class ShotQueue {
  constructor(db: ProjectDb, provider: GenProvider, prompts: PromptEngine, config: PipelineConfig);
  /** Drive all shots to completion. autoApprove=true: IMAGE_READY -> APPROVED without review (Phase 1 CLI mode). */
  run(opts: { autoApprove: boolean }): Promise<void>;
  /** Review verbs (Phase 2 UI calls these; CLI exposes them for testing). */
  approve(shotId: string): Promise<void>;                       // IN_REVIEW -> APPROVED (queues animation prompt + video)
  requestEdit(shotId: string, instructions: string): Promise<void>; // IN_REVIEW -> IMAGE_QUEUED (image-to-image w/ reference)
  requestRedo(shotId: string): Promise<void>;                   // IN_REVIEW -> PROMPTED (fresh prompt, no reference)
  redoAnimation(shotId: string, newPrompt: string): Promise<void>;  // VIDEO_READY|PLACED -> VIDEO_QUEUED (same startImage)
}
```

Responsibilities: preflight **every** job via `provider.preflightCost()` →
`db.insertLedger()` before submit; respect `config.concurrency`; keep
`config.bufferSize` shots at IMAGE_READY; on video completion download to
`app/projects/<name>/clips/`, set `videoPath`, then write the EDL entry
(`timelineStart = line.start`, `duration = line.targetDuration`,
`inPoint = 0`, `outPoint = targetDuration`) and transition to PLACED.
`VideoJobSpec.duration = clampVideoSeconds(line.targetDuration)`.
All state persisted through `ProjectDb` — crash/restart resumes from
`listShots()` + `listOpenJobs()` with no extra bookkeeping.

## media — `src/media.ts`

FFmpeg (8.1.1 on PATH, `h264_nvenc`) via `spawn` with array args. MUST export:

```ts
export function probeDuration(mediaPath: string): Promise<number>; // ffprobe, seconds
/** Trim src to [inPoint, inPoint+duration), normalize to 1080p30 CFR, NVENC encode. */
export function trimNormalize(srcPath: string, destPath: string, inPoint: number, duration: number): Promise<string>;
/** Concat pre-normalized clips with the concat demuxer, -c copy. */
export function concatClips(clipPaths: string[], destPath: string): Promise<string>;
/** Mux the voiceover WAV over the concatenated video (-c:v copy -c:a aac). */
export function muxVoiceover(videoPath: string, voPath: string, destPath: string): Promise<string>;
/** Full export: EDL (timeline order) -> parallel trimNormalize -> concat -> VO mux -> final MP4 path. */
export function exportTimeline(entries: EDLEntry[], voPath: string, outPath: string, opts?: { concurrency?: number }): Promise<string>;
```

Export trims each EDL entry to its exact fractional `duration` (the generated clip is
intentionally longer — integer-clamped at generation). Gaps between clips must not
exist by construction (timeline rule: each clip covers [start, next.start)).

## cli — `src/cli.ts` + `src/config.ts`

`src/config.ts` MUST export:

```ts
export function loadConfig(projectName: string): PipelineConfig; // project config_json if present, else DEFAULT_CONFIG (+ optional app/config.json overrides)
```

`src/cli.ts` (commander, `npm run cli --`):

```
init    <name> --script <path> --vo <path>     create project + db, ensureProject
align   <name>                                 alignScript -> computeTimeline -> planShots -> insertShots
elements<name> [--add <id:name:category>]      register/list ElementRefs
run     <name> [--auto-approve]                ShotQueue.run (Phase 1: always --auto-approve with mock provider)
status  <name>                                 shots by state, open jobs, credit total
export  <name> [--out <path>]                  exportTimeline from EDL
cost    <name>                                 ledger dump + totalCredits
```

Phase 1 exit criterion: `init` → `align` → `run --auto-approve` → `export` with
`provider='mock'` on `phase0/script.txt` + `phase0/test_vo.wav` produces a final
MP4 with correct per-line cut points, zero credits spent.

## Persistence — `src/db.ts` (shared)

`openProjectDb(name): ProjectDb` — creates `app/projects/<name>/`, opens WAL DB.
Tables: `projects`, `shots` (UNIQUE project/line/sub, state-indexed), `jobs`,
`edl` (UNIQUE project/shot — timeline-redo upserts), `cost_ledger`, `elements`
(UNIQUE project/name). Key methods: `ensureProject`, `getProject`, `saveConfig`,
`insertShots`, `getShot`, `listShots(state?)`, `countShots`,
`updateShotState(shotId, state, patch?)` (validates `SHOT_TRANSITIONS`),
`insertJob`, `updateJobResult`, `getJob`, `listOpenJobs`,
`upsertEdlEntry`, `listEdl`, `insertLedger`, `updateLedgerCharge`, `listLedger`,
`totalCredits`, `upsertElement`, `listElements`, `getElementByName`.

## Project artifact layout

```
app/projects/<name>/
  pipeline.db          # SQLite (WAL)
  alignment.json       # align_cli.py output
  images/<shotId>.png
  clips/<shotId>.mp4   # generated (integer-second) clips
  export/trim_<n>.mp4  # normalized trims (export working dir)
  export/final.mp4
```

## Measured facts the code relies on (Phase 0, 2026-07-03)

- Video workhorse `kling3_0`: mode `std`, sound off, **6.25 credits/5s**, duration
  3–15s integer, element-capable via `<<<element_id>>>` in the prompt.
- Default image model `nano_banana_2`: **1.5 credits**, element-capable.
- Element ids are UUIDs, embedded as `<<<uuid>>>` placeholders in prompts.
- Higgsfield CLI: `higgsfield generate create <model> ... --json --wait`; errors
  with "Session expired" when unauthenticated.
- ffmpeg 8.1.1 with `h264_nvenc`; python 3.12 with stable-ts (CPU ~15 s-audio/s).
- 6 concurrent jobs accepted without throttling; default `concurrency: 4`.
