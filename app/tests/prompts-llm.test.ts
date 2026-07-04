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

  test('explicit null client (no LLM transport at all) falls back to the template', async () => {
    // Policy change (owner-directed 2026-07-04): a missing ANTHROPIC_API_KEY now
    // resolves to the headless claude-CLI transport instead of "no client", so
    // the no-transport fallback path is exercised via explicit client: null.
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const warn = vi.fn();
      const engine = new LlmPromptEngine(config(), { warn, client: null });
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

// ---------------------------------------------------------------------------
// Branch-coverage stragglers (T-82, test-only): constructor env-key path,
// reply-shape fallbacks, model-skipped lines, null-client animation, the
// non-fragile (location) element path, and the empty-name element guard.
// All hermetic — no network, no ANTHROPIC_API_KEY call.
// ---------------------------------------------------------------------------

const LOCATION: ElementRef = { id: 'loc-uuid', name: 'Lighthouse', category: 'location' };
const LOC_TAG = '<<<loc-uuid>>>';

describe('LlmPromptEngine branch coverage (T-82)', () => {
  test('constructor takes the env-key branch when no client is injected (no network at construction)', () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-ant-dummy-never-called';
    try {
      const engine = new LlmPromptEngine(config()); // executes `new Anthropic()` — construction only, no API call
      expect(engine).toBeInstanceOf(LlmPromptEngine);
    } finally {
      if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = saved;
    }
  });

  test('a reply with no text block falls back to the template', async () => {
    const create = vi.fn(async () => ({ content: [{ type: 'tool_use' }] }));
    const engine = new LlmPromptEngine(config(), { client: { messages: { create } }, warn: vi.fn() });
    const [out] = await engine.imagePromptBatch([line()], [HAPIE], '');
    expect(out.imagePrompt).toContain('Featuring Hapie');
    expect(out.imagePrompt).toContain(TAG);
  });

  test('a result whose "prompts" is not an array -> the line uses the template', async () => {
    const { client } = mockClient({ prompts: 'not-an-array' });
    const [out] = await new LlmPromptEngine(config(), { client }).imagePromptBatch([line()], [HAPIE], '');
    expect(out.imagePrompt).toContain('Featuring Hapie');
  });

  test('non-object entries in the prompts array are skipped', async () => {
    const { client } = mockClient({ prompts: [null, 42, 'x'] });
    const [out] = await new LlmPromptEngine(config(), { client }).imagePromptBatch([line()], [HAPIE], '');
    expect(out.imagePrompt).toContain('Featuring Hapie');
  });

  test('a line the model skipped uses the template; a returned line uses the model output', async () => {
    const { client } = mockClient({ prompts: [{ lineIndex: 0, imagePrompt: `A figure climbs ${TAG}` }] });
    const engine = new LlmPromptEngine(config(), { client });
    const out = await engine.imagePromptBatch([line(0), line(1, 'Hapie reaches the top.')], [HAPIE], '');
    expect(out).toHaveLength(2);
    expect(out[0].imagePrompt).toContain(TAG); // model output for line 0
    expect(out[1].imagePrompt).toContain('Featuring Hapie'); // template for the skipped line 1
  });

  test('animationPrompt with explicit null client falls back to the template', async () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const warn = vi.fn();
      const out = await new LlmPromptEngine(config(), { warn, client: null }).animationPrompt(shot(), [HAPIE]);
      expect(out).toContain(TAG);
      expect(warn.mock.calls.some((c) => String(c[0]).includes('ANTHROPIC_API_KEY'))).toBe(true);
    } finally {
      if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
    }
  });

  test('an animation reply lacking a string animationPrompt falls back to the template', async () => {
    const { client } = mockClient({ notThePrompt: 'oops' });
    const out = await new LlmPromptEngine(config(), { client, warn: vi.fn() }).animationPrompt(shot(), [HAPIE]);
    expect(out).toContain(TAG);
  });

  test('a location-only shot is not "fragile" (no character/prop) — motion prompt passes through', async () => {
    const { client } = mockClient({ animationPrompt: `Slow drift over the cliffs ${LOC_TAG}` });
    const s = shot({ elementIds: ['loc-uuid'] });
    const out = await new LlmPromptEngine(config(), { client }).animationPrompt(s, [LOCATION]);
    expect(out).toContain('drift');
    expect(out).toContain(LOC_TAG);
  });

  test('an element with an all-whitespace name never matches (relevantElements guard)', async () => {
    const BLANK: ElementRef = { id: 'blank-uuid', name: '   ', category: 'character' };
    const { client } = mockClient({ prompts: [{ lineIndex: 0, imagePrompt: 'A figure <<<blank-uuid>>>' }] });
    const [out] = await new LlmPromptEngine(config(), { client }).imagePromptBatch([line()], [BLANK], '');
    expect(out.lineIndex).toBe(0); // no crash; blank-named element is simply never name-matched
  });
});

// ---------------------------------------------------------------------------
// T-89 — owner's documentary Master System Prompt wired in + Rule 3/12 guards.
// ---------------------------------------------------------------------------

describe('LlmPromptEngine documentary system prompt + rule guards (T-89)', () => {
  test('the owner spec (documentary-image-writer.md) is loaded and sent as the image system', async () => {
    const { client, create } = mockClient({ prompts: [{ lineIndex: 0, imagePrompt: `A figure climbs the stairs ${TAG}` }] });
    await new LlmPromptEngine(config(), { client }).imagePromptBatch([line()], [HAPIE], '');
    const system = String(create.mock.calls[0][0].system);
    expect(system).toContain('documentary visual storyteller'); // verbatim from the spec file
    expect(system).toContain('No split screens'); // Rule 3 heading text from the spec
    expect(system).toContain('<<<element_id>>>'); // the appended identity/placeholder bridge
  });

  test('imageSystemPrompt override replaces the loaded spec (bridge still appended)', async () => {
    const { client, create } = mockClient({ prompts: [{ lineIndex: 0, imagePrompt: `x ${TAG}` }] });
    await new LlmPromptEngine(config(), { client, imageSystemPrompt: 'CUSTOM_SPEC_MARKER_XYZ' }).imagePromptBatch(
      [line()],
      [HAPIE],
      '',
    );
    const system = String(create.mock.calls[0][0].system);
    expect(system).toContain('CUSTOM_SPEC_MARKER_XYZ');
    expect(system).toContain('<<<element_id>>>');
  });

  test('RULE 3 guard: a split-screen / before-after prompt is rejected -> template', async () => {
    const { client } = mockClient({
      prompts: [{ lineIndex: 0, imagePrompt: `A before vs after split-screen of the factory ${TAG}` }],
    });
    const warn = vi.fn();
    const [out] = await new LlmPromptEngine(config(), { client, warn }).imagePromptBatch([line()], [HAPIE], '');
    expect(out.imagePrompt).toContain('Featuring Hapie'); // identity-safe template substituted
    expect(out.imagePrompt).not.toMatch(/split-screen/i);
    expect(warn.mock.calls.some((c) => String(c[0]).includes('Rule 3'))).toBe(true);
  });

  test('RULE 12 guard: a readable-in-image-text prompt is rejected -> template', async () => {
    const { client } = mockClient({
      prompts: [{ lineIndex: 0, imagePrompt: `A newspaper headline reading "SUCCESS" on a desk ${TAG}` }],
    });
    const warn = vi.fn();
    const [out] = await new LlmPromptEngine(config(), { client, warn }).imagePromptBatch([line()], [HAPIE], '');
    expect(out.imagePrompt).toContain('Featuring Hapie');
    expect(out.imagePrompt).not.toMatch(/newspaper|headline/i);
    expect(warn.mock.calls.some((c) => String(c[0]).includes('Rule 12'))).toBe(true);
  });

  test('a clean documentary prompt (no split screen / text / appearance leak) passes through', async () => {
    const { client } = mockClient({
      prompts: [{ lineIndex: 0, imagePrompt: `Workers load finished products into a delivery truck ${TAG}` }],
    });
    const warn = vi.fn();
    const [out] = await new LlmPromptEngine(config(), { client, warn }).imagePromptBatch([line()], [HAPIE], '');
    expect(out.imagePrompt).toBe(`Workers load finished products into a delivery truck ${TAG}`);
    expect(warn).not.toHaveBeenCalled();
  });

  test('animation prompts use the documentary-framed motion system (single moment, no split screens)', async () => {
    const { client, create } = mockClient({ animationPrompt: `Slow push-in as the figure climbs ${TAG}` });
    await new LlmPromptEngine(config(), { client }).animationPrompt(shot(), [HAPIE]);
    const system = String(create.mock.calls[0][0].system);
    expect(system).toMatch(/documentary/i);
    expect(system).toMatch(/split screens/i);
  });
});
