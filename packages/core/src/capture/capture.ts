// Capture one story. The ordering here is load-bearing — see settle.ts for why
// each step exists. Because pass/fail is a byte-exact hash, every source of
// nondeterminism left in this path becomes a false failure somewhere.

import sharp from 'sharp';
import type { Page } from 'playwright';
import type { Platform } from '../platform.js';
import type { Snapshot, StoryManifest, StoryParams, Viewport } from '../types.js';
import {
  armSettle,
  drain,
  FREEZE_ANIMATIONS_CSS,
  waitForSelector,
} from './settle.js';

const WEBP_QUALITY = 90;
const DEFAULT_CAPTURE_TIMEOUT_MS = 2000;

export interface CaptureDeps {
  platform: Platform;
  baseUrl: string;
  /** WebP encode effort, 0-6. Higher is smaller and slower. Capture is
   *  browser-bound, so 0 is the right default — the bytes are transient. */
  webpEffort?: number;
}

/** Per-page memo: skip work that only needs doing once per page. */
const styleInjected = new WeakSet<Page>();
const pageViewport = new WeakMap<Page, string>();
const warmPages = new WeakMap<Page, string>();

export async function captureStory(
  page: Page,
  story: StoryManifest,
  deps: CaptureDeps,
  viewport: Viewport,
): Promise<Snapshot> {
  const started = Date.now();
  const params = story.params;
  const effectiveViewport = params.viewport ?? viewport;
  const timeoutMs = params.captureTimeout ?? DEFAULT_CAPTURE_TIMEOUT_MS;
  const ctx = { story, params, timeoutMs };

  await ensureViewport(page, effectiveViewport);

  // Arm before triggering the render, or the observer misses the mutations it
  // exists to watch.
  //
  // A story that wants animations running can't reuse a page whose stylesheet
  // already froze them, so force the cold path for those.
  const warm =
    warmPages.get(page) === deps.baseUrl &&
    !(params.animations === 'play' && styleInjected.has(page));
  if (warm) await armSettle(page);

  const switched =
    warm && deps.platform.switchStory
      ? await deps.platform.switchStory(page, story.storyId, ctx)
      : false;

  if (!switched) {
    await page.goto(deps.platform.storyUrl(deps.baseUrl, story.storyId), {
      waitUntil: 'load',
    });
    // A navigation discards injected style tags, so the freeze must be
    // re-applied for the next story that wants it.
    styleInjected.delete(page);
    warmPages.set(page, deps.baseUrl);
    await armSettle(page);
  }

  await deps.platform.settle(page, ctx);

  if (params.waitForSelector) {
    await waitForSelector(page, params.waitForSelector, timeoutMs);
  }

  await drain(page);

  // Fixed delay is the escape hatch of last resort — it costs the same on
  // every run whether or not it was needed. Prefer waitForSelector.
  if (params.delay && params.delay > 0) {
    await page.waitForTimeout(params.delay);
  }

  await freezeAnimations(page, params);

  const png = await page.screenshot({ type: 'png' });
  const image = await sharp(png)
    .webp({ quality: WEBP_QUALITY, effort: deps.webpEffort ?? 0 })
    .toBuffer();

  return {
    storyId: story.storyId,
    image,
    viewport: effectiveViewport,
    capturedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
  };
}

/** Setting the viewport is a CDP round-trip; skip it when nothing changed. */
async function ensureViewport(page: Page, viewport: Viewport): Promise<void> {
  const key = `${viewport.width}x${viewport.height}`;
  if (pageViewport.get(page) === key) return;
  await page.setViewportSize(viewport);
  pageViewport.set(page, key);
}

/**
 * Inject the freeze stylesheet, once per page.
 *
 * Note the interaction with warm-page reuse: the style tag survives a story
 * switch, so a story with `animations: 'play'` landing on a page that already
 * froze would still be frozen. Rather than track and remove the tag, such
 * stories are routed to a cold page by the caller — animation stories are rare
 * and a navigation is cheaper than making this stateful.
 */
async function freezeAnimations(page: Page, params: StoryParams): Promise<void> {
  if (params.animations === 'play') return;
  if (styleInjected.has(page)) return;
  await page.addStyleTag({ content: FREEZE_ANIMATIONS_CSS }).catch(() => {});
  styleInjected.add(page);
}

/** True if this story must not reuse a page that has been frozen. */
export function requiresColdPage(story: StoryManifest): boolean {
  return story.params.animations === 'play';
}
