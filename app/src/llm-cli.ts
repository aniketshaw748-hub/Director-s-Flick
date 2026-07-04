/**
 * llm-cli.ts — headless Claude Code CLI as an LLM transport (owner-directed).
 *
 * The owner does not want metered API keys: their Claude Code SUBSCRIPTION
 * already runs Sonnet/Opus, and `claude -p` (print mode) executes one-shot
 * prompts headlessly on that login. This module wraps it in the same minimal
 * `{ messages: { create(req) } }` client surface that prompts-llm.ts and
 * segment-llm.ts already accept, so the app's LLM features work with ZERO
 * API keys: transport resolution everywhere is
 *   injected client (tests)  >  ANTHROPIC_API_KEY (API)  >  claude CLI (this).
 *
 * Implementation notes:
 *   - The entire prompt (system + user + JSON-only instruction) is written to
 *     STDIN — argv carries only fixed flags, so Windows .cmd shim quoting can
 *     never corrupt a prompt.
 *   - `--output-format json` gives an envelope; `.result` is the model text.
 *   - cwd is the OS temp dir so the spawned CLI does NOT load this repo's
 *     CLAUDE.md/skills context into every call.
 *   - API model ids are mapped to CLI aliases (claude-opus-4-8 -> opus).
 *   - Hermetic: the spawn runner is injectable for tests.
 */

import { spawn } from 'node:child_process';
import os from 'node:os';

const DEFAULT_TIMEOUT_MS = 240_000;

/** API-style model id -> claude CLI --model value. Unknown ids pass through. */
export function cliModelAlias(model: string | undefined): string {
  if (!model) return 'sonnet';
  const m = model.toLowerCase();
  if (m === 'sonnet' || m === 'opus' || m === 'haiku') return m;
  if (m.startsWith('claude-opus')) return 'opus';
  if (m.startsWith('claude-sonnet')) return 'sonnet';
  if (m.startsWith('claude-haiku')) return 'haiku';
  return model;
}

export interface CliRunResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

export type CliRunner = (args: string[], stdinText: string, timeoutMs: number) => Promise<CliRunResult>;

/** Only ever interpolated into a shell command after this whitelist check. */
const SAFE_ARG = /^[A-Za-z0-9._:@-]+$/;

/** Default runner: spawn the `claude` CLI (Windows npm shim needs a shell). */
const spawnRunner: CliRunner = (args, stdinText, timeoutMs) =>
  new Promise<CliRunResult>((resolve, reject) => {
    // On Windows the npm `claude` shim is a .cmd, which requires a shell. To
    // avoid DEP0190 (args array + shell:true) we join into ONE command string —
    // safe because every arg is validated against a strict whitelist first
    // (the prompt itself always travels via STDIN, never argv).
    const unsafe = args.find((a) => !SAFE_ARG.test(a));
    if (unsafe !== undefined) {
      reject(new Error(`claude CLI arg failed safety whitelist: ${JSON.stringify(unsafe)}`));
      return;
    }
    const win = process.platform === 'win32';
    const child = win
      ? spawn(['claude', ...args].join(' '), { cwd: os.tmpdir(), shell: true, windowsHide: true })
      : spawn('claude', args, { cwd: os.tmpdir(), windowsHide: true });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill();
      } catch {
        // best effort
      }
      reject(new Error(`claude CLI call timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    timer.unref?.();
    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');
    child.stdout.on('data', (c: string) => {
      stdout += c;
    });
    child.stderr.on('data', (c: string) => {
      stderr += c;
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`failed to spawn claude CLI (is Claude Code installed and on PATH?): ${err.message}`));
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
    child.stdin.write(stdinText, () => child.stdin.end());
  });

/** Strip a single leading/trailing markdown code fence, if present. */
export function stripFences(text: string): string {
  return text
    .trim()
    .replace(/^```[a-zA-Z]*\s*\n?/, '')
    .replace(/\n?```\s*$/, '')
    .trim();
}

interface CreateRequest {
  model?: string;
  system?: string;
  messages?: Array<{ role: string; content: string }>;
  output_config?: { format?: { type?: string; schema?: unknown } };
  [key: string]: unknown;
}

export interface ClaudeCliClientOptions {
  /** Override the model for every call (else per-request model, aliased). */
  model?: string;
  timeoutMs?: number;
  /** Test injection: replaces the real spawn. */
  runner?: CliRunner;
}

/**
 * An Anthropic-SDK-shaped client ({messages:{create}}) backed by headless
 * `claude -p` on the user's Claude Code subscription. Returns objects shaped
 * like API replies: `{ content: [{ type: 'text', text }] }`.
 */
export function createClaudeCliClient(opts: ClaudeCliClientOptions = {}) {
  const runner = opts.runner ?? spawnRunner;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return {
    messages: {
      async create(req: CreateRequest): Promise<unknown> {
        const model = cliModelAlias(opts.model ?? (typeof req.model === 'string' ? req.model : undefined));
        const user = req.messages?.map((m) => m.content).join('\n\n') ?? '';
        const schema = req.output_config?.format?.schema;
        const parts: string[] = [];
        if (req.system) parts.push(req.system);
        parts.push(user);
        if (schema !== undefined) {
          parts.push(
            'OUTPUT FORMAT (hard requirement): respond with ONLY valid JSON matching this JSON Schema — ' +
              'no prose, no explanation, no markdown fences:\n' +
              JSON.stringify(schema),
          );
        }
        const prompt = parts.join('\n\n---\n\n');
        const args = ['-p', '--output-format', 'json', '--model', model];
        const { stdout, stderr, code } = await runner(args, prompt, timeoutMs);
        if (code !== 0) {
          const detail = (stderr || stdout).trim().slice(-500);
          throw new Error(`claude CLI exited with code ${code}${detail ? `: ${detail}` : ''}`);
        }
        let envelope: { is_error?: boolean; result?: unknown; subtype?: string };
        try {
          envelope = JSON.parse(stdout) as typeof envelope;
        } catch {
          throw new Error(`claude CLI output was not the expected JSON envelope: ${stdout.trim().slice(0, 300)}`);
        }
        if (envelope.is_error || typeof envelope.result !== 'string') {
          throw new Error(`claude CLI reported an error (${envelope.subtype ?? 'unknown'})`);
        }
        return { content: [{ type: 'text', text: stripFences(envelope.result) }] };
      },
    },
  };
}
