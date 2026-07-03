/**
 * prompts-llm.test.ts — LlmPromptEngine (T-55).
 *
 * Fully hermetic: a mock Anthropic client is injected (opts.client), so no
 * network and no ANTHROPIC_API_KEY are ever needed. Verifies structured-output
 * request shape, the element-identity guard (a physical-description leak in the
 * mocked reply is rejected → identity-safe template substituted), placeholder
 * preservation, and the never-stall fallbacks (API error / missing key).
 */

import { describe, test, expect, vi } from 'vitest';
import { LlmPromptEngine } from '../src/prompts-llm.js';
import { DEFAULT_CONFIG } from '../src/types.js';
import type { ElementRef, LineTiming, PipelineConfig, Shot } from '../src/types.js';

const HAPIE: ElementRef = { id: 'hapie-uuid', name: 'Hapie', category: 'character' };
const TAG = '<<<hapie-uuid>>>';

function config(over: Partial<PipelineConfig> = {}): PipelineConfig {
  return { ...DEFAULT_CONFIG, promptBackend: 'llm', ...over };
}

function line(index = 0, text = 'Hapie lit its lantern and started to climb.'): LineTiming {
  return { index, text, start: 0, end: 2, duration: 2, pauseAfter: 0, targetDuration: 3 };
}

function shot(over: Partial<Shot> = {}): Shot {
  return {
    id: 'shot-1',
    projectId: 'p',
    lineIndex: 0,
    subIndex: 0,
    state: 'APPROVED',
    line: line(),
    elementIds: ['hapie-uuid'],
    attempts: 0,
    createdAt: '2026-07-03T00:00:00Z',
    updatedAt: '2026-07-03T00:00:00Z',
    ...over,
  };
}

/** Mock client whose messages.create returns a JSON text block for `payload`. */
function mockClient(payload: unknown) {
  const create = vi.fn(async () => ({ content: [{ type: 'text', text: JSON.stringify(payload) }] }));
  return { client: { messages: { create } }, create };
}

// ---------------------------------------------------------------------------

describe('LlmPromptEngine.imagePromptBatch', () => {
  test('uses the model output when clean, preserving element placeholders', async () => {
    const { client, create } = mockClient({
      prompts: [{ lineIndex: 0, imagePrompt: `A small figure climbs the tower stairs, lantern glowing ${TAG}` }],
    });
    const warn = vi.fn();
    const engine = new LlmPromptEngine(config(), { client, warn });

    const [out] = await engine.imagePromptBatch([line()], [HAPIE], 'painterly cinematic realism');
    expect(out.imagePrompt).toBe(`A small figure climbs the tower stairs, lantern glowing ${TAG}`);
    expect(out.lineIndex).toBe(0);
    expect(warn).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledTimes(1);
  });

  test('request shape: model claude-opus-4-8, structured output, NO thinking param', async () => {
    const { client, create } = mockClient({ prompts: [{ lineIndex: 0, imagePrompt: `x ${TAG}` }] });
    await new LlmPromptEngine(config(), { client }).imagePromptBatch([line()], [HAPIE], '');
    const params = create.mock.calls[0][0];
    expect(params.model).toBe('claude-opus-4-8');
    expect((params.output_config as any).format.type).toBe('json_schema');
    expect('thinking' in params).toBe(false);
  });

  test('config.llmModel overrides the default model', async () => {
    const { client, create } = mockClient({ prompts: [{ lineIndex: 0, imagePrompt: `x ${TAG}` }] });
    await new LlmPromptEngine(config({ llmModel: 'claude-sonnet-5' }), { client }).imagePromptBatch(
      [line()],
      [HAPIE],
      '',
    );
    expect(create.mock.calls[0][0].model).toBe('claude-sonnet-5');
  });

  test('IDENTITY GUARD: a physical description of an element-tagged subject is rejected -> template', async () => {
    // The exact T-08 leak class: describing the character instead of relying on its placeholder.
    const { client } = mockClient({
      prompts: [{ lineIndex: 0, imagePrompt: `A silver-and-copper robot with rounded lens-eyes climbs the stairs ${TAG}` }],
    });
    const warn = vi.fn();
    const engine = new LlmPromptEngine(config(), { client, warn });

    const [out] = await engine.imagePromptBatch([line()], [HAPIE], '');
    // fell back to the identity-safe template: no appearance words, placeholder intact
    expect(out.imagePrompt).not.toMatch(/silver|copper|robot|lens-eyes/i);
    expect(out.imagePrompt).toContain(TAG);
    expect(out.imagePrompt).toContain('Featuring Hapie');
    expect(warn.mock.calls.some((c) => String(c[0]).includes('identity guard'))).toBe(true);
  });

  test('style-bible palette vocabulary does NOT trip the guard', async () => {
    // "amber"/"teal" are appearance terms but live in the style bible -> allowed.
    const { client } = mockClient({
      prompts: [{ lineIndex: 0, imagePrompt: `Warm amber lantern light, muted teal shadows; a figure climbs ${TAG}` }],
    });
    const warn = vi.fn();
    const [out] = await new LlmPromptEngine(config(), { client, warn }).imagePromptBatch(
      [line()],
      [HAPIE],
      'Muted teal shadows, warm amber key light.',
    );
    expect(out.imagePrompt).toContain('amber');
    expect(warn).not.toHaveBeenCalled();
  });

  test('appends a missing placeholder when the line references an element (tag preservation)', async () => {
    const { client } = mockClient({ prompts: [{ lineIndex: 0, imagePrompt: 'A figure climbs the tower stairs' }] });
    const [out] = await new LlmPromptEngine(config(), { client }).imagePromptBatch([line()], [HAPIE], '');
    expect(out.imagePrompt).toContain(TAG);
  });

  test('falls back to the template on an API error (never stalls)', async () => {
    const create = vi.fn(async () => {
      throw new Error('503 overloaded');
    });
    const warn = vi.fn();
    const engine = new LlmPromptEngine(config(), { client: { messages: { create } }, warn });
    const [out] = await engine.imagePromptBatch([line()], [HAPIE], '');
    expect(out.imagePrompt).toContain('Featuring Hapie');
    expect(out.imagePrompt).toContain(TAG);
    expect(warn.mock.calls.some((c) => String(c[0]).includes('image batch call failed'))).toBe(true);
  });

  test('missing ANTHROPIC_API_KEY (no injected client) falls back to the template', async () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const warn = vi.fn();
      const engine = new LlmPromptEngine(config(), { warn }); // no client
      const [out] = await engine.imagePromptBatch([line()], [HAPIE], '');
      expect(out.imagePrompt).toContain('Featuring Hapie');
      expect(warn.mock.calls.some((c) => String(c[0]).includes('ANTHROPIC_API_KEY'))).toBe(true);
    } finally {
      if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
    }
  });
});

describe('LlmPromptEngine.animationPrompt', () => {
  test('uses the model motion prompt when clean, preserving the placeholder', async () => {
    const { client } = mockClient({ animationPrompt: `Slow push-in as the figure climbs, lantern swaying ${TAG}` });
    const out = await new LlmPromptEngine(config(), { client }).animationPrompt(shot(), [HAPIE]);
    expect(out).toBe(`Slow push-in as the figure climbs, lantern swaying ${TAG}`);
  });

  test('IDENTITY GUARD: appearance leak on an element-tagged shot -> template', async () => {
    const { client } = mockClient({ animationPrompt: `The silver robot turns its metallic head ${TAG}` });
    const warn = vi.fn();
    const out = await new LlmPromptEngine(config(), { client, warn }).animationPrompt(shot(), [HAPIE]);
    expect(out).not.toMatch(/silver|robot|metallic/i);
    expect(out).toContain(TAG);
    expect(warn.mock.calls.some((c) => String(c[0]).includes('identity guard'))).toBe(true);
  });

  test('falls back to the template on an API error', async () => {
    const create = vi.fn(async () => {
      throw new Error('network down');
    });
    const warn = vi.fn();
    const out = await new LlmPromptEngine(config(), { client: { messages: { create } }, warn }).animationPrompt(
      shot(),
      [HAPIE],
    );
    expect(out).toContain(TAG);
    expect(warn.mock.calls.some((c) => String(c[0]).includes('animation call failed'))).toBe(true);
  });
});
