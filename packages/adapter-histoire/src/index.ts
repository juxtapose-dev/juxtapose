// Histoire platform adapter.
//
// Written third, against the interface Storybook shaped and Ladle confirmed.
// Like Ladle it needed no changes to `Platform` — but it is the first platform
// whose native unit is not a story, which is where the interesting work is.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Page } from 'playwright';
import { navigateToStory } from '@juxtapose/core';
import type {
  Platform,
  EnumerateTarget,
  SettleContext,
  StoryManifest,
  StoryParams,
} from '@juxtapose/core';

/**
 * One entry in histoire.json.
 *
 * Declared locally rather than imported from `histoire`: the schema below is
 * what `histoire build` actually emits (verified against 1.0.0-beta.1), and
 * the package does not export a type for its own build artifact.
 */
interface HistoireStory {
  id: string;
  title: string;
  docsOnly?: boolean;
  variants?: HistoireVariant[];
  /** Project-relative, forward slashes. Histoire's equivalent of importPath. */
  relativePath?: string;
  /** Ancestor titles, e.g. ['Forms', 'Button']. `title` is the last entry. */
  treePath?: string[];
  /** True for stories synthesised from markdown rather than a source file. */
  virtual?: boolean;
  meta?: Record<string, unknown>;
}

interface HistoireVariant {
  id: string;
  title: string;
  meta?: Record<string, unknown>;
}

interface HistoireIndex {
  stories: HistoireStory[];
}

/**
 * The sandbox's render-ready message.
 *
 * Histoire's host app renders each variant in an `__sandbox.html` iframe and
 * the sandbox posts this to `window.parent` once the variant has mounted.
 * We load the sandbox directly rather than through the host, which works
 * because `window.parent === window` for a top-level page — the sandbox posts
 * the message to itself and a listener on `window` still sees it. Verified
 * against a real build, not inferred.
 */
const SANDBOX_READY = '__histoire:sandbox-ready';

/** Flag the init script sets once SANDBOX_READY has been seen. */
const READY_FLAG = '__juxtaposeHistoireReady';

/**
 * Where a story or variant declares juxtapose config.
 *
 * Histoire serialises `<Story :meta>` and `<Variant :meta>` into
 * histoire.json verbatim, so per-story config is readable without a browser —
 * no `readLiveParams` needed, unlike Storybook. Namespaced because Histoire
 * writes its own keys into `meta` too.
 */
const META_NAMESPACE = 'juxtapose';

export class HistoirePlatform implements Platform {
  readonly name = 'histoire';

  async detect(target: EnumerateTarget): Promise<boolean> {
    return (await loadIndex(target)) !== null;
  }

  async enumerate(target: EnumerateTarget): Promise<StoryManifest[]> {
    const index = await loadIndex(target);
    if (!index) {
      throw new Error(
        `[histoire] no histoire.json at ${target.origin ?? target.buildDir}. ` +
          `Run \`histoire build\`, or point --origin at a running dev server.`,
      );
    }

    const manifests: StoryManifest[] = [];

    for (const story of index.stories) {
      // Markdown-only entries render docs, not components. Storybook's adapter
      // drops `type === 'docs'` for the same reason.
      if (story.docsOnly) continue;

      for (const variant of story.variants ?? []) {
        this.storyFileIds.set(variant.id, story.id);
        manifests.push({
          // A Histoire "story" is a file holding many variants, and only a
          // variant is a single render. The variant id is what the sandbox
          // addresses, so it is the unit juxtapose captures — one story file
          // with six variants is six baselines, not one.
          storyId: variant.id,
          title: (story.treePath ?? [story.title]).join('/'),
          name: variant.title,
          // Empty when absent rather than fabricated — affected-story analysis
          // treats a blank path as "can't prove unaffected" and captures it.
          // Virtual (markdown-derived) stories have no source file to resolve.
          componentPath:
            story.relativePath && !story.virtual
              ? path.resolve(target.projectRoot, story.relativePath)
              : '',
          // Variant config wins over story config, so a single variant can
          // opt out or retune without affecting its siblings.
          params: { ...readParams(story.meta), ...readParams(variant.meta) },
        });
      }
    }

    return manifests.sort((a, b) => a.storyId.localeCompare(b.storyId));
  }

  /**
   * Maps a juxtapose storyId (a Histoire *variant* id) to its owning story
   * file id, populated by `enumerate`.
   *
   * The sandbox needs both ids and only the index knows the pairing: variant
   * ids are `<storyId>-<index>` by default, but `<Variant id="...">` sets an
   * arbitrary one and a variant-less `<Story>` yields `_default`. Deriving the
   * story id by stripping a numeric suffix works for the default case and
   * silently produces an unrenderable URL for the other two.
   */
  private readonly storyFileIds = new Map<string, string>();

  /**
   * Address one variant in the chrome-free sandbox.
   *
   * `__sandbox.html` is the route Histoire's own host app embeds — it renders
   * the variant and nothing else, so it is the equivalent of Storybook's
   * `iframe.html`. Both ids are required: the sandbox looks up the story file
   * first, then the variant within it.
   */
  storyUrl(baseUrl: string, storyId: string): string {
    const storyFileId = this.storyFileIds.get(storyId) ?? storyId;
    return (
      `${stripSlash(baseUrl)}/__sandbox.html` +
      `?storyId=${encodeURIComponent(storyFileId)}` +
      `&variantId=${encodeURIComponent(storyId)}`
    );
  }

  /**
   * Arm the ready listener, then navigate.
   *
   * SANDBOX_READY is a fired event, not a latched state: a variant that mounts
   * before a listener attaches would leave `settle` waiting for a message that
   * already went out. An init script runs before any page script on every
   * navigation, which closes that race — hence overriding `showStory` rather
   * than using `navigateToStory` alone.
   */
  async showStory(page: Page, storyId: string, baseUrl: string): Promise<void> {
    await armReadyFlag(page);
    await navigateToStory((b, s) => this.storyUrl(b, s))(page, storyId, baseUrl);
  }

  /** Blank sandbox, for warming a page before any variant is selected. */
  previewUrl(baseUrl: string): string {
    return `${stripSlash(baseUrl)}/__sandbox.html`;
  }

  async settle(page: Page, ctx: SettleContext): Promise<void> {
    await page
      .waitForFunction(
        (flag) => (window as unknown as Record<string, boolean>)[flag] === true,
        READY_FLAG,
        { timeout: ctx.timeoutMs },
      )
      // Timing out is not fatal: capture what rendered. A slow variant should
      // surface as a reviewable diff, not abort the run.
      .catch(() => {});
  }

  // No switchStory: the sandbox reads its ids from `location.search` at module
  // scope and exposes no client-side variant-switch channel, so there is
  // nothing to drive without a reload. The pool falls back to navigation,
  // which is the correct behaviour rather than a missing optimisation.

  // Histoire's config is a root-level file, not a directory like `.storybook`
  // or `.ladle`. Affected-analysis matches entries by exact path as well as by
  // prefix, so the config files are listed alongside the setup directory —
  // otherwise a change to `histoire.config.ts` would not force a full run.
  readonly configDirs = [
    '.histoire',
    'histoire',
    'histoire.config.ts',
    'histoire.config.js',
    'histoire.config.mjs',
    'histoire.config.cjs',
  ];
  readonly storyFileGlobs = ['**/*.story.@(vue|svelte|ts|tsx|js|jsx)'];
}

function readParams(meta: Record<string, unknown> | undefined): StoryParams {
  const ns = meta?.[META_NAMESPACE];
  return ns && typeof ns === 'object' ? (ns as StoryParams) : {};
}

/** Latch SANDBOX_READY into a flag `settle` can poll, before any page script runs. */
async function armReadyFlag(page: Page): Promise<void> {
  const anyPage = page as Page & { __juxtaposeHistoireArmed?: boolean };
  if (anyPage.__juxtaposeHistoireArmed) return;

  await page.addInitScript(
    ([flag, readyType]) => {
      (window as unknown as Record<string, boolean>)[flag] = false;
      window.addEventListener('message', (event: MessageEvent) => {
        if ((event.data as { type?: string } | null)?.type === readyType) {
          (window as unknown as Record<string, boolean>)[flag] = true;
        }
      });
    },
    [READY_FLAG, SANDBOX_READY] as const,
  );

  // addInitScript stacks: registering it per capture would install a listener
  // per story on a warm page.
  anyPage.__juxtaposeHistoireArmed = true;
}

async function loadIndex(target: EnumerateTarget): Promise<HistoireIndex | null> {
  if (target.origin) {
    try {
      const res = await fetch(new URL('histoire.json', withSlash(target.origin)));
      if (!res.ok) return null;
      const parsed = (await res.json()) as HistoireIndex;
      return Array.isArray(parsed?.stories) ? parsed : null;
    } catch {
      return null;
    }
  }

  if (!target.buildDir) return null;
  try {
    const raw = await readFile(path.join(target.buildDir, 'histoire.json'), 'utf8');
    const parsed = JSON.parse(raw) as HistoireIndex;
    return Array.isArray(parsed?.stories) ? parsed : null;
  } catch {
    return null;
  }
}

const withSlash = (u: string) => (u.endsWith('/') ? u : u + '/');
const stripSlash = (u: string) => u.replace(/\/+$/, '');
