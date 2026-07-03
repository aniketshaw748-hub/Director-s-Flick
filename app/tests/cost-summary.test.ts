/**
 * cost-summary.test.ts — unit-aware ledger aggregation (T-46).
 *
 * Verifies credits and usd are grouped separately (never summed), the
 * charged-else-preflight amount rule, legacy rows counting as credits, and the
 * per-account/per-unit subtotals + formatting.
 */

import { describe, test, expect } from 'vitest';
import {
  summarizeLedger,
  ledgerAmount,
  ledgerUnit,
  formatCostAmount,
} from '../src/cost-summary.js';
import type { CostLedgerEntry } from '../src/types.js';

function entry(over: Partial<CostLedgerEntry>): CostLedgerEntry {
  return {
    projectId: 'p',
    jobId: `job-${Math.round(over.preflightCredits ?? 0)}-${over.unit ?? 'c'}-${over.accountName ?? 'x'}`,
    kind: 'video',
    model: 'kling3_0',
    preflightCredits: 0,
    chargedCredits: null,
    createdAt: '2026-07-03T00:00:00Z',
    ...over,
  };
}

describe('ledgerAmount / ledgerUnit', () => {
  test('amount = charged ?? preflight ?? 0', () => {
    expect(ledgerAmount(entry({ preflightCredits: 1.5, chargedCredits: null }))).toBe(1.5);
    expect(ledgerAmount(entry({ preflightCredits: 6.25, chargedCredits: 6.0 }))).toBe(6.0); // charged wins
    expect(ledgerAmount(entry({ preflightCredits: null, chargedCredits: null }))).toBe(0);
  });

  test('unit defaults to credits for legacy rows', () => {
    expect(ledgerUnit(entry({ unit: 'usd' }))).toBe('usd');
    expect(ledgerUnit(entry({ unit: undefined }))).toBe('credits');
  });
});

describe('formatCostAmount', () => {
  test('credits -> "X.XX cr", usd -> "$X.XX"', () => {
    expect(formatCostAmount('credits', 9.5)).toBe('9.50 cr');
    expect(formatCostAmount('usd', 1.05)).toBe('$1.05');
  });
});

describe('summarizeLedger', () => {
  test('groups credits and usd separately and never sums across units', () => {
    const entries: CostLedgerEntry[] = [
      entry({ unit: 'credits', accountName: 'A', preflightCredits: 1.5 }), // 1.5
      entry({ unit: 'credits', accountName: 'A', preflightCredits: 6.25, chargedCredits: 6.0 }), // 6.0
      entry({ unit: 'usd', accountName: 'B', preflightCredits: 0.35 }), // 0.35
      entry({ unit: 'usd', accountName: 'B', preflightCredits: 0.7, chargedCredits: 0.7 }), // 0.70
      entry({ unit: undefined, accountName: 'A', preflightCredits: 2 }), // legacy -> credits, 2
      entry({ unit: 'credits', accountName: undefined, preflightCredits: null }), // (none), 0
    ];

    const { totals, byAccount } = summarizeLedger(entries);

    expect(totals.credits).toBeCloseTo(9.5, 5); // 1.5 + 6.0 + 2 + 0
    expect(totals.usd).toBeCloseTo(1.05, 5); // 0.35 + 0.70
    // the two units are NOT summed into one number
    expect(Object.keys(totals).sort()).toEqual(['credits', 'usd']);

    const find = (acct: string | null, unit: string) =>
      byAccount.find((b) => b.accountName === acct && b.unit === unit);
    expect(find('A', 'credits')).toMatchObject({ total: expect.closeTo(9.5, 5), entryCount: 3 });
    expect(find('B', 'usd')).toMatchObject({ total: expect.closeTo(1.05, 5), entryCount: 2 });
    expect(find(null, 'credits')).toMatchObject({ total: 0, entryCount: 1 });
  });

  test('empty ledger -> empty totals and byAccount', () => {
    const { totals, byAccount } = summarizeLedger([]);
    expect(totals).toEqual({});
    expect(byAccount).toEqual([]);
  });

  test('single-unit single-account ledger', () => {
    const { totals, byAccount } = summarizeLedger([
      entry({ unit: 'credits', accountName: 'Solo', preflightCredits: 1.5 }),
      entry({ unit: 'credits', accountName: 'Solo', preflightCredits: 6.25 }),
    ]);
    expect(totals).toEqual({ credits: 7.75 });
    expect(byAccount).toHaveLength(1);
    expect(byAccount[0]).toMatchObject({ accountName: 'Solo', unit: 'credits', entryCount: 2 });
  });
});
