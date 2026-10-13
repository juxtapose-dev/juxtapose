// Capture one URL through the full settle pipeline, outside any run.
//
// The public entry point for `jux snap` and for anything else that needs a
// single deterministic capture. It exists so captureStory and the settle
// pipeline can stay unexported (see index.ts): callers get the result of the
// load-bearing ordering without being able to reorder it.

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

const DEFAULT_SNAP_VIEWPORT: Viewport = { width: 1280, height: 800 };

export async function snapPage(opts: SnapOptions): Promise<SnapResult> {
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
    const platform = createUrlPlatform([
      { id: 'snap', url: opts.url, ...(opts.params ? { params: opts.params } : {}) },
    ]);
    const [story] = await platform.enumerate({ projectRoot: process.cwd() });
    const snapshot = await captureStory(
      page,
      story,
      { platform, baseUrl: opts.url },
      viewport,
    );
    if (!snapshot) throw new Error('jux: page declared skip');
    return { snapshot, env: captureEnv(browser), status };
  } finally {
    await browser.close().catch(() => {});
  }
}
