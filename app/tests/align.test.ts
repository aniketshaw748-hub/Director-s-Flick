import { vi, describe, test, expect, beforeEach } from 'vitest';
import { computeTimeline, planShots, alignScript } from '../src/align.js';
import type { AlignedLine } from '../src/types.js';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';

const mockSpawnCalls: { command: string; args: string[] }[] = [];

vi.mock('node:child_process', () => {
  return {
    spawn: (command: string, args: string[], options: any) => {
      mockSpawnCalls.push({ command, args });
      const child: any = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stdout.setEncoding = () => {};
      child.stderr = new EventEmitter();
      child.stderr.setEncoding = () => {};
      process.nextTick(() => {
        child.emit('close', 0);
      });
      return child;
    }
  };
});

describe('align', () => {
  describe('alignScript', () => {
    beforeEach(() => {
      mockSpawnCalls.length = 0;
    });

    test('spawns Python aligner and parses written JSON output', async () => {
      const scriptPath = path.resolve('tests/fixtures/script.txt');
      const audioPath = 'dummy.wav';
      const outJsonPath = path.resolve('projects/test_align_out/alignment.json');

      // Create dummy file for parseAlignmentJson to read
      fs.mkdirSync(path.dirname(outJsonPath), { recursive: true });
      fs.writeFileSync(outJsonPath, JSON.stringify({
        lines: [
          {
            index: 0,
            text: 'Hello world.',
            start: 1.0,
            end: 3.5,
            words: [
              { word: 'Hello', start: 1.0, end: 2.0 },
              { word: 'world.', start: 2.5, end: 3.5 },
            ],
          }
        ]
      }));

      try {
        const result = await alignScript(scriptPath, audioPath, outJsonPath);
        expect(result).toHaveLength(1);
        expect(result[0]!.text).toBe('Hello world.');
        expect(mockSpawnCalls).toHaveLength(1);
        expect(mockSpawnCalls[0]!.command).toBe('python');
        expect(mockSpawnCalls[0]!.args).toContain(scriptPath);
      } finally {
        fs.rmSync(path.dirname(outJsonPath), { recursive: true, force: true });
      }
    });
  });
  describe('computeTimeline', () => {
    test('applies TIMELINE RULE correctly to multiple lines', () => {
      const mockAlignedLines: AlignedLine[] = [
        {
          index: 0,
          text: 'Hello world.',
          start: 1.0,
          end: 3.5,
          words: [
            { word: 'Hello', start: 1.0, end: 2.0 },
            { word: 'world.', start: 2.5, end: 3.5 },
          ],
        },
        {
          index: 1,
          text: 'This is a test script.',
          start: 5.0,
          end: 8.0,
          words: [
            { word: 'This', start: 5.0, end: 5.5 },
            { word: 'is', start: 5.6, end: 6.0 },
            { word: 'a', start: 6.1, end: 6.5 },
            { word: 'test', start: 6.6, end: 7.2 },
            { word: 'script.', start: 7.3, end: 8.0 },
          ],
        },
      ];

      const result = computeTimeline(mockAlignedLines);

      expect(result).toHaveLength(2);

      // First line
      expect(result[0]!.index).toBe(0);
      expect(result[0]!.text).toBe('Hello world.');
      expect(result[0]!.start).toBe(1.0);
      expect(result[0]!.end).toBe(3.5);
      expect(result[0]!.duration).toBe(2.5); // 3.5 - 1.0
      expect(result[0]!.pauseAfter).toBe(1.5); // 5.0 - 3.5
      expect(result[0]!.targetDuration).toBe(4.0); // 5.0 - 1.0

      // Last line
      expect(result[1]!.index).toBe(1);
      expect(result[1]!.text).toBe('This is a test script.');
      expect(result[1]!.start).toBe(5.0);
      expect(result[1]!.end).toBe(8.0);
      expect(result[1]!.duration).toBe(3.0); // 8.0 - 5.0
      expect(result[1]!.pauseAfter).toBe(0); // last line pauseAfter is always 0
      expect(result[1]!.targetDuration).toBe(3.5); // duration + 0.5s tail
    });
  });

  describe('planShots', () => {
    test('creates 1 shot for normal short lines', () => {
      const mockAligned: AlignedLine[] = [
        {
          index: 0,
          text: 'Short line.',
          start: 0.0,
          end: 2.0,
          words: [
            { word: 'Short', start: 0.0, end: 0.8 },
            { word: 'line.', start: 1.0, end: 2.0 },
          ],
        },
      ];
      const timeline = computeTimeline(mockAligned);
      const shots = planShots('proj-1', timeline, mockAligned);

      expect(shots).toHaveLength(1);
      expect(shots[0]!.projectId).toBe('proj-1');
      expect(shots[0]!.lineIndex).toBe(0);
      expect(shots[0]!.subIndex).toBe(0);
      expect(shots[0]!.state).toBe('PENDING');
      expect(shots[0]!.line.targetDuration).toBe(2.5); // 2.0 + 0.5 tail
    });

    test('splits long lines (>15s) at word boundaries', () => {
      // Create a line that takes 20 seconds.
      // We will place words such that it splits.
      // Ideal split is at 10s.
      // Words are at:
      // Word 1: 0-1
      // Word 2: 4-5
      // Word 3: 9-10  (word start 9.0)
      // Word 4: 11-12 (word start 11.0)
      // Word 5: 18-19
      const mockAligned: AlignedLine[] = [
        {
          index: 0,
          text: 'One Two Three Four Five',
          start: 0.0,
          end: 19.0,
          words: [
            { word: 'One', start: 0.0, end: 1.0 },
            { word: 'Two', start: 4.0, end: 5.0 },
            { word: 'Three', start: 9.0, end: 10.0 },
            { word: 'Four', start: 11.0, end: 12.0 },
            { word: 'Five', start: 18.0, end: 19.0 },
          ],
        },
      ];
      const timeline = computeTimeline(mockAligned); // targetDuration = 19.5s
      const shots = planShots('proj-1', timeline, mockAligned);

      expect(shots.length).toBeGreaterThan(1);
      // Verify that every shot's targetDuration is <= 15s
      for (const shot of shots) {
        expect(shot.line.targetDuration).toBeLessThanOrEqual(15.0);
        expect(shot.state).toBe('PENDING');
        expect(shot.lineIndex).toBe(0);
      }
      
      // Let's check subIndex ordering
      expect(shots[0]!.subIndex).toBe(0);
      expect(shots[1]!.subIndex).toBe(1);
    });

    test('falls back to equal raw splits if irreducible at word boundaries', () => {
      // Line with targetDuration = 20s, but no words in between to cut
      const mockAligned: AlignedLine[] = [
        {
          index: 0,
          text: 'Silent line',
          start: 0.0,
          end: 19.5,
          words: [], // no words
        },
      ];
      const timeline = computeTimeline(mockAligned);
      const shots = planShots('proj-1', timeline, mockAligned);

      expect(shots).toHaveLength(2);
      expect(shots[0]!.line.targetDuration).toBe(10.0);
      expect(shots[1]!.line.targetDuration).toBe(10.0);
    });
  });
});
