// Enumeration-time parameter discovery, then variant expansion: the step
// between "what stories exist" and "what captures to take".
//
// Lives in core so every caller that captures (jux run, jux init, the review
// server) builds the same capture set from the same inputs.

import type { Browser } from '../browser/browser.js';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { EnumerateTarget, Platform } from '../platform.js';
import type {
  StoryManifest,
  StoryOverride,
  StoryParams,
  VariantSpec,
  Viewport,
} from '../types.js';
import { expandVariants } from './variants.js';
import type { ProvenanceLog } from './provenance.js';

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
  /** `ProjectConfig.stories`. */
  projectStories?: Record<string, StoryOverride>;
  /** Receives where each capture's settings came from (`jux config --explain`). */
  trace?: ProvenanceLog;
  onWarning?: (message: string) => void;
  timeoutMs?: number;
  /** Keep discovered params on disk, keyed by the platform's
   *  `discoveryKey`, so an unchanged build skips the preview load. */
  cache?: { dir: string; target: EnumerateTarget };
}

/** Bumped when the cached shape or what discovery reads changes. */
const CACHE_SCHEMA = 1;
const CACHE_FILE = 'discovered-params.json';
/** Makes each write's temp file its own, for discoveries running at once in one process. */
let tmpCounter = 0;

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
  opts: Omit<PrepareOptions, 'projectVariants' | 'projectStories' | 'trace'>,
): Promise<StoryManifest[]> {
  const discover = opts.platform.discoverParams?.bind(opts.platform);
  if (!discover || stories.length === 0) return [...stories];

  const key = await cacheKey(opts);
  const cached = key ? await readCache(opts.cache!.dir, key) : undefined;
  const found = cached ?? (await discoverLive(discover, opts));
  if (!found) return [...stories];
  if (key && !cached) await writeCache(opts.cache!.dir, key, found);

  return stories.map((s) => {
    const params = found.get(s.storyId);
    return isRecord(params) ? { ...s, params: { ...s.params, ...params } } : s;
  });
}

/** One preview load; undefined (after a warning) when it can't be read. */
async function discoverLive(
  discover: NonNullable<Platform['discoverParams']>,
  opts: Omit<PrepareOptions, 'projectVariants' | 'projectStories' | 'trace'>,
): Promise<Map<string, StoryParams> | undefined> {
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
    return undefined;
  } finally {
    clearTimeout(timer);
    await context.close().catch(() => {});
  }
  return found;
}

/** The platform's fingerprint of what it would discover from, salted with
 *  the platform and cache schema; undefined disables the cache. */
async function cacheKey(
  opts: Omit<PrepareOptions, 'projectVariants' | 'projectStories' | 'trace'>,
): Promise<string | undefined> {
  if (!opts.cache || !opts.platform.discoveryKey) return undefined;
  try {
    const key = await opts.platform.discoveryKey(opts.cache.target);
    if (key === undefined) return undefined;
    return createHash('sha256')
      .update(`${CACHE_SCHEMA}\0${opts.platform.name}\0${key}`)
      .digest('hex');
  } catch {
    return undefined;
  }
}

/** A missing, unreadable or mismatched cache is a miss, never an error. */
async function readCache(
  dir: string,
  key: string,
): Promise<Map<string, StoryParams> | undefined> {
  try {
    const parsed: unknown = JSON.parse(
      await readFile(path.join(dir, CACHE_FILE), 'utf8'),
    );
    if (!isRecord(parsed) || parsed['key'] !== key || !isRecord(parsed['params']))
      return undefined;
    return new Map(Object.entries(parsed['params'] as Record<string, StoryParams>));
  } catch {
    return undefined;
  }
}

/** Written atomically; a failed write costs the next run a discovery. */
async function writeCache(
  dir: string,
  key: string,
  found: Map<string, StoryParams>,
): Promise<void> {
  try {
    await mkdir(dir, { recursive: true });
    const tmp = path.join(dir, `${CACHE_FILE}.${process.pid}.${tmpCounter++}.tmp`);
    await writeFile(
      tmp,
      JSON.stringify({ key, params: Object.fromEntries(found) }) + '\n',
    );
    await rename(tmp, path.join(dir, CACHE_FILE));
  } catch {
    // best effort
  }
}

/** Discover, then expand: one StoryManifest per capture. */
export async function prepareCaptures(
  stories: readonly StoryManifest[],
  opts: PrepareOptions,
): Promise<StoryManifest[]> {
  return expandVariants(
    await discoverParams(stories, opts),
    opts.projectVariants,
    opts.projectStories,
    opts.trace,
  );
}
