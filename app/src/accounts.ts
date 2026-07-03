/**
 * accounts.ts — AccountManager: per-account Higgsfield credential files.
 *
 * Each account gets its own credentials file at
 * app/accounts/<name>/credentials.json, so the higgsfield CLI can be pointed
 * at a specific account's session via the HIGGSFIELD_CREDENTIALS_PATH env
 * var (see providers/higgsfield-cli.ts) instead of always using the CLI's
 * one global session file. This lets different projects run concurrently
 * under separate accounts without one clobbering another's session.
 *
 * cost_ledger account attribution: CostLedgerEntry/the cost_ledger schema
 * (types.ts/db.ts) are ARCHITECT-owned (contract review only per
 * ARCHITECTURE.md's module map), so rather than requesting a schema change
 * for this, job->account attribution is tracked here in a small companion
 * file (app/accounts/_usage.json) keyed by jobId, joinable against
 * ProjectDb.listLedger() by jobId wherever the ledger is displayed (see
 * cli.ts's `cost` command).
 *
 * Never spends credits itself: addAccount() only spawns the interactive
 * `higgsfield auth login` flow (no generation); getAccountStatus() only
 * reads status, never submits a job.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { APP_ROOT } from './db.js';
import { resolveCliInvocation, stripAnsi, isAuthFailureText } from './providers/cli-invocation.js';

export const ACCOUNTS_ROOT = path.join(APP_ROOT, 'accounts');
const USAGE_FILE = path.join(ACCOUNTS_ROOT, '_usage.json');
const ACTIVE_FILE = path.join(ACCOUNTS_ROOT, '_active.json');

// ---------------------------------------------------------------------------
// Credential file paths
// ---------------------------------------------------------------------------

export function accountDir(name: string): string {
  return path.join(ACCOUNTS_ROOT, name);
}

export function credentialsPath(name: string): string {
  return path.join(accountDir(name), 'credentials.json');
}

/** An account "exists" once it has a credentials.json on disk. */
export function accountExists(name: string): boolean {
  return fs.existsSync(credentialsPath(name));
}

/** Names of accounts with a credentials.json under app/accounts/. */
export function listAccounts(): string[] {
  if (!fs.existsSync(ACCOUNTS_ROOT)) return [];
  return fs
    .readdirSync(ACCOUNTS_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory() && accountExists(d.name))
    .map((d) => d.name)
    .sort();
}

// ---------------------------------------------------------------------------
// Small JSON-file stores (job->account tags, active account per project)
// ---------------------------------------------------------------------------

function readJsonFile<T>(file: string, fallback: T): T {
  if (!fs.existsSync(file)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

function writeJsonFile(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

/** Record which account a provider job (image or video) was submitted under. */
export function tagJobAccount(jobId: string, accountName: string): void {
  const usage = readJsonFile<Record<string, string>>(USAGE_FILE, {});
  usage[jobId] = accountName;
  writeJsonFile(USAGE_FILE, usage);
}

/** Account a given job was submitted under, or null if untagged (e.g. mock runs). */
export function getJobAccount(jobId: string): string | null {
  const usage = readJsonFile<Record<string, string>>(USAGE_FILE, {});
  return usage[jobId] ?? null;
}

/** Active account for a project, or null if none has been chosen (CLI default session). */
export function getActiveAccount(projectName: string): string | null {
  const active = readJsonFile<Record<string, string>>(ACTIVE_FILE, {});
  return active[projectName] ?? null;
}

/** Switch which account a project's provider should run as. Throws on an
 * unknown account name (no credentials.json) rather than silently no-op-ing. */
export function setActiveAccount(projectName: string, accountName: string): void {
  if (!accountExists(accountName)) {
    throw new Error(`setActiveAccount: unknown account '${accountName}' (no credentials.json)`);
  }
  const active = readJsonFile<Record<string, string>>(ACTIVE_FILE, {});
  active[projectName] = accountName;
  writeJsonFile(ACTIVE_FILE, active);
}

// ---------------------------------------------------------------------------
// CLI-backed operations
// ---------------------------------------------------------------------------

export interface AccountStatus {
  name: string;
  /** null when unauthenticated or the balance couldn't be parsed. */
  balance: number | null;
  authenticated: boolean;
}

interface CliRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  cliCommandOverride?: string,
): Promise<CliRunResult> {
  const { command, prefixArgs } = resolveCliInvocation(cliCommandOverride);
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...prefixArgs, ...args], {
      windowsHide: true,
      env: { ...process.env, ...env, NO_COLOR: '1', FORCE_COLOR: '0' },
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`higgsfield ${args.slice(0, 2).join(' ')} timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(
        new Error(
          `Failed to spawn Higgsfield CLI (${command}): ${err.message}. ` +
            `Is the "higgsfield" npm package installed globally and on PATH?`,
        ),
      );
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout: stripAnsi(stdout), stderr: stripAnsi(stderr) });
    });
  });
}

/** Best-effort numeric balance extraction from `account status` output,
 * tolerating either a --json payload or plain text across CLI versions. */
function parseBalance(stdout: string, stderrAndStdout: string): number | null {
  try {
    const json = JSON.parse(stdout.trim()) as Record<string, unknown>;
    const raw = json.balance ?? json.credits ?? json.credit_balance;
    if (typeof raw === 'number') return raw;
    if (typeof raw === 'string' && raw.trim() !== '') {
      const n = Number(raw.replace(/,/g, ''));
      if (!Number.isNaN(n)) return n;
    }
  } catch {
    /* not JSON - fall through to a loose text scrape below */
  }
  const m = stderrAndStdout.match(/([\d,]+\.?\d*)\s*cr(edits)?\b/i);
  return m ? Number(m[1]!.replace(/,/g, '')) : null;
}

/**
 * Spawn `higgsfield account status --json` scoped to this account's
 * credentials file. Never submits/spends credits.
 */
export async function getAccountStatus(
  name: string,
  opts: { cliCommand?: string; timeoutMs?: number } = {},
): Promise<AccountStatus> {
  if (!accountExists(name)) {
    return { name, balance: null, authenticated: false };
  }
  const { stdout, stderr } = await runCli(
    ['account', 'status', '--json'],
    { HIGGSFIELD_CREDENTIALS_PATH: credentialsPath(name) },
    opts.timeoutMs ?? 30_000,
    opts.cliCommand,
  );
  const combined = `${stdout}\n${stderr}`;
  if (isAuthFailureText(combined)) {
    return { name, balance: null, authenticated: false };
  }
  return { name, balance: parseBalance(stdout, combined), authenticated: true };
}

/**
 * Spawn the interactive `higgsfield auth login` flow scoped to a (new or
 * existing) account's own credentials file, so its session never clobbers
 * the CLI's default global session or another account's file. This is an
 * interactive device-auth flow completed by the user in a browser - it does
 * not itself spend credits, but the returned promise only resolves once the
 * CLI process exits, so callers should treat it as long-running and not
 * block critical paths on it.
 */
export async function addAccount(
  name: string,
  opts: { cliCommand?: string; timeoutMs?: number } = {},
): Promise<CliRunResult> {
  fs.mkdirSync(accountDir(name), { recursive: true });
  return runCli(
    ['auth', 'login'],
    { HIGGSFIELD_CREDENTIALS_PATH: credentialsPath(name) },
    opts.timeoutMs ?? 5 * 60_000,
    opts.cliCommand,
  );
}
