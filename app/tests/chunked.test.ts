/**
 * chunked.test.ts — chunked production (owner-directed, 2026-07-04):
 * SECTION-marker detection, chunkIndex propagation through timeline/planning,
 * and queue gating on config.activeChunk.
 */

import { describe, expect, test } from 'vitest';
import { computeTimeline, isChunkMarker, planShots } from '../src/align.js';
import type { AlignedLine, WordTiming } from '../src/types.js';

function words(text: string, start: number, end: number): WordTiming[] {
  const parts = text.split(/\s+/).filter(Boolean);
  const step = (end - start) / parts.length;
  return parts.map((word, i) => ({ word, start: start + i * step, end: start + (i + 1) * step }));
}

function line(index: number, text: string, start: number, end: number, chunkIndex?: number): AlignedLine {
  return { index, text, start, end, words: words(text, start, end), chunkIndex };
}

describe('isChunkMarker', () => {
  test('matches the owner script conventions', () => {
    expect(isChunkMarker('SECTION 4 - Mars wali sachhai')).toBe(true);
    expect(isChunkMarker('  section 1 - Jahaan se sab shuru hua')).toBe(true);
    expect(isChunkMarker('CHUNK 2')).toBe(true);
    expect(isChunkMarker('Part 3: the fall')).toBe(true);
  });
  test('does not match narration', () => {
    expect(isChunkMarker('2015 mein SUGAR ne ek category pakdi thi.')).toBe(false);
    expect(isChunkMarker('Ye section badal gaya tha.')).toBe(false); // "section" not at start with number
    expect(isChunkMarker('Aur waqt ke saath sab badla.')).toBe(false);
  });
});

describe('chunkIndex propagation', () => {
  test('computeTimeline carries chunkIndex (default 0)', () => {
    const timeline = computeTimeline([line(0, 'Pehli baat.', 0, 2, 1), line(1, 'Doosri baat.', 3, 5)]);
    expect(timeline[0]!.chunkIndex).toBe(1);
    expect(timeline[1]!.chunkIndex).toBe(0);
  });

  test('planShots sub-shots inherit the parent chunkIndex', () => {
    // 40s line -> multiple sub-shots via the 15s safety net; all must stay chunk 2.
    const long = line(0, Array.from({ length: 60 }, (_, i) => `w${i}`).join(' '), 0, 40, 2);
    const timeline = computeTimeline([long]);
    const shots = planShots('p1', timeline, [long], Number.POSITIVE_INFINITY);
    expect(shots.length).toBeGreaterThan(1);
    for (const s of shots) expect(s.line.chunkIndex).toBe(2);
  });
});
