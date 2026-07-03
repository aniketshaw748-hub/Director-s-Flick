/**
 * scale-test.ts — T-74 100-shot pre-pilot scale test (Opus).
 *
 * Runs the FULL headless pipeline at N=100 shots with a MOCK provider — ZERO
 * credits, no network, no live API. Local ffmpeg only (real trim/concat/mux
 * export + a synthetic template clip and silent VO). NOT a vitest test (lives
 * outside src/**, so it never runs in or affects the suite); run on demand:
 *
 *   cd app && npx tsx scripts/scale-test.ts
 *
 * Measures, and prints as a numbers table: queue throughput + tick count at
 * concurrency 4 and 6 (the 2s production tick is accelerated to 20ms so the
 * fixed pacing constant doesn't dominate — ticks are counted so the production
 * drain floor can be projected), 'shotEvent' volume (== the WS stream the
 * server forwards), peak RSS + heap growth, the listShots() sync/review-deck
 * payload size, and export wall-clock + final.mp4 duration vs the alignment.
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { ProjectDb } from '../src/db.js';
import { ShotQueue } from '../src/queue.js';
import { computeTimeline, planShots } from '../src/align.js';
import { exportTimeline, probeDuration } from '../src/media.js';
import { DEFAULT_CONFIG } from '../src/types.js';
import type { AlignedLine, GenProvider, JobResult, PromptEngine, Shot, WordTiming } from '../src/types.js';

const N = 100;
const STEP = 4.0; // seconds between line starts
const SPOKEN = 3.2; // spoken length per line (< 15s -> no sub-shot splits)
const PROJECTS_ROOT = path.resolve('projects');
const SCRATCH = path.resolve('projects', '_scale_scratch');

function log(msg: string) {
  process.stdout.write(msg + '\n');
}

// --- synthetic alignment ----------------------------------------------------
function makeAligned(n: number): AlignedLine[] {
  return Array.from({ length: n }, (_, i): AlignedLine => {
    const start = +(i * STEP + 0.1).toFixed(3);
    const end = +(start + SPOKEN).toFixed(3);
    const wordCount = 6;
    const words: WordTiming[] = Array.from({ length: wordCount }, (_, w) => {
      const ws = +(start + (SPOKEN * w) / wordCount).toFixed(3);
      const we = +(start + (SPOKEN * (w + 1)) / wordCount).toFixed(3);
      return { word: `w${w}`, start: ws, end: we };
    });
    return {
      index: i,
      text: `Line ${i + 1} of the synthetic scale-test narration, spoken by a calm narrator.`,
      start,
      end,
      words,
    };
  });
}

// --- mock provider: instant, zero-credit, writes REAL files -----------------
function mockProvider(clipTemplate: string): GenProvider {
  return {
    name: 'mock-scale',
    preflightCost: async () => 0,
    submitImage: async () => `img-${randomUUID()}`,
    submitVideo: async () => `vid-${randomUUID()}`,
    poll: async (jobId: string): Promise<JobResult> => ({
      jobId,
      status: 'completed',
      resultUrl: 'file:///mock/result',
      creditsCharged: 0,
    }),
    download: async (_result: JobResult, destPath: string): Promise<string> => {
      if (destPath.endsWith('.mp4')) {
        fs.copyFileSync(clipTemplate, destPath); // real clip so ffmpeg export works
      } else {
        fs.writeFileSync(destPath, 'x'); // tiny image placeholder (unused by mock video)
      }
      return destPath;
    },
  };
}

const prompts: PromptEngine = {
  imagePromptBatch: async (lines) => lines.map((l) => ({ lineIndex: l.index, imagePrompt: `prompt ${l.index}` })),
  animationPrompt: async () => 'slow push-in',
};

function freshProject(name: string, voPath: string, shots: Shot[]): ProjectDb {
  const dir = path.join(PROJECTS_ROOT, name);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const db = new ProjectDb(name, path.join(dir, 'pipeline.db'));
  const project = db.ensureProject({ name, scriptPath: 'synthetic.txt', voPath });
  db.insertShots(shots.map((s) => ({ ...s, projectId: project.id })));
  return db;
}

// Accelerate the queue's hardcoded 2s inter-tick sleep to 20ms and COUNT ticks
// so the production drain floor (ticks * 2s) can be projected honestly.
let tickCount = 0;
const realSetTimeout = global.setTimeout;
global.setTimeout = ((fn: (...a: unknown[]) => void, ms?: number, ...a: unknown[]) => {
  if (ms === 2000) {
    tickCount++;
    return realSetTimeout(fn, 20, ...a);
  }
  return realSetTimeout(fn, ms, ...a);
}) as typeof global.setTimeout;

interface RunMetrics {
  concurrency: number;
  wallMs: number;
  ticks: number;
  placed: number;
  edl: number;
  events: number;
  byState: Record<string, number>;
  peakRssMb: number;
  heapGrowthMb: number;
  syncPayloadKb: number;
  credits: number;
}

async function runQueue(name: string, concurrency: number, voPath: string, template: string): Promise<RunMetrics> {
  const aligned = makeAligned(N);
  const timeline = computeTimeline(aligned);
  const shots = planShots(randomUUID(), timeline, aligned);
  const db = freshProject(name, voPath, shots);
  const q = new ShotQueue(db, mockProvider(template), prompts, { ...DEFAULT_CONFIG, concurrency });

  let events = 0;
  const byState: Record<string, number> = {};
  q.on('shotEvent', (e: { state: string }) => {
    events++;
    byState[e.state] = (byState[e.state] ?? 0) + 1;
  });

  let peakRss = 0;
  const rssTimer = realSetTimeout;
  const heap0 = process.memoryUsage().heapUsed;
  const memInterval = setInterval(() => {
    const r = process.memoryUsage().rss;
    if (r > peakRss) peakRss = r;
  }, 25);

  tickCount = 0;
  const t0 = performance.now();
  await q.run({ autoApprove: true });
  const wallMs = performance.now() - t0;
  clearInterval(memInterval);

  const shotsAll = db.listShots();
  const placed = shotsAll.filter((s) => s.state === 'PLACED').length;
  const edl = db.listEdl().length;
  const syncPayloadKb = Buffer.byteLength(JSON.stringify(shotsAll), 'utf-8') / 1024;
  const heapGrowthMb = (process.memoryUsage().heapUsed - heap0) / 1048576;
  const credits = db.totalCredits();
  db.close();
  void rssTimer;

  return {
    concurrency,
    wallMs,
    ticks: tickCount,
    placed,
    edl,
    events,
    byState,
    peakRssMb: peakRss / 1048576,
    heapGrowthMb,
    syncPayloadKb,
    credits,
  };
}

async function main() {
  fs.mkdirSync(SCRATCH, { recursive: true });
  const template = path.join(SCRATCH, 'template.mp4');
  const voPath = path.join(SCRATCH, 'vo.wav');

  // total timeline duration for the silent VO
  const timeline = computeTimeline(makeAligned(N));
  const last = timeline[timeline.length - 1]!;
  const totalSec = Math.ceil(last.start + last.targetDuration) + 1;

  log(`[setup] generating 6s template clip + ${totalSec}s silent VO via ffmpeg...`);
  const g1 = spawnSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
    'testsrc=duration=6:size=320x240:rate=24', '-pix_fmt', 'yuv420p', template]);
  if (g1.status !== 0) throw new Error(`template ffmpeg failed: ${g1.stderr}`);
  const g2 = spawnSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
    'anullsrc=r=44100:cl=stereo', '-t', String(totalSec), voPath]);
  if (g2.status !== 0) throw new Error(`vo ffmpeg failed: ${g2.stderr}`);

  log(`[run] queue @ concurrency 4 ...`);
  const r4 = await runQueue('_scale_test_c4', 4, voPath, template);
  log(`[run] queue @ concurrency 6 ...`);
  const r6 = await runQueue('_scale_test_c6', 6, voPath, template);

  // --- export the concurrency-6 project (100 clips) ---
  log(`[export] exporting ${N} clips (real ffmpeg trim+concat+mux) ...`);
  const exDb = new ProjectDb('_scale_test_c6', path.join(PROJECTS_ROOT, '_scale_test_c6', 'pipeline.db'));
  const entries = exDb.listEdl();
  const outPath = path.join(SCRATCH, 'final.mp4');
  let exportEvents = 0;
  const et0 = performance.now();
  const finalPath = await exportTimeline(entries, voPath, outPath, {
    concurrency: 2,
    onProgress: () => {
      exportEvents++;
    },
  });
  const exportMs = performance.now() - et0;
  const finalDur = await probeDuration(finalPath);
  const expectedDur = last.start + last.targetDuration;
  exDb.close();

  // --- report ---
  const fmt = (m: RunMetrics) =>
    `  concurrency=${m.concurrency}  wall=${(m.wallMs / 1000).toFixed(2)}s  ticks=${m.ticks}  ` +
    `prodDrainFloor=${((m.ticks * 2000) / 1000).toFixed(0)}s  placed=${m.placed}/${N}  edl=${m.edl}  ` +
    `events=${m.events} (${JSON.stringify(m.byState)})  peakRss=${m.peakRssMb.toFixed(0)}MB  ` +
    `heapGrowth=${m.heapGrowthMb.toFixed(1)}MB  syncPayload=${m.syncPayloadKb.toFixed(1)}KB  credits=${m.credits}`;

  log('\n================ T-74 SCALE TEST RESULTS (N=100, mock, 0 credits) ================');
  log('QUEUE THROUGHPUT');
  log(fmt(r4));
  log(fmt(r6));
  log(`  throughput@accel-tick: c4=${(r4.placed / (r4.wallMs / 1000)).toFixed(1)} shots/s, ` +
    `c6=${(r6.placed / (r6.wallMs / 1000)).toFixed(1)} shots/s`);
  log('\nWS EVENT VOLUME (shotEvent == server WS forward)');
  log(`  c4=${r4.events} events over ${r4.ticks} ticks (${(r4.events / r4.ticks).toFixed(1)}/tick); ` +
    `c6=${r6.events} events over ${r6.ticks} ticks`);
  log('\nMEMORY');
  log(`  peak RSS c4=${r4.peakRssMb.toFixed(0)}MB c6=${r6.peakRssMb.toFixed(0)}MB; heap growth < ${Math.max(r4.heapGrowthMb, r6.heapGrowthMb).toFixed(1)}MB`);
  log('\nREVIEW-DECK / SYNC PAYLOAD');
  log(`  listShots() JSON = ${r6.syncPayloadKb.toFixed(1)}KB for ${N} shots (${(r6.syncPayloadKb * 1024 / N).toFixed(0)} bytes/shot)`);
  log('\nEXPORT (100 clips, real ffmpeg)');
  log(`  wall=${(exportMs / 1000).toFixed(2)}s  progressEvents=${exportEvents}  ` +
    `finalDuration=${finalDur.toFixed(2)}s  expected≈${expectedDur.toFixed(2)}s  ` +
    `delta=${(finalDur - expectedDur).toFixed(2)}s`);
  log('==================================================================================');

  // cleanup
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  fs.rmSync(path.join(PROJECTS_ROOT, '_scale_test_c4'), { recursive: true, force: true });
  fs.rmSync(path.join(PROJECTS_ROOT, '_scale_test_c6'), { recursive: true, force: true });
  log('[cleanup] temp project dirs removed.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
