/**
 * llm-cli.test.ts — hermetic tests for the headless Claude Code CLI transport
 * (owner-directed, 2026-07-04). Injected runner only: no real spawns.
 */

import { describe, expect, test } from 'vitest';
import { cliModelAlias, createClaudeCliClient, stripFences, type CliRunResult } from '../src/llm-cli.js';

function fakeRunner(results: (CliRunResult | Error)[]) {
  const calls: { args: string[]; stdin: string }[] = [];
  let i = 0;
  const runner = async (args: string[], stdinText: string): Promise<CliRunResult> => {
    calls.push({ args, stdin: stdinText });
    const r = results[Math.min(i, results.length - 1)];
    i++;
    if (r instanceof Error) throw r;
    return r;
  };
  return { runner, calls };
}

function envelope(result: string): CliRunResult {
  return { stdout: JSON.stringify({ type: 'result', is_error: false, result }), stderr: '', code: 0 };
}

describe('cliModelAlias', () => {
  test('maps API ids to CLI aliases and passes aliases/unknowns through', () => {
    expect(cliModelAlias('claude-opus-4-8')).toBe('opus');
    expect(cliModelAlias('claude-sonnet-5')).toBe('sonnet');
    expect(cliModelAlias('claude-haiku-4-5-20251001')).toBe('haiku');
    expect(cliModelAlias('opus')).toBe('opus');
    expect(cliModelAlias(undefined)).toBe('sonnet');
    expect(cliModelAlias('some-custom-model')).toBe('some-custom-model');
  });
});

describe('stripFences', () => {
  test('removes a single wrapping markdown fence', () => {
    expect(stripFences('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(stripFences('{"a":1}')).toBe('{"a":1}');
  });
});

describe('createClaudeCliClient', () => {
  test('sends system + user + schema instruction via stdin, fixed argv only', async () => {
    const { runner, calls } = fakeRunner([envelope('{"segments":["x"]}')]);
    const client = createClaudeCliClient({ runner });
    const res = (await client.messages.create({
      model: 'claude-opus-4-8',
      system: 'SYSTEM RULES',
      messages: [{ role: 'user', content: 'USER TEXT' }],
      output_config: { format: { type: 'json_schema', schema: { type: 'object' } } },
    })) as { content: Array<{ type: string; text: string }> };
    expect(res.content[0].text).toBe('{"segments":["x"]}');
    expect(calls[0].args).toEqual(['-p', '--output-format', 'json', '--model', 'opus']);
    expect(calls[0].stdin).toContain('SYSTEM RULES');
    expect(calls[0].stdin).toContain('USER TEXT');
    expect(calls[0].stdin).toMatch(/ONLY valid JSON/);
  });

  test('strips markdown fences from the model result', async () => {
    const { runner } = fakeRunner([envelope('```json\n{"ok":true}\n```')]);
    const client = createClaudeCliClient({ runner });
    const res = (await client.messages.create({ messages: [{ role: 'user', content: 'q' }] })) as {
      content: Array<{ text: string }>;
    };
    expect(res.content[0].text).toBe('{"ok":true}');
  });

  test('throws on non-zero exit with stderr detail', async () => {
    const { runner } = fakeRunner([{ stdout: '', stderr: 'not logged in', code: 1 }]);
    const client = createClaudeCliClient({ runner });
    await expect(client.messages.create({ messages: [{ role: 'user', content: 'q' }] })).rejects.toThrow(
      /code 1.*not logged in/s,
    );
  });

  test('throws on an error envelope', async () => {
    const { runner } = fakeRunner([
      { stdout: JSON.stringify({ is_error: true, subtype: 'error_during_execution' }), stderr: '', code: 0 },
    ]);
    const client = createClaudeCliClient({ runner });
    await expect(client.messages.create({ messages: [{ role: 'user', content: 'q' }] })).rejects.toThrow(
      /error_during_execution/,
    );
  });

  test('throws when stdout is not the JSON envelope', async () => {
    const { runner } = fakeRunner([{ stdout: 'plain text', stderr: '', code: 0 }]);
    const client = createClaudeCliClient({ runner });
    await expect(client.messages.create({ messages: [{ role: 'user', content: 'q' }] })).rejects.toThrow(
      /not the expected JSON envelope/,
    );
  });

  test('client-level model option overrides the per-request model', async () => {
    const { runner, calls } = fakeRunner([envelope('ok')]);
    const client = createClaudeCliClient({ runner, model: 'sonnet' });
    await client.messages.create({ model: 'claude-opus-4-8', messages: [{ role: 'user', content: 'q' }] });
    expect(calls[0].args).toContain('sonnet');
    expect(calls[0].args).not.toContain('opus');
  });
});
