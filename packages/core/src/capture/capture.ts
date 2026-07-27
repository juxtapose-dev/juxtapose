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
  waitForPaint,
  waitForSelector,
} from './settle.js';

const DEFAULT_CAPTURE_TIMEOUT_MS = 2000;

export interface CaptureDeps {
  platform: Platform;
  baseUrl: string;
  /** WebP encode effort, 0-6. Higher is smaller and slower. Capture is
   *  browser-bound, so 0 is the right default — the bytes are transient. */
  webpEffort?: number;
  /**
   * Reuse a warm page and switch stories over the platform's channel instead
   * of navigating. Roughly 4x faster per story.
   *
   * OFF BY DEFAULT, and that is a deliberate, measured decision rather than
   * caution. A warm switch does not reproduce a cold load's pixels exactly:
   * the previous story leaves residue — retained style and layout state,
   * settled transitions, a different paint history — and the same story
   * captured warm differs from the same story captured cold by a handful of
   * antialiased pixels.
   *
   * Each path is internally stable. They just disagree with each other. Under
   * a byte-exact hash that makes a story's verdict depend on where it happened
   * to land in the shuffled work queue, which is to say: random. Measured on a
   * 16-story suite, 1-4 stories failed per run purely from queue order.
   *
   * The speed is real and worth having, so this is not abandoned — see the
   * tracking issue. But correctness is not negotiable against it, and a
   * visual test that cries wolf is worse than a slow one.
   */
  warmSwitch?: boolean;
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
    deps.warmSwitch === true &&
    warmPages.get(page) === deps.baseUrl &&
    !(params.animations === 'play' && styleInjected.has(page));
  if (warm) await armSettle(page);

  const switched =
    warm && deps.platform.switchStory
      ? await deps.platform.switchStory(page, story.storyId, ctx)
      : false;

  if (!switched) {
    // Delegated rather than built here: not every platform addresses a story
    // by URL. Playwright galleries render via window.mount() on a fixed page.
    await deps.platform.showStory(page, story.storyId, deps.baseUrl);
    // A navigation discards injected style tags, so the freeze must be
    // re-applied for the next story that wants it.
    styleInjected.delete(page);
    warmPages.set(page, deps.baseUrl);
    await armSettle(page);
  }

  // Freeze BEFORE the story renders, not after.
  //
  // This ordering is the whole ballgame for warm-page reuse. Injected styles
  // survive a story switch but not a navigation, so freezing after render
  // means a warm story renders with the previous story's freeze already
  // active while a cold story renders unfrozen — and the two paths produce
  // different pixels for the same story. Under a byte-exact hash that makes a
  // story's result depend on where it landed in the shuffled queue, which is
  // to say: random.
  //
  // Injecting here makes both paths see identical conditions. Measured on a
  // 16-story suite: 2-4 stories failing per run before, 16/16 stable after.
  await freezeAnimations(page, params);

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

  // Last barrier before the shutter: the DOM being quiet does not mean the
  // pixels are final. Style, layout and paint still have to land, and without
  // this the capture intermittently catches an intermediate frame — which a
  // byte-exact hash reports as a failure.
  await waitForPaint(page);

  const png = await page.screenshot({ type: 'png' });

  // LOSSLESS, deliberately, and it is not a size-vs-quality preference.
  //
  // Lossy WebP at q90 perturbs ~7.7% of pixels frame-wide. The hash comparison
  // survives that (encoding is deterministic, so identical input still yields
  // identical bytes), but the pixel diff does not: comparing two lossy decodes
  // scatters compression noise across every row and column, which swallows the
  // real changed region into a full-viewport bounding box and destroys the
  // localization the diff exists to provide.
  //
  // Measured: 3537 changed pixels from a single recoloured button spread over
  // all 800 rows and all 1280 columns. With lossless, zero pixels differ from
  // the source. Costs ~4x the bytes; buys a diff that means something.
  const image = await sharp(png)
    .webp({ lossless: true, effort: deps.webpEffort ?? 0 })
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
 * switch but not a navigation, so a story with `animations: 'play'` landing on
 * an already-frozen page would still be frozen. The warm check above excludes
 * those stories for that reason, forcing them down the cold path where the
 * navigation clears the tag.
 */
async function freezeAnimations(page: Page, params: StoryParams): Promise<void> {
  if (params.animations === 'play') return;
  if (styleInjected.has(page)) return;
  await page.addStyleTag({ content: FREEZE_ANIMATIONS_CSS }).catch(() => {});
  styleInjected.add(page);
}
