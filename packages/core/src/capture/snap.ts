// Capture one URL through the full settle pipeline, outside any run.
//
// The public entry point for `jux snap` and for anything else that needs a
// single deterministic capture. It exists so captureStory and the settle
// pipeline can stay unexported (see index.ts): callers get the result of the
// load-bearing ordering without being able to reorder it.

import type { BrowserContext, Page } from 'playwright';
import type { CaptureEnv, Snapshot, StoryParams, Viewport } from '../types.js';
import { createUrlPlatform } from '../platforms/urls.js';
import { captureStory } from './capture.js';
import { captureEnv } from './env.js';
import { deterministicLaunchOptions } from './launch.js';

export interface SnapOptions {
  url: string;
  viewport?: Viewport;
  params?: StoryParams;
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
 * Capture several URLs with one browser, one context and one page, in order.
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
  // playwright is an optional peer of core; load it here so importing core
  // does not require it.
  const { chromium } = await import('playwright');
  const browser = await chromium.launch(deterministicLaunchOptions());
  try {
    const context = await browser.newContext({
      viewport,
      deviceScaleFactor: 1,
      serviceWorkers: 'block',
    });
    const page = await context.newPage();
    let status: number | null = null;
    page.on('response', (r) => {
      if (r.request().isNavigationRequest() && r.frame() === page.mainFrame()) {
        status = r.status();
      }
    });
    const pages: SnapPageResult[] = [];
    for (const [k, url] of opts.urls.entries()) {
      status = null;
      const id = `snap-${k}`;
      const platform = createUrlPlatform([
        { id, url, ...(opts.params ? { params: opts.params } : {}) },
      ]);
      try {
        const [story] = await platform.enumerate({ projectRoot: process.cwd() });
        const snapshot = await captureStory(
          page,
          story,
          { platform, baseUrl: url },
          viewport,
        );
        if (!snapshot) throw new Error('page declared skip');
        pages.push({ url, snapshot, status });
      } catch (err) {
        pages.push({
          url,
          status,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      await resetBetweenPages(context, page, url);
    }
    return { env: captureEnv(browser), pages };
  } finally {
    await browser.close().catch(() => {});
  }
}

/**
 * A navigation keeps everything origin-scoped: cookies, localStorage,
 * IndexedDB, Cache Storage and service workers. One context is shared by every
 * page (a context per page would cost the launch savings back), so the
 * previous page's origin is wiped through CDP instead; otherwise a page's
 * pixels could depend on which page was captured before it. Service workers
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
  const cdp = await context.newCDPSession(page).catch(() => null);
  if (!cdp) return;
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
  for (const origin of origins) {
    await cdp
      .send('Storage.clearDataForOrigin', { origin, storageTypes: 'all' })
      .catch(() => {});
  }
  await cdp.detach().catch(() => {});
}

export async function snapPage(opts: SnapOptions): Promise<SnapResult> {
  const { env, pages } = await snapPages({
    urls: [opts.url],
    ...(opts.viewport ? { viewport: opts.viewport } : {}),
    ...(opts.params ? { params: opts.params } : {}),
  });
  const [r] = pages;
  if (!r.snapshot) throw new Error(r.error ?? 'jux: could not capture');
  return { snapshot: r.snapshot, env, status: r.status };
}
