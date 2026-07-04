import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { ProjectDb, openProjectDb, projectDir, PROJECTS_ROOT, APP_ROOT } from './db.js';
import { loadConfig, mergeLayer, type ConfigOverrides } from './config.js';
import { createStageProviders } from './providers/index.js';
import { createPromptEngine } from './prompts.js';
import { ShotQueue, type ShotEvent } from './queue.js';
import {
  listAccounts,
  accountExists,
  getActiveAccount,
  setActiveAccount,
  getAccountStatus,
  addAccount,
  credentialsPath,
} from './accounts.js';
import { alignScriptEx, computeTimeline, planShots } from './align.js';
import { exportTimeline, type ExportProgressEvent } from './media.js';
import { exportSrtSidecar } from './srt.js';
import { summarizeLedger } from './cost-summary.js';
import type { AccountStatus } from './accounts.js';
import type { ElementCategory, ProviderName, Project } from './types.js';

const PROVIDER_NAMES: readonly ProviderName[] = ['mock', 'higgsfield-cli', 'fal', 'replicate'];
const PROMPT_BACKENDS = ['template', 'llm'] as const;
const SEGMENTATION_MODES = ['llm', 'heuristic'] as const;
const CONFIG_PATCH_KEYS = new Set([
   'provider',
   'imageProvider',
   'videoProvider',
   'models',
   'styleBible',
   'accountName',
   'promptBackend',
   'llmModel',
   'segmentation',
   'maxShotSeconds',
   'activeChunk',
]);
const MODEL_PATCH_KEYS = new Set(['image', 'video', 'videoMode']);
// T-84 amendment (Opus audit + Fable ruling): the JSON+base64 create-project
// path still fully decodes the VO into a server-RAM Buffer - fine only for
// small payloads. Cap it by CONTRACT, not by hope, so a future large caller
// can't reintroduce the exact server-side OOM risk multipart was added to
// avoid; anything bigger must use the streaming multipart path instead.
const MAX_JSON_VO_BYTES = 20 * 1024 * 1024; // 20MB decoded

const ELEMENT_CATEGORIES: readonly ElementCategory[] = ['character', 'location', 'prop'];

interface OpenProject {
  db: ProjectDb;
  queue: ShotQueue;
}

export function startServer(port = 4000) {
  const app = express();
  app.use(cors());
  // T-38 BUG 1 (dispatch) + T-84 amendment (limit): POST /api/projects gets
  // its own JSON parser separate from every other (small hand-typed JSON)
  // endpoint - this body-parser version has no "already parsed" guard, so
  // two express.json() calls can't safely stack on one request (the second
  // would try to re-read an already-drained stream), hence dispatch to
  // exactly one parser per request. The limit here used to be 500mb (large
  // real VOs arrived as base64-in-JSON) - now that multipart (T-84) is the
  // real path for big voiceovers, the JSON path is CONTRACTUALLY small-
  // payload-only (MAX_JSON_VO_BYTES below enforces the exact 20MB-decoded
  // boundary with a helpful message); this raw limit is just defense in
  // depth so an oversized request body never gets fully buffered at all.
  const smallJsonParser = express.json({ limit: '2mb' });
  const projectCreateJsonParser = express.json({ limit: '30mb' });
  app.use((req, res, next) => {
     if (req.method === 'POST' && req.path === '/api/projects') {
        projectCreateJsonParser(req, res, next);
     } else {
        smallJsonParser(req, res, next);
     }
  });
  // body-parser rejects an over-limit raw body BEFORE any route handler runs
  // (entity.too.large) - without this, that surfaces as Express's default
  // HTML error page instead of the same clean JSON shape every other 413/400
  // on this route uses.
  app.use((err: any, _req: express.Request, res: express.Response, next: express.NextFunction) => {
     if (err?.type === 'entity.too.large' || err?.status === 413) {
        res.status(413).json({ error: 'request body too large - use multipart/form-data (vo file field) for large voiceovers' });
        return;
     }
     next(err);
  });

  // T-84: multipart/form-data upload for POST /api/projects (live OOM fix -
  // base64-in-JSON held an entire real VO, ~3x-inflated, in the browser tab's
  // memory; multer streams the file part straight to a temp file on disk,
  // never buffering it in RAM). The temp dir is on the SAME volume as
  // PROJECTS_ROOT (both under APP_ROOT) so moving the upload into the real
  // project dir once its name is known is a cheap rename, not a copy - this
  // also sidesteps any dependency on `name`/`vo` field arrival order in the
  // multipart body. Applied as route-level middleware only: multer no-ops
  // for non-multipart requests (content-type mismatch), so the JSON path
  // above keeps working unchanged for small hand-built payloads.
  const uploadTmpDir = path.join(APP_ROOT, 'tmp-uploads');
  fs.mkdirSync(uploadTmpDir, { recursive: true });
  const upload = multer({
     storage: multer.diskStorage({
        destination: (_req, _file, cb) => cb(null, uploadTmpDir),
        filename: (_req, _file, cb) => cb(null, randomUUID()),
     }),
     limits: { fileSize: 2 * 1024 * 1024 * 1024 }, // 2GB ceiling, not a buffering limit
  });
  // multer surfaces malformed multipart requests (wrong file field name,
  // over the size limit, corrupt boundary, etc.) by calling next(err) -
  // uncaught, that falls through to Express's default HTML error page. Wrap
  // it so a bad multipart request gets the same clean JSON 400 shape as
  // every other validation failure on this route.
  const uploadVoField: express.RequestHandler = (req, res, next) => {
     upload.single('vo')(req, res, (err: unknown) => {
        if (err) {
           if (req.file) {
              try {
                 fs.unlinkSync(req.file.path);
              } catch {
                 // best-effort only
              }
           }
           const message = err instanceof Error ? err.message : String(err);
           res.status(400).json({ error: `multipart upload error: ${message}` });
           return;
        }
        next();
     });
  };

  const server = createServer(app);
  const wss = new WebSocketServer({ server });

  // Map of projectName -> Set<WebSocket>
  const clients = new Map<string, Set<WebSocket>>();
  // One ProjectDb + one live ShotQueue per project, for the server's lifetime
  // (fixes the earlier per-request connection leak; also lets the review-gate
  // actions below delegate straight to the queue instead of re-implementing
  // its state-machine logic).
  const openProjects = new Map<string, OpenProject>();
  // Names with a currently-looping queue.run() (T-27: explicit start/stop -
  // an entry can exist in openProjects, for reads, while stopped).
  const runningProjects = new Set<string>();
  // Balance cache for the polling cost-meter widget (T-36) - avoids spawning
  // `higgsfield account status` on every poll tick. GET .../status (T-05)
  // stays uncached for on-demand checks (e.g. opening the account switcher).
  const BALANCE_CACHE_MS = 60_000;
  const balanceCache = new Map<string, { status: AccountStatus; fetchedAt: number }>();

  function broadcast(projectName: string, payload: unknown): void {
    const wsClients = clients.get(projectName);
    if (!wsClients || wsClients.size === 0) return;
    const msg = JSON.stringify(payload);
    for (const client of wsClients) {
      if (client.readyState === WebSocket.OPEN) client.send(msg);
    }
  }

  /** Build a fresh db+queue pair for a project (does not start the loop). */
  function buildProjectEntry(name: string, db: ProjectDb): OpenProject {
    const config = loadConfig(name);
    const activeAccount = getActiveAccount(name);
    const providers = createStageProviders(
      config,
      activeAccount ? { credentialsPath: credentialsPath(activeAccount), accountName: activeAccount } : undefined,
    );
    const prompts = createPromptEngine(config);
    const queue = new ShotQueue(db, providers, prompts, config, activeAccount ?? undefined);
    queue.on('shotEvent', (evt: ShotEvent) => {
      broadcast(name, { type: 'shotEvent', ...evt });
    });
    return { db, queue };
  }

  /** Start (or resume) a project entry's review-gate loop in the background. */
  function startQueueLoop(name: string, entry: OpenProject): void {
    runningProjects.add(name);
    entry.queue
      .run({ autoApprove: false })
      .catch((err) => {
        console.error(`[server] queue.run failed for project '${name}':`, err);
        // Drop the cached entry so a later request/connection reopens (and
        // retries) the project instead of leaving it permanently stuck.
        openProjects.delete(name);
      })
      .finally(() => {
        runningProjects.delete(name);
      });
  }

  /** Remove the shell db files openProjectDb() creates on first open, and the
   * directory itself if nothing else (script/voiceover) was ever written
   * there. Only removes the specific sqlite files it knows it created - never
   * a blind rm -rf of the whole dir - so a concurrent legitimate
   * POST /api/projects for this same name (mid-write) is never touched. */
  function cleanupShellProjectDir(name: string): void {
     const dir = projectDir(name);
     for (const suffix of ['', '-wal', '-shm']) {
        const f = path.join(dir, `pipeline.db${suffix}`);
        if (fs.existsSync(f)) fs.rmSync(f, { force: true });
     }
     if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) {
        fs.rmSync(dir, { recursive: true, force: true });
     }
  }

  /**
   * Stop and evict a project's cached entry, if one exists (T-62). Awaits
   * genuine queue termination BEFORE dropping it from the cache - the
   * account-switch and config-PATCH endpoints below both need the next
   * access to rebuild fresh against new credentials/config, but evicting
   * without stopping first orphans the old queue's still-running loop with
   * no way to reach it again (openProjects.get() would find nothing), which
   * either keeps ticking forever in production (wasted polling against a db
   * nobody's watching) or throws "database connection is not open" the
   * moment something else closes that db (exactly what surfaced in tests).
   */
  async function evictProjectEntry(name: string): Promise<void> {
     const entry = openProjects.get(name);
     if (!entry) return;
     await entry.queue.stop();
     openProjects.delete(name);
  }

  /**
   * Open (or reuse) a project's db + a live ShotQueue. On a true cache miss
   * (never opened this server session) this also starts the review-gate loop
   * (autoApprove: false — shots stop at IN_REVIEW for the API below to
   * approve/edit/redo). Once cached, further calls just return the existing
   * entry WITHOUT restarting its loop if it was explicitly stopped (T-27) -
   * only POST .../run does that. Idempotent per project name.
   *
   * Throws for a project that doesn't exist (T-38 BUG 2) rather than silently
   * creating+caching a shell db and a ShotQueue that would crash on its first
   * submit — callers must catch and turn this into a 404.
   */
  function getOrOpenProject(name: string): OpenProject {
    const existing = openProjects.get(name);
    if (existing) return existing;

    const db = openProjectDb(name);
    if (!db.getProject()) {
       db.close();
       cleanupShellProjectDir(name);
       throw new Error(`project '${name}' does not exist`);
    }
    const entry = buildProjectEntry(name, db);
    openProjects.set(name, entry);
    startQueueLoop(name, entry);
    return entry;
  }

  wss.on('connection', (ws, req) => {
    // Expect URL like /?project=test_project
    const url = new URL(req.url || '', `http://${req.headers.host}`);
    const projectName = url.searchParams.get('project');

    if (projectName) {
       if (!clients.has(projectName)) {
          clients.set(projectName, new Set());
       }
       clients.get(projectName)!.add(ws);
       try {
          getOrOpenProject(projectName); // start driving the queue as soon as anyone watches
       } catch (e: any) {
          // T-38 BUG 2: getOrOpenProject now throws for an unknown project -
          // a thrown error here is a synchronous callback inside `ws`'s own
          // connection event, NOT an Express request handler, so it is NOT
          // caught by Express's error handling and would otherwise crash the
          // whole process. Close the socket gracefully instead.
          console.error(`[server] WS connect for unknown project '${projectName}':`, e.message);
          clients.get(projectName)?.delete(ws);
          ws.close(1008, 'project not found');
          return;
       }

       ws.on('close', () => {
          clients.get(projectName)?.delete(ws);
       });
    }
  });

  // API endpoints
  app.get('/api/projects', (req, res) => {
     if (!fs.existsSync(PROJECTS_ROOT)) {
        return res.json([]);
     }
     const dirs = fs.readdirSync(PROJECTS_ROOT, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name);
     res.json(dirs);
  });

  app.get('/api/project/:name', (req, res) => {
     try {
        const { db } = getOrOpenProject(req.params.name);
        const project = db.getProject();
        const shots = db.listShots();
        const elements = db.listElements();
        res.json({ project, shots, elements });
     } catch(e: any) {
        res.status(404).json({ error: e.message });
     }
  });

  // Account management (T-05). Never spends credits: listing/status/add-account
  // are all auth/status-only CLI calls, never a generation.
  app.get('/api/accounts', (req, res) => {
     res.json(listAccounts().map((name) => ({ name })));
  });

  app.get('/api/accounts/:name/status', async (req, res) => {
     try {
        const status = await getAccountStatus(req.params.name);
        res.json(status);
     } catch (e: any) {
        res.status(500).json({ error: e.message });
     }
  });

  // Kicks off the interactive `higgsfield auth login` flow scoped to this
  // account and returns immediately (the flow itself is completed by the
  // user in a browser and can take minutes) rather than blocking the request.
  app.post('/api/accounts', (req, res) => {
     const { name } = req.body ?? {};
     if (typeof name !== 'string' || !name) {
        res.status(400).json({ error: 'add-account requires a string "name" field' });
        return;
     }
     addAccount(name).catch((err) => {
        console.error(`[server] addAccount('${name}') failed:`, err);
     });
     res.json({ started: true, name });
  });

  // Switch which account a project's provider runs as. Drops the cached
  // ShotQueue/provider so the next access rebuilds it with the new account's
  // credentials (safe: state resumes from listShots()/listOpenJobs(), same
  // as the crash-recovery path above).
  app.post('/api/project/:name/account', async (req, res) => {
     const { account } = req.body ?? {};
     if (typeof account !== 'string' || !account) {
        res.status(400).json({ error: 'switch-account requires a string "account" field' });
        return;
     }
     if (!accountExists(account)) {
        res.status(404).json({ error: `unknown account '${account}' (no credentials.json)` });
        return;
     }
     setActiveAccount(req.params.name, account);
     await evictProjectEntry(req.params.name);
     res.json({ success: true });
  });

  // --- T-51 project-config endpoints (backend for T-49's settings screen) --
  // Note: the task text says `/api/projects/:id/config` (plural, id); using
  // `/api/project/:name/config` instead to match every other single-project
  // endpoint's established convention in this file (singular "project",
  // keyed by name) - flagged on the board.

  app.get('/api/project/:name/config', (req, res) => {
     try {
        const { db } = getOrOpenProject(req.params.name);
        const project = db.getProject()!;
        res.json({ config: project.config, accountName: getActiveAccount(req.params.name) });
     } catch (e: any) {
        res.status(404).json({ error: e.message });
     }
  });

  app.patch('/api/project/:name/config', async (req, res) => {
     let db: ProjectDb;
     let project: Project;
     try {
        ({ db } = getOrOpenProject(req.params.name));
        project = db.getProject()!;
     } catch (e: any) {
        res.status(404).json({ error: e.message });
        return;
     }
     try {
        const body = (req.body ?? {}) as Record<string, unknown>;

        for (const key of Object.keys(body)) {
           if (!CONFIG_PATCH_KEYS.has(key)) {
              res.status(400).json({ error: `unknown config key '${key}'` });
              return;
           }
        }
        for (const field of ['provider', 'imageProvider', 'videoProvider'] as const) {
           const value = body[field];
           if (value !== undefined && !PROVIDER_NAMES.includes(value as ProviderName)) {
              res.status(400).json({ error: `${field} must be one of: ${PROVIDER_NAMES.join(', ')}` });
              return;
           }
        }
        if (body.models !== undefined) {
           if (typeof body.models !== 'object' || body.models === null || Array.isArray(body.models)) {
              res.status(400).json({ error: 'models must be an object' });
              return;
           }
           const models = body.models as Record<string, unknown>;
           for (const key of Object.keys(models)) {
              if (!MODEL_PATCH_KEYS.has(key)) {
                 res.status(400).json({ error: `unknown models key '${key}'` });
                 return;
              }
              if (typeof models[key] !== 'string') {
                 res.status(400).json({ error: `models.${key} must be a string` });
                 return;
              }
           }
        }
        if (body.styleBible !== undefined && typeof body.styleBible !== 'string') {
           res.status(400).json({ error: 'styleBible must be a string' });
           return;
        }
        if (body.promptBackend !== undefined && !PROMPT_BACKENDS.includes(body.promptBackend as 'template' | 'llm')) {
           res.status(400).json({ error: `promptBackend must be one of: ${PROMPT_BACKENDS.join(', ')}` });
           return;
        }
        if (body.llmModel !== undefined && (typeof body.llmModel !== 'string' || !body.llmModel)) {
           res.status(400).json({ error: 'llmModel must be a non-empty string' });
           return;
        }
        if (body.segmentation !== undefined && !SEGMENTATION_MODES.includes(body.segmentation as 'llm' | 'heuristic')) {
           res.status(400).json({ error: `segmentation must be one of: ${SEGMENTATION_MODES.join(', ')}` });
           return;
        }
        if (
           body.maxShotSeconds !== undefined &&
           (typeof body.maxShotSeconds !== 'number' || !Number.isFinite(body.maxShotSeconds) || body.maxShotSeconds <= 0)
        ) {
           res.status(400).json({ error: 'maxShotSeconds must be a positive number' });
           return;
        }
        if (
           body.activeChunk !== undefined &&
           (typeof body.activeChunk !== 'number' || !Number.isInteger(body.activeChunk) || body.activeChunk < 0)
        ) {
           res.status(400).json({ error: 'activeChunk must be a non-negative integer' });
           return;
        }
        const accountName = body.accountName;
        if (accountName !== undefined) {
           if (typeof accountName !== 'string' || !accountName) {
              res.status(400).json({ error: 'accountName must be a non-empty string' });
              return;
           }
           if (!accountExists(accountName)) {
              res.status(404).json({ error: `unknown account '${accountName}' (no credentials.json)` });
              return;
           }
        }

        const { accountName: _ignored, ...configPatch } = body;
        const mergedConfig = mergeLayer(project.config, configPatch as ConfigOverrides);
        db.saveConfig(project.id, mergedConfig);
        if (typeof accountName === 'string') {
           setActiveAccount(req.params.name, accountName);
        }
        // Same pattern as the account-switch endpoint above: evict the cached
        // queue (T-62: stop-before-evict) so the next access rebuilds it
        // against the new config/account, with no orphaned loop left behind.
        await evictProjectEntry(req.params.name);

        const updatedProject = { ...project, config: mergedConfig };
        broadcast(req.params.name, { type: 'sync', shots: db.listShots(), project: updatedProject });
        res.json({ config: mergedConfig, accountName: getActiveAccount(req.params.name) });
     } catch (e: any) {
        res.status(500).json({ error: e.message });
     }
  });

  // Chunked production (owner-directed, 2026-07-04): the chunk list from the
  // last alignment + the active chunk + live per-chunk progress, so the UI
  // can render "Chunk 2 of 6 — 12/17 placed" and gate advancement.
  app.get('/api/project/:name/chunks', (req, res) => {
     try {
        const { db } = getOrOpenProject(req.params.name);
        const project = db.getProject()!;
        const chunksPath = path.join(projectDir(req.params.name), 'chunks.json');
        let chunks: Array<{ index: number; title: string; shotCount?: number }> = [];
        if (fs.existsSync(chunksPath)) {
           chunks = JSON.parse(fs.readFileSync(chunksPath, 'utf-8'));
        }
        const shots = db.listShots();
        const withProgress = chunks.map((c) => {
           const chunkShots = shots.filter((s) => (s.line.chunkIndex ?? 0) === c.index);
           return {
              ...c,
              shotCount: chunkShots.length,
              placed: chunkShots.filter((s) => s.state === 'PLACED').length,
              approvedOrBeyond: chunkShots.filter((s) =>
                 ['APPROVED', 'VIDEO_QUEUED', 'VIDEO_READY', 'PLACED'].includes(s.state),
              ).length,
              failed: chunkShots.filter((s) => s.state === 'FAILED').length,
           };
        });
        res.json({ chunks: withProgress, activeChunk: project.config.activeChunk ?? 0 });
     } catch (e: any) {
        res.status(404).json({ error: e.message });
     }
  });

  // --- T-48 (Fable-2 mini-lease, additive only — @sonnet please review) ---
  // LAN address for the mobile-onboarding QR: the browser cannot enumerate
  // NICs, so the server reports the first non-internal IPv4.
  app.get('/api/lan-info', (req, res) => {
     let lanIp: string | null = null;
     for (const nets of Object.values(os.networkInterfaces())) {
        for (const net of nets ?? []) {
           if (net.family === 'IPv4' && !net.internal) {
              lanIp = net.address;
              break;
           }
        }
        if (lanIp) break;
     }
     res.json({ lanIp, apiPort: port });
  });

  app.get('/api/project/:name/media/:type/:file', (req, res) => {
     // type is 'images' or 'clips'
     const safeFile = path.basename(req.params.file);
     const safeType = path.basename(req.params.type);
     const file = path.join(projectDir(req.params.name), safeType, safeFile);
     if (fs.existsSync(file)) {
        res.sendFile(file);
     } else {
        res.status(404).send('Not found');
     }
  });

  // --- T-25 preview-playback routes (Fable-2 lease: media routes only) ---

  // EDL read model for the timeline preview player (in/out trims + timeline
  // placement per placed clip). Client derives media URLs from clipPath
  // basenames via the media route above.
  app.get('/api/project/:name/edl', (req, res) => {
     try {
        const { db } = getOrOpenProject(req.params.name);
        res.json(db.listEdl());
     } catch (e: any) {
        res.status(404).json({ error: e.message });
     }
  });

  // Voiceover audio — the preview player's master clock. `res.sendFile`
  // streams with HTTP Range support, which <audio>/<video> seeking needs.
  app.get('/api/project/:name/vo', (req, res) => {
     try {
        const { db } = getOrOpenProject(req.params.name);
        const project = db.getProject();
        if (!project || !fs.existsSync(project.voPath)) {
           res.status(404).send('No voiceover');
           return;
        }
        res.sendFile(path.resolve(project.voPath));
     } catch (e: any) {
        res.status(404).json({ error: e.message });
     }
  });

  // --- T-27 setup-flow endpoints -------------------------------------------

  // Create a new project. Accepts EITHER multipart/form-data (part names
  // `name`/`script`/`vo` per the T-84/T-85 contract - the vo file streams
  // straight to disk via multer, never touching browser or server RAM as a
  // whole blob) OR the original JSON+base64 body (voiceoverBase64/
  // voiceoverExt - kept working for small hand-built payloads/existing
  // tests). Exactly one of `req.file` (multipart) or `voiceoverBase64`
  // (JSON) will be present per request.
  app.post('/api/projects', uploadVoField, (req, res) => {
     const { name, script, voiceoverBase64, voiceoverExt } = req.body ?? {};
     const cleanupUpload = () => {
        // Sync: runs on the reject path only (not perf-sensitive), and
        // guarantees the temp file is gone before the response is sent -
        // callers observing a 4xx/5xx should never see a lingering upload.
        if (req.file) {
           try {
              fs.unlinkSync(req.file.path);
           } catch {
              // already moved into place, or already gone - fine either way
           }
        }
     };
     if (typeof name !== 'string' || !/^[A-Za-z0-9_-]+$/.test(name)) {
        cleanupUpload();
        res.status(400).json({ error: 'name must be a non-empty string of letters/numbers/_/-' });
        return;
     }
     if (typeof script !== 'string' || !script.trim()) {
        cleanupUpload();
        res.status(400).json({ error: 'script (narration text) is required' });
        return;
     }
     if (!req.file && (typeof voiceoverBase64 !== 'string' || !voiceoverBase64)) {
        res.status(400).json({ error: 'voiceoverBase64 (base64-encoded audio) or a multipart vo file is required' });
        return;
     }
     if (!req.file && typeof voiceoverBase64 === 'string') {
        // Buffer.byteLength with 'base64' computes the decoded size from the
        // string's own length/padding - no decoding/allocation needed just
        // to check it.
        const decodedBytes = Buffer.byteLength(voiceoverBase64, 'base64');
        if (decodedBytes > MAX_JSON_VO_BYTES) {
           res.status(413).json({
              error: `voiceoverBase64 decodes to ${(decodedBytes / (1024 * 1024)).toFixed(1)}MB, over the ${MAX_JSON_VO_BYTES / (1024 * 1024)}MB JSON-path limit - use multipart/form-data (vo file field) for larger voiceovers`,
           });
           return;
        }
     }
     let db: ProjectDb | undefined;
     try {
        const dir = projectDir(name);
        for (const sub of ['images', 'clips', 'export']) {
           fs.mkdirSync(path.join(dir, sub), { recursive: true });
        }
        const scriptPath = path.join(dir, 'script.txt');
        fs.writeFileSync(scriptPath, script, 'utf8');

        let voPath: string;
        if (req.file) {
           const ext = path.extname(req.file.originalname).replace(/^\./, '') || 'wav';
           voPath = path.join(dir, `voiceover.${ext}`);
           fs.renameSync(req.file.path, voPath); // same-volume move, not a copy
        } else {
           const ext = typeof voiceoverExt === 'string' && voiceoverExt ? voiceoverExt.replace(/^\./, '') : 'wav';
           voPath = path.join(dir, `voiceover.${ext}`);
           fs.writeFileSync(voPath, Buffer.from(voiceoverBase64, 'base64'));
        }

        db = openProjectDb(name);
        const project = db.ensureProject({ name, scriptPath, voPath, config: loadConfig(name) });
        res.json({ project });
     } catch (e: any) {
        cleanupUpload(); // no-op if the file was already moved into place
        res.status(500).json({ error: e.message });
     } finally {
        db?.close();
     }
  });

  // Trigger alignment on a project with no shots planned yet. Streams
  // align_cli.py's ASCII progress lines as WS events alongside the normal
  // 2s sync, since this step (stable-ts, ~15s-of-audio/s on CPU) can take a
  // while for a long voiceover.
  app.post('/api/project/:name/align', async (req, res) => {
     try {
        const { db } = getOrOpenProject(req.params.name);
        const project = db.getProject();
        if (!project) {
           res.status(404).json({ error: 'project not found' });
           return;
        }
        const existing = db.listShots();
        if (existing.length > 0) {
           // Re-alignment (owner-directed, segmentation tuning): allowed with
           // {force:true} ONLY while every shot is still PENDING — once any
           // generation has started, re-planning would orphan paid media.
           const force = req.body?.force === true;
           if (!force) {
              res.status(409).json({
                 error: 'project already has shots planned — pass {"force":true} to re-align (allowed while all shots are PENDING)',
              });
              return;
           }
           // The invariant is "never orphan PAID media": consult the cost
           // ledger, not shot states — mock-provider progress (0-amount
           // entries) is free to discard, real spend is not.
           const paid = db.listLedger().some((e) => (e.chargedCredits ?? e.preflightCredits ?? 0) > 0);
           if (paid) {
              res.status(409).json({ error: 'cannot force re-align: this project has PAID generations on its ledger' });
              return;
           }
           // Force re-align stops the queue ITSELF (T-62 awaitable stop) —
           // a separate stop-then-align sequence loses the race against the
           // UI's reconnect auto-start, and /stop never cleared the
           // runningProjects flag anyway.
           const entry = openProjects.get(req.params.name);
           if (entry) await entry.queue.stop();
           runningProjects.delete(req.params.name);
           const removed = db.deleteAllShots(project.id);
           broadcast(req.params.name, { type: 'alignProgress', line: `force re-align: cleared ${removed} pending shots` });
        }
        const outJson = path.join(projectDir(project.name), 'alignment.json');
        const { lines, chunks, segmentationUsed } = await alignScriptEx(project.scriptPath, project.voPath, outJson, {
           onProgress: (line) => broadcast(req.params.name, { type: 'alignProgress', line }),
           segmentation: project.config.segmentation ?? 'llm',
           llmModel: project.config.llmModel,
        });
        const timeline = computeTimeline(lines);
        // LLM one-visual-idea segments are authoritative — skip phrase splitting
        // (hard 15s model cap inside planShots still applies).
        const effectiveMaxShot =
           segmentationUsed === 'llm' ? Number.POSITIVE_INFINITY : project.config.maxShotSeconds;
        const shots = planShots(project.id, timeline, lines, effectiveMaxShot);
        db.insertShots(shots);
        // Chunked production: persist the chunk list (with per-chunk shot
        // counts) beside alignment.json for GET /chunks + the UI.
        const chunksWithCounts = chunks.map((c) => ({
           ...c,
           shotCount: shots.filter((s) => (s.line.chunkIndex ?? 0) === c.index).length,
        }));
        fs.writeFileSync(path.join(projectDir(project.name), 'chunks.json'), JSON.stringify(chunksWithCounts, null, 2));
        broadcast(req.params.name, {
           type: 'alignProgress',
           line: `done (${shots.length} shots across ${chunksWithCounts.length} chunk${chunksWithCounts.length === 1 ? '' : 's'}, segmentation: ${segmentationUsed})`,
        });
        res.json({ success: true, shotCount: shots.length, chunks: chunksWithCounts });
     } catch (e: any) {
        res.status(500).json({ error: e.message });
     }
  });

  // Explicit start/stop of a project's review-gate queue loop, for the setup
  // flow's "Start generation" button (separate from just opening the project
  // for reading, which getOrOpenProject already does implicitly for the
  // review UI on a never-before-opened project). Idempotent either way:
  // /run resumes if stopped or no-ops if already running; /stop is safe to
  // call even if nothing is running. Once stopped, the project stays in
  // openProjects (so plain reads/WS connects don't silently restart it) -
  // only this /run endpoint resumes it, by building a fresh ShotQueue since
  // a stopped instance's stop flag can't be un-set (queue.ts::stop() docs).
  app.post('/api/project/:name/run', (req, res) => {
     try {
        const name = req.params.name;
        let entry = openProjects.get(name);
        if (!entry) {
           entry = getOrOpenProject(name);
        } else if (!runningProjects.has(name)) {
           entry = buildProjectEntry(name, entry.db);
           openProjects.set(name, entry);
           startQueueLoop(name, entry);
        }
        res.json({ success: true, running: true });
     } catch (e: any) {
        res.status(404).json({ error: e.message });
     }
  });

  app.post('/api/project/:name/stop', async (req, res) => {
     const entry = openProjects.get(req.params.name);
     // T-62: await genuine termination (queue.ts::stop() docs) so this
     // response's running:false is honest - not just "asked to stop" while
     // the loop could still be mid-tick.
     if (entry) await entry.queue.stop();
     res.json({ success: true, running: false });
  });

  // Element registry: create/update (upsert) + list. No delete endpoint -
  // ProjectDb has no deleteElement method (db.ts is ARCHITECT-owned; would
  // need a contract change to add one).
  app.get('/api/project/:name/elements', (req, res) => {
     try {
        const { db } = getOrOpenProject(req.params.name);
        res.json(db.listElements());
     } catch (e: any) {
        res.status(404).json({ error: e.message });
     }
  });

  app.post('/api/project/:name/elements', (req, res) => {
     try {
        const { db } = getOrOpenProject(req.params.name);
        const project = db.getProject();
        if (!project) {
           res.status(404).json({ error: 'project not found' });
           return;
        }
        const { id, name, category, thumbUrl } = req.body ?? {};
        if (typeof id !== 'string' || !id) {
           res.status(400).json({ error: 'id (Higgsfield element UUID) is required' });
           return;
        }
        if (typeof name !== 'string' || !name) {
           res.status(400).json({ error: 'name is required' });
           return;
        }
        if (!ELEMENT_CATEGORIES.includes(category)) {
           res.status(400).json({ error: 'category must be character | location | prop' });
           return;
        }
        if (thumbUrl !== undefined && typeof thumbUrl !== 'string') {
           res.status(400).json({ error: 'thumbUrl must be a string when present' });
           return;
        }
        db.upsertElement(project.id, thumbUrl ? { id, name, category, thumbUrl } : { id, name, category });
        res.json({ success: true });
     } catch (e: any) {
        res.status(500).json({ error: e.message });
     }
  });

  // --- T-36 export + cost endpoints -----------------------------------------

  // Export the timeline (EDL -> trim -> concat -> mux -> final MP4), the same
  // pipeline as `cli export`, streaming per-stage progress as WS events so
  // the TimelinePage export panel (T-20) can show a real progress bar/ETA
  // instead of its current mocked state.
  app.post('/api/project/:name/export', async (req, res) => {
     try {
        const { db } = getOrOpenProject(req.params.name);
        const project = db.getProject();
        if (!project) {
           res.status(404).json({ error: 'project not found' });
           return;
        }
        const entries = db.listEdl();
        if (entries.length === 0) {
           res.status(409).json({ error: 'EDL is empty - nothing to export (run the queue first)' });
           return;
        }
        // T-42 (T-40 finding H3): a partially-placed timeline exported a
        // short final.mp4 silently, no warning. Require an explicit
        // force:true once placed<total so a bare POST (or a stale UI build)
        // can't ship a silently-truncated export; the confirm dialog (T-41)
        // sends force after the user acknowledges.
        const total = db.listShots().length;
        const placed = entries.length;
        const force = req.body?.force === true;
        if (placed < total && !force) {
           res.status(409).json({
              error: `only ${placed} of ${total} shots are placed - pass force:true to export anyway`,
              placed,
              total,
           });
           return;
        }
        const outPath =
           typeof req.body?.outPath === 'string' && req.body.outPath
              ? path.resolve(req.body.outPath)
              : path.join(projectDir(project.name), 'export', 'final.mp4');
        const finalPath = await exportTimeline(entries, project.voPath, outPath, {
           onProgress: (evt: ExportProgressEvent) => {
              broadcast(req.params.name, { type: 'exportProgress', ...evt });
           },
        });
        // T-68: always write a per-line .srt caption sidecar beside final.mp4.
        // Best-effort — a missing/invalid alignment.json must never fail the export.
        try {
           exportSrtSidecar(finalPath, path.join(projectDir(project.name), 'alignment.json'));
        } catch {
           /* no captions if alignment is absent; the video export still succeeds */
        }
        res.json({ success: true, outputPath: finalPath, placed, total });
     } catch (e: any) {
        res.status(500).json({ error: e.message });
     }
  });

  // Cached account balance for a polling cost-meter widget (distinct from the
  // uncached GET /api/accounts/:name/status above, which is for on-demand
  // checks like opening the account-switcher dropdown).
  app.get('/api/accounts/:name/balance', async (req, res) => {
     const name = req.params.name;
     try {
        const cached = balanceCache.get(name);
        if (cached && Date.now() - cached.fetchedAt < BALANCE_CACHE_MS) {
           res.json({ ...cached.status, cached: true });
           return;
        }
        const status = await getAccountStatus(name);
        balanceCache.set(name, { status, fetchedAt: Date.now() });
        res.json({ ...status, cached: false });
     } catch (e: any) {
        // Graceful degrade (T-41 residual, Fable-2): getAccountStatus() only
        // throws for a genuinely broken CLI (not installed / spawn failure)
        // or a timeout - both look identical to "no balance available" to a
        // caller, exactly like the authenticated:false case it already
        // returns without throwing. A raw 500 here was cosmetic noise only:
        // the UI's balance fetch (App.tsx useAccounts()) doesn't check
        // res.ok, it just reads whatever JSON body comes back - so this
        // needs zero ui/** changes to take effect.
        res.json({ name, balance: null, authenticated: false, cached: false, error: e.message });
     }
  });

  // Session cost summary: ledger totals for the project, broken down by
  // account AND currency unit (T-38c: higgsfield/mock rows are 'credits',
  // fal rows are 'usd' - a mixed-provider project must never sum these
  // together, per Opus's T-34 flag). Legacy rows predating this migration
  // have no `unit` column value; treat them as 'credits' (everything was
  // higgsfield-only before the fal fallback existed). Grouping logic lives in
  // cost-summary.ts::summarizeLedger (T-52 dedupe - Opus extracted the same
  // grouping for `cli cost` in T-46; this endpoint used to duplicate it
  // inline). Response shape unchanged:
  //   { totals: { credits?: number, usd?: number },
  //     byAccount: [{ accountName: string|null, unit: 'credits'|'usd', total: number, entryCount: number }] }
  app.get('/api/project/:name/cost-summary', (req, res) => {
     try {
        const { db } = getOrOpenProject(req.params.name);
        res.json(summarizeLedger(db.listLedger()));
     } catch (e: any) {
        res.status(500).json({ error: e.message });
     }
  });

  // Review-gate actions: approve / edit(instructions) / redo(prompt?) /
  // redoAnimation(prompt?), delegated to the project's live ShotQueue (owns
  // this state-machine logic). Field names match the actual UI callers
  // (ReviewPage/MobileReviewPage always send `instructions` + `prompt`
  // together; only the one relevant to `action` is used) - per Fable's T-04
  // contract decision (T-11 finding 2): a supplied `prompt` is used verbatim
  // for redo/redoAnimation, otherwise the PromptEngine regenerates one.
  app.post('/api/project/:name/shots/:shotId/action', async (req, res) => {
     try {
        const { queue } = getOrOpenProject(req.params.name);
        const { shotId } = req.params;
        const { action, instructions, prompt } = req.body ?? {};
        const userPrompt = typeof prompt === 'string' && prompt ? prompt : undefined;
        switch (action) {
           case 'approve':
              await queue.approve(shotId);
              break;
           case 'edit':
              if (typeof instructions !== 'string' || !instructions) {
                 res.status(400).json({ error: 'edit requires a string "instructions" field' });
                 return;
              }
              await queue.requestEdit(shotId, instructions);
              break;
           case 'redo':
              await queue.requestRedo(shotId, userPrompt);
              break;
           case 'redoAnimation':
              await queue.redoAnimation(shotId, userPrompt);
              break;
           default:
              res.status(400).json({ error: `unknown action '${action}'` });
              return;
        }
        res.json({ success: true });
     } catch (e: any) {
        res.status(500).json({ error: e.message });
     }
  });

  // Periodic full-state sync — a robust baseline (e.g. for a client that just
  // connected) on top of the immediate per-transition `shotEvent` pushes above.
  setInterval(() => {
     for (const [projectName, wsClients] of clients.entries()) {
        if (wsClients.size === 0) continue;
        const opened = openProjects.get(projectName);
        if (!opened) continue;
        const shots = opened.db.listShots();
        broadcast(projectName, { type: 'sync', shots });
     }
  }, 2000);

  // --- T-67 production static serving (Fable-2, additive end block) ---------
  // When ui/dist exists (vite build), serve the app from this server so no
  // vite dev process is needed: static assets + SPA fallback for client-side
  // routes. Registered LAST so every /api route above wins; the WS upgrade
  // path is unaffected (wss ignores the URL path, reads only ?project=).
  // NOTE: Express 5's path-to-regexp rejects the classic '*' wildcard route —
  // a plain middleware guard is the compatible SPA fallback.
  const distDir = path.resolve(APP_ROOT, '..', 'ui', 'dist');
  if (fs.existsSync(path.join(distDir, 'index.html'))) {
    app.use(express.static(distDir));
    app.use((req, res, next) => {
      if (req.method !== 'GET' || req.path.startsWith('/api/')) {
        next();
        return;
      }
      res.sendFile(path.join(distDir, 'index.html'));
    });
    console.log(`[server] serving ui from ${distDir}`);
  } else {
    console.log('[server] ui/dist not found - API-only mode (run `npm run build` in ui/ or use the vite dev server)');
  }

  // Friendly port-in-use exit. IMPORTANT: the ws WebSocketServer forwards the
  // http server's 'error' events to itself, and its forwarder is attached
  // (at construction) BEFORE this handler — an unhandled re-emit on `wss`
  // would throw first, so the handler must be on BOTH emitters.
  const onServerError = (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[server] port ${port} is already in use - is Director's Flick already running? (close it or pass --port <other>)`);
      process.exit(1);
    }
    throw err;
  };
  server.on('error', onServerError);
  wss.on('error', onServerError);

  server.listen(port, () => {
    console.log(`Server listening on port ${port}`);
  });
}
