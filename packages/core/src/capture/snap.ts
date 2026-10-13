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
 * navigation discards injected styles and captureStory re-applies them. What
 * a navigation does not discard is origin storage and cookies, so those are
 * cleared between pages; otherwise a page's result would depend on which page
 * was captured before it.
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
    const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
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
        pages.push({ url, status, error: (err as Error).message });
      }
      await resetBetweenPages(context, page);
    }
    return { env: captureEnv(browser), pages };
  } finally {
    await browser.close().catch(() => {});
  }
}

/** Best effort: a page that blocks storage access (opaque origin, about:blank
 *  after a failed load) has nothing to leak, so a throw here is not a failure. */
async function resetBetweenPages(context: BrowserContext, page: Page): Promise<void> {
  await context.clearCookies().catch(() => {});
  await page
    .evaluate(() => {
      localStorage.clear();
      sessionStorage.clear();
    })
    .catch(() => {});
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
