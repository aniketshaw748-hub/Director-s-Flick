/**
 * cli-invocation.ts — shared Higgsfield CLI process helpers.
 *
 * Windows npm-shim-safe invocation resolution + small output-parsing
 * primitives, extracted so both `higgsfield-cli.ts` (real generation
 * provider) and `accounts.ts` (auth login / balance status - never
 * generation) can spawn the CLI without duplicating this logic or creating
 * a circular import between the two.
 *
 * Windows-safe: on Windows the npm `.cmd` shim cannot be spawned directly
 * (Node >= 20 rejects it with EINVAL), so this resolver locates the
 * package's real JS bin script and runs it with the current node executable.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface CliInvocation {
  command: string;
  prefixArgs: string[];
}

let cachedInvocation: CliInvocation | null = null;

export function resolveCliInvocation(override?: string): CliInvocation {
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

const ANSI_RE = /\x1B\[[0-9;]*[A-Za-z]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '');
}

export function isAuthFailureText(text: string): boolean {
  return /session expired|not authenticated/i.test(text);
}

export function truncate(text: string, max = 400): string {
  const t = text.trim();
  return t.length <= max ? t : `${t.slice(0, max)}...`;
}
