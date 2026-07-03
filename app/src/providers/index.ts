/**
 * providers/index.ts — provider factory + public surface of the providers module.
 *
 * `createProvider(config)` is the only construction path the rest of the app
 * uses: 'mock' (development/tests, zero credits) or 'higgsfield-cli' (real,
 * spends credits, requires `higgsfield auth login`).
 */

import type { GenProvider, PipelineConfig } from '../types.js';
import { MockProvider } from './mock.js';
import { HiggsfieldCliProvider } from './higgsfield-cli.js';

export { MockProvider, PHASE0_SAMPLE_DIR, measuredPreflightCredits } from './mock.js';
export type { MockProviderOptions } from './mock.js';
export { HiggsfieldCliProvider, AuthRequiredError, AuthError } from './higgsfield-cli.js';
export type { HiggsfieldCliOptions } from './higgsfield-cli.js';

/** Optional per-account info (see accounts.ts) threaded into HiggsfieldCliProvider. */
export interface ProviderAccountOpts {
  credentialsPath?: string;
  accountName?: string;
}

/** Instantiate the GenProvider selected by config.provider. */
export function createProvider(config: PipelineConfig, account?: ProviderAccountOpts): GenProvider {
  switch (config.provider) {
    case 'mock':
      return new MockProvider();
    case 'higgsfield-cli':
      return new HiggsfieldCliProvider(config, account);
    // Temporary stub keeping HEAD's typecheck green between the ProviderName
    // contract change and T-30 landing — Opus replaces this within its lease.
    case 'fal':
      throw new Error("provider 'fal' lands with T-30 (FalProvider)");
    default: {
      const unknown: never = config.provider;
      throw new Error(`Unknown provider: ${String(unknown)}`);
    }
  }
}
