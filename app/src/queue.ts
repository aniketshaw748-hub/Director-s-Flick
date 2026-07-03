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
  Project
} from './types.js';
import { clampVideoSeconds } from './types.js';
import { projectDir, type ProjectDb, type JobRow } from './db.js';

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
  /** Active account name (see accounts.ts), tagged onto every ledger row this
   * queue inserts. Undefined for mock runs / no account selected. */
  private accountName: string | undefined;

  constructor(
    db: ProjectDb,
    provider: GenProvider | { image: GenProvider; video: GenProvider },
    prompts: PromptEngine,
    config: PipelineConfig,
    accountName?: string,
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
    this.project = db.getProject()!;
    this.accountName = accountName;
  }

  /** Signal run() to exit at the top of its next iteration (T-27: explicit
   * start/stop from the setup flow). A stopped instance is done for good -
   * construct a new ShotQueue to resume (safe: state persists in the db). */
  stop(): void {
    this.stopped = true;
  }

  async run(opts: { autoApprove: boolean }): Promise<void> {
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
      const activeJobsCount = this.db.listOpenJobs().length;
      let availableConcurrency = this.config.concurrency - activeJobsCount;
      const imageReadyCount = currentShots.filter((s: Shot) => s.state === 'IMAGE_READY' || s.state === 'IN_REVIEW').length;
      
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
         if (availableConcurrency <= 0) break;
         let animPrompt = shot.animationPrompt;
         if (!animPrompt) {
            animPrompt = await this.prompts.animationPrompt(shot, elements);
            this.db.updateShotState(shot.id, 'APPROVED', { animationPrompt: animPrompt });
         }
         await this.submitVideoForShot(shot, animPrompt);
         availableConcurrency--;
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
         if (availableConcurrency <= 0) break;
         await this.submitImageForShot(shot);
         availableConcurrency--;
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
            // good - resubmit video only.
            await this.submitVideoForShot(shot, shot.animationPrompt, { attempts });
         } else if (shot.imageJobId && shot.imagePrompt) {
            // Image stage failed; the prompt is still good - resubmit image only.
            await this.submitImageForShot(shot, { attempts });
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

  private async submitVideoForShot(
     shot: Shot,
     animPrompt: string,
     opts?: { attempts?: number },
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
         createdAt: new Date().toISOString()
      });
      this.db.updateShotState(shot.id, 'VIDEO_QUEUED', {
         videoJobId: jobId,
         videoSeconds,
         animationPrompt: animPrompt,
         ...(opts?.attempts !== undefined ? { attempts: opts.attempts } : {}),
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
     opts?: { prompt?: string; referenceImagePath?: string; attempts?: number },
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
         createdAt: new Date().toISOString()
      });
      this.db.updateShotState(shot.id, 'IMAGE_QUEUED', {
         imageJobId: jobId,
         imagePrompt: prompt,
         ...(opts?.attempts !== undefined ? { attempts: opts.attempts } : {}),
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
