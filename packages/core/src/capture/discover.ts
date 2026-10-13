// Enumeration-time parameter discovery, then variant expansion: the step
// between "what stories exist" and "what captures to take".
//
// Lives in core so every caller that captures (jux run, jux init, the review
// server) builds the same capture set from the same inputs.

import type { Browser } from '../browser/browser.js';
import type { Platform } from '../platform.js';
import type { StoryManifest, StoryParams, VariantSpec, Viewport } from '../types.js';
import { expandVariants } from './variants.js';

/** A preview that hasn't produced its parameters in this long is broken, not
 *  slow: the example's 17 stories take ~60 ms. */
const DISCOVER_TIMEOUT_MS = 30_000;

export interface PrepareOptions {
  platform: Platform;
  browser: Browser;
  baseUrl: string;
  viewport: Viewport;
  /** `ProjectConfig.variants`. */
  projectVariants?: Record<string, VariantSpec | false>;
  onWarning?: (message: string) => void;
  timeoutMs?: number;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Merge the platform's discovered params over the enumerated ones. Never
 * throws for discovery itself: a preview that can't be read costs the
 * story-level settings the index lacks, which is today's behavior, and must
 * not cost the run. Throws VariantConfigError from expansion.
 */
export async function discoverParams(
  stories: readonly StoryManifest[],
  opts: Omit<PrepareOptions, 'projectVariants'>,
): Promise<StoryManifest[]> {
  const discover = opts.platform.discoverParams?.bind(opts.platform);
  if (!discover || stories.length === 0) return [...stories];

  let found: Map<string, StoryParams>;
  const context = await opts.browser.newContext({ viewport: opts.viewport });
  let timer: NodeJS.Timeout | undefined;
  try {
    const page = await context.newPage();
    const timeoutMs = opts.timeoutMs ?? DISCOVER_TIMEOUT_MS;
    found = await Promise.race([
      discover(page, opts.baseUrl),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`no answer within ${timeoutMs} ms`)),
          timeoutMs,
        );
      }),
    ]);
  } catch (err) {
    opts.onWarning?.(
      `jux: could not read story parameters from the ${opts.platform.name} preview (${
        err instanceof Error ? err.message : String(err)
      }); story-level settings and variants come from the index only`,
    );
    return [...stories];
  } finally {
    clearTimeout(timer);
    await context.close().catch(() => {});
  }

  return stories.map((s) => {
    const params = found.get(s.storyId);
    return isRecord(params) ? { ...s, params: { ...s.params, ...params } } : s;
  });
}

/** Discover, then expand: one StoryManifest per capture. */
export async function prepareCaptures(
  stories: readonly StoryManifest[],
  opts: PrepareOptions,
): Promise<StoryManifest[]> {
  return expandVariants(await discoverParams(stories, opts), opts.projectVariants);
}
