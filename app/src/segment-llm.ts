/**
 * segment-llm.ts — LLM-based semantic script segmentation (owner-directed).
 *
 * The owner's direction (2026-07-04): shot boundaries must come from MEANING,
 * not from voiceover gaps or punctuation heuristics. Rule 1 of the owner's
 * Documentary Image Prompt Writer spec ("one visual idea per prompt") is the
 * segmentation criterion itself: the LLM reads the full narration and cuts it
 * into one-visual-idea segments; word-level alignment then only TIMES those
 * segments, never decides them.
 *
 * Contract with callers (align.ts):
 *   - llmSegmentScript() returns the segments as an EXACT partition of the
 *     script's word sequence (validated token-by-token, one corrective retry),
 *     or throws SegmentationError — callers fall back to the heuristic
 *     splitter and keep the pipeline moving (never stall, same invariant as
 *     prompts-llm.ts).
 *   - Hermetic: the Anthropic client is injectable (opts.client); tests pass a
 *     mock and no network / API key is required.
 */

import Anthropic from '@anthropic-ai/sdk';

const DEFAULT_LLM_MODEL = 'claude-opus-4-8';
const MAX_TOKENS = 8192;

/** Minimal client surface (mirrors prompts-llm.ts) so tests can inject a mock. */
export interface SegmentLlmClient {
  messages: { create(req: Record<string, unknown>): Promise<unknown> };
}

export class SegmentationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SegmentationError';
  }
}

export interface LlmSegmentOptions {
  model?: string;
  client?: SegmentLlmClient | null;
  warn?: (message: string) => void;
}

const SEGMENT_SYSTEM =
  'You are a documentary film editor dividing narration into shots. Divide the ' +
  'narration into segments where EACH SEGMENT IS EXACTLY ONE VISUAL IDEA — one ' +
  'moment a documentary camera could film as a single photograph (owner rule: ' +
  '"one visual idea per prompt"). A new subject, action, consequence, or scene ' +
  'starts a new segment. Narration may be Hinglish (Hindi in Latin script mixed ' +
  'with English): connectives like "par", "aur", "toh", "lekin", "kyunki" often ' +
  'begin a new idea. Segments are typically 5-20 words; never split a number or ' +
  'proper name from its clause.\n' +
  'HARD CONSTRAINT: the segments, concatenated in order, must reproduce the ' +
  'narration EXACTLY word-for-word — copy the text verbatim into segments; do ' +
  'not add, drop, reorder, translate, or rewrite ANY word or punctuation.\n' +
  'Return the required JSON exactly: {"segments": ["...", "..."]}.';

const SEGMENT_SCHEMA = {
  type: 'object',
  properties: {
    segments: { type: 'array', items: { type: 'string' }, minItems: 1 },
  },
  required: ['segments'],
  additionalProperties: false,
} as const;

/** Whitespace-insensitive token sequence used to validate the partition. */
function tokens(text: string): string[] {
  return text.split(/\s+/).filter((t) => t.length > 0);
}

function isExactPartition(script: string, segments: string[]): boolean {
  const a = tokens(script);
  const b = tokens(segments.join(' '));
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function extractText(res: unknown): string | null {
  const content = (res as { content?: unknown })?.content;
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    const b = block as { type?: unknown; text?: unknown };
    if (b?.type === 'text' && typeof b.text === 'string' && b.text.length > 0) return b.text;
  }
  return null;
}

function resolveClient(opts: LlmSegmentOptions): SegmentLlmClient | null {
  if (opts.client !== undefined) return opts.client;
  if (process.env.ANTHROPIC_API_KEY) return new Anthropic() as unknown as SegmentLlmClient;
  return null;
}

/**
 * Segment `scriptText` (full narration, whitespace-normalized by the caller)
 * into one-visual-idea segments. Exact-partition validated; ONE corrective
 * retry on mismatch; throws SegmentationError on any failure.
 */
export async function llmSegmentScript(scriptText: string, opts: LlmSegmentOptions = {}): Promise<string[]> {
  const client = resolveClient(opts);
  if (client === null) {
    throw new SegmentationError('LLM segmentation unavailable: ANTHROPIC_API_KEY is not set');
  }
  const model = opts.model ?? DEFAULT_LLM_MODEL;
  const baseUser = `Divide this narration into one-visual-idea segments (verbatim partition):\n\n${scriptText}`;

  let lastProblem = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const user =
      attempt === 0
        ? baseUser
        : `${baseUser}\n\nYour previous answer was NOT an exact word-for-word partition (${lastProblem}). ` +
          'Redo it: copy the narration verbatim into segments — same words, same order, nothing added or dropped.';
    let res: unknown;
    try {
      res = await client.messages.create({
        model,
        max_tokens: MAX_TOKENS,
        system: SEGMENT_SYSTEM,
        messages: [{ role: 'user', content: user }],
        output_config: { format: { type: 'json_schema', schema: SEGMENT_SCHEMA } },
      });
    } catch (err) {
      throw new SegmentationError(
        `LLM segmentation API call failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const text = extractText(res);
    if (text === null) throw new SegmentationError('LLM segmentation reply had no text block');
    let segments: string[];
    try {
      const parsed = JSON.parse(text) as { segments?: unknown };
      if (!Array.isArray(parsed.segments) || parsed.segments.some((s) => typeof s !== 'string')) {
        throw new Error('reply JSON missing string[] "segments"');
      }
      segments = (parsed.segments as string[]).map((s) => s.trim()).filter((s) => s.length > 0);
    } catch (err) {
      throw new SegmentationError(
        `LLM segmentation reply was not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (segments.length === 0) throw new SegmentationError('LLM segmentation returned zero segments');
    if (isExactPartition(scriptText, segments)) return segments;
    lastProblem = `${tokens(scriptText).length} words in, ${tokens(segments.join(' ')).length} words out`;
    opts.warn?.(`[segment-llm] attempt ${attempt + 1}: reply was not an exact partition (${lastProblem}) — retrying`);
  }
  throw new SegmentationError(`LLM segmentation failed partition validation twice (${lastProblem})`);
}
