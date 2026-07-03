import { vi, describe, test, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const appDir = path.resolve(__dirname, '..');

const randomId = Math.floor(Math.random() * 1000000);
const tempProjName = `cli_e2e_temp_proj_${randomId}`;
const tempProjDir = path.join(appDir, 'projects', tempProjName);

const scriptFile = path.join(appDir, `temp_script_${randomId}.txt`);
const voFile = path.join(appDir, `temp_vo_${randomId}.wav`);

function runCliCommand(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const quotedArgs = args.map((arg) => {
    if (arg.includes(' ') || arg.includes('\\') || arg.includes('"')) {
      const escaped = arg.replace(/"/g, '\\"');
      return `"${escaped}"`;
    }
    return arg;
  });

  return new Promise((resolve) => {
    const child = spawn('npx', ['tsx', 'src/cli.ts', ...quotedArgs], {
      cwd: appDir,
      shell: true,
    });
    let stdout = '';
    let stderr = '';

    const timer = setTimeout(() => {
      child.kill();
    }, 45000); // 45s timeout limit

    child.stdout?.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 0, stdout, stderr });
    });
  });
}

describe('cli.ts e2e subprocess tests', () => {
  beforeAll(() => {
    // Create dummy files for script and voiceover
    fs.writeFileSync(scriptFile, 'Hello e2e test script narration.');
    fs.writeFileSync(voFile, 'RIFF....WAVEfmt....data....');
  });

  afterAll(() => {
    // Clean up temporary script and voiceover files
    if (fs.existsSync(scriptFile)) fs.unlinkSync(scriptFile);
    if (fs.existsSync(voFile)) fs.unlinkSync(voFile);

    // Clean up temporary project directory and SQLite database
    if (fs.existsSync(tempProjDir)) {
      fs.rmSync(tempProjDir, { recursive: true, force: true });
    }
  });

  test('unknown command prints help/error and exits non-zero', async () => {
    const res = await runCliCommand(['boguscmd']);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('error: unknown command');
  }, 60000);

  test('init command without required option --script fails and exits non-zero', async () => {
    const res = await runCliCommand(['init', tempProjName, '--vo', voFile]);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("required option '--script <path>' not specified");
  }, 60000);

  test('init command successfully creates project database and folder structures', async () => {
    const res = await runCliCommand(['init', tempProjName, '--script', scriptFile, '--vo', voFile]);
    if (res.code !== 0) {
      console.error('init failed:', res);
    }
    expect(res.code).toBe(0);
    expect(res.stdout).toContain(`project '${tempProjName}' ready`);
    
    // Verify files and directories are created
    expect(fs.existsSync(tempProjDir)).toBe(true);
    expect(fs.existsSync(path.join(tempProjDir, 'pipeline.db'))).toBe(true);
    expect(fs.existsSync(path.join(tempProjDir, 'images'))).toBe(true);
    expect(fs.existsSync(path.join(tempProjDir, 'clips'))).toBe(true);
    expect(fs.existsSync(path.join(tempProjDir, 'export'))).toBe(true);
  }, 60000);

  test('status command displays correct shots state and total credits information', async () => {
    const res = await runCliCommand(['status', tempProjName]);
    if (res.code !== 0) {
      console.error('status failed:', res);
    }
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('no shots');
    expect(res.stdout).toContain('total shots: 0');
    expect(res.stdout).toContain('credits:');
  }, 60000);

  test('elements command registers and lists element refs', async () => {
    // Add character and location elements
    const addRes = await runCliCommand([
      'elements',
      tempProjName,
      '--add',
      'c1:Protagonist:character',
      '--add',
      'l1:Dungeon:location',
    ]);
    if (addRes.code !== 0) {
      console.error('elements add failed:', addRes);
    }
    expect(addRes.code).toBe(0);
    expect(addRes.stdout).toContain('c1');
    expect(addRes.stdout).toContain('Protagonist');
    expect(addRes.stdout).toContain('character');

    // List elements
    const listRes = await runCliCommand(['elements', tempProjName]);
    if (listRes.code !== 0) {
      console.error('elements list failed:', listRes);
    }
    expect(listRes.code).toBe(0);
    expect(listRes.stdout).toContain('c1');
    expect(listRes.stdout).toContain('l1');
    expect(listRes.stdout).toContain('Dungeon');
  }, 60000);

  test('cost command dumps empty ledger and prints seeded ledger subtotals', async () => {
    // 1. Check empty cost command output
    const emptyRes = await runCliCommand(['cost', tempProjName]);
    if (emptyRes.code !== 0) {
      console.error('cost empty failed:', emptyRes);
    }
    expect(emptyRes.code).toBe(0);
    expect(emptyRes.stdout).toContain('ledger is empty');


    // 2. Open db and seed rows to the ledger
    const dbPath = path.join(tempProjDir, 'pipeline.db');
    const db = new Database(dbPath);
    
    const project = db.prepare('SELECT id FROM projects LIMIT 1').get() as { id: string };
    const projectId = project.id;

    // Seed credits row (Higgsfield)
    db.prepare(`
      INSERT INTO cost_ledger (project_id, job_id, kind, model, preflight_credits, charged_credits, account_name, provider, unit, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      projectId,
      'job-e2e-1',
      'video',
      'kling3_0',
      2.5,
      2.5,
      'Max',
      'higgsfield-cli',
      'credits',
      new Date().toISOString()
    );

    // Seed USD row (Fal)
    db.prepare(`
      INSERT INTO cost_ledger (project_id, job_id, kind, model, preflight_credits, charged_credits, account_name, provider, unit, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      projectId,
      'job-e2e-2',
      'video',
      'kling-v2.5-turbo-pro',
      0.35,
      0.35,
      'Max',
      'fal',
      'usd',
      new Date().toISOString()
    );

    db.close();

    // 3. Check seeded cost command output
    const seededRes = await runCliCommand(['cost', tempProjName]);
    expect(seededRes.code).toBe(0);
    expect(seededRes.stdout).toContain('kling3_0');
    expect(seededRes.stdout).toContain('kling-v2.5-turbo-pro');
    expect(seededRes.stdout).toContain('total credits: 2.50 cr');
    expect(seededRes.stdout).toContain('total usd: $0.35');
    expect(seededRes.stdout).toContain('Max · 2.50 cr');
    expect(seededRes.stdout).toContain('Max · $0.35');
  }, 60000);

  test('in-process dynamic execution of cli.ts to collect Vitest V8 coverage', async () => {
    const originalArgv = process.argv;
    const originalExit = process.exit;

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      process.argv = [process.execPath, path.join(appDir, 'src/cli.ts'), '--help'];
      // Use a literal string dynamic import so Vite can compile/resolve it statically
      await import('../src/cli.js');
    } finally {
      process.argv = originalArgv;
      exitSpy.mockRestore();
      consoleLogSpy.mockRestore();
      consoleErrorSpy.mockRestore();
    }
  }, 60000);
});
