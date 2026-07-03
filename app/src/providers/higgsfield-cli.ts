/**
 * providers/higgsfield-cli.ts — HiggsfieldCliProvider: real GenProvider that
 * shells out to the globally installed `higgsfield` CLI (npm global).
 *
 * NEVER invoked by tests or default runs — it spends real credits (and the
 * CLI is unauthenticated until the user runs `higgsfield auth login`).
 *
 * Submit path:   higgsfield generate create <model> --prompt "..." [flags] --json
 * Poll path:     higgsfield generate get <jobId> --json
 * Fallback:      if `generate get` is unavailable, submit runs
 *                `generate create ... --json --wait` synchronously and caches
 *                the terminal JobResult so poll() can serve it.
 *
 * Elements:
 *   config.elementsViaPlaceholders === true  -> `<<<element_id>>>` placeholders
 *     are already embedded in spec.prompt; the prompt is passed through
 *     verbatim and no extra flags are added.
 *   config.elementsViaPlaceholders === false -> each spec.elementIds entry is
 *     passed via a repeated `--image <id-or-path>` flag (URLs are downloaded
 *     to a local cache file first).
 *
 * Windows-safe: child_process.spawn with ARRAY args only (never shell-string
 * interpolation). On Windows the npm `.cmd` shim cannot be spawned directly
 * (Node >= 20 rejects it with EINVAL), so the invocation resolver locates the
 * package's real JS bin script and runs it with the current node executable.
 */

import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import type {
  GenProvider,
  ImageJobSpec,
  JobResult,
  JobSpec,
  JobStatus,
  PipelineConfig,
  VideoJobSpec,
} from '../types.js';
import { measuredPreflightCredits } from './mock.js';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Thrown when the CLI reports 'Session expired' / 'Not authenticated'.
 * The queue must pause on this instead of retrying.
 */
export class AuthRequiredError extends Error {
  constructor(detail?: string) {
    super(
      `Higgsfield CLI is not authenticated${detail ? ` (${detail})` : ''}. ` +
        'Run: higgsfield auth login',
    );
    this.name = 'AuthRequiredError';
  }
}

/** Alias kept for the ARCHITECTURE.md wording ("typed AuthError"). */
export { AuthRequiredError as AuthError };

// ---------------------------------------------------------------------------
// CLI invocation resolution (Windows npm-shim safe)
// ---------------------------------------------------------------------------

interface CliInvocation {
  command: string;
  prefixArgs: string[];
}

let cachedInvocation: CliInvocation | null = null;

function resolveCliInvocation(override?: string): CliInvocation {
  if (override) return { command: override, prefixArgs: [] };
  if (!cachedInvocation) cachedInvocation = computeCliInvocation();
  return cachedInvocation;
}

function computeCliInvocation(): CliInvocation {
  if (process.platform !== 'win32') {
    return { command: 'higgsfield', prefixArgs: [] };
  }
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  // npm's global bin dir is the usual home of the shim; make sure it is searched.
  if (process.env.APPDATA) dirs.push(path.join(process.env.APPDATA, 'npm'));
  for (const dir of dirs) {
    const exe = path.join(dir, 'higgsfield.exe');
    if (fs.existsSync(exe)) return { command: exe, prefixArgs: [] };
    const cmdShim = path.join(dir, 'higgsfield.cmd');
    if (fs.existsSync(cmdShim)) {
      const binScript = resolveNpmBinScript(dir);
      if (binScript) {
        // Run the package's JS entry with the current node executable:
        // plain array args, no shell, no .cmd (Node >= 20 EINVAL-blocks .cmd).
        return { command: process.execPath, prefixArgs: [binScript] };
      }
      // Last resort: run the shim through cmd.exe with array args. Only
      // reached when the npm package layout next to the shim is unreadable.
      return { command: 'cmd.exe', prefixArgs: ['/d', '/s', '/c', cmdShim] };
    }
  }
  // Not found on PATH; let spawn fail with a clear error at run time.
  return { command: 'higgsfield', prefixArgs: [] };
}

/** Resolve the real JS bin script of the globally installed npm package. */
function resolveNpmBinScript(shimDir: string): string | null {
  try {
    const pkgDir = path.join(shimDir, 'node_modules', 'higgsfield');
    const raw = fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8');
    const pkg = JSON.parse(raw) as { bin?: string | Record<string, string> };
    let rel: string | undefined;
    if (typeof pkg.bin === 'string') rel = pkg.bin;
    else if (pkg.bin) rel = pkg.bin['higgsfield'] ?? Object.values(pkg.bin)[0];
    if (!rel) return null;
    const script = path.resolve(pkgDir, rel);
    return fs.existsSync(script) ? script : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// CLI output parsing helpers
// ---------------------------------------------------------------------------

interface CliRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

const ANSI_RE = /\x1B\[[0-9;]*[A-Za-z]/g;

function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '');
}

function isAuthFailureText(text: string): boolean {
  return /session expired|not authenticated/i.test(text);
}

function truncate(text: string, max = 400): string {
  const t = text.trim();
  return t.length <= max ? t : `${t.slice(0, max)}...`;
}

/** Best-effort JSON extraction from possibly noisy CLI stdout. */
function extractJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    /* fall through */
  }
  const start = trimmed.search(/[{[]/);
  const end = Math.max(trimmed.lastIndexOf('}'), trimmed.lastIndexOf(']'));
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      /* fall through */
    }
  }
  for (const line of trimmed.split(/\r?\n/).reverse()) {
    const l = line.trim();
    if (l.startsWith('{') || l.startsWith('[')) {
      try {
        return JSON.parse(l);
      } catch {
        /* keep scanning */
      }
    }
  }
  return null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Containers commonly wrapping the payload in CLI JSON responses. */
function payloadContainers(json: unknown): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  if (isRecord(json)) {
    out.push(json);
    for (const key of ['job', 'data', 'result', 'generation', 'jobs', 'results']) {
      const v = json[key];
      if (isRecord(v)) out.push(v);
      else if (Array.isArray(v) && isRecord(v[0])) out.push(v[0]);
    }
  } else if (Array.isArray(json) && isRecord(json[0])) {
    out.push(json[0]);
  }
  return out;
}

function pickJobId(json: unknown): string | null {
  for (const c of payloadContainers(json)) {
    for (const key of ['id', 'job_id', 'jobId', 'generation_id', 'generationId', 'uuid']) {
      const v = c[key];
      if (typeof v === 'string' && v.length > 0) return v;
    }
  }
  return null;
}

const STATUS_MAP: Readonly<Record<string, JobStatus>> = {
  queued: 'queued',
  pending: 'queued',
  submitted: 'queued',
  created: 'queued',
  in_progress: 'in_progress',
  processing: 'in_progress',
  running: 'in_progress',
  generating: 'in_progress',
  started: 'in_progress',
  completed: 'completed',
  complete: 'completed',
  succeeded: 'completed',
  success: 'completed',
  done: 'completed',
  finished: 'completed',
  failed: 'failed',
  error: 'failed',
  nsfw: 'nsfw',
  moderated: 'nsfw',
  moderation: 'nsfw',
  flagged: 'nsfw',
  blocked: 'nsfw',
  canceled: 'canceled',
  cancelled: 'canceled',
};

function pickStatus(json: unknown): JobStatus | null {
  for (const c of payloadContainers(json)) {
    for (const key of ['status', 'state']) {
      const v = c[key];
      if (typeof v === 'string') {
        const mapped = STATUS_MAP[v.trim().toLowerCase()];
        if (mapped) return mapped;
      }
    }
  }
  return null;
}

function collectUrls(
  value: unknown,
  out: { key: string; url: string }[],
  keyHint: string,
  depth: number,
): void {
  if (depth > 6 || value === null || value === undefined) return;
  if (typeof value === 'string') {
    if (/^https?:\/\//i.test(value)) out.push({ key: keyHint.toLowerCase(), url: value });
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectUrls(v, out, keyHint, depth + 1);
    return;
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) collectUrls(v, out, k, depth + 1);
  }
}

/** Best URL in the response: prefers result/output/media keys, shuns thumbnails. */
function pickResultUrl(json: unknown): string | null {
  const urls: { key: string; url: string }[] = [];
  collectUrls(json, urls, '', 0);
  if (urls.length === 0) return null;
  const score = (k: string): number => {
    if (/thumb|preview|icon|avatar|logo/.test(k)) return -1;
    if (/result|output|download/.test(k)) return 3;
    if (/video|image|media|file|asset/.test(k)) return 2;
    if (k === 'url') return 1;
    return 0;
  };
  let best = urls[0]!;
  for (const u of urls) {
    if (score(u.key) > score(best.key)) best = u;
  }
  return best.url;
}

function collectNumbers(
  value: unknown,
  out: { key: string; num: number }[],
  keyHint: string,
  depth: number,
): void {
  if (depth > 5 || value === null || value === undefined) return;
  if (typeof value === 'number' && Number.isFinite(value)) {
    out.push({ key: keyHint.toLowerCase(), num: value });
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectNumbers(v, out, keyHint, depth + 1);
    return;
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) collectNumbers(v, out, k, depth + 1);
  }
}

/** Credits charged, if the CLI JSON exposes them under a recognizable key. */
function pickCredits(json: unknown): number | null {
  const nums: { key: string; num: number }[] = [];
  collectNumbers(json, nums, '', 0);
  const score = (k: string): number => {
    if (/credits?_?(charged|used|spent)/.test(k)) return 3;
    if (/^credits?$/.test(k) || /credit_?cost/.test(k)) return 2;
    if (/^(cost|price|charge)$/.test(k)) return 1;
    return 0;
  };
  let best: { key: string; num: number } | null = null;
  for (const n of nums) {
    if (score(n.key) > 0 && (best === null || score(n.key) > score(best.key))) best = n;
  }
  return best ? best.num : null;
}

function pickError(json: unknown): string | null {
  for (const c of payloadContainers(json)) {
    for (const key of ['error', 'error_message', 'message', 'reason', 'detail']) {
      const v = c[key];
      if (typeof v === 'string' && v.length > 0) return v;
    }
  }
  return null;
}

const TERMINAL_STATUSES: ReadonlySet<JobStatus> = new Set([
  'completed',
  'failed',
  'nsfw',
  'canceled',
]);

async function downloadUrlToFile(url: string, destPath: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new Error(`Download failed: HTTP ${res.status} ${res.statusText} for ${url}`);
  }
  await pipeline(
    Readable.fromWeb(res.body as unknown as WebReadableStream<Uint8Array>),
    fs.createWriteStream(destPath),
  );
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export interface HiggsfieldCliOptions {
  /** Override the resolved CLI command (mainly for tests). */
  cliCommand?: string;
  /** Cache dir for element media downloaded from URLs (--image fallback). */
  elementCacheDir?: string;
  /** Timeout for `generate create` submits without --wait (default 120s). */
  submitTimeoutMs?: number;
  /** Timeout for `generate get` polls (default 60s). */
  pollTimeoutMs?: number;
  /** Timeout for the synchronous `create --wait` fallback (default 15 min). */
  waitTimeoutMs?: number;
}

export class HiggsfieldCliProvider implements GenProvider {
  readonly name = 'higgsfield-cli';

  private readonly config: PipelineConfig;
  private readonly cliCommand: string | undefined;
  private readonly elementCacheDir: string;
  private readonly submitTimeoutMs: number;
  private readonly pollTimeoutMs: number;
  private readonly waitTimeoutMs: number;

  /** Terminal results cached from `create --wait` fallback or prior polls. */
  private readonly resultCache = new Map<string, JobResult>();
  /** Lazily probed: does the CLI support `generate get`? */
  private getSupport: boolean | null = null;

  constructor(config: PipelineConfig, opts: HiggsfieldCliOptions = {}) {
    this.config = config;
    this.cliCommand = opts.cliCommand;
    this.elementCacheDir =
      opts.elementCacheDir ?? path.join(os.tmpdir(), 'directors-flick', 'element-media');
    this.submitTimeoutMs = opts.submitTimeoutMs ?? 120_000;
    this.pollTimeoutMs = opts.pollTimeoutMs ?? 60_000;
    this.waitTimeoutMs = opts.waitTimeoutMs ?? 900_000;
  }

  /**
   * The CLI exposes no get_cost preflight; estimate from the Phase 0 measured
   * table (null for unmeasured models). poll().creditsCharged reconciled from
   * the CLI JSON remains the ledger ground truth.
   */
  async preflightCost(spec: JobSpec): Promise<number | null> {
    return measuredPreflightCredits(spec);
  }

  async submitImage(spec: ImageJobSpec): Promise<string> {
    return this.submit(spec);
  }

  async submitVideo(spec: VideoJobSpec): Promise<string> {
    return this.submit(spec);
  }

  async poll(jobId: string): Promise<JobResult> {
    const cached = this.resultCache.get(jobId);
    if (cached) return cached;
    if (!(await this.supportsGet())) {
      throw new Error(
        `HiggsfieldCliProvider.poll: no cached result for job ${jobId} and ` +
          `'higgsfield generate get' is unavailable in this CLI version.`,
      );
    }
    const run = await this.run(['generate', 'get', jobId, '--json'], {
      timeoutMs: this.pollTimeoutMs,
    });
    const json = extractJson(run.stdout);
    const result = this.toJobResult(jobId, json, run);
    if (TERMINAL_STATUSES.has(result.status)) this.resultCache.set(jobId, result);
    return result;
  }

  async download(result: JobResult, destPath: string): Promise<string> {
    const url = result.resultUrl;
    if (!url) {
      throw new Error(
        `HiggsfieldCliProvider.download: job ${result.jobId} has no resultUrl ` +
          `(status=${result.status})`,
      );
    }
    await fsp.mkdir(path.dirname(destPath), { recursive: true });
    if (/^https?:\/\//i.test(url)) {
      await downloadUrlToFile(url, destPath);
    } else {
      const src = url.startsWith('file:') ? fileURLToPath(url) : url;
      await fsp.copyFile(src, destPath);
    }
    result.localPath = destPath;
    return destPath;
  }

  // -- submit ---------------------------------------------------------------

  private async submit(spec: ImageJobSpec | VideoJobSpec): Promise<string> {
    const args = await this.buildCreateArgs(spec);

    if (!(await this.supportsGet())) {
      // Fallback: `generate get` unavailable -> run create --wait synchronously
      // and cache the terminal result so poll() can serve it.
      const run = await this.run([...args, '--wait'], { timeoutMs: this.waitTimeoutMs });
      const json = extractJson(run.stdout);
      const jobId = pickJobId(json) ?? randomUUID();
      let result = this.toJobResult(jobId, json, run);
      if (!TERMINAL_STATUSES.has(result.status)) {
        // --wait returned, so the job is over: with a result URL it completed,
        // without one it is unusable.
        result = result.resultUrl
          ? { ...result, status: 'completed' }
          : {
              ...result,
              status: 'failed',
              error:
                result.error ??
                `create --wait finished without a terminal status or result URL; ` +
                  `stdout: ${truncate(run.stdout)}`,
            };
      }
      this.resultCache.set(jobId, result);
      return jobId;
    }

    const run = await this.run(args, { timeoutMs: this.submitTimeoutMs });
    const json = extractJson(run.stdout);
    const jobId = pickJobId(json);
    if (!jobId) {
      throw new Error(
        `higgsfield generate create returned no job id; stdout: ${truncate(run.stdout)}`,
      );
    }
    // Some CLI versions may return a terminal payload even without --wait.
    const maybe = this.toJobResult(jobId, json, run);
    if (TERMINAL_STATUSES.has(maybe.status) && maybe.resultUrl) {
      this.resultCache.set(jobId, maybe);
    }
    return jobId;
  }

  private async buildCreateArgs(spec: ImageJobSpec | VideoJobSpec): Promise<string[]> {
    // elementsViaPlaceholders=true: <<<element_id>>> placeholders are already
    // embedded in spec.prompt -> pass the prompt through verbatim, no flags.
    const args = ['generate', 'create', spec.model, '--prompt', spec.prompt];
    if (spec.kind === 'video') {
      if (spec.startImage) args.push('--start-image', spec.startImage);
      args.push('--duration', String(spec.duration));
      args.push('--mode', spec.mode ?? this.config.models.videoMode);
      args.push('--sound', spec.soundOff ? 'off' : 'on');
      args.push('--resolution', spec.resolution ?? '720p');
    } else {
      if (spec.resolution) args.push('--resolution', spec.resolution);
      // Edit = image-to-image: the rejected image is passed as a reference
      // input, same --image flag used for explicit element references below.
      if (spec.referenceImagePath) args.push('--image', spec.referenceImagePath);
    }
    args.push('--aspect_ratio', spec.aspectRatio);
    if (!this.config.elementsViaPlaceholders) {
      // Placeholder support off -> pass element references explicitly.
      for (const ref of spec.elementIds) {
        args.push('--image', await this.resolveElementRef(ref));
      }
    }
    args.push('--json');
    return args;
  }

  /**
   * Element references for --image: UUIDs and local paths pass through
   * verbatim (the CLI accepts both); URLs are downloaded to a cache file
   * first and the local path is passed.
   */
  private async resolveElementRef(ref: string): Promise<string> {
    if (!/^https?:\/\//i.test(ref)) return ref;
    const hash = createHash('sha1').update(ref).digest('hex').slice(0, 16);
    let ext = '';
    try {
      ext = path.extname(new URL(ref).pathname);
    } catch {
      /* keep default */
    }
    if (!ext || ext.length > 8) ext = '.png';
    const dest = path.join(this.elementCacheDir, `${hash}${ext}`);
    if (!fs.existsSync(dest)) {
      await fsp.mkdir(this.elementCacheDir, { recursive: true });
      await downloadUrlToFile(ref, dest);
    }
    return dest;
  }

  // -- CLI plumbing -----------------------------------------------------------

  private async supportsGet(): Promise<boolean> {
    if (this.getSupport !== null) return this.getSupport;
    try {
      const run = await this.run(['generate', 'get', '--help'], {
        timeoutMs: 30_000,
        check: false,
      });
      const text = `${run.stdout}\n${run.stderr}`.toLowerCase();
      if (/unknown command|unrecognized|no such command|invalid command/.test(text)) {
        this.getSupport = false;
      } else if (run.code === 0 || /usage|options/.test(text) || isAuthFailureText(text)) {
        // Auth errors mean the command was recognized far enough to exist.
        this.getSupport = true;
      } else {
        this.getSupport = false; // ambiguous -> use the safe --wait fallback
      }
    } catch {
      this.getSupport = false;
    }
    return this.getSupport;
  }

  private run(
    args: string[],
    opts: { timeoutMs?: number; check?: boolean } = {},
  ): Promise<CliRunResult> {
    const { timeoutMs = 120_000, check = true } = opts;
    const { command, prefixArgs } = resolveCliInvocation(this.cliCommand);
    return new Promise<CliRunResult>((resolve, reject) => {
      const child = spawn(command, [...prefixArgs, ...args], {
        windowsHide: true,
        env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
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
        reject(
          new Error(`higgsfield ${args.slice(0, 3).join(' ')} timed out after ${timeoutMs} ms`),
        );
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
        const result: CliRunResult = {
          code: code ?? -1,
          stdout: stripAnsi(stdout),
          stderr: stripAnsi(stderr),
        };
        if (check) {
          if (isAuthFailureText(`${result.stdout}\n${result.stderr}`)) {
            reject(new AuthRequiredError(`while running: higgsfield ${args.slice(0, 3).join(' ')}`));
            return;
          }
          if (result.code !== 0) {
            reject(
              new Error(
                `higgsfield ${args.slice(0, 3).join(' ')} exited with code ${result.code}: ` +
                  truncate(result.stderr || result.stdout),
              ),
            );
            return;
          }
        }
        resolve(result);
      });
    });
  }

  private toJobResult(jobId: string, json: unknown, raw: CliRunResult): JobResult {
    const status = pickStatus(json);
    const resultUrl = pickResultUrl(json) ?? undefined;
    const credits = pickCredits(json);
    const effective: JobStatus = status ?? (resultUrl ? 'completed' : 'in_progress');
    const result: JobResult = { jobId, status: effective };
    if (resultUrl) result.resultUrl = resultUrl;
    if (credits !== null) result.creditsCharged = credits;
    if (effective === 'failed' || effective === 'nsfw' || effective === 'canceled') {
      result.error =
        pickError(json) ?? (truncate(raw.stderr || raw.stdout) || `job ${effective}`);
    }
    return result;
  }
}
