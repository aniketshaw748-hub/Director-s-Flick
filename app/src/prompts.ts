/**
 * prompts.ts — PromptEngine implementations (see ARCHITECTURE.md "prompts").
 *
 * ClaudePromptEngine   — Claude Agent SDK (query(), model 'sonnet'), used with
 *                        the real provider. Batches up to 5 lines per call,
 *                        injects the style bible, returns STRICT JSON.
 * TemplatePromptEngine — deterministic, offline, zero-token engine used with
 *                        MockProvider in runs/tests.
 *
 * Both engines embed Higgsfield element references as `<<<element_id>>>`
 * placeholders (via elementPlaceholder() from types.ts) — measured Phase 0
 * finding: element tags in image AND video prompts prevent identity drift.
 */

import { query } from '@anthropic-ai/claude-agent-sdk';
import type {
  ElementRef,
  LineTiming,
  PipelineConfig,
  PromptEngine,
  Shot,
} from './types.js';
import { elementPlaceholder } from './types.js';

/** Max script lines per Claude call (Phase 0 manual-flow batch size). */
const BATCH_LINE_LIMIT = 5;

// ---------------------------------------------------------------------------
// Shared helpers (module-private)
// ---------------------------------------------------------------------------

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Elements whose name (or a word-boundary match of it) appears in the given
 * text, case-insensitively. Registry order is preserved (deterministic).
 */
function relevantElements(text: string, elements: ElementRef[]): ElementRef[] {
  return elements.filter((el) => {
    const name = el.name.trim();
    if (name.length === 0) return false;
    return new RegExp(`\\b${escapeRegExp(name)}\\b`, 'i').test(text);
  });
}

/**
 * Guarantee the `<<<element_id>>>` placeholder invariant: any required element
 * id missing from the prompt text is appended. Idempotent and deterministic.
 */
function ensurePlaceholders(prompt: string, elementIds: string[]): string {
  let out = prompt.trim();
  for (const id of elementIds) {
    const tag = elementPlaceholder(id);
    if (!out.includes(tag)) out = `${out} ${tag}`;
  }
  return out;
}

/** Human-readable element registry block for LLM prompts. */
function describeElements(elements: ElementRef[]): string {
  if (elements.length === 0) return '(no registered elements)';
  return elements
    .map((el) => `- name: "${el.name}" | category: ${el.category} | placeholder: ${elementPlaceholder(el.id)}`)
    .join('\n');
}

/** Find the index of the `]` that balances the `[` at `start`, or -1. */
function scanBalancedArray(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Extract and parse the FIRST valid JSON array found anywhere in the reply. */
function extractFirstJsonArray(text: string): unknown[] | null {
  let from = 0;
  for (let guard = 0; guard < 50; guard++) {
    const start = text.indexOf('[', from);
    if (start === -1) return null;
    const end = scanBalancedArray(text, start);
    if (end !== -1) {
      try {
        const parsed: unknown = JSON.parse(text.slice(start, end + 1));
        if (Array.isArray(parsed)) return parsed;
      } catch {
        /* fall through to the next candidate '[' */
      }
    }
    from = start + 1;
  }
  return null;
}

/** Strip markdown fences / surrounding quotes, collapse to one line. */
function cleanSingleLinePrompt(reply: string): string {
  let out = reply.trim();
  // Drop fenced code blocks markers, keep inner content.
  out = out.replace(/```[a-zA-Z]*\n?/g, '').replace(/```/g, '');
  out = out.trim();
  if (
    (out.startsWith('"') && out.endsWith('"')) ||
    (out.startsWith("'") && out.endsWith("'"))
  ) {
    out = out.slice(1, -1);
  }
  return out.replace(/\s*\n+\s*/g, ' ').trim();
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// ---------------------------------------------------------------------------
// Deterministic templates (shared: TemplatePromptEngine + Claude fallbacks)
// ---------------------------------------------------------------------------

function templateImagePrompt(
  line: LineTiming,
  elements: ElementRef[],
  styleBible: string,
): string {
  const rel = relevantElements(line.text, elements);
  const parts: string[] = [];
  if (styleBible.trim().length > 0) parts.push(styleBible.trim().replace(/\s*\n+\s*/g, ' '));
  parts.push(`Cinematic 16:9 still frame depicting: ${line.text.trim()}`);
  for (const el of rel) {
    parts.push(`Featuring ${el.name} (${el.category}) ${elementPlaceholder(el.id)}.`);
  }
  return ensurePlaceholders(parts.join(' '), rel.map((el) => el.id));
}

function templateAnimationPrompt(shot: Shot, elements: ElementRef[]): string {
  const byId = new Map(elements.map((el) => [el.id, el]));
  const parts: string[] = [
    'Slow cinematic push-in, subtle handheld drift; natural ambient motion in the scene.',
    `The moment: ${shot.line.text.trim()}`,
  ];
  for (const id of shot.elementIds) {
    const el = byId.get(id);
    if (el) {
      parts.push(
        `${el.name} ${elementPlaceholder(el.id)} moves naturally and keeps exact identity, wardrobe and features.`,
      );
    }
  }
  return ensurePlaceholders(parts.join(' '), shot.elementIds);
}

// ---------------------------------------------------------------------------
// TemplatePromptEngine — deterministic, offline, zero-token
// ---------------------------------------------------------------------------

/** Deterministic, offline, zero-token engine for MockProvider runs and tests. */
export class TemplatePromptEngine implements PromptEngine {
  async imagePromptBatch(
    lines: LineTiming[],
    elements: ElementRef[],
    styleBible: string,
  ): Promise<{ lineIndex: number; imagePrompt: string }[]> {
    return lines.map((line) => ({
      lineIndex: line.index,
      imagePrompt: templateImagePrompt(line, elements, styleBible),
    }));
  }

  async animationPrompt(shot: Shot, elements: ElementRef[]): Promise<string> {
    return templateAnimationPrompt(shot, elements);
  }
}

// ---------------------------------------------------------------------------
// ClaudePromptEngine — Claude Agent SDK, Sonnet, ~5-line batches
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT =
  'You are a senior prompt engineer for AI image and video generation ' +
  '(Higgsfield: nano_banana_2 stills, kling3_0 image-to-video). ' +
  'You write vivid, concrete, production-ready prompts and you follow output-format ' +
  'instructions EXACTLY. `<<<uuid>>>` tokens are element reference placeholders and ' +
  'must be copied verbatim, never altered, never invented.';

/** Claude Agent SDK engine (query(), default model 'sonnet'). */
export class ClaudePromptEngine implements PromptEngine {
  private readonly model: string;

  constructor(opts?: { model?: string }) {
    this.model = opts?.model ?? 'sonnet';
  }

  /** One single-turn, tool-less query; returns the final result text. */
  private async ask(prompt: string): Promise<string> {
    const q = query({
      prompt,
      options: {
        model: this.model,
        systemPrompt: SYSTEM_PROMPT,
        tools: [], // no built-in tools — pure text generation
        maxTurns: 1,
      },
    });
    for await (const message of q) {
      if (message.type === 'result') {
        if (message.subtype === 'success') return message.result;
        throw new Error(`ClaudePromptEngine: query failed (${message.subtype})`);
      }
    }
    throw new Error('ClaudePromptEngine: query ended without a result message');
  }

  private buildImageBatchPrompt(
    lines: LineTiming[],
    elements: ElementRef[],
    styleBible: string,
  ): string {
    const lineBlock = lines
      .map((l) => `lineIndex ${l.index}: "${l.text.trim()}"`)
      .join('\n');
    return [
      'Write one AI image-generation prompt per narration line below. Each prompt is the',
      'first frame of a video clip covering that line: a single vivid cinematic 16:9 still',
      '(composition, subject, setting, lighting, lens). Do not mention audio or narration.',
      '',
      'STYLE BIBLE (must shape every prompt):',
      styleBible.trim().length > 0 ? styleBible.trim() : '(none provided)',
      '',
      'ELEMENT REGISTRY (recurring characters / locations / props):',
      describeElements(elements),
      '',
      'ELEMENT RULE: whenever a line mentions or clearly refers to a registered element,',
      "embed that element's placeholder token (e.g. <<<element-uuid>>>) verbatim inside the",
      'prompt text at the point where the element appears. Use ONLY placeholders from the',
      'registry above. Never fabricate placeholders.',
      '',
      'NARRATION LINES:',
      lineBlock,
      '',
      'OUTPUT FORMAT — STRICT: reply with ONLY a JSON array, no prose, no markdown fences:',
      '[{"lineIndex": <number>, "imagePrompt": "<string>"}, ...]',
      `Exactly one entry per line above (${lines.length} entries), using the given lineIndex values.`,
    ].join('\n');
  }

  private parseImageBatchReply(
    reply: string,
    wanted: Set<number>,
  ): Map<number, string> | null {
    const arr = extractFirstJsonArray(reply);
    if (arr === null) return null;
    const out = new Map<number, string>();
    for (const item of arr) {
      if (typeof item !== 'object' || item === null) continue;
      const rec = item as Record<string, unknown>;
      const lineIndex = rec['lineIndex'];
      const imagePrompt = rec['imagePrompt'];
      if (
        typeof lineIndex === 'number' &&
        Number.isInteger(lineIndex) &&
        wanted.has(lineIndex) &&
        typeof imagePrompt === 'string' &&
        imagePrompt.trim().length > 0 &&
        !out.has(lineIndex)
      ) {
        out.set(lineIndex, imagePrompt.trim());
      }
    }
    return out.size > 0 ? out : null;
  }

  async imagePromptBatch(
    lines: LineTiming[],
    elements: ElementRef[],
    styleBible: string,
  ): Promise<{ lineIndex: number; imagePrompt: string }[]> {
    const results: { lineIndex: number; imagePrompt: string }[] = [];

    for (const batch of chunk(lines, BATCH_LINE_LIMIT)) {
      const wanted = new Set(batch.map((l) => l.index));
      const basePrompt = this.buildImageBatchPrompt(batch, elements, styleBible);

      let parsed: Map<number, string> | null = null;
      let reply = await this.ask(basePrompt);
      parsed = this.parseImageBatchReply(reply, wanted);
      if (parsed === null) {
        // Retry once with a hard format reminder (per contract).
        reply = await this.ask(
          basePrompt +
            '\n\nYour previous reply could not be parsed. Reply again with ONLY the raw JSON ' +
            'array — first character "[", last character "]", valid JSON, nothing else.',
        );
        parsed = this.parseImageBatchReply(reply, wanted);
      }
      if (parsed === null) {
        throw new Error(
          `ClaudePromptEngine: could not parse a JSON array from the model reply after retry (lines ${[...wanted].join(', ')})`,
        );
      }

      for (const line of batch) {
        let imagePrompt = parsed.get(line.index);
        if (imagePrompt === undefined) {
          // Model skipped a line — deterministic fallback keeps the batch complete.
          imagePrompt = templateImagePrompt(line, elements, styleBible);
        }
        const rel = relevantElements(line.text, elements);
        results.push({
          lineIndex: line.index,
          imagePrompt: ensurePlaceholders(imagePrompt, rel.map((el) => el.id)),
        });
      }
    }

    return results;
  }

  async animationPrompt(shot: Shot, elements: ElementRef[]): Promise<string> {
    const byId = new Map(elements.map((el) => [el.id, el]));
    const shotElements = shot.elementIds
      .map((id) => byId.get(id))
      .filter((el): el is ElementRef => el !== undefined);

    const prompt = [
      'An approved still image will be animated with an image-to-video model (kling3_0,',
      `${shot.videoSeconds ?? 'a few'} seconds). Write ONE motion-focused animation prompt for it.`,
      'Describe ONLY motion: camera move (e.g. slow push-in, pan, handheld drift), subject',
      'movement, and ambient/secondary motion. Do NOT re-describe the scene as a still, do',
      'not mention audio, text or narration.',
      '',
      `The still was generated from this prompt: "${(shot.imagePrompt ?? shot.line.text).trim()}"`,
      `It covers the narration line: "${shot.line.text.trim()}"`,
      '',
      shotElements.length > 0
        ? 'ELEMENT RULE (identity lock): re-embed EACH of these placeholder tokens verbatim in ' +
          'your prompt, attached to the matching subject:\n' +
          describeElements(shotElements)
        : 'No element placeholders are required for this shot.',
      '',
      'OUTPUT FORMAT — STRICT: reply with ONLY the prompt text itself on a single line.',
      'No quotes, no markdown, no preamble, no explanation.',
    ].join('\n');

    let text = cleanSingleLinePrompt(await this.ask(prompt));
    if (text.length === 0) {
      // Retry once (per contract: robust parse, one retry).
      text = cleanSingleLinePrompt(
        await this.ask(prompt + '\n\nYour previous reply was empty. Reply with the prompt text only.'),
      );
    }
    if (text.length === 0) {
      throw new Error(
        `ClaudePromptEngine: empty animation prompt from the model after retry (shot ${shot.id})`,
      );
    }
    return ensurePlaceholders(text, shot.elementIds);
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Mock provider -> deterministic TemplatePromptEngine; real provider -> Claude. */
export function createPromptEngine(config: PipelineConfig): PromptEngine {
  return config.provider === 'mock'
    ? new TemplatePromptEngine()
    : new ClaudePromptEngine();
}

/**
 * Back-compat alias: some earlier drafts referred to the deterministic engine
 * as "MockPromptEngine". ARCHITECTURE.md's canonical name is
 * TemplatePromptEngine; both names resolve to the same class.
 */
export { TemplatePromptEngine as MockPromptEngine };
