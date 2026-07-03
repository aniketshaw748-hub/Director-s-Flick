import { vi, describe, test, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';

vi.mock('node:fs', () => {
  return {
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
  };
});

describe('cli-invocation', () => {
  let originalPlatform: string;
  let originalEnv: NodeJS.ProcessEnv;
  let resolveCliInvocation: any;
  let stripAnsi: any;
  let isAuthFailureText: any;
  let truncate: any;

  beforeEach(async () => {
    originalPlatform = process.platform;
    originalEnv = { ...process.env };
    vi.mocked(existsSync).mockReset();
    vi.mocked(readFileSync).mockReset();

    // Import dynamically using a literal string so Vitest/Vite can compile it.
    // vi.resetModules() in afterEach will clear the cache.
    const mod = await import('../src/providers/cli-invocation.js');
    resolveCliInvocation = mod.resolveCliInvocation;
    stripAnsi = mod.stripAnsi;
    isAuthFailureText = mod.isAuthFailureText;
    truncate = mod.truncate;
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    process.env = originalEnv;
    vi.resetModules();
  });

  test('resolveCliInvocation returns override immediately if provided', () => {
    const res = resolveCliInvocation('custom-override-cli');
    expect(res).toEqual({ command: 'custom-override-cli', prefixArgs: [] });
  });

  test('stripAnsi removes ANSI escape sequences correctly', () => {
    const raw = '\x1B[31mRed Text\x1B[0m and \x1B[4mUnderlined\x1B[0m';
    expect(stripAnsi(raw)).toBe('Red Text and Underlined');
  });

  test('isAuthFailureText matches authentication failure phrases', () => {
    expect(isAuthFailureText('Your session expired.')).toBe(true);
    expect(isAuthFailureText('user is not authenticated.')).toBe(true);
    expect(isAuthFailureText('Authenticated successfully.')).toBe(false);
  });

  test('truncate trims and cuts long text correctly', () => {
    expect(truncate('  hello world  ', 20)).toBe('hello world');
    expect(truncate('this is a very long text that exceeds maximum', 10)).toBe('this is a ...');
  });

  test('computeCliInvocation returns simple "higgsfield" on non-Windows', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const res = resolveCliInvocation();
    expect(res.command).toBe('higgsfield');
    expect(res.prefixArgs).toEqual([]);
  });

  test('computeCliInvocation searches PATH on Windows and returns .exe path if found', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    process.env.PATH = `C:\\bin${path.delimiter}D:\\tools`;
    process.env.APPDATA = '';

    vi.mocked(existsSync).mockImplementation((p: string) => {
      return p === path.normalize('D:\\tools\\higgsfield.exe');
    });

    const res = resolveCliInvocation();
    expect(res.command).toBe(path.normalize('D:\\tools\\higgsfield.exe'));
    expect(res.prefixArgs).toEqual([]);
  });

  test('computeCliInvocation resolves JS bin script when cmd shim is found', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    process.env.PATH = `C:\\npm`;
    process.env.APPDATA = '';

    vi.mocked(existsSync).mockImplementation((p: string) => {
      // Simulate finding the .cmd shim, the global node_modules script
      if (p === path.normalize('C:\\npm\\higgsfield.cmd')) return true;
      if (p.includes('package.json')) return true;
      if (p.includes('cli.js')) return true;
      return false;
    });

    vi.mocked(readFileSync).mockImplementation((p: string) => {
      if (p.includes('package.json')) {
        return JSON.stringify({
          bin: {
            higgsfield: 'bin/cli.js'
          }
        });
      }
      throw new Error('Not found');
    });

    const res = resolveCliInvocation();
    expect(res.command).toBe(process.execPath);
    expect(res.prefixArgs[0]).toContain(path.normalize('node_modules/higgsfield/bin/cli.js'));
  });

  test('computeCliInvocation resolves JS bin script when pkg.bin is string', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    process.env.PATH = `C:\\npm`;
    process.env.APPDATA = '';

    vi.mocked(existsSync).mockImplementation((p: string) => {
      if (p === path.normalize('C:\\npm\\higgsfield.cmd')) return true;
      if (p.includes('package.json')) return true;
      if (p.includes('index.js')) return true;
      return false;
    });

    vi.mocked(readFileSync).mockImplementation((p: string) => {
      if (p.includes('package.json')) {
        return JSON.stringify({
          bin: 'bin/index.js'
        });
      }
      throw new Error('Not found');
    });

    const res = resolveCliInvocation();
    expect(res.command).toBe(process.execPath);
    expect(res.prefixArgs[0]).toContain(path.normalize('node_modules/higgsfield/bin/index.js'));
  });

  test('computeCliInvocation falls back to cmd.exe when package.json fails to read', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    process.env.PATH = `C:\\npm`;
    process.env.APPDATA = '';

    vi.mocked(existsSync).mockImplementation((p: string) => {
      return p === path.normalize('C:\\npm\\higgsfield.cmd');
    });

    vi.mocked(readFileSync).mockImplementation(() => {
      throw new Error('File read error');
    });

    const res = resolveCliInvocation();
    expect(res.command).toBe('cmd.exe');
    expect(res.prefixArgs).toEqual(['/d', '/s', '/c', path.normalize('C:\\npm\\higgsfield.cmd')]);
  });
});
