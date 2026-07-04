/**
 * segment-llm.test.ts — hermetic tests for LLM semantic segmentation
 * (owner-directed, 2026-07-04). Mock client only: no network, no API key.
 */

import { describe, expect, test } from 'vitest';
import { llmSegmentScript, SegmentationError, type SegmentLlmClient } from '../src/segment-llm.js';

const SCRIPT =
  '2024 mein ye company Rs500 crore revenue cross kar chuki thi... ' +
  'par 2025 aate-aate isi company ka revenue pehli baar neeche gir gaya.';

const GOOD_SEGMENTS = [
  '2024 mein ye company Rs500 crore revenue cross kar chuki thi...',
  'par 2025 aate-aate isi company ka revenue pehli baar neeche gir gaya.',
];

function mockClient(replies: unknown[]): SegmentLlmClient & { calls: Record<string, unknown>[] } {
  const calls: Record<string, unknown>[] = [];
  let i = 0;
  return {
    calls,
    messages: {
      async create(req: Record<string, unknown>) {
        calls.push(req);
        const reply = replies[Math.min(i, replies.length - 1)];
        i++;
        if (reply instanceof Error) throw reply;
        return { content: [{ type: 'text', text: JSON.stringify(reply) }] };
      },
    },
  };
}

describe('llmSegmentScript', () => {
  test('returns segments when the reply is an exact partition', async () => {
    const client = mockClient([{ segments: GOOD_SEGMENTS }]);
    const segments = await llmSegmentScript(SCRIPT, { client });
    expect(segments).toEqual(GOOD_SEGMENTS);
    expect(client.calls).toHaveLength(1);
    // Verbatim-partition constraint and the one-visual-idea criterion are in the system prompt.
    expect(String(client.calls[0].system)).toMatch(/ONE VISUAL IDEA/i);
    expect(String(client.calls[0].system)).toMatch(/word-for-word/i);
  });

  test('retries once with a corrective message when the partition is wrong, then succeeds', async () => {
    const bad = { segments: ['completely different text'] };
    const client = mockClient([bad, { segments: GOOD_SEGMENTS }]);
    const warns: string[] = [];
    const segments = await llmSegmentScript(SCRIPT, { client, warn: (m) => warns.push(m) });
    expect(segments).toEqual(GOOD_SEGMENTS);
    expect(client.calls).toHaveLength(2);
    const retryUser = String((client.calls[1].messages as { content: string }[])[0].content);
    expect(retryUser).toMatch(/NOT an exact word-for-word partition/);
    expect(warns.length).toBeGreaterThan(0);
  });

  test('throws SegmentationError after two non-partition replies', async () => {
    const bad = { segments: ['nope'] };
    const client = mockClient([bad, bad]);
    await expect(llmSegmentScript(SCRIPT, { client })).rejects.toBeInstanceOf(SegmentationError);
  });

  test('throws SegmentationError when no client and no API key', async () => {
    await expect(llmSegmentScript(SCRIPT, { client: null })).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });

  test('throws SegmentationError when the API call itself fails', async () => {
    const client = mockClient([new Error('boom')]);
    await expect(llmSegmentScript(SCRIPT, { client })).rejects.toThrow(/API call failed: boom/);
  });

  test('whitespace differences do not fail the partition check', async () => {
    const spaced = GOOD_SEGMENTS.map((s) => `  ${s.replace(/ /g, '  ')}  `);
    const client = mockClient([{ segments: spaced }]);
    const segments = await llmSegmentScript(SCRIPT, { client });
    expect(segments).toHaveLength(2);
  });

  test('empty segments array is rejected', async () => {
    const client = mockClient([{ segments: [] }]);
    await expect(llmSegmentScript(SCRIPT, { client })).rejects.toThrow(/zero segments|partition/);
  });
});
