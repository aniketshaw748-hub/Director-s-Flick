import express from 'express';
import cors from 'cors';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { ProjectDb, projectDir } from './db.js';

export function startServer(port = 4000) {
  const app = express();
  app.use(cors());
  app.use(express.json());

  const server = createServer(app);
  const wss = new WebSocketServer({ server });

  // Map of projectName -> Set<WebSocket>
  const clients = new Map<string, Set<WebSocket>>();

  wss.on('connection', (ws, req) => {
    // Expect URL like /?project=test_project
    const url = new URL(req.url || '', `http://${req.headers.host}`);
    const projectName = url.searchParams.get('project');
    
    if (projectName) {
       if (!clients.has(projectName)) {
          clients.set(projectName, new Set());
       }
       clients.get(projectName)!.add(ws);
       
       ws.on('close', () => {
          clients.get(projectName)?.delete(ws);
       });
    }
  });

  // API endpoints
  app.get('/api/projects', (req, res) => {
     const projDir = path.join(process.cwd(), 'projects');
     if (!fs.existsSync(projDir)) {
        return res.json([]);
     }
     const dirs = fs.readdirSync(projDir, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name);
     res.json(dirs);
  });

  app.get('/api/project/:name', (req, res) => {
     try {
        const db = new ProjectDb(req.params.name);
        const project = db.getProject();
        const shots = db.listShots();
        const elements = db.listElements();
        res.json({ project, shots, elements });
     } catch(e: any) {
        res.status(404).json({ error: e.message });
     }
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

  // Endpoint to approve/edit/redo from mobile
  app.post('/api/project/:name/shots/:shotId/action', (req, res) => {
     try {
        const db = new ProjectDb(req.params.name);
        const { action, instructions, animationPrompt } = req.body;
        if (action === 'approve') {
           db.updateShotState(req.params.shotId, 'APPROVED');
        } else if (action === 'edit') {
           const shot = db.getShot(req.params.shotId);
           db.updateShotState(req.params.shotId, 'PROMPTED', { 
             imagePrompt: (shot?.imagePrompt || '') + '\n[Edit: ' + instructions + ']' 
           });
        } else if (action === 'redo') {
           db.updateShotState(req.params.shotId, 'PROMPTED', { imagePrompt: undefined });
        } else if (action === 'redoAnimation') {
           db.updateShotState(req.params.shotId, 'APPROVED', { animationPrompt });
        }
        res.json({ success: true });
     } catch (e: any) {
        res.status(500).json({ error: e.message });
     }
  });

  // Polling loop to broadcast state changes
  setInterval(() => {
     for (const [projectName, wsClients] of clients.entries()) {
        if (wsClients.size === 0) continue;
        try {
           const db = new ProjectDb(projectName);
           const shots = db.listShots();
           // Just send the whole shots array every 2s to keep it simple and robust for this prototype
           const payload = JSON.stringify({ type: 'sync', shots });
           for (const client of wsClients) {
              if (client.readyState === WebSocket.OPEN) {
                 client.send(payload);
              }
           }
        } catch(e) {
           // project might not exist yet
        }
     }
  }, 2000);

  server.listen(port, () => {
    console.log(`Server listening on port ${port}`);
  });
}
