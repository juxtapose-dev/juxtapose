// Ladle platform adapter.
//
// Written second, against the interface the Storybook adapter shaped. It needed
// no changes to `Platform` — which is the evidence the seam is real rather than
// a Storybook API wearing a trenchcoat.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { navigateToStory } from '@juxtapose/core';

import type {
  Page,
  Platform,
  EnumerateTarget,
  SettleContext,
  StoryManifest,
  StoryParams,
} from '@juxtapose/core';

// The `window as unknown as {…}` casts below sit inside page.evaluate
// callbacks: they run in the page, and the globals they read are Ladle
// internals with no published types. The cast is the claim; the code still
// checks each value before using it.

/**
 * One entry in Ladle's meta.json.
 *
 * Declared locally rather than imported from @ladle/react: the published
 * `MetaJsonStory` type omits `filePath` and `namedExport` even though
 * get-meta-json.js demonstrably emits both. The runtime data is authoritative.
 */

interface LadleStory {
  name: string;
  levels: string[];
  /** Project-relative, forward slashes. Ladle's equivalent of importPath. */
  filePath?: string;
  namedExport?: string;
  /** Line range of the export. Ladle gives us more than Storybook here. */
  locStart?: number;
  locEnd?: number;
  meta?: Record<string, unknown>;
}

interface LadleMeta {
  stories: Record<string, LadleStory>;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** An object with a `stories` object; stories are read field by field
 *  downstream. */
const isLadleMeta = (v: unknown): v is LadleMeta => isRecord(v) && isRecord(v['stories']);

/** Where a story declares juxtapose config. Ladle's `meta` is an open index
 *  signature, so a namespaced key passes through untouched. */
const META_NAMESPACE = 'juxtapose';

export class LadlePlatform implements Platform {
  readonly name = 'ladle';

  async detect(target: EnumerateTarget): Promise<boolean> {
    return (await loadMeta(target)) !== null;
  }

  async enumerate(target: EnumerateTarget): Promise<StoryManifest[]> {
    const meta = await loadMeta(target);
    if (!meta) {
      throw new Error(
        `[ladle] no meta.json at ${target.origin ?? target.buildDir}. ` +
          `Run \`ladle build\`, or point --origin at a running dev server.`,
      );
    }

    return Object.entries(meta.stories)
      .map<StoryManifest>(([id, story]) => ({
        storyId: id,
        title: story.levels.join('/'),
        name: story.name,
        // Empty when absent rather than fabricated — affected-story analysis
        // treats a blank path as "can't prove unaffected" and captures it.
        componentPath: story.filePath
          ? path.resolve(target.projectRoot, story.filePath)
          : '',
        params: readParams(story.meta),
      }))
      .sort((a, b) => a.storyId.localeCompare(b.storyId));
  }

  storyUrl(baseUrl: string, storyId: string): string {
    // No iframe route; `mode=preview` is what strips the sidebar and addon
    // chrome, leaving only the story.
    return `${stripSlash(baseUrl)}/?story=${encodeURIComponent(storyId)}&mode=preview`;
  }

  /** URL-addressable, so showing a story is just a navigation. */
  async showStory(page: Page, storyId: string, baseUrl: string): Promise<void> {
    await navigateToStory((b, s) => this.storyUrl(b, s))(page, storyId, baseUrl);
  }

  previewUrl(baseUrl: string): string {
    return `${stripSlash(baseUrl)}/?mode=preview`;
  }

  async settle(page: Page, ctx: SettleContext): Promise<void> {
    await waitForStoryLoaded(page, ctx.timeoutMs);
  }

  /**
   * Switch stories without a navigation via Ladle's exposed dispatch.
   *
   * `window.ladleDispatch` is set deliberately — Ladle's own public `linkTo()`
   * API is built on it — so this is a supported path, not a private poke.
   *
   * The subtlety: `data-storyloaded` is a plain attribute toggle, so a naive
   * wait after dispatching can match the *outgoing* story's attribute before
   * React tears it down. Clear it ourselves first, then wait for it to come
   * back, which makes the signal unambiguous.
   */
  async switchStory(page: Page, storyId: string, ctx: SettleContext): Promise<boolean> {
    const dispatched = await page
      .evaluate((id) => {
        const w = window as unknown as {
          ladleDispatch?: (action: { type: string; value: string }) => void;
        };
        if (typeof w.ladleDispatch !== 'function') return false;
        document.documentElement.removeAttribute('data-storyloaded');
        w.ladleDispatch({ type: 'update-story', value: id });
        return true;
      }, storyId)
      .catch(() => false);

    if (!dispatched) return false;

    await waitForStoryLoaded(page, ctx.timeoutMs);
    return true;
  }

  readonly configDirs = ['.ladle'];
  readonly storyFileGlobs = ['**/*.stories.@(ts|tsx|js|jsx|mdx)'];
}

/**
 * Ladle's authoritative render signal: `data-storyloaded` on <html>.
 *
 * Set by a component rendered inside Suspense after the story commits, and
 * removed by the loading spinner on mount — so its presence means the story
 * chunk loaded and React committed, not merely that the page fired `load`.
 * This is what Ladle's own screenshot suite waits on.
 */
async function waitForStoryLoaded(page: Page, timeoutMs: number): Promise<void> {
  await page
    .waitForSelector('[data-storyloaded]', { timeout: timeoutMs })
    // Timing out is not fatal: capture what rendered. A slow story should
    // surface as a reviewable diff, not abort the run.
    .catch(() => {});
}

function readParams(meta: Record<string, unknown> | undefined): StoryParams {
  const ns = meta?.[META_NAMESPACE];
  return ns && typeof ns === 'object' ? ns : {};
}

async function loadMeta(target: EnumerateTarget): Promise<LadleMeta | null> {
  if (target.origin) {
    try {
      const res = await fetch(new URL('meta.json', withSlash(target.origin)));
      if (!res.ok) return null;
      const parsed: unknown = await res.json();
      return isLadleMeta(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  if (!target.buildDir) return null;
  try {
    const raw = await readFile(path.join(target.buildDir, 'meta.json'), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    return isLadleMeta(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

const withSlash = (u: string) => (u.endsWith('/') ? u : u + '/');
const stripSlash = (u: string) => u.replace(/\/+$/, '');
