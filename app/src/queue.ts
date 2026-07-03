import { randomUUID } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
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

export class ShotQueue {
  private db: ProjectDb;
  private provider: GenProvider;
  private prompts: PromptEngine;
  private config: PipelineConfig;
  private project: Project;

  constructor(db: ProjectDb, provider: GenProvider, prompts: PromptEngine, config: PipelineConfig) {
    this.db = db;
    this.provider = provider;
    this.prompts = prompts;
    this.config = config;
    this.project = db.getProject()!;
  }

  async run(opts: { autoApprove: boolean }): Promise<void> {
    let idleCount = 0;
    while (true) {
      const shots = this.db.listShots();
      const allPlaced = shots.length > 0 && shots.every((s: Shot) => s.state === 'PLACED');
      
      if (shots.length > 0 && allPlaced) {
         break;
      }

      const elements = this.db.listElements();
      const openJobs = this.db.listOpenJobs();
      let workDone = false;

      // 1. Poll in-flight jobs
      for (const job of openJobs) {
        try {
           const result = await this.provider.poll(job.id);
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
                    const finalPath = await this.provider.download(result, destPath);
                    if (job.kind === 'image') {
                       this.db.updateShotState(shot.id, 'IMAGE_READY', { imagePath: finalPath, attempts: 0, lastError: undefined });
                    } else {
                       this.db.updateShotState(shot.id, 'VIDEO_READY', { videoPath: finalPath, attempts: 0, lastError: undefined });
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
         
         const spec: ImageJobSpec = {
            kind: 'image',
            prompt: shot.imagePrompt!,
            elementIds: shot.elementIds,
            model: this.config.models.image,
            aspectRatio: this.config.aspectRatio
         };
         const cost = await this.provider.preflightCost(spec);
         const jobId = await this.provider.submitImage(spec);
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
            createdAt: new Date().toISOString()
         });
         this.db.updateShotState(shot.id, 'IMAGE_QUEUED', { imageJobId: jobId });
         availableConcurrency--;
         workDone = true;
      }
      
      // E. PENDING -> PROMPTED
      const pendingShots = currentShots.filter((s: Shot) => s.state === 'PENDING');
      if (pendingShots.length > 0 && imageReadyCount < this.config.bufferSize) {
         const batch = pendingShots.slice(0, 5); 
         const lines = batch.map((s: Shot) => s.line);
         const generated = await this.prompts.imagePromptBatch(lines, elements, this.config.styleBible);
         for (const g of generated) {
            const shot = batch.find((s: Shot) => s.lineIndex === g.lineIndex);
            if (shot) {
               this.db.updateShotState(shot.id, 'PROMPTED', { imagePrompt: g.imagePrompt });
               workDone = true;
            }
         }
      }

      // Retry FAILED if attempts < 3
      for (const shot of currentShots.filter((s: Shot) => s.state === 'FAILED')) {
         if (shot.attempts < 3) {
            this.db.updateShotState(shot.id, 'PENDING', { attempts: shot.attempts + 1 });
            workDone = true;
         }
      }

      if (!workDone) {
         idleCount++;
      } else {
         idleCount = 0;
      }
      
      // Safety break if we are stuck and have no open jobs
      if (idleCount > 10 && this.db.listOpenJobs().length === 0) {
         console.log("Queue idle and no open jobs. Exiting run loop.");
         break;
      }

      await new Promise(r => setTimeout(r, 2000));
    }
  }

  private async submitVideoForShot(shot: Shot, animPrompt: string): Promise<void> {
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
      const cost = await this.provider.preflightCost(spec);
      const jobId = await this.provider.submitVideo(spec);
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
         createdAt: new Date().toISOString()
      });
      this.db.updateShotState(shot.id, 'VIDEO_QUEUED', { videoJobId: jobId, videoSeconds, animationPrompt: animPrompt });
  }

  async approve(shotId: string): Promise<void> {
    this.db.updateShotState(shotId, 'APPROVED');
  }

  async requestEdit(shotId: string, instructions: string): Promise<void> {
    const shot = this.db.getShot(shotId);
    this.db.updateShotState(shotId, 'PROMPTED', { 
       imagePrompt: (shot?.imagePrompt || '') + ' ' + instructions 
    });
  }

  async requestRedo(shotId: string): Promise<void> {
    this.db.updateShotState(shotId, 'PROMPTED', { imagePrompt: undefined });
  }

  async redoAnimation(shotId: string, newPrompt: string): Promise<void> {
    const shot = this.db.getShot(shotId);
    if (!shot) throw new Error("Shot not found");
    await this.submitVideoForShot(shot, newPrompt);
  }
}
