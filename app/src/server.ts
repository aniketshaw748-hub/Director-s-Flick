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

interface OpenProject {
  db: ProjectDb;
  queue: ShotQueue;
}

export function startServer(port = 4000) {
  const app = express();
  app.use(cors());
  app.use(express.json());

  const server = createServer(app);
  const wss = new WebSocketServer({ server });

  // Map of projectName -> Set<WebSocket>
  const clients = new Map<string, Set<WebSocket>>();
  // One ProjectDb + one live ShotQueue per project, for the server's lifetime
  // (fixes the earlier per-request connection leak; also lets the review-gate
  // actions below delegate straight to the queue instead of re-implementing
  // its state-machine logic).
  const openProjects = new Map<string, OpenProject>();

  function broadcast(projectName: string, payload: unknown): void {
    const wsClients = clients.get(projectName);
    if (!wsClients || wsClients.size === 0) return;
    const msg = JSON.stringify(payload);
    for (const client of wsClients) {
      if (client.readyState === WebSocket.OPEN) client.send(msg);
    }
  }

  /**
   * Open (or reuse) a project's db + a live ShotQueue driving its review-gate
   * loop in the background (autoApprove: false — shots stop at IN_REVIEW for
   * the API below to approve/edit/redo). Idempotent per project name.
   */
  function getOrOpenProject(name: string): OpenProject {
    const existing = openProjects.get(name);
    if (existing) return existing;

    const db = openProjectDb(name);
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
    queue.run({ autoApprove: false }).catch((err) => {
      console.error(`[server] queue.run failed for project '${name}':`, err);
      // Drop the cached entry so a later request/connection reopens (and
      // retries) the project instead of leaving it permanently stuck.
      openProjects.delete(name);
    });

    const entry: OpenProject = { db, queue };
    openProjects.set(name, entry);
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
