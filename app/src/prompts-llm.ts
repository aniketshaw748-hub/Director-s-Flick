/**
 * prompts-llm.ts — LlmPromptEngine: optional LLM-backed PromptEngine (T-55).
 *
 * Selected by `config.promptBackend === 'llm'` (wired in prompts.ts). Uses the
 * OFFICIAL Anthropic SDK (`@anthropic-ai/sdk`) — never raw fetch — with model
 * `config.llmModel` (default `claude-opus-4-8`) and structured JSON output
 * (`output_config.format`). The `thinking` param is omitted (Opus 4.8 runs
 * without it when omitted).
 *
 * Two invariants make this safe to drop into the pipeline:
 *   1. NEVER STALL. On any API error, a missing ANTHROPIC_API_KEY, an
 *      unparseable reply, or an identity-rule violation, it falls back to the
 *      deterministic TemplatePromptEngine (identity-safe by construction) and
 *      logs a warning. A prompt is always produced.
 *   2. ELEMENT-IDENTITY RULE (the quality-critical invariant — T-08's wrong-robot
 *      regression). The system prompt forbids physically describing an
 *      element-tagged subject; a post-generation IDENTITY GUARD then rejects any
 *      image/animation prompt that still leaks a physical description of an
 *      identity-fragile (character/prop) element and substitutes the template's
 *      identity-safe prompt for that line/shot. The guard is deliberately
 *      conservative: a false positive costs a (still-correct) template prompt,
 *      never a wrong character.
 *
 * Hermetic: the Anthropic client is injectable (opts.client); tests pass a mock
 * and no network / API key is required.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { createClaudeCliClient } from './llm-cli.js';
import type { ElementRef, LineTiming, PipelineConfig, PromptEngine, Shot } from './types.js';
import { elementPlaceholder } from './types.js';
import { TemplatePromptEngine } from './prompts.js';

const DEFAULT_LLM_MODEL = 'claude-opus-4-8';
const BATCH_LINE_LIMIT = 5;
const MAX_TOKENS = 4096;

/**
 * The element-identity rule, shared verbatim with prompts.ts's ClaudePromptEngine
 * (T-32): a `<<<uuid>>>` placeholder already carries the element's appearance via
 * its reference image, so describing it in words competes with — and can override —
 * that image, producing the wrong character.
 */
const SYSTEM_PROMPT =
  'You are a senior prompt engineer for AI image and video generation ' +
  '(Higgsfield: nano_banana_2 stills, kling3_0 image-to-video). ' +
  'You write vivid, concrete, production-ready prompts and follow output-format ' +
  'instructions EXACTLY. `<<<uuid>>>` tokens are element reference placeholders and ' +
  'must be copied verbatim, never altered, never invented. ' +
  'CRITICAL IDENTITY RULE: a registered element (its `<<<uuid>>>` placeholder) already IS ' +
  "that character/location/prop's appearance via its own reference image — the placeholder " +
  'carries identity, not the words around it. NEVER physically describe an element-tagged ' +
  'subject (no colors, materials, species, build, distinguishing features, clothing details). ' +
  'For an element-tagged subject, describe ONLY action, pose, framing, environment, and lighting.';

// ---------------------------------------------------------------------------
// Documentary Image Prompt Writer (owner-authored spec) + rule post-checks (T-89)
// ---------------------------------------------------------------------------

/** app/prompts/documentary-image-writer.md, resolved relative to this module. */
const DOC_SPEC_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'prompts',
  'documentary-image-writer.md',
);

/** Load the owner's verbatim documentary spec; null if unreadable (fallback path). */
function loadDocumentarySpec(): string | null {
  try {
    const text = fs.readFileSync(DOC_SPEC_PATH, 'utf-8').trim();
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

/**
 * Appended after the documentary spec so its Rule 14 (real people =
 * reference-only, never described) is realized through THIS pipeline's
 * `<<<element_id>>>` placeholder mechanism, and so the structured-JSON envelope
 * is reconciled with Rule 23 ("output only the finished prompt").
 */
const IMAGE_IDENTITY_BRIDGE =
  '\n\n---\n\n# Placeholder & identity mechanism (realizes Rule 14 here)\n' +
  'Registered subjects are supplied as `<<<element_id>>>` placeholder tokens. For each relevant ' +
  'element, embed its placeholder verbatim (never alter or invent one) and NEVER physically ' +
  'describe an element-tagged subject — no colors, materials, species, build, features, or ' +
  'clothing. The placeholder already carries identity via a reference image; describe only ' +
  'action, pose, framing, environment, and lighting for that subject. The style bible in the ' +
  'user message applies to every prompt.\n' +
  'OUTPUT: return the required JSON exactly; put ONLY the finished cinematic scene description in ' +
  'each `imagePrompt` field (no reasoning or commentary, per Rule 23). One entry per requested lineIndex.';

/** Built-in fallback if the spec file is unreadable (keeps the engine working). */
const IMAGE_SYSTEM_FALLBACK = SYSTEM_PROMPT + IMAGE_IDENTITY_BRIDGE;

function buildImageSystem(spec: string | null): string {
  return spec ? spec + IMAGE_IDENTITY_BRIDGE : IMAGE_SYSTEM_FALLBACK;
}

/**
 * Animation keeps its own motion-only engine but inherits the documentary framing
 * (single decisive moment, visible action, one continuous scene, no split screens,
 * no on-screen text) and the identity rule.
 */
const ANIMATION_SYSTEM =
  'You are a documentary cinematographer writing image-to-video MOTION prompts (kling3_0) for a ' +
  'single already-generated still. Describe ONLY motion: one camera move (slow push-in, pan, ' +
  'handheld drift) plus subject and ambient/secondary motion. Documentary realism (inherited from ' +
  'the image spec): one continuous real scene, a single decisive moment with visible action, NO ' +
  'split screens / collages / before-after / picture-in-picture, and no readable on-screen text. ' +
  '`<<<element_id>>>` placeholders are copied verbatim and their subjects are NEVER physically ' +
  'described (identity lives in the reference image). Follow the JSON schema EXACTLY.';

// Rule 3 (no split screens) and Rule 12 (no readable text) — conservative,
// high-precision post-checks. A trip rejects the LLM prompt and substitutes the
// identity-safe template, exactly like the identity guard: a false positive costs
// a still-correct template prompt, never a rule violation shipped.
const RULE3_SPLIT_SCREEN =
  /\b(split[- ]?screens?|before\s*(?:vs\.?|versus|and|\/)\s*after|side[- ]by[- ]side|picture[- ]in[- ]picture|collages?|diptychs?|triptychs?|left\s*(?:vs\.?|versus)\s*right|past\s*(?:vs\.?|versus)\s*present|multiple (?:panels|frames)|split into (?:two|three|multiple) (?:frames|panels))\b/i;

const RULE12_READABLE_TEXT =
  /\b(captions?|subtitles?|newspapers?|news articles?|headlines?|signboards?|billboards?|infographics?|power\s?points?|teleprompters?)\b|\b(?:sign|text|banner|label|poster|screen|words?)\s+(?:that\s+)?read(?:s|ing)\b|\b(?:reads?|reading)\s*["“']|\breadable text\b/i;

/** Rule 3: the prompt describes a split-screen / multi-frame / comparison composition. */
function violatesRule3(prompt: string): boolean {
  return RULE3_SPLIT_SCREEN.test(prompt);
}
/** Rule 12: the prompt relies on readable in-image text (captions, signs, headlines, …). */
function violatesRule12(prompt: string): boolean {
  return RULE12_READABLE_TEXT.test(prompt);
}

// ---------------------------------------------------------------------------
// Injectable client surface (the real @anthropic-ai/sdk client satisfies it)
// ---------------------------------------------------------------------------

/** Minimal shape of `client.messages` used here; the real SDK client satisfies it. */
export interface LlmClient {
  messages: {
    create(
      params: Record<string, unknown>,
    ): Promise<{ content: Array<{ type: string; text?: string }> }>;
  };
}

export interface LlmPromptEngineOptions {
  /** Override the model (else config.llmModel, else claude-opus-4-8). */
  model?: string;
  /** Injected client (tests). Default: a real Anthropic() when ANTHROPIC_API_KEY is set. */
  client?: LlmClient;
  /** Warning sink for fallbacks (default console.warn; tests capture it). */
  warn?: (message: string) => void;
  /**
   * Override the loaded documentary image system spec (T-89). Absent → load
   * app/prompts/documentary-image-writer.md; a string → use it; null → force the
   * built-in fallback (exercised by tests). Present-key detection, not `??`.
   */
  imageSystemPrompt?: string | null;
}

// ---------------------------------------------------------------------------
// Local helpers (kept local so this module doesn't reach into prompts.ts internals)
// ---------------------------------------------------------------------------

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Elements whose name matches (word-boundary, case-insensitive) the text. */
function relevantElements(text: string, elements: ElementRef[]): ElementRef[] {
  return elements.filter((el) => {
    const name = el.name.trim();
    if (name.length === 0) return false;
    return new RegExp(`\\b${escapeRegExp(name)}\\b`, 'i').test(text);
  });
}

/** Append any required `<<<id>>>` placeholder missing from the prompt (idempotent). */
function ensurePlaceholders(prompt: string, elementIds: string[]): string {
  let out = prompt.trim();
  for (const id of elementIds) {
    const tag = elementPlaceholder(id);
    if (!out.includes(tag)) out = `${out} ${tag}`;
  }
  return out;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function describeElements(elements: ElementRef[]): string {
  if (elements.length === 0) return '(no registered elements)';
  return elements
    .map(
      (el) =>
        `- name: "${el.name}" | category: ${el.category} | placeholder: ${elementPlaceholder(el.id)}`,
    )
    .join('\n');
}

// ---------------------------------------------------------------------------
// Identity guard — physical-description leak detection
// ---------------------------------------------------------------------------

/**
 * Appearance vocabulary the identity rule forbids around an element-tagged
 * subject: colors, materials, species/build, and distinguishing features. Not
 * exhaustive — it targets the leak class from T-08 ("silver-and-copper robot,
 * rounded lens-eyes"). Missing a term degrades gracefully (the placeholder still
 * carries identity); catching one substitutes the identity-safe template.
 */
const APPEARANCE_TERMS =
  /\b(silver|copper|gold(?:en)?|bronze|brass|chrome|metallic|metal|steel|iron|plastic|wooden|wood|glass|ceramic|rubber|leather|fabric|red|orange|yellow|green|blue|purple|violet|pink|brown|black|white|grey|gray|crimson|scarlet|azure|teal|amber|beige|tan|robot|robotic|android|humanoid|cyborg|mechanical|feathered|furry|scaled|winged|bearded|blonde|brunette|redheaded|freckled|tall|short|stocky|slender|muscular|lanky)\b/gi;

/**
 * True when `prompt` physically describes an identity-fragile (character/prop)
 * element that the line references — i.e. it leaks appearance the placeholder is
 * supposed to own. Terms already present in the style bible are excluded, so
 * palette/material style vocabulary ("muted teal", "warm amber") never
 * false-positives. Location-only lines are exempt (environments are, by nature,
 * described).
 */
function leaksElementAppearance(
  prompt: string,
  relevant: ElementRef[],
  styleBible: string,
): boolean {
  const fragile = relevant.some((el) => el.category === 'character' || el.category === 'prop');
  if (!fragile) return false;
  const bible = styleBible.toLowerCase();
  const matches = prompt.match(APPEARANCE_TERMS);
  if (!matches) return false;
  return matches.some((m) => !bible.includes(m.toLowerCase()));
}

// ---------------------------------------------------------------------------
// JSON schemas for structured output
// ---------------------------------------------------------------------------

const IMAGE_SCHEMA = {
  type: 'object',
  properties: {
    prompts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          lineIndex: { type: 'integer' },
          imagePrompt: { type: 'string' },
        },
        required: ['lineIndex', 'imagePrompt'],
        additionalProperties: false,
      },
    },
  },
  required: ['prompts'],
  additionalProperties: false,
} as const;

const ANIMATION_SCHEMA = {
  type: 'object',
  properties: { animationPrompt: { type: 'string' } },
  required: ['animationPrompt'],
  additionalProperties: false,
} as const;

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export class LlmPromptEngine implements PromptEngine {
  private readonly model: string;
  private readonly client: LlmClient | null;
  private readonly template = new TemplatePromptEngine();
  private readonly warn: (message: string) => void;
  /** Documentary image system prompt (owner spec + identity bridge), loaded once (T-89). */
  private readonly imageSystem: string;
  /** Motion system prompt inheriting documentary framing (T-89). */
  private readonly animationSystem: string = ANIMATION_SYSTEM;

  constructor(config: PipelineConfig, opts: LlmPromptEngineOptions = {}) {
    this.model = opts.model ?? config.llmModel ?? DEFAULT_LLM_MODEL;
    this.warn = opts.warn ?? ((m) => console.warn(m));
    if ('client' in opts) {
      // Explicit injection (tests): null means "no client", full stop.
      this.client = opts.client ?? null;
    } else if (process.env.ANTHROPIC_API_KEY) {
      this.client = new Anthropic() as unknown as LlmClient;
    } else {
      // Owner-directed (2026-07-04): no API keys — run prompts through the
      // headless Claude Code CLI on the owner's subscription. Spawn failures
      // surface per-call and hit the existing never-stall template fallback.
      this.client = createClaudeCliClient({ model: this.model }) as unknown as LlmClient;
    }
    // T-89: load the owner's documentary spec at construction (or an override/fallback).
    const spec = 'imageSystemPrompt' in opts ? (opts.imageSystemPrompt ?? null) : loadDocumentarySpec();
    if (!('imageSystemPrompt' in opts) && spec === null) {
      this.warn('[prompts-llm] documentary-image-writer.md unreadable; using built-in fallback system prompt');
    }
    this.imageSystem = buildImageSystem(spec);
  }

  private fellBack(reason: string): void {
    this.warn(`[prompts-llm] falling back to the template engine: ${reason}`);
  }

  private extractText(res: { content: Array<{ type: string; text?: string }> }): string | null {
    for (const block of res.content ?? []) {
      if (block.type === 'text' && typeof block.text === 'string') return block.text;
    }
    return null;
  }

  /** One structured-JSON Messages call. Throws on any failure (callers fall back). */
  private async callJson(user: string, schema: unknown, system: string): Promise<unknown> {
    if (this.client === null) throw new Error('no Anthropic client (ANTHROPIC_API_KEY unset)');
    const res = await this.client.messages.create({
      model: this.model,
      max_tokens: MAX_TOKENS,
      system,
      messages: [{ role: 'user', content: user }],
      output_config: { format: { type: 'json_schema', schema } },
    });
    const text = this.extractText(res);
    if (text === null) throw new Error('model reply had no text block');
    return JSON.parse(text) as unknown;
  }

  private buildImageUser(lines: LineTiming[], elements: ElementRef[], styleBible: string): string {
    const lineBlock = lines.map((l) => `lineIndex ${l.index}: "${l.text.trim()}"`).join('\n');
    return [
      'Write one AI image-generation prompt per narration line below — each is the first frame',
      'of a video clip covering that line: a single vivid cinematic 16:9 still (composition,',
      'subject, setting, lighting, lens). Do not mention audio or narration.',
      '',
      'STYLE BIBLE (must shape every prompt):',
      styleBible.trim().length > 0 ? styleBible.trim() : '(none provided)',
      '',
      'ELEMENT REGISTRY (recurring characters / locations / props):',
      describeElements(elements),
      '',
      "ELEMENT RULE: when a line references a registered element, embed that element's",
      'placeholder token (e.g. <<<element-uuid>>>) verbatim at the point it appears. Use ONLY',
      'placeholders from the registry; never fabricate one. Do NOT physically describe an',
      'element-tagged subject (no colors, materials, species, build, distinguishing features,',
      'clothing) — the placeholder already defines its appearance. Describe only its action,',
      'pose, and how it fits the framing / environment / lighting.',
      '',
      'NARRATION LINES:',
      lineBlock,
      '',
      `Return exactly one entry per line above (${lines.length} entries) using the given lineIndex values.`,
    ].join('\n');
  }

  private buildAnimationUser(shot: Shot, shotElements: ElementRef[]): string {
    return [
      'An approved still image will be animated with an image-to-video model (kling3_0,',
      `${shot.videoSeconds ?? 'a few'} seconds). Write ONE motion-focused animation prompt.`,
      'Describe ONLY motion: camera move (slow push-in, pan, handheld drift), subject movement,',
      'and ambient/secondary motion. Do NOT re-describe the scene as a still; no audio or text.',
      '',
      `The still was generated from: "${(shot.imagePrompt ?? shot.line.text).trim()}"`,
      `It covers the narration line: "${shot.line.text.trim()}"`,
      '',
      shotElements.length > 0
        ? 'ELEMENT RULE (identity lock): re-embed EACH placeholder token verbatim, attached to its ' +
          'subject:\n' +
          describeElements(shotElements) +
          '\nDo NOT physically describe any element-tagged subject — describe only its motion.'
        : 'No element placeholders are required for this shot.',
    ].join('\n');
  }

  private parseImageJson(json: unknown, wanted: Set<number>): Map<number, string> {
    const out = new Map<number, string>();
    const arr =
      json !== null && typeof json === 'object' && Array.isArray((json as Record<string, unknown>)['prompts'])
        ? ((json as Record<string, unknown>)['prompts'] as unknown[])
        : [];
    for (const item of arr) {
      if (item === null || typeof item !== 'object') continue;
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
    return out;
  }

  async imagePromptBatch(
    lines: LineTiming[],
    elements: ElementRef[],
    styleBible: string,
  ): Promise<{ lineIndex: number; imagePrompt: string }[]> {
    if (this.client === null) {
      this.fellBack('ANTHROPIC_API_KEY not set');
      return this.template.imagePromptBatch(lines, elements, styleBible);
    }

    const results: { lineIndex: number; imagePrompt: string }[] = [];
    for (const batch of chunk(lines, BATCH_LINE_LIMIT)) {
      const wanted = new Set(batch.map((l) => l.index));
      let map: Map<number, string> = new Map();
      try {
        map = this.parseImageJson(
          await this.callJson(this.buildImageUser(batch, elements, styleBible), IMAGE_SCHEMA, this.imageSystem),
          wanted,
        );
      } catch (err) {
        this.fellBack(`image batch call failed: ${errMessage(err)}`);
        map = new Map();
      }

      for (const line of batch) {
        const rel = relevantElements(line.text, elements);
        const llmPrompt = map.get(line.index);
        // Guard chain — a trip substitutes the identity-safe template for that line.
        // (undefined = model skipped the line: template, no warning.)
        let reject: string | null = null;
        if (llmPrompt === undefined) reject = 'skipped';
        else if (leaksElementAppearance(llmPrompt, rel, styleBible))
          reject = 'identity guard rejected — physical description of an element-tagged subject';
        else if (violatesRule3(llmPrompt)) reject = 'Rule 3 rejected — split-screen / multi-frame composition';
        else if (violatesRule12(llmPrompt)) reject = 'Rule 12 rejected — readable in-image text';

        if (reject !== null) {
          if (llmPrompt !== undefined) this.fellBack(`image prompt for line ${line.index}: ${reject}`);
          const [t] = await this.template.imagePromptBatch([line], elements, styleBible);
          results.push({ lineIndex: line.index, imagePrompt: t!.imagePrompt });
        } else {
          results.push({
            lineIndex: line.index,
            imagePrompt: ensurePlaceholders(llmPrompt!, rel.map((el) => el.id)),
          });
        }
      }
    }
    return results;
  }

  async animationPrompt(shot: Shot, elements: ElementRef[]): Promise<string> {
    const byId = new Map(elements.map((el) => [el.id, el]));
    const shotElements = shot.elementIds
      .map((id) => byId.get(id))
      .filter((el): el is ElementRef => el !== undefined);
    const fragile = shotElements.some((el) => el.category === 'character' || el.category === 'prop');

    if (this.client === null) {
      this.fellBack('ANTHROPIC_API_KEY not set');
      return this.template.animationPrompt(shot, elements);
    }

    let text: string | null = null;
    try {
      const json = await this.callJson(this.buildAnimationUser(shot, shotElements), ANIMATION_SCHEMA, this.animationSystem);
      const raw =
        json !== null && typeof json === 'object'
          ? (json as Record<string, unknown>)['animationPrompt']
          : undefined;
      text = typeof raw === 'string' ? raw.trim() : null;
    } catch (err) {
      this.fellBack(`animation call failed: ${errMessage(err)}`);
      text = null;
    }

    if (text === null || text.length === 0) {
      return this.template.animationPrompt(shot, elements);
    }
    // Animation carries no style bible, so any appearance term on an element-tagged
    // shot is treated as an identity leak. (Use .match, not .test — APPEARANCE_TERMS
    // is a /g regex and .test() would be stateful across calls.)
    if (fragile && text.match(APPEARANCE_TERMS) !== null) {
      this.fellBack(`identity guard rejected animation prompt for shot ${shot.id}`);
      return this.template.animationPrompt(shot, elements);
    }
    return ensurePlaceholders(text, shot.elementIds);
  }
}
