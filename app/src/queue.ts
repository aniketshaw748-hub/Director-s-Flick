import { randomUUID } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import type {
  Shot,
  ShotState,
  ImageJobSpec,
  VideoJobSpec,
  PipelineConfig,
  GenProvider,
  PromptEngine,
  ElementRef,
  Project,
  ProviderName,
  LineTiming,
} from './types.js';
import { clampVideoSeconds } from './types.js';
import { projectDir, type ProjectDb, type JobRow } from './db.js';

/** higgsfield-cli/mock price in credits; fal is dollar-denominated (T-38c). */
function unitForProvider(providerName: string): 'credits' | 'usd' {
  return providerName === 'fal' ? 'usd' : 'credits';
}

/** Marks a shot as having already had its one nsfw-sanitized retry (T-37) -
 * stored in the existing `lastError` column so a second nsfw hit on the new
 * job can tell "first strike" from "sanitized retry also failed" without a
 * new persisted field. Cleared automatically on the next success/failure
 * patch that sets a different lastError (or none). */
const NSFW_RETRY_MARKER = 'nsfw:sanitized-retry-pending';

/** A safety instruction appended to the line text handed to the PromptEngine
 * for an nsfw-triggered sanitize retry - reuses imagePromptBatch/
 * animationPrompt as-is (no PromptEngine interface change) by cloning the
 * shot's LineTiming with modified text. */
const NSFW_SAFE_SUFFIX =
  '(keep the depiction strictly modest and tasteful; no nudity, gore, or explicit content)';

/** Emitted by ShotQueue whenever a shot reaches a state a UI should react to
 * immediately (IMAGE_READY, VIDEO_READY, PLACED), in addition to whatever
 * periodic full-state sync a caller (e.g. server.ts) also runs. */
export interface ShotEvent {
  shotId: string;
  state: 'IMAGE_READY' | 'VIDEO_READY' | 'PLACED';
}

export class ShotQueue extends EventEmitter {
  private db: ProjectDb;
  /** Per-stage providers (T-34). Image jobs submit/poll/download via
   * imageProvider, video jobs via videoProvider. Equal when a single provider
   * was passed (back-compat) or both stages resolve to the same provider. */
  private imageProvider: GenProvider;
  private videoProvider: GenProvider;
  private prompts: PromptEngine;
  private config: PipelineConfig;
  private project: Project;
  private stopped = false;
  /** The in-flight run() loop's promise (T-62), so stop() can await genuine
   * termination instead of just flipping the flag and hoping. */
  private runPromise: Promise<void> | undefined;
  /** Active account name (see accounts.ts), tagged onto every ledger row this
   * queue inserts. Undefined for mock runs / no account selected. */
  private accountName: string | undefined;

  /** T-37 adaptive concurrency: consecutive 'failed' poll results per stage.
   * Reset to 0 on any 'completed' for that stage. */
  private consecutiveImageErrors = 0;
  private consecutiveVideoErrors = 0;
  private static readonly ERROR_BACKOFF_THRESHOLD = 3;
  /** Concurrent-job cap a backed-off stage is throttled down to (on top of
   * the existing shared config.concurrency pool - never raises the total
   * ceiling, only lets a struggling stage claim less of it). */
  private static readonly BACKOFF_CAP = 1;

  /** T-37 per-stage provider fallback hook. Optional and backward-compatible:
   * absent (all current callers) -> zero behavior change. When supplied, a
   * run of repeated video-stage failures switches this.videoProvider over to
   * it once, permanently, for the rest of this queue's lifetime. Wiring a
   * REAL fallback instance from config at construction time (server.ts/
   * cli.ts + a PipelineConfig field) is a follow-up contract change - out of
   * this task's lease (queue.ts + tests only). */
  private videoProviderFallback: GenProvider | undefined;
  private failedOverToVideoFallback = false;
  private static readonly FAILOVER_THRESHOLD = 5;

  constructor(
    db: ProjectDb,
    provider: GenProvider | { image: GenProvider; video: GenProvider },
    prompts: PromptEngine,
    config: PipelineConfig,
    accountName?: string,
    videoProviderFallback?: GenProvider,
  ) {
    super();
    this.db = db;
    // Accept a single provider (used for both stages — back-compat) or a
    // per-stage { image, video } pair (T-34).
    if ('submitImage' in provider) {
      this.imageProvider = provider;
      this.videoProvider = provider;
    } else {
      this.imageProvider = provider.image;
      this.videoProvider = provider.video;
    }
    this.prompts = prompts;
    this.config = config;
    // T-38 BUG 2: db.getProject() is undefined for a shell db opened for a
    // project that was never created (e.g. openProjectDb() on a bad/typo'd
    // name) - the old `!` assertion let that through silently, and this
    // queue's very first submit crashed with "Cannot read properties of
    // undefined (reading 'id')" deep inside a background run() loop that had
    // already been cached by the caller. Fail loudly here instead, at
    // construction time, so getOrOpenProject (server.ts) can catch this and
    // return a clean 404 without ever caching a broken queue.
    const project = db.getProject();
    if (!project) {
      throw new Error(`ShotQueue: no project row in this db (project was never created)`);
    }
    this.project = project;
    this.accountName = accountName;
    this.videoProviderFallback = videoProviderFallback;
  }

  /**
   * Signal run() to exit at the top of its next iteration (T-27: explicit
   * start/stop from the setup flow), and wait for it to actually finish
   * (T-62). A stopped instance is done for good - construct a new ShotQueue
   * to resume (safe: state persists in the db).
   *
   * Awaiting this is the ONLY way to know the loop has genuinely exited -
   * before this fix, `stop()` just flipped a flag and returned immediately,
   * so a caller that closed the db (or reused the account/config) right
   * after calling it could race an in-flight tick still using the old db
   * connection / provider, surfacing as "database connection is not open" in
   * tests and, in production, as a `/stop` response claiming `running:false`
   * while the loop was still mid-tick doing real work.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.runPromise) {
      // run() can reject (e.g. AuthError) - that's the caller's concern via
      // the run() promise itself, not stop()'s; just wait for it to settle.
      await this.runPromise.catch(() => {});
    }
  }

  /** Starts the review-gate loop and remembers its promise so stop() can
   * await genuine termination (T-62). The actual loop lives in runLoop(). */
  run(opts: { autoApprove: boolean }): Promise<void> {
    const promise = this.runLoop(opts);
    this.runPromise = promise;
    return promise;
  }

  private async runLoop(opts: { autoApprove: boolean }): Promise<void> {
    let idleCount = 0;
    while (!this.stopped) {
      const shots = this.db.listShots();
      const allPlaced = shots.length > 0 && shots.every((s: Shot) => s.state === 'PLACED');

      // Only exit-when-done in autoApprove mode (CLI/mock bounded runs, so
      // `cli run`'s awaited promise resolves and export can proceed). In
      // review-gate mode (server.ts, autoApprove=false) this must NOT exit
      // just because every shot happens to be PLACED at this snapshot - new
      // work can arrive later (a fresh `align`, or a redo/edit resetting a
      // placed shot back to an earlier state), and nothing else restarts a
      // naturally-completed loop the way T-27's explicit /run does for a
      // stopped one. Same reasoning as the autoApprove-gated idle-break below.
      if (opts.autoApprove && shots.length > 0 && allPlaced) {
         break;
      }

      const elements = this.db.listElements();
      const openJobs = this.db.listOpenJobs();
      let workDone = false;

      // 1. Poll in-flight jobs
      for (const job of openJobs) {
        // Route poll/download to the provider that owns this job's stage (T-34).
        const stageProvider = job.kind === 'image' ? this.imageProvider : this.videoProvider;
        try {
           const result = await stageProvider.poll(job.id);
           if (['completed', 'failed', 'nsfw', 'canceled'].includes(result.status)) {
              workDone = true;
              this.db.updateJobResult(result);
              if (result.creditsCharged !== undefined && result.creditsCharged !== null) {
                 this.db.updateLedgerCharge(job.id, result.creditsCharged);
              }
              // T-37 adaptive concurrency + fallback hook: track this stage's
              // reliability independent of any particular shot.
              this.recordStageResult(job.kind, result.status);
              const shot = job.shotId ? this.db.getShot(job.shotId) : undefined;
              if (shot) {
                 if (result.status === 'completed') {
                    const destDir = path.join(projectDir(this.project.name), job.kind === 'image' ? 'images' : 'clips');
                    fs.mkdirSync(destDir, { recursive: true });
                    const ext = job.kind === 'image' ? 'png' : 'mp4';
                    const destPath = path.join(destDir, `${shot.id}.${ext}`);
                    const finalPath = await stageProvider.download(result, destPath);
                    if (job.kind === 'image') {
                       this.db.updateShotState(shot.id, 'IMAGE_READY', { imagePath: finalPath, attempts: 0, lastError: undefined });
                       this.emit('shotEvent', { shotId: shot.id, state: 'IMAGE_READY' } satisfies ShotEvent);
                    } else {
                       this.db.updateShotState(shot.id, 'VIDEO_READY', { videoPath: finalPath, attempts: 0, lastError: undefined });
                       this.emit('shotEvent', { shotId: shot.id, state: 'VIDEO_READY' } satisfies ShotEvent);
                    }
                 } else if (result.status === 'nsfw') {
                    await this.handleNsfw(shot, job);
                 } else {
                    this.db.updateShotState(shot.id, 'FAILED', { lastError: result.error || result.status });
                 }
              }
           }
        } catch (err: any) {
           console.error(`Error polling job ${job.id}:`, err);
           if (err.name === 'AuthError') throw err;
        }
      }
      
      const currentShots = this.db.listShots();
      const openJobsNow = this.db.listOpenJobs();
      const activeJobsCount = openJobsNow.length;
      let availableConcurrency = this.config.concurrency - activeJobsCount;
      // T-40 finding H4 (buffer overshoot): two bugs, both needed fixing.
      // (1) must count IMAGE_QUEUED (already submitted, in flight) toward the
      // same budget as IMAGE_READY/IN_REVIEW - otherwise a completed batch
      // frees up concurrency and the D-loop below can dump a whole new burst
      // of submissions before any of them are visible in this count,
      // overshooting bufferSize once they all land (measured: bufferSize=5
      // but 8 shots reached IN_REVIEW). (2) this count must also update AS
      // the D-loop below submits within the SAME tick (`let` + increment,
      // not a frozen `const`) - otherwise a single tick's loop keeps
      // comparing every iteration against the snapshot taken before any of
      // its own submissions happened, so it could still blow past bufferSize
      // in one pass even with fix (1) in place.
      let imageReadyCount = currentShots.filter(
         (s: Shot) => s.state === 'IMAGE_READY' || s.state === 'IN_REVIEW' || s.state === 'IMAGE_QUEUED',
      ).length;

      // T-37 adaptive concurrency: on top of the existing shared
      // config.concurrency pool above (unchanged ceiling), a stage with 3+
      // consecutive provider errors is additionally throttled to at most
      // BACKOFF_CAP concurrent jobs of its own, restored (Infinity, i.e. no
      // extra restriction) the moment that stage next succeeds.
      const activeImageJobs = openJobsNow.filter((j) => j.kind === 'image').length;
      const activeVideoJobs = openJobsNow.filter((j) => j.kind === 'video').length;
      const imageBackoffCap =
         this.consecutiveImageErrors >= ShotQueue.ERROR_BACKOFF_THRESHOLD ? ShotQueue.BACKOFF_CAP : Infinity;
      const videoBackoffCap =
         this.consecutiveVideoErrors >= ShotQueue.ERROR_BACKOFF_THRESHOLD ? ShotQueue.BACKOFF_CAP : Infinity;
      let imageSlotsLeft = imageBackoffCap - activeImageJobs;
      let videoSlotsLeft = videoBackoffCap - activeVideoJobs;

      // 2. Process shots state machine
      
      // A. VIDEO_READY -> PLACED
      for (const shot of currentShots.filter((s: Shot) => s.state === 'VIDEO_READY')) {
         if (!shot.videoPath) continue;
         this.db.upsertEdlEntry({
            id: randomUUID(),
            projectId: this.project.id,
            shotId: shot.id,
            lineIndex: shot.lineIndex,
            clipPath: shot.videoPath,
            inPoint: 0,
            outPoint: shot.line.targetDuration,
            timelineStart: shot.line.start,
            duration: shot.line.targetDuration
         });
         this.db.updateShotState(shot.id, 'PLACED');
         this.emit('shotEvent', { shotId: shot.id, state: 'PLACED' } satisfies ShotEvent);
         workDone = true;
      }

      // B. APPROVED -> VIDEO_QUEUED
      for (const shot of currentShots.filter((s: Shot) => s.state === 'APPROVED')) {
         if (availableConcurrency <= 0 || videoSlotsLeft <= 0) break;
         let animPrompt = shot.animationPrompt;
         if (!animPrompt) {
            animPrompt = await this.prompts.animationPrompt(shot, elements);
            this.db.updateShotState(shot.id, 'APPROVED', { animationPrompt: animPrompt });
         }
         await this.submitVideoForShot(shot, animPrompt);
         availableConcurrency--;
         videoSlotsLeft--;
         workDone = true;
      }

      // C. IMAGE_READY -> IN_REVIEW (or APPROVED if autoApprove)
      for (const shot of currentShots.filter((s: Shot) => s.state === 'IMAGE_READY')) {
         this.db.updateShotState(shot.id, 'IN_REVIEW');
         if (opts.autoApprove) {
            await this.approve(shot.id);
         }
         workDone = true;
      }

      // D. PROMPTED -> IMAGE_QUEUED
      for (const shot of currentShots.filter((s: Shot) => s.state === 'PROMPTED')) {
         if (imageReadyCount >= this.config.bufferSize) break;
         if (availableConcurrency <= 0 || imageSlotsLeft <= 0) break;
         await this.submitImageForShot(shot);
         availableConcurrency--;
         imageSlotsLeft--;
         imageReadyCount++;
         workDone = true;
      }
      
      // E. PENDING -> PROMPTED
      const pendingShots = currentShots.filter((s: Shot) => s.state === 'PENDING');
      if (pendingShots.length > 0 && imageReadyCount < this.config.bufferSize) {
         const batch = pendingShots.slice(0, 5);
         const lines = batch.map((s: Shot) => s.line);
         try {
            const generated = await this.prompts.imagePromptBatch(lines, elements, this.config.styleBible);
            for (const g of generated) {
               const shot = batch.find((s: Shot) => s.lineIndex === g.lineIndex);
               if (shot) {
                  this.db.updateShotState(shot.id, 'PROMPTED', { imagePrompt: g.imagePrompt });
                  workDone = true;
               }
            }
         } catch (err: any) {
            // Prompt-stage failure: no job was ever submitted for these shots,
            // so retry (below) correctly falls back to a full PENDING restart.
            console.error(`Error generating prompt batch:`, err);
            for (const shot of batch) {
               this.db.updateShotState(shot.id, 'FAILED', { lastError: err?.message ?? String(err) });
            }
            workDone = true;
         }
      }

      // Retry FAILED if attempts < 3. Stage-aware re-entry: resubmit only the
      // stage that actually failed (reuse the still-good image/prompt from
      // earlier stages) instead of restarting the whole shot from scratch.
      for (const shot of currentShots.filter((s: Shot) => s.state === 'FAILED')) {
         if (shot.attempts >= 3) continue;
         const attempts = shot.attempts + 1;
         if (shot.videoJobId && shot.imagePath && shot.animationPrompt) {
            // Video stage failed; the approved image + anim prompt are still
            // good - resubmit video only. T-37: this is the path a backed-off
            // video stage most needs throttled (it's exactly the resubmission
            // traffic from recent failures) - skip for now, retried again
            // once a slot frees up.
            if (videoSlotsLeft <= 0) continue;
            await this.submitVideoForShot(shot, shot.animationPrompt, { attempts });
            videoSlotsLeft--;
         } else if (shot.imageJobId && shot.imagePrompt) {
            // Image stage failed; the prompt is still good - resubmit image only.
            if (imageSlotsLeft <= 0) continue;
            await this.submitImageForShot(shot, { attempts });
            imageSlotsLeft--;
         } else {
            // Prompt-stage (or unknown) failure - full restart.
            this.db.updateShotState(shot.id, 'PENDING', { attempts });
         }
         workDone = true;
      }

      if (!workDone) {
         idleCount++;
      } else {
         idleCount = 0;
      }
      
      // Safety break if we are stuck and have no open jobs. Only applies in
      // autoApprove mode (CLI/mock one-shot runs): in review-gate mode
      // (autoApprove=false, e.g. driven by server.ts) shots sitting IN_REVIEW
      // waiting on a human action are expected idling, not "stuck" - that
      // loop must keep running indefinitely so approve/edit/redo calls
      // arriving later still get picked up.
      if (opts.autoApprove && idleCount > 10 && this.db.listOpenJobs().length === 0) {
         console.log("Queue idle and no open jobs. Exiting run loop.");
         break;
      }

      await new Promise(r => setTimeout(r, 2000));
    }
  }

  /** T-37: update per-stage consecutive-error tracking from a poll result,
   * and one-time-failover the video stage to the configured fallback
   * provider (if any) once it's failed FAILOVER_THRESHOLD times running. */
  private recordStageResult(kind: 'image' | 'video', status: string): void {
     if (kind === 'image') {
        if (status === 'completed') this.consecutiveImageErrors = 0;
        else if (status === 'failed') this.consecutiveImageErrors++;
        return;
     }
     if (status === 'completed') {
        this.consecutiveVideoErrors = 0;
        return;
     }
     if (status !== 'failed') return;
     this.consecutiveVideoErrors++;
     if (
        !this.failedOverToVideoFallback &&
        this.videoProviderFallback &&
        this.consecutiveVideoErrors >= ShotQueue.FAILOVER_THRESHOLD
     ) {
        console.warn(
           `[queue] video provider '${this.videoProvider.name}' failed ${this.consecutiveVideoErrors} times in a row - ` +
              `failing over to configured fallback provider '${this.videoProviderFallback.name}'`,
        );
        this.videoProvider = this.videoProviderFallback;
        this.failedOverToVideoFallback = true;
        this.consecutiveVideoErrors = 0;
     }
  }

  /**
   * NSFW handling (T-37): one sanitized retry, then a permanent FAILED. The
   * retry regenerates the prompt via the existing PromptEngine (no interface
   * change) against a cloned LineTiming with an appended safety instruction -
   * the shot's own persisted `line` is never mutated, only what's handed to
   * the prompt engine for this one call. A second nsfw hit on the shot
   * (detected via the NSFW_RETRY_MARKER left in lastError by the first) sets
   * attempts:3 so the generic FAILED-retry loop below never resurrects it
   * with the original, still-flaggable prompt.
   */
  private async handleNsfw(shot: Shot, job: JobRow): Promise<void> {
     if (shot.lastError === NSFW_RETRY_MARKER) {
        this.db.updateShotState(shot.id, 'FAILED', {
           lastError: `nsfw content flagged again after a sanitized retry (${job.kind} job ${job.id}) - manual review required`,
           attempts: 3,
        });
        return;
     }
     const elements = this.db.listElements();
     const sfwLine: LineTiming = { ...shot.line, text: `${shot.line.text.trim()} ${NSFW_SAFE_SUFFIX}` };
     if (job.kind === 'image') {
        const [regenerated] = await this.prompts.imagePromptBatch([sfwLine], elements, this.config.styleBible);
        await this.submitImageForShot(shot, {
           prompt: regenerated?.imagePrompt ?? sfwLine.text,
           lastError: NSFW_RETRY_MARKER,
        });
     } else {
        const sanitized = await this.prompts.animationPrompt({ ...shot, line: sfwLine }, elements);
        await this.submitVideoForShot(shot, sanitized, { lastError: NSFW_RETRY_MARKER });
     }
  }

  private async submitVideoForShot(
     shot: Shot,
     animPrompt: string,
     opts?: { attempts?: number; lastError?: string },
  ): Promise<void> {
      const videoSeconds = clampVideoSeconds(shot.line.targetDuration);
      const spec: VideoJobSpec = {
         kind: 'video',
         prompt: animPrompt,
         elementIds: shot.elementIds,
         startImage: shot.imagePath,
         model: this.config.models.video,
         duration: videoSeconds,
         mode: this.config.models.videoMode,
         soundOff: this.config.soundOff,
         aspectRatio: this.config.aspectRatio
      };
      const cost = await this.videoProvider.preflightCost(spec);
      const jobId = await this.videoProvider.submitVideo(spec);
      const jobRow: JobRow = {
         id: jobId,
         projectId: this.project.id,
         shotId: shot.id,
         kind: 'video',
         model: spec.model,
         spec,
         status: 'queued',
         submittedAt: new Date().toISOString(),
         updatedAt: new Date().toISOString()
      };
      this.db.insertJob(jobRow);
      this.db.insertLedger({
         projectId: this.project.id,
         jobId,
         shotId: shot.id,
         kind: 'video',
         model: spec.model,
         preflightCredits: cost,
         chargedCredits: null,
         accountName: this.accountName,
         provider: this.videoProvider.name as ProviderName,
         unit: unitForProvider(this.videoProvider.name),
         createdAt: new Date().toISOString()
      });
      this.db.updateShotState(shot.id, 'VIDEO_QUEUED', {
         videoJobId: jobId,
         videoSeconds,
         animationPrompt: animPrompt,
         ...(opts?.attempts !== undefined ? { attempts: opts.attempts } : {}),
         ...(opts?.lastError !== undefined ? { lastError: opts.lastError } : {}),
      });
  }

  /**
   * Submit an image job for a shot and transition it to IMAGE_QUEUED.
   * Used by the normal PROMPTED -> IMAGE_QUEUED step, by requestEdit
   * (image-to-image with the rejected image as reference), and by
   * stage-aware FAILED retry (resubmit image only).
   */
  private async submitImageForShot(
     shot: Shot,
     opts?: { prompt?: string; referenceImagePath?: string; attempts?: number; lastError?: string },
  ): Promise<void> {
      const prompt = opts?.prompt ?? shot.imagePrompt;
      if (!prompt) throw new Error(`submitImageForShot: shot ${shot.id} has no imagePrompt`);
      const spec: ImageJobSpec = {
         kind: 'image',
         prompt,
         elementIds: shot.elementIds,
         model: this.config.models.image,
         aspectRatio: this.config.aspectRatio,
         ...(opts?.referenceImagePath ? { referenceImagePath: opts.referenceImagePath } : {}),
      };
      const cost = await this.imageProvider.preflightCost(spec);
      const jobId = await this.imageProvider.submitImage(spec);
      const jobRow: JobRow = {
         id: jobId,
         projectId: this.project.id,
         shotId: shot.id,
         kind: 'image',
         model: spec.model,
         spec,
         status: 'queued',
         submittedAt: new Date().toISOString(),
         updatedAt: new Date().toISOString()
      };
      this.db.insertJob(jobRow);
      this.db.insertLedger({
         projectId: this.project.id,
         jobId,
         shotId: shot.id,
         kind: 'image',
         model: spec.model,
         preflightCredits: cost,
         chargedCredits: null,
         accountName: this.accountName,
         provider: this.imageProvider.name as ProviderName,
         unit: unitForProvider(this.imageProvider.name),
         createdAt: new Date().toISOString()
      });
      this.db.updateShotState(shot.id, 'IMAGE_QUEUED', {
         imageJobId: jobId,
         imagePrompt: prompt,
         ...(opts?.attempts !== undefined ? { attempts: opts.attempts } : {}),
         ...(opts?.lastError !== undefined ? { lastError: opts.lastError } : {}),
      });
  }

  async approve(shotId: string): Promise<void> {
    this.db.updateShotState(shotId, 'APPROVED');
  }

  /**
   * Edit = image-to-image with the rejected image as reference: submit a new
   * image job directly (IN_REVIEW -> IMAGE_QUEUED) instead of routing through
   * PROMPTED like Redo does. (T-01 finding 2 / Fable-approved contract change:
   * ImageJobSpec.referenceImagePath.)
   */
  async requestEdit(shotId: string, instructions: string): Promise<void> {
    const shot = this.db.getShot(shotId);
    if (!shot) throw new Error(`requestEdit: shot not found: ${shotId}`);
    const prompt = `${shot.imagePrompt ?? ''} ${instructions}`.trim();
    await this.submitImageForShot(shot, { prompt, referenceImagePath: shot.imagePath });
  }

  /**
   * Redo = fresh generation, no reference image. Per Fable's T-04 contract
   * decision (T-11 finding 2): if the caller supplies a rewritten prompt, use
   * it verbatim (desktop's "Rewrite prompt" box always sends one); otherwise
   * regenerate via the PromptEngine (mobile's "Redo (generate fresh prompt)"
   * sends none). Submits directly (IN_REVIEW -> IMAGE_QUEUED, like Edit) so a
   * shot never sits PROMPTED without a real prompt.
   */
  async requestRedo(shotId: string, prompt?: string): Promise<void> {
    const shot = this.db.getShot(shotId);
    if (!shot) throw new Error(`requestRedo: shot not found: ${shotId}`);
    let finalPrompt = prompt;
    if (!finalPrompt) {
       const elements = this.db.listElements();
       const [generated] = await this.prompts.imagePromptBatch([shot.line], elements, this.config.styleBible);
       finalPrompt = generated?.imagePrompt;
       if (!finalPrompt) throw new Error(`requestRedo: prompt engine returned no prompt for shot ${shotId}`);
    }
    await this.submitImageForShot(shot, { prompt: finalPrompt });
  }

  /**
   * Same rule as requestRedo (Fable's T-04 contract decision): a supplied
   * prompt is used verbatim; otherwise regenerate via the PromptEngine.
   * Always resubmits against the same start_image (shot.imagePath).
   */
  async redoAnimation(shotId: string, prompt?: string): Promise<void> {
    const shot = this.db.getShot(shotId);
    if (!shot) throw new Error(`redoAnimation: shot not found: ${shotId}`);
    const finalPrompt = prompt || (await this.prompts.animationPrompt(shot, this.db.listElements()));
    await this.submitVideoForShot(shot, finalPrompt);
  }
}
