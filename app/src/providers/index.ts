/**
 * providers/index.ts — provider factory + public surface of the providers module.
 *
 * `createProvider(config)` is the only construction path the rest of the app
 * uses: 'mock' (development/tests, zero credits), 'higgsfield-cli' (real,
 * spends credits, requires `higgsfield auth login`), or 'fal' (fal.ai fallback,
 * video-only, requires FAL_KEY).
 */

import type { GenProvider, PipelineConfig } from '../types.js';
import { MockProvider } from './mock.js';
import { HiggsfieldCliProvider } from './higgsfield-cli.js';
import { FalProvider } from './fal.js';

export { MockProvider, PHASE0_SAMPLE_DIR, measuredPreflightCredits } from './mock.js';
export type { MockProviderOptions } from './mock.js';
export { HiggsfieldCliProvider, AuthRequiredError, AuthError } from './higgsfield-cli.js';
export type { HiggsfieldCliOptions } from './higgsfield-cli.js';
export { FalProvider, FalError, FalAuthError } from './fal.js';
export type { FalProviderOptions } from './fal.js';

/** Optional per-account info (see accounts.ts) threaded into HiggsfieldCliProvider. */
export interface ProviderAccountOpts {
  credentialsPath?: string;
  accountName?: string;
}

/** Per-stage provider pair (image-stage vs video-stage) — see createStageProviders. */
export interface StageProviders {
  image: GenProvider;
  video: GenProvider;
}

/**
 * Build per-stage providers from `config.imageProvider` / `config.videoProvider`,
 * each falling back to `config.provider` (T-34). When both stages resolve to the
 * same provider name a single shared instance is returned for both, so the
 * pre-split single-provider behavior is preserved exactly. Enables e.g. images
 * on Higgsfield + video on the fal fallback (fal is video-only).
 */
export function createStageProviders(
  config: PipelineConfig,
  account?: ProviderAccountOpts,
): StageProviders {
  const imageName = config.imageProvider ?? config.provider;
  const videoName = config.videoProvider ?? config.provider;
  const image = createProvider({ ...config, provider: imageName }, account);
  const video =
    imageName === videoName ? image : createProvider({ ...config, provider: videoName }, account);
  return { image, video };
}

/** Instantiate the GenProvider selected by config.provider. */
export function createProvider(config: PipelineConfig, account?: ProviderAccountOpts): GenProvider {
  switch (config.provider) {
    case 'mock':
      return new MockProvider();
    case 'higgsfield-cli':
      return new HiggsfieldCliProvider(config, account);
    case 'fal':
      // fal.ai fallback (video-only; images stay on Higgsfield). FAL_KEY from env.
      return new FalProvider(config);
    default: {
      const unknown: never = config.provider;
      throw new Error(`Unknown provider: ${String(unknown)}`);
    }
  }
}
