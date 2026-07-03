import { vi, describe, test, expect, beforeEach } from 'vitest';
import { createPromptEngine, ClaudePromptEngine, TemplatePromptEngine } from '../src/prompts.js';
import type { ElementRef, LineTiming, Shot } from '../src/types.js';
import { query } from '@anthropic-ai/claude-agent-sdk';

// Mock the Claude Agent SDK
let mockQueryResult = '';
let mockQueryError = false;

vi.mock('@anthropic-ai/claude-agent-sdk', () => {
  return {
    query: vi.fn().mockImplementation(() => {
      if (mockQueryError) {
        throw new Error('Mock SDK Error');
      }
      return (async function* () {
        yield {
          type: 'result',
          subtype: 'success',
          result: mockQueryResult,
        };
      })();
    }),
  };
});

describe('prompts', () => {
  beforeEach(() => {
    mockQueryResult = '';
    mockQueryError = false;
  });

  describe('createPromptEngine', () => {
    test('returns TemplatePromptEngine when provider is mock', () => {
      const config = { provider: 'mock' } as any;
      const engine = createPromptEngine(config);
      expect(engine).toBeInstanceOf(TemplatePromptEngine);
    });

    test('returns ClaudePromptEngine when provider is higgsfield-cli', () => {
      const config = { provider: 'higgsfield-cli' } as any;
      const engine = createPromptEngine(config);
      expect(engine).toBeInstanceOf(ClaudePromptEngine);
    });
  });

  describe('TemplatePromptEngine (deterministic, offline)', () => {
    const engine = new TemplatePromptEngine();
    const elements: ElementRef[] = [
      { id: 'uuid-hapie', name: 'Hapie-character', category: 'character' },
      { id: 'uuid-lighthouse', name: 'Old lighthouse', category: 'location' },
    ];

    test('imagePromptBatch is deterministic and embeds elements placeholders', async () => {
      const lines: LineTiming[] = [
        {
          index: 0,
          text: 'Hapie-character stands near the Old lighthouse.',
          start: 0.0,
          end: 3.0,
          duration: 3.0,
          pauseAfter: 1.0,
          targetDuration: 4.0,
        },
      ];

      const res1 = await engine.imagePromptBatch(lines, elements, 'Style: neon lighting');
      const res2 = await engine.imagePromptBatch(lines, elements, 'Style: neon lighting');

      // Determinism check
      expect(res1).toEqual(res2);

      // Placeholder checks
      expect(res1).toHaveLength(1);
      expect(res1[0]!.lineIndex).toBe(0);
      expect(res1[0]!.imagePrompt).toContain('Style: neon lighting');
      expect(res1[0]!.imagePrompt).toContain('<<<uuid-hapie>>>');
      expect(res1[0]!.imagePrompt).toContain('<<<uuid-lighthouse>>>');
    });

    test('animationPrompt embeds elements placeholders', async () => {
      const shot: Shot = {
        id: 'shot-1',
        projectId: 'proj-1',
        lineIndex: 0,
        subIndex: 0,
        state: 'APPROVED',
        line: {
          index: 0,
          text: 'Hapie-character walks away.',
          start: 0,
          end: 2,
          duration: 2,
          pauseAfter: 0,
          targetDuration: 2,
        },
        elementIds: ['uuid-hapie'],
        attempts: 0,
        createdAt: '',
        updatedAt: '',
      };

      const prompt = await engine.animationPrompt(shot, elements);
      expect(prompt).toContain('<<<uuid-hapie>>>');
      expect(prompt).toContain('Slow cinematic push-in');
    });
  });

  describe('ClaudePromptEngine (SDK integration)', () => {
    const engine = new ClaudePromptEngine({ model: 'sonnet' });
    const elements: ElementRef[] = [
      { id: 'uuid-hapie', name: 'Hapie-character', category: 'character' },
    ];

    test('imagePromptBatch parses valid Claude JSON responses', async () => {
      mockQueryResult = JSON.stringify([
        {
          lineIndex: 0,
          imagePrompt: 'Vivid shot of Hapie-character',
        },
      ]);

      const lines: LineTiming[] = [
        {
          index: 0,
          text: 'Hapie-character looks up.',
          start: 0.0,
          end: 2.0,
          duration: 2.0,
          pauseAfter: 0.0,
          targetDuration: 2.0,
        },
      ];

      const res = await engine.imagePromptBatch(lines, elements, '');
      expect(res).toHaveLength(1);
      expect(res[0]!.lineIndex).toBe(0);
      expect(res[0]!.imagePrompt).toContain('<<<uuid-hapie>>>'); // Auto-injected by ensurePlaceholders
    });

    test('imagePromptBatch retries once on invalid JSON, then parses retry response', async () => {
      let callCount = 0;
      // Mock query mock to return invalid JSON on first call, valid on second
      vi.mocked(query).mockImplementation(() => {
        callCount++;
        const result = callCount === 1 
          ? 'Invalid non-json markdown here' 
          : JSON.stringify([{ lineIndex: 0, imagePrompt: 'Vivid retry shot of Hapie-character' }]);
        return (async function* () {
          yield { type: 'result', subtype: 'success', result };
        })();
      });

      const lines: LineTiming[] = [
        {
          index: 0,
          text: 'Hapie-character looks up.',
          start: 0.0,
          end: 2.0,
          duration: 2.0,
          pauseAfter: 0.0,
          targetDuration: 2.0,
        },
      ];

      const res = await engine.imagePromptBatch(lines, elements, '');
      expect(res).toHaveLength(1);
      expect(res[0]!.imagePrompt).toContain('Vivid retry');
      expect(res[0]!.imagePrompt).toContain('<<<uuid-hapie>>>');
    });

    test('animationPrompt parses clean single-line prompt', async () => {
      mockQueryResult = 'Slow cinematic pan around Hapie-character <<<uuid-hapie>>>';

      const shot: Shot = {
        id: 'shot-1',
        projectId: 'proj-1',
        lineIndex: 0,
        subIndex: 0,
        state: 'APPROVED',
        line: { index: 0, text: 'Hapie-character runs.', start: 0, end: 2, duration: 2, pauseAfter: 0, targetDuration: 2 },
        elementIds: ['uuid-hapie'],
        attempts: 0,
        createdAt: '',
        updatedAt: '',
      };

      // Reset mock implementation to default ask behavior
      vi.mocked(query).mockImplementation(() => {
        return (async function* () {
          yield { type: 'result', subtype: 'success', result: mockQueryResult };
        })();
      });

      const prompt = await engine.animationPrompt(shot, elements);
      expect(prompt).toBe('Slow cinematic pan around Hapie-character <<<uuid-hapie>>>');
    });

    // T-08 finding 3 (live run): the element tag was embedded but the engine's
    // own instructions never told it to avoid physically describing that
    // subject, so the LLM added its own appearance description that competed
    // with (and won over) the element's reference image - wrong character
    // generated. Can't assert LLM *compliance* in a hermetic unit test (no
    // real model call), only that the prohibition is actually present in what
    // gets sent - so capture the real prompt/systemPrompt text passed to
    // query() and assert on that, per Fable's guidance on this task.
    test('image batch instructions forbid physically describing element-tagged subjects', async () => {
      let capturedPrompt = '';
      let capturedSystemPrompt = '';
      vi.mocked(query).mockImplementation((args: any) => {
        capturedPrompt = args.prompt;
        capturedSystemPrompt = args.options.systemPrompt;
        return (async function* () {
          yield {
            type: 'result',
            subtype: 'success',
            result: JSON.stringify([{ lineIndex: 0, imagePrompt: 'Hapie-character looks up.' }]),
          };
        })();
      });

      const lines: LineTiming[] = [
        { index: 0, text: 'Hapie-character looks up.', start: 0, end: 2, duration: 2, pauseAfter: 0, targetDuration: 2 },
      ];
      await engine.imagePromptBatch(lines, elements, '');

      for (const text of [capturedSystemPrompt, capturedPrompt]) {
        expect(text.toLowerCase()).toMatch(/physical(ly)?[\s-]*(appearance|describ)/);
      }
    });

    test('animation prompt instructions forbid physically describing element-tagged subjects', async () => {
      let capturedPrompt = '';
      vi.mocked(query).mockImplementation((args: any) => {
        capturedPrompt = args.prompt;
        return (async function* () {
          yield { type: 'result', subtype: 'success', result: 'Slow cinematic pan <<<uuid-hapie>>>' };
        })();
      });

      const shot: Shot = {
        id: 'shot-1',
        projectId: 'proj-1',
        lineIndex: 0,
        subIndex: 0,
        state: 'APPROVED',
        line: { index: 0, text: 'Hapie-character runs.', start: 0, end: 2, duration: 2, pauseAfter: 0, targetDuration: 2 },
        elementIds: ['uuid-hapie'],
        attempts: 0,
        createdAt: '',
        updatedAt: '',
      };
      await engine.animationPrompt(shot, elements);
      expect(capturedPrompt.toLowerCase()).toMatch(/physical(ly)?[\s-]*(appearance|describ)/);
    });
  });
});
