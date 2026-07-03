/**
 * cli.ts — commander entry point (cli module). `npm run cli -- <command>`.
 *
 * Commands (ARCHITECTURE.md):
 *   init     <name> --script <path> --vo <path>   create project + db
 *   align    <name>                               alignScript -> computeTimeline -> planShots -> insertShots
 *   elements <name> [--add <id:name:category>]    register/list ElementRefs
 *   accounts [--add <name>] [--status]            list/add Higgsfield accounts (T-05)
 *   run      [name] [--auto-approve] [--account <name>]  ShotQueue.run
 *            [--script <p> --vo <p> [--provider <p>] [--project <n>] [--elements <json>]]
 *            with --script/--vo: full end-to-end pipeline (init + align +
 *            queue + export + summary) in one shot — Phase 1 headless mode.
 *   status   <name>                               shots by state, open jobs, credit total
 *   export   <name> [--out <path>]                exportTimeline from EDL
 *   cost     <name>                               ledger dump + totalCredits (account-tagged)
 *
 * Output is concise and ASCII-only. Exits non-zero on failure.
 */

import { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { openProjectDb, projectDir, projectDbPath, ProjectDb } from './db.js';
import { loadConfig } from './config.js';
import type { ConfigOverrides } from './config.js';
import { alignScript, computeTimeline, planShots, AlignInputError } from './align.js';
import { createStageProviders } from './providers/index.js';
import { summarizeLedger, formatCostAmount, ledgerUnit, type CostUnit } from './cost-summary.js';
import { createPromptEngine } from './prompts.js';
import { ShotQueue } from './queue.js';
import { exportTimeline, probeDuration } from './media.js';
import { exportSrtSidecar, buildBurnFilterArgs } from './srt.js';
import { startServer } from './server.js';
import {
  listAccounts,
  addAccount,
  getAccountStatus,
  getJobAccount,
  credentialsPath as accountCredentialsPath,
} from './accounts.js';
import type {
  EDLEntry,
  ElementCategory,
  ElementRef,
  PipelineConfig,
  Project,
  ProviderName,
  Shot,
  ShotState,
} from './types.js';

// ---------------------------------------------------------------------------
// Small helpers (ASCII-only output, non-zero exit on failure)
// ---------------------------------------------------------------------------

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

function fmtSec(n: number): string {
  return n.toFixed(2);
}

function formatTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length), 1),
  );
  const line = (cells: string[]): string =>
    cells
      .map((c, i) => c.padEnd(widths[i] ?? 0))
      .join('  ')
      .trimEnd();
  return [
    line(headers),
    line(widths.map((w) => '-'.repeat(w))),
    ...rows.map((r) => line(r)),
  ].join('\n');
}

const ELEMENT_CATEGORIES: readonly ElementCategory[] = ['character', 'location', 'prop'];

function isElementCategory(v: string): v is ElementCategory {
  return (ELEMENT_CATEGORIES as readonly string[]).includes(v);
}

function parseProvider(v: string): ProviderName {
  if (v === 'mock' || v === 'higgsfield-cli' || v === 'fal' || v === 'replicate') return v;
  return fail(`invalid provider '${v}' (expected mock | higgsfield-cli | fal | replicate)`);
}

/** Parse an --add spec: `id:name:category[:thumbUrl]` (element ids are UUIDs,
 * no colons; thumbUrl may itself contain colons, e.g. https://..., so
 * everything after the category segment is rejoined verbatim). */
function parseElementSpec(spec: string): ElementRef {
  const parts = spec.split(':');
  if (parts.length < 3) {
    return fail(`invalid element spec '${spec}' (expected id:name:category[:thumbUrl])`);
  }
  const id = parts[0]!;
  const name = parts[1]!;
  const category = parts[2]!;
  const thumbUrl = parts.length > 3 ? parts.slice(3).join(':') : undefined;
  if (!id) return fail(`invalid element spec '${spec}' (empty id)`);
  if (!name) return fail(`invalid element spec '${spec}' (empty name)`);
  if (!isElementCategory(category)) {
    return fail(`invalid element category '${category}' (expected character | location | prop)`);
  }
  return thumbUrl ? { id, name, category, thumbUrl } : { id, name, category };
}

/** Parse --elements JSON: [{id,name,category,thumbUrl?}, ...]. */
function parseElementsJson(json: string): ElementRef[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    return fail(`--elements is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!Array.isArray(parsed)) return fail('--elements must be a JSON array');
  return parsed.map((e, i) => {
    if (e === null || typeof e !== 'object') return fail(`--elements[${i}] must be an object`);
    const { id, name, category, thumbUrl } = e as Record<string, unknown>;
    if (typeof id !== 'string' || !id) return fail(`--elements[${i}].id must be a string`);
    if (typeof name !== 'string' || !name) return fail(`--elements[${i}].name must be a string`);
    if (typeof category !== 'string' || !isElementCategory(category)) {
      return fail(`--elements[${i}].category must be character | location | prop`);
    }
    if (thumbUrl !== undefined && typeof thumbUrl !== 'string') {
      return fail(`--elements[${i}].thumbUrl must be a string when present`);
    }
    return thumbUrl ? { id, name, category, thumbUrl } : { id, name, category };
  });
}

function resolveExistingFile(p: string, label: string): string {
  const abs = path.resolve(p);
  if (!fs.existsSync(abs)) return fail(`${label} not found: ${abs}`);
  return abs;
}

/** Open a project db that must already exist (read-style commands never
 * create the project directory as a side effect). */
function openExistingProject(name: string): { db: ProjectDb; project: Project } {
  if (!fs.existsSync(projectDbPath(name))) {
    return fail(`project '${name}' not found - run: cli init ${name} --script <path> --vo <path>`);
  }
  const db = openProjectDb(name);
  const project = db.getProject();
  if (!project) {
    db.close();
    return fail(`project '${name}' has no project row - re-run init`);
  }
  return { db, project };
}

function ensureProjectDirs(name: string): void {
  const dir = projectDir(name);
  for (const sub of ['images', 'clips', 'export']) {
    fs.mkdirSync(path.join(dir, sub), { recursive: true });
  }
}

// ---------------------------------------------------------------------------
// Pipeline steps shared by commands
// ---------------------------------------------------------------------------

async function stepAlign(db: ProjectDb, project: Project): Promise<Shot[]> {
  const outJson = path.join(projectDir(project.name), 'alignment.json');
  const lines = await alignScript(project.scriptPath, project.voPath, outJson);
  const timeline = computeTimeline(lines);
  const shots = planShots(project.id, timeline, lines);
  db.insertShots(shots);
  console.log(`aligned ${lines.length} lines -> ${shots.length} shots`);
  console.log(
    formatTable(
      ['line', 'sub', 'start', 'end', 'dur', 'pause', 'target'],
      shots.map((s: Shot) => [
        String(s.lineIndex),
        String(s.subIndex),
        fmtSec(s.line.start),
        fmtSec(s.line.end),
        fmtSec(s.line.duration),
        fmtSec(s.line.pauseAfter),
        fmtSec(s.line.targetDuration),
      ]),
    ),
  );
  return db.listShots();
}

/**
 * EDL entries live in the db (queue.ts writes one per shot on PLACED).
 * As a safety net, synthesize any missing entry from a PLACED shot using the
 * timeline-rule invariants: timelineStart = line.start,
 * duration = line.targetDuration, inPoint = 0, outPoint = targetDuration.
 */
function ensureEdl(db: ProjectDb, project: Project): EDLEntry[] {
  const have = new Set(db.listEdl().map((e) => e.shotId));
  for (const shot of db.listShots('PLACED')) {
    if (have.has(shot.id) || !shot.videoPath) continue;
    db.upsertEdlEntry({
      id: randomUUID(),
      projectId: project.id,
      shotId: shot.id,
      lineIndex: shot.lineIndex,
      clipPath: shot.videoPath,
      inPoint: 0,
      outPoint: shot.line.targetDuration,
      timelineStart: shot.line.start,
      duration: shot.line.targetDuration,
    });
  }
  return db.listEdl();
}

async function stepRunQueue(
  db: ProjectDb,
  config: PipelineConfig,
  autoApproveFlag: boolean,
  accountName?: string,
): Promise<void> {
  const imageProv = config.imageProvider ?? config.provider;
  const videoProv = config.videoProvider ?? config.provider;
  // Phase 1 has no review UI: all-mock runs always auto-approve. When a real
  // provider is in the mix, require an explicit --auto-approve so unreviewed
  // shots never spend credits/$ by default.
  const autoApprove = autoApproveFlag || (imageProv === 'mock' && videoProv === 'mock');
  const realStages = [...new Set([imageProv, videoProv])].filter((p) => p !== 'mock');
  if (realStages.length > 0) {
    console.log(`provider(s): ${realStages.join(', ')} (REAL credits/$ will be spent)`);
    if (accountName) console.log(`account: ${accountName}`);
  }
  console.log(
    `running queue (image=${imageProv}, video=${videoProv}, auto-approve=${autoApprove ? 'on' : 'off'})`,
  );
  const providers = createStageProviders(
    config,
    accountName ? { credentialsPath: accountCredentialsPath(accountName), accountName } : undefined,
  );
  const prompts = createPromptEngine(config);
  const queue = new ShotQueue(db, providers, prompts, config, accountName);
  await queue.run({ autoApprove });
}

async function stepExport(db: ProjectDb, project: Project, outPath: string): Promise<string> {
  const entries = ensureEdl(db, project);
  if (entries.length === 0) return fail('EDL is empty - nothing to export (run the queue first)');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const finalPath = await exportTimeline(entries, project.voPath, outPath);
  return finalPath;
}

async function printSummary(db: ProjectDb, finalPath?: string): Promise<void> {
  const shots = db.listShots();
  console.log('');
  console.log(
    formatTable(
      ['line', 'sub', 'state', 'start', 'target', 'clip_s'],
      shots.map((s) => [
        String(s.lineIndex),
        String(s.subIndex),
        s.state,
        fmtSec(s.line.start),
        fmtSec(s.line.targetDuration),
        s.videoSeconds !== undefined ? String(s.videoSeconds) : '-',
      ]),
    ),
  );
  const placed = shots.filter((s) => s.state === 'PLACED').length;
  const failed = shots.filter((s) => s.state === 'FAILED').length;
  console.log(`shots: ${shots.length} total, ${placed} placed, ${failed} failed`);
  console.log(`credits: ${db.totalCredits().toFixed(2)}`);
  if (finalPath) {
    console.log(`output: ${finalPath}`);
    const dur = await probeDuration(finalPath);
    console.log(`final duration: ${fmtSec(dur)}s (ffprobe)`);
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const program = new Command();
program
  .name('directors-flick')
  .description('Local AI-video pipeline: script + VO -> aligned shots -> images -> videos -> export');

program
  .command('init')
  .description('create project + db')
  .argument('<name>', 'project name (folder under app/projects/)')
  .requiredOption('--script <path>', 'narration script .txt')
  .requiredOption('--vo <path>', 'voiceover .wav')
  .action((name: string, opts: { script: string; vo: string }) => {
    const scriptPath = resolveExistingFile(opts.script, 'script');
    const voPath = resolveExistingFile(opts.vo, 'voiceover');
    const config = loadConfig(name);
    const db = openProjectDb(name);
    try {
      ensureProjectDirs(name);
      const project = db.ensureProject({ name, scriptPath, voPath, config });
      console.log(`project '${project.name}' ready (id ${project.id})`);
      console.log(`dir: ${projectDir(name)}`);
      console.log(`script: ${project.scriptPath}`);
      console.log(`vo: ${project.voPath}`);
      console.log(`provider: ${project.config.provider}`);
    } finally {
      db.close();
    }
  });

program
  .command('align')
  .description('align VO to script, apply timeline rule, plan shots into db')
  .argument('<name>', 'project name')
  .action(async (name: string) => {
    const { db, project } = openExistingProject(name);
    try {
      await stepAlign(db, project);
    } finally {
      db.close();
    }
  });

program
  .command('elements')
  .description('register/list element refs (Higgsfield element UUIDs)')
  .argument('<name>', 'project name')
  .option(
    '--add <id:name:category>',
    'register an element (repeatable); category: character | location | prop',
    (val: string, acc: string[]) => [...acc, val],
    [] as string[],
  )
  .action((name: string, opts: { add: string[] }) => {
    const { db, project } = openExistingProject(name);
    try {
      for (const spec of opts.add) {
        db.upsertElement(project.id, parseElementSpec(spec));
      }
      const elements = db.listElements();
      if (elements.length === 0) {
        console.log('no elements registered');
      } else {
        console.log(
          formatTable(
            ['id', 'name', 'category'],
            elements.map((e) => [e.id, e.name, e.category]),
          ),
        );
      }
    } finally {
      db.close();
    }
  });

program
  .command('accounts')
  .description('list registered Higgsfield accounts, or add a new one (T-05)')
  .option('--add <name>', 'register a new account: spawns `higgsfield auth login` scoped to it')
  .option('--status', 'fetch live auth/balance status for each listed account (spawns the CLI)')
  .action(async (opts: { add?: string; status?: boolean }) => {
    if (opts.add) {
      console.log(`spawning: higgsfield auth login (account '${opts.add}')`);
      const result = await addAccount(opts.add);
      if (result.code === 0) {
        console.log(`account '${opts.add}' ready`);
      } else {
        return fail(`auth login exited with code ${result.code}: ${result.stderr || result.stdout}`);
      }
      return;
    }
    const names = listAccounts();
    if (names.length === 0) {
      console.log('no accounts registered - use: cli accounts --add <name>');
      return;
    }
    if (opts.status) {
      for (const name of names) {
        const s = await getAccountStatus(name);
        const balance = s.balance !== null ? `${s.balance.toFixed(2)} credits` : 'balance unknown';
        console.log(`${name}: ${s.authenticated ? balance : 'not authenticated'}`);
      }
    } else {
      console.log(formatTable(['name'], names.map((n) => [n])));
    }
  });

program
  .command('run')
  .description(
    'run the shot queue; with --script/--vo runs the full pipeline end-to-end (init+align+queue+export)',
  )
  .argument('[name]', 'project name (or use --project)')
  .option('--auto-approve', 'approve images without review (Phase 1 CLI mode)')
  .option('--script <path>', 'narration script .txt (full-pipeline mode)')
  .option('--vo <path>', 'voiceover .wav (full-pipeline mode)')
  .option('--provider <provider>', 'mock | higgsfield-cli | fal (default for both stages)')
  .option('--image-provider <provider>', 'image-stage provider (overrides --provider for images)')
  .option('--video-provider <provider>', 'video-stage provider (overrides --provider for video, e.g. fal)')
  .option('--project <name>', 'project name (full-pipeline mode)')
  .option('--elements <json>', 'JSON array of {id,name,category} to register')
  .option('--account <name>', 'use a specific account\'s credentials (see: cli accounts)')
  .action(
    async (
      nameArg: string | undefined,
      opts: {
        autoApprove?: boolean;
        script?: string;
        vo?: string;
        provider?: string;
        imageProvider?: string;
        videoProvider?: string;
        project?: string;
        elements?: string;
        account?: string;
      },
    ) => {
      const overrides: ConfigOverrides = {};
      if (opts.provider !== undefined) overrides.provider = parseProvider(opts.provider);
      if (opts.imageProvider !== undefined) overrides.imageProvider = parseProvider(opts.imageProvider);
      if (opts.videoProvider !== undefined) overrides.videoProvider = parseProvider(opts.videoProvider);

      const fullPipeline = opts.script !== undefined || opts.vo !== undefined;
      if (fullPipeline && (opts.script === undefined || opts.vo === undefined)) {
        return fail('full-pipeline mode needs both --script and --vo');
      }

      let db: ProjectDb;
      let project: Project;
      let name: string;
      if (fullPipeline) {
        const scriptPath = resolveExistingFile(opts.script!, 'script');
        const voPath = resolveExistingFile(opts.vo!, 'voiceover');
        name =
          opts.project ??
          nameArg ??
          path.basename(scriptPath, path.extname(scriptPath)).replace(/[^A-Za-z0-9_-]+/g, '_');
        db = openProjectDb(name);
        ensureProjectDirs(name);
        project = db.ensureProject({ name, scriptPath, voPath, config: loadConfig(name, overrides) });
      } else {
        name = opts.project ?? nameArg ?? fail('project name required (positional or --project)');
        ({ db, project } = openExistingProject(name));
      }

      try {
        const config = loadConfig(name, overrides);
        if (JSON.stringify(config) !== JSON.stringify(project.config)) {
          db.saveConfig(project.id, config);
        }

        if (opts.elements !== undefined) {
          const elements = parseElementsJson(opts.elements);
          for (const el of elements) db.upsertElement(project.id, el);
          console.log(`registered ${elements.length} elements`);
        }

        if (db.listShots().length === 0) {
          if (!fullPipeline) {
            return fail(`no shots planned - run: cli align ${name}`);
          }
          await stepAlign(db, project);
        } else {
          console.log(`shots already planned (${db.listShots().length}) - skipping align`);
        }

        await stepRunQueue(db, config, Boolean(opts.autoApprove), opts.account);

        let finalPath: string | undefined;
        if (fullPipeline) {
          finalPath = await stepExport(
            db,
            project,
            path.join(projectDir(name), 'export', 'final.mp4'),
          );
        }
        await printSummary(db, finalPath);

        if (db.listShots('FAILED').length > 0) {
          return fail('one or more shots FAILED');
        }
      } finally {
        db.close();
      }
    },
  );

program
  .command('status')
  .description('shots by state, open jobs, credit total')
  .argument('<name>', 'project name')
  .action((name: string) => {
    const { db } = openExistingProject(name);
    try {
      const shots = db.listShots();
      const states: ShotState[] = [
        'PENDING',
        'PROMPTED',
        'IMAGE_QUEUED',
        'IMAGE_READY',
        'IN_REVIEW',
        'APPROVED',
        'VIDEO_QUEUED',
        'VIDEO_READY',
        'PLACED',
        'FAILED',
      ];
      const rows = states
        .map((st): [ShotState, number] => [st, shots.filter((s) => s.state === st).length])
        .filter(([, n]) => n > 0)
        .map(([st, n]) => [st, String(n)]);
      console.log(rows.length ? formatTable(['state', 'shots'], rows) : 'no shots');
      console.log(`total shots: ${shots.length}`);
      console.log(`open jobs: ${db.listOpenJobs().length}`);
      console.log(`credits: ${db.totalCredits().toFixed(2)}`);
    } finally {
      db.close();
    }
  });

program
  .command('export')
  .description('export the timeline (EDL -> trim -> concat -> VO mux -> final MP4)')
  .argument('<name>', 'project name')
  .option('--out <path>', 'output MP4 path (default: <project>/export/final.mp4)')
  .option('--srt', 'also write a per-line .srt caption sidecar next to the MP4')
  .option('--burn', 'construct the ffmpeg subtitles-filter args (implies --srt); does not re-encode')
  .action(async (name: string, opts: { out?: string; srt?: boolean; burn?: boolean }) => {
    const { db, project } = openExistingProject(name);
    try {
      const outPath = path.resolve(opts.out ?? path.join(projectDir(name), 'export', 'final.mp4'));
      const finalPath = await stepExport(db, project, outPath);
      console.log(`output: ${finalPath}`);
      const dur = await probeDuration(finalPath);
      console.log(`final duration: ${fmtSec(dur)}s (ffprobe)`);
      if (opts.srt || opts.burn) {
        const alignmentPath = path.join(projectDir(name), 'alignment.json');
        const srtPath = exportSrtSidecar(finalPath, alignmentPath);
        console.log(`captions: ${srtPath}`);
        if (opts.burn) {
          // Construct only; execution stays with the export pipeline (see srt.ts).
          console.log(`burn args: ${buildBurnFilterArgs(srtPath).join(' ')}`);
        }
      }
    } finally {
      db.close();
    }
  });

program
  .command('cost')
  .description('cost ledger dump + total credits')
  .argument('<name>', 'project name')
  .action((name: string) => {
    const { db } = openExistingProject(name);
    try {
      const entries = db.listLedger();
      if (entries.length === 0) {
        console.log('ledger is empty');
        return;
      }
      console.log(
        formatTable(
          ['id', 'kind', 'model', 'provider', 'unit', 'preflight', 'charged', 'account', 'job'],
          entries.map((e) => [
            String(e.id ?? '-'),
            e.kind,
            e.model,
            e.provider ?? '-',
            ledgerUnit(e),
            e.preflightCredits === null ? '-' : e.preflightCredits.toFixed(2),
            e.chargedCredits === null ? '-' : e.chargedCredits.toFixed(2),
            // Prefer the ledger row's own account_name (written at insert
            // time since T-32); fall back to the _usage.json map for rows
            // written before that column existed.
            e.accountName ?? getJobAccount(e.jobId) ?? '-',
            e.jobId,
          ]),
        ),
      );
      // Unit-aware totals (T-46): credits and usd are reported separately -
      // never summed (higgsfield prices in credits, fal in dollars).
      const summary = summarizeLedger(entries);
      console.log('');
      for (const [unit, amount] of Object.entries(summary.totals)) {
        console.log(`total ${unit}: ${formatCostAmount(unit as CostUnit, amount)}`);
      }
      // Per-account per-unit subtotals when the ledger spans >1 account/unit.
      if (summary.byAccount.length > 1) {
        console.log('by account:');
        for (const b of summary.byAccount) {
          console.log(
            `  ${b.accountName ?? '(none)'} · ${formatCostAmount(b.unit, b.total)} (${b.entryCount})`,
          );
        }
      }
    } finally {
      db.close();
    }
  });

program
  .command('serve')
  .description('start the backend web server for UI and WebSocket communication')
  .option('--port <port>', 'port to listen on', '4000')
  .action((opts: { port: string }) => {
    startServer(parseInt(opts.port, 10));
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  if (err instanceof AlignInputError) {
    // Expected input-validation failure (T-78/T-81): print the friendly
    // one-liner only — a JS stack + embedded ffprobe internals would bury it.
    fail(err.message);
  } else {
    fail(err instanceof Error ? (err.stack ?? err.message) : String(err));
  }
});
