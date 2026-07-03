/**
 * cost-summary.ts — unit-aware ledger aggregation (T-46).
 *
 * The cost ledger mixes currency units: higgsfield/mock rows are priced in
 * 'credits', fal rows in 'usd' (per the CostLedgerEntry.provider/unit contract
 * landed with T-34). Credits and dollars must NEVER be summed into one number.
 * This groups a ledger by unit (and by account) so both the `cli cost` command
 * and the T-38 `/cost-summary` endpoint can report each currency separately.
 */

import type { CostLedgerEntry } from './types.js';

export type CostUnit = 'credits' | 'usd';

export interface AccountUnitSubtotal {
  accountName: string | null;
  unit: CostUnit;
  total: number;
  entryCount: number;
}

export interface LedgerSummary {
  /** Total per currency unit. Legacy rows without a `unit` count as credits. */
  totals: Partial<Record<CostUnit, number>>;
  /** One subtotal per (account, unit) pair. */
  byAccount: AccountUnitSubtotal[];
}

/** The amount a ledger row contributes: actual charge if known, else preflight estimate. */
export function ledgerAmount(entry: CostLedgerEntry): number {
  return entry.chargedCredits ?? entry.preflightCredits ?? 0;
}

/** The currency unit for a ledger row (legacy rows without one are credits). */
export function ledgerUnit(entry: CostLedgerEntry): CostUnit {
  return entry.unit ?? 'credits';
}

/**
 * Group ledger entries by currency unit and account. Credits and usd are kept
 * strictly separate. Mirrors the T-38 cost-summary endpoint.
 */
export function summarizeLedger(entries: CostLedgerEntry[]): LedgerSummary {
  const totals = new Map<CostUnit, number>();
  const byAccount = new Map<string, AccountUnitSubtotal>();
  for (const e of entries) {
    const amount = ledgerAmount(e);
    const unit = ledgerUnit(e);
    totals.set(unit, (totals.get(unit) ?? 0) + amount);
    const key = `${e.accountName ?? '(none)'}::${unit}`;
    const bucket =
      byAccount.get(key) ?? { accountName: e.accountName ?? null, unit, total: 0, entryCount: 0 };
    bucket.total += amount;
    bucket.entryCount += 1;
    byAccount.set(key, bucket);
  }
  return {
    totals: Object.fromEntries(totals) as Partial<Record<CostUnit, number>>,
    byAccount: [...byAccount.values()],
  };
}

/** Human-readable amount for a unit: credits -> "12.50 cr", usd -> "$12.50". */
export function formatCostAmount(unit: CostUnit, amount: number): string {
  return unit === 'usd' ? `$${amount.toFixed(2)}` : `${amount.toFixed(2)} cr`;
}
