import express from 'express';
import cors from 'cors';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { ProjectDb, openProjectDb, projectDir, PROJECTS_ROOT } from './db.js';
import { loadConfig } from './config.js';
import { createProvider } from './providers/index.js';
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
import { alignScript, computeTimeline, planShots } from './align.js';
import type { ElementCategory } from './types.js';

const ELEMENT_CATEGORIES: readonly ElementCategory[] = ['character', 'location', 'prop'];

interface OpenProject {
  db: ProjectDb;
  queue: ShotQueue;
}

export function startServer(port = 4000) {
  const app = express();
  app.use(cors());
  // Default 100kb limit is far too small for POST /api/projects, which
  // carries a base64-encoded voiceover file in the JSON body (T-27).
  app.use(express.json({ limit: '150mb' }));

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
    const provider = createProvider(
      config,
      activeAccount ? { credentialsPath: credentialsPath(activeAccount), accountName: activeAccount } : undefined,
    );
    const prompts = createPromptEngine(config);
    const queue = new ShotQueue(db, provider, prompts, config);
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

  /**
   * Open (or reuse) a project's db + a live ShotQueue. On a true cache miss
   * (never opened this server session) this also starts the review-gate loop
   * (autoApprove: false — shots stop at IN_REVIEW for the API below to
   * approve/edit/redo). Once cached, further calls just return the existing
   * entry WITHOUT restarting its loop if it was explicitly stopped (T-27) -
   * only POST .../run does that. Idempotent per project name.
   */
  function getOrOpenProject(name: string): OpenProject {
    const existing = openProjects.get(name);
    if (existing) return existing;

    const db = openProjectDb(name);
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
       getOrOpenProject(projectName); // start driving the queue as soon as anyone watches

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
  app.post('/api/project/:name/account', (req, res) => {
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
     openProjects.delete(req.params.name);
     res.json({ success: true });
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

  // Create a new project. Uploads are JSON+base64 rather than multipart: the
  // standard multipart middleware (multer) would be a new dependency, and
  // package.json is ARCHITECT-owned per ARCHITECTURE.md's module map (change
  // by contract review only) - base64-in-JSON needs no new dependency on
  // either side and is simple for a browser <input type="file"> to produce
  // via FileReader, so it's functionally equivalent for this use case.
  app.post('/api/projects', (req, res) => {
     const { name, script, voiceoverBase64, voiceoverExt } = req.body ?? {};
     if (typeof name !== 'string' || !/^[A-Za-z0-9_-]+$/.test(name)) {
        res.status(400).json({ error: 'name must be a non-empty string of letters/numbers/_/-' });
        return;
     }
     if (typeof script !== 'string' || !script.trim()) {
        res.status(400).json({ error: 'script (narration text) is required' });
        return;
     }
     if (typeof voiceoverBase64 !== 'string' || !voiceoverBase64) {
        res.status(400).json({ error: 'voiceoverBase64 (base64-encoded audio) is required' });
        return;
     }
     const ext = typeof voiceoverExt === 'string' && voiceoverExt ? voiceoverExt.replace(/^\./, '') : 'wav';
     let db: ProjectDb | undefined;
     try {
        const dir = projectDir(name);
        for (const sub of ['images', 'clips', 'export']) {
           fs.mkdirSync(path.join(dir, sub), { recursive: true });
        }
        const scriptPath = path.join(dir, 'script.txt');
        const voPath = path.join(dir, `voiceover.${ext}`);
        fs.writeFileSync(scriptPath, script, 'utf8');
        fs.writeFileSync(voPath, Buffer.from(voiceoverBase64, 'base64'));
        db = openProjectDb(name);
        const project = db.ensureProject({ name, scriptPath, voPath, config: loadConfig(name) });
        res.json({ project });
     } catch (e: any) {
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
        if (db.listShots().length > 0) {
           res.status(409).json({ error: 'project already has shots planned' });
           return;
        }
        const outJson = path.join(projectDir(project.name), 'alignment.json');
        const lines = await alignScript(project.scriptPath, project.voPath, outJson, {
           onProgress: (line) => broadcast(req.params.name, { type: 'alignProgress', line }),
        });
        const timeline = computeTimeline(lines);
        const shots = planShots(project.id, timeline, lines);
        db.insertShots(shots);
        broadcast(req.params.name, { type: 'alignProgress', line: `done (${shots.length} shots)` });
        res.json({ success: true, shotCount: shots.length });
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
  });

  app.post('/api/project/:name/stop', (req, res) => {
     const entry = openProjects.get(req.params.name);
     if (entry) entry.queue.stop();
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

  server.listen(port, () => {
    console.log(`Server listening on port ${port}`);
  });
}
