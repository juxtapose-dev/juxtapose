// Capture one URL through the full settle pipeline, outside any run.
//
// The public entry point for `jux snap` and for anything else that needs a
// single deterministic capture. It exists so captureStory and the settle
// pipeline can stay unexported (see index.ts): callers get the result of the
// load-bearing ordering without being able to reorder it.

import type { Browser, BrowserContext } from '../browser/browser.js';
import type { Page } from '../browser/page.js';
import type { CaptureEnv, Snapshot, StoryParams, Viewport } from '../types.js';
import { createUrlPlatform } from '../platforms/urls.js';
import { captureStory } from './capture.js';
import { captureEnv } from './env.js';
import {
  budgetedCapture,
  closeBounded,
  DEFAULT_STORY_TIMEOUT_MS,
  StoryTimeoutError,
} from './pool.js';
import { PageCrashedError, TimeoutError } from '../browser/page.js';
import { SendTimeoutError, TargetClosedError } from '../browser/cdp.js';
import type { SettleLayer } from './settle-options.js';

export interface SnapOptions {
  url: string;
  viewport?: Viewport;
  params?: StoryParams;
  /** Acquired by the caller (acquireBrowser); not closed here. */
  browser: Browser;
}

export interface SnapResult {
  snapshot: Snapshot;
  env: CaptureEnv;
  /** HTTP status of the main document, null for non-HTTP URLs. */
  status: number | null;
}

export interface SnapPagesOptions {
  urls: string[];
  viewport?: Viewport;
  params?: StoryParams;
  /** The project config's settle options, below `params`. */
  projectSettle?: SettleLayer;
  /** Per-URL budget, ms; the config's `storyTimeout`. See DEFAULT_STORY_TIMEOUT_MS. */
  storyTimeoutMs?: number;
  /** A new renderer per URL after the first; default true. See CaptureDeps. */
  freshRenderer?: boolean;
  renderer?: StoryParams['renderer'];
  /** Acquired by the caller (acquireBrowser); not closed here. */
  browser: Browser;
}

export interface SnapPageResult {
  url: string;
  /** Absent when this page failed; `error` says why. */
  snapshot?: Snapshot;
  status: number | null;
  error?: string;
}

const DEFAULT_SNAP_VIEWPORT: Viewport = { width: 1280, height: 800 };

/**
 * Capture several URLs with one context and one page, in order.
 * A page that fails records its error and the rest still capture: the agent
 * asked for all of them and wants to know which ones it got.
 *
 * One page, navigated, is the cold path captureStory already takes: a
 * navigation discards injected styles and captureStory re-applies them.
 * Origin state is cleared between pages by resetBetweenPages.
 */
export async function snapPages(
  opts: SnapPagesOptions,
): Promise<{ env: CaptureEnv; pages: SnapPageResult[] }> {
  const viewport = opts.viewport ?? DEFAULT_SNAP_VIEWPORT;
  let context = await opts.browser.newContext({ viewport, blockServiceWorkers: true });
  const budgetMs = opts.storyTimeoutMs ?? DEFAULT_STORY_TIMEOUT_MS;
  let page = await context.newPage().catch(async (err: unknown) => {
    await context.close().catch(() => {});
    throw err;
  });
  try {
    let status: number | null = null;
    let off = page.onMainResponse((s) => (status = s));
    const pages: SnapPageResult[] = [];
    // Set when a replacement page could not be opened (the browser is gone):
    // the remaining URLs fail with it, and the captured results are kept.
    let lost: string | null = null;
    for (const [k, url] of opts.urls.entries()) {
      if (lost !== null) {
        pages.push({ url, status: null, error: lost });
        continue;
      }
      status = null;
      const id = `snap-${k}`;
      const platform = createUrlPlatform([
        { id, url, ...(opts.params ? { params: opts.params } : {}) },
      ]);
      try {
        // A url platform enumerates exactly the one entry it was given.
        const [story] = await platform.enumerate({ projectRoot: process.cwd() });
        const live = page;
        const snapshot = await budgetedCapture(id, budgetMs, (hooks) =>
          captureStory(
            live,
            story!,
            {
              platform,
              baseUrl: url,
              ...hooks,
              renderer: opts.renderer,
              ...(opts.freshRenderer !== undefined
                ? { freshRenderer: opts.freshRenderer }
                : {}),
              ...(opts.projectSettle
                ? { settleLayers: { project: opts.projectSettle } }
                : {}),
            },
            viewport,
          ),
        );
        if (!snapshot) throw new Error('page declared skip');
        pages.push({ url, snapshot, status });
      } catch (err) {
        pages.push({
          url,
          status,
          error: err instanceof Error ? err.message : String(err),
        });
        // A wedged or crashed page stays wedged: left alone it fails every
        // later URL at its full cap (3 URLs, 90 s, all failed: #163). A busy
        // main thread usually surfaces as the 30 s navigation or call cap,
        // below the story budget, so those count too. Only then is the shared
        // page replaced; the normal path keeps reusing it.
        if (
          opts.browser.isConnected() &&
          (err instanceof StoryTimeoutError ||
            err instanceof TimeoutError ||
            err instanceof SendTimeoutError ||
            err instanceof PageCrashedError ||
            err instanceof TargetClosedError)
        ) {
          off();
          await closeBounded(context);
          try {
            context = await opts.browser.newContext({
              viewport,
              blockServiceWorkers: true,
            });
            page = await context.newPage();
            off = page.onMainResponse((s) => (status = s));
          } catch (e) {
            lost = `jux: could not open a fresh page after the previous one hung: ${
              e instanceof Error ? e.message : String(e)
            }`;
          }
          continue; // the new context starts clean: nothing to reset
        }
      }
      await resetBetweenPages(context, page, url);
    }
    off();
    return { env: captureEnv(opts.browser), pages };
  } finally {
    await closeBounded(context);
  }
}

/**
 * A navigation keeps everything origin-scoped: cookies, localStorage,
 * IndexedDB, Cache Storage and service workers. One context is shared by every
 * page (a context per page would cost the launch savings back), so the
 * previous page's origin is wiped through the page's own CDP session
 * (Storage.clearDataForOrigin, as before) instead; otherwise a page's pixels
 * could depend on which page was captured before it. Service workers
 * are blocked at context creation, since clearing cannot stop one that has
 * already intercepted the next navigation.
 *
 * The origin comes from the requested URL, not only the page: after a failed
 * load the page is an error page with an opaque origin. The page's final URL
 * is cleared too, for redirects. Covers IndexedDB, Cache Storage, service
 * workers and local storage. Best effort: nothing here
 * may fail a capture that already succeeded.
 */
async function resetBetweenPages(
  context: BrowserContext,
  page: Page,
  requestedUrl: string,
): Promise<void> {
  await context.clearCookies().catch(() => {});
  // A redirect lands on another origin (a login host, a canonical port) that
  // holds state of its own.
  const origins = new Set<string>();
  for (const u of [requestedUrl, page.url()]) {
    try {
      const o = new URL(u);
      if (o.protocol === 'http:' || o.protocol === 'https:') origins.add(o.origin);
    } catch {
      // about:blank, chrome-error:// — no origin to clear.
    }
  }
  for (const origin of origins) await page.clearOrigin(origin).catch(() => {});
}

export async function snapPage(opts: SnapOptions): Promise<SnapResult> {
  const { env, pages } = await snapPages({
    urls: [opts.url],
    browser: opts.browser,
    ...(opts.viewport ? { viewport: opts.viewport } : {}),
    ...(opts.params ? { params: opts.params } : {}),
  });
  // snapPages pushes one result per url, success or failure.
  const r = pages[0]!;
  if (!r.snapshot) throw new Error(r.error ?? 'jux: could not capture');
  return { snapshot: r.snapshot, env, status: r.status };
}
