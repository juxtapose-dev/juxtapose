// Capture one story. The ordering here is load-bearing — see settle.ts for why
// each step exists. Because pass/fail is a byte-exact hash, every source of
// nondeterminism left in this path becomes a false failure somewhere.

import sharp from 'sharp';
import { emulatedMedia, type Page } from '../browser/page.js';
import { assertCssSelector } from '../browser/selectors.js';
import type { Platform } from '../platform.js';
import type {
  ColorScheme,
  Snapshot,
  StoryManifest,
  StoryParams,
  Viewport,
} from '../types.js';
import { FREEZE_ANIMATIONS_CSS, waitForPaint, waitForSelector } from './settle.js';
import {
  installIdleDetector,
  movedSincePaint,
  resetIdle,
  waitForIdle,
  type IdleResult,
} from './idle.js';
import {
  checkSettle,
  layerScalars,
  resolveSettle,
  type SettleLayer,
} from './settle-options.js';
import { captureStructure } from './structure.js';
import { deepEqual, mergeLiveParams, platformStoryId } from './variants.js';

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
  /**
   * Capture the structure snapshot beside the pixels. Default true. It costs
   * one CDP call per story (budget: < 30 ms) and explains failures; it never
   * decides one. `JUXTAPOSE_NO_STRUCTURE=1` turns it off for A/B timing.
   */
  structure?: boolean;
  /** Something the user should know that doesn't fail the story. */
  onWarning?: (message: string) => void;
  /** Settle options from outside the story: the project config below the
   *  story's own params, the call (CLI flags, MCP arguments) above them. */
  settleLayers?: { project?: SettleLayer; call?: SettleLayer };
}

/** Per-page memo: skip work that only needs doing once per page. */
const styleInjected = new WeakSet<Page>();
const pageViewport = new WeakMap<Page, string>();
const pageColorScheme = new WeakMap<Page, ColorScheme>();
/** The capture last shown on a page: its key and its platform story id. */
const pageCapture = new WeakMap<Page, { key: string; base: string }>();
const warmPages = new WeakMap<Page, string>();

export async function captureStory(
  page: Page,
  story: StoryManifest,
  deps: CaptureDeps,
  viewport: Viewport,
  // Returns null when the story declares `skip` in its live params — see below.
): Promise<Snapshot | null> {
  const started = Date.now();
  // Copied, not aliased: live params get merged in below, and mutating the
  // manifest entry would leak one story's config into the next run.
  const params: StoryParams = { ...story.params };
  const effectiveViewport = params.viewport ?? viewport;
  const timeoutMs = params.captureTimeout ?? DEFAULT_CAPTURE_TIMEOUT_MS;
  // Every platform call gets the platform's own id; the variant capture key
  // means nothing to Storybook or Ladle.
  const id = platformStoryId(story);
  const ctx = {
    story: id === story.storyId ? story : { ...story, storyId: id },
    params,
    timeoutMs,
  };

  // Selector syntax is validated before the page is touched: a Playwright-only
  // selector (`text=`, `>>`) would otherwise match nothing and the story would
  // be captured unmasked, or wait its whole timeout, and the baseline would
  // record the wrong thing. Live params are re-checked below.
  assertSelectors(params);

  // Before the first navigation on this page: the init script applies to
  // documents created after it is installed.
  const idle = await installIdleDetector(page);

  await ensureViewport(page, effectiveViewport);

  // Only a variant sets a scheme: a default capture resets to light, which is
  // what stops a pooled page carrying a dark variant's scheme into the next
  // story.
  const scheme: ColorScheme =
    story.variant !== undefined ? (params.colorScheme ?? 'light') : 'light';

  // A story that wants animations running can't reuse a page whose stylesheet
  // already froze them, so force the cold path for those. Likewise a scheme
  // change: an app that reads matchMedia once at boot keeps the old scheme
  // across a warm switch (measured: card then card__dark captured both light,
  // the reverse both dark). Decided before the scheme is applied, against
  // what the page booted under.
  //
  // And another capture of the same story (default -> mobile): the platform
  // sees its story already rendered and "switches" without re-rendering, so
  // the variant would be captured from the previous capture's layout.
  const previous = pageCapture.get(page);
  const sameStoryOtherCapture =
    previous !== undefined && previous.base === id && previous.key !== story.storyId;
  const schemeChanged = pageColorScheme.has(page) && pageColorScheme.get(page) !== scheme;
  const warm =
    deps.warmSwitch === true &&
    warmPages.get(page) === deps.baseUrl &&
    !schemeChanged &&
    !sameStoryOtherCapture &&
    !(params.animations === 'play' && styleInjected.has(page));

  // Before showStory, on every capture, so the story renders in its scheme
  // from the first frame. Memoized, so it costs nothing when unchanged.
  await ensureColorScheme(page, scheme);
  // A variant shares its story's URL, and a URL differing only in its
  // fragment is a same-document navigation: the cold path below would not
  // reload, and an app that read the scheme at boot would keep the old one,
  // or keep the previous capture's render. Blank the page so the story boots
  // fresh.
  if ((schemeChanged || sameStoryOtherCapture) && warmPages.has(page)) {
    await page.goto('about:blank');
    warmPages.delete(page);
  }
  pageCapture.set(page, { key: story.storyId, base: id });
  // Before the render is triggered, so a request or ready() call from this
  // story's render is never mistaken for the previous one's.
  await resetIdle(page, idle, warm);

  const switched =
    warm && deps.platform.switchStory
      ? await deps.platform.switchStory(page, id, ctx)
      : false;

  if (!switched) {
    // Delegated rather than built here: not every platform addresses a story
    // by URL. Playwright galleries render via window.mount() on a fixed page.
    await deps.platform.showStory(page, id, deps.baseUrl);
    // A navigation discards injected style tags, so the freeze must be
    // re-applied for the next story that wants it.
    styleInjected.delete(page);
    warmPages.set(page, deps.baseUrl);
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

  // Now that the story has rendered, ask the platform whether it declares
  // params the static index didn't carry.
  //
  // Storybook is why this exists: it only serializes a whitelist of parameters
  // into index.json, so `parameters.juxtapose` is essentially never there.
  // Reading the index alone silently dropped every per-story threshold,
  // waitForSelector and skip on that platform.
  //
  // Live params override manifest params — the live preview is the story's own
  // declaration, and the index is a lossy projection of it — but merge under
  // a variant's own fields, so the mobile variant stays mobile.
  const live = await deps.platform.readLiveParams?.(page, id);
  if (live) {
    Object.assign(params, mergeLiveParams(story, live));
    assertSelectors(params);

    // A story can opt out of a project variant in params only the live
    // preview carries (Storybook). Honour it as a skip.
    if (story.variant !== undefined && live.variants?.[story.variant] === false) {
      return null;
    }
    if (story.variant !== undefined && liveOverrideDiffers(story, live)) {
      deps.onWarning?.(
        `jux: ${story.storyId}: the story's live parameters declare variant '${story.variant}' differently from the settings it was captured with. Parameters read after render can't change which variants exist or what they set; declare variants in the story's parameters, where discovery reads them before capture.`,
      );
    }

    // Viewport is the one param that cannot be applied retroactively — the
    // story has already laid out. Re-set it and let the platform settle
    // again, so a story declaring its own viewport is captured at that size
    // rather than the project default.
    const liveViewport = params.viewport;
    if (liveViewport && !sameViewport(liveViewport, effectiveViewport)) {
      await ensureViewport(page, liveViewport);
      await deps.platform.settle(page, { ...ctx, params });
    }
  }

  // A story can declare `skip` in params the static index never carried, so
  // this is the first point we can honour it. Signalled rather than returning
  // a snapshot, because capturing and then discarding would still cost the
  // screenshot and would report a meaningless hash.
  if (params.skip === true) return null;

  // Project and call layers around the story's own: waitForSelector and
  // delay are call > story > project; settle merges field by field. Live
  // params can carry a `settle` discovery never saw, so it is checked here;
  // a bad one fails this story with the reason.
  Object.assign(
    params,
    layerScalars(deps.settleLayers?.project, params, deps.settleLayers?.call),
  );
  assertSelectors(params);
  checkSettle(params.settle, `story '${story.storyId}'`);
  const settle = resolveSettle(
    deps.settleLayers?.project?.settle,
    params.settle,
    deps.settleLayers?.call?.settle,
  );

  if (params.waitForSelector) {
    await waitForSelector(page, params.waitForSelector, timeoutMs);
  }

  const first = await waitForIdle(page, idle, settle);

  // Fixed delay is the escape hatch of last resort — it costs the same on
  // every run whether or not it was needed. Prefer waitForSelector.
  if (params.delay && params.delay > 0) {
    await new Promise<void>((r) => setTimeout(r, params.delay));
  }

  // Last barrier before the shutter: the DOM being quiet does not mean the
  // pixels are final. Style, layout and paint still have to land, and without
  // this the capture intermittently catches an intermediate frame — which a
  // byte-exact hash reports as a failure.
  await waitForPaint(page);

  // Work that landed during the paint barrier (an observer callback, a
  // request the last frame started) gets one more wait, within what is left
  // of the cap. Once: a page that keeps moving is captured, not chased.
  let flagged: IdleResult | undefined = first.status === 'idle' ? undefined : first;
  if (
    first.status === 'idle' &&
    (await movedSincePaint(page, idle, first.snap, settle))
  ) {
    const second = await waitForIdle(
      page,
      idle,
      settle,
      Math.max(100, settle.timeoutMs - first.waitedMs),
    );
    await waitForPaint(page);
    if (second.status !== 'idle') flagged = second;
  }

  // Structure from the same frame the screenshot is about to take: after the
  // paint barrier, before the shutter, with nothing in between that could
  // mutate the page.
  const effective = params.viewport ?? effectiveViewport;
  const structure =
    deps.structure !== false && process.env.JUXTAPOSE_NO_STRUCTURE !== '1'
      ? await captureStructure(page, effective, params.mask ?? [])
      : undefined;

  // A selector matching nothing is not an error — a story that conditionally
  // renders the element shouldn't fail on the branch where it's absent.
  const png = await page.screenshot(params.mask?.length ? { mask: params.mask } : {});

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
    ...(story.baseStoryId !== undefined ? { baseStoryId: story.baseStoryId } : {}),
    ...(story.variant !== undefined ? { variant: story.variant } : {}),
    image,
    // The live params may have widened or narrowed this after first render,
    // so report what we actually captured at — the agent handoff computes
    // region area as a fraction of it.
    viewport: effective,
    capturedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    ...(structure ? { structure } : {}),
    ...(flagged?.status === 'timeout'
      ? {
          settle: {
            status: 'timeout' as const,
            timeoutMs: settle.timeoutMs,
            pending: flagged.pending ?? [],
          },
        }
      : flagged?.status === 'fallback'
        ? { settle: { status: 'fallback' as const, pending: flagged.pending ?? [] } }
        : {}),
  };
}

/** Whether the live preview declares this variant with settings other than
 *  the ones it was expanded with: Storybook keeps story-level variants out of
 *  index.json, so they only surface here, after the capture set is fixed. */
function liveOverrideDiffers(story: StoryManifest, live: StoryParams): boolean {
  const spec = story.variant !== undefined ? live.variants?.[story.variant] : undefined;
  if (spec === undefined || spec === false || typeof spec !== 'object') return false;
  const expanded: Record<string, unknown> = story.variantParams ?? {};
  return Object.entries(spec).some(
    ([k, v]) => k !== 'extends' && !deepEqual(v, expanded[k]),
  );
}

const sameViewport = (a: Viewport, b: Viewport) =>
  a.width === b.width && a.height === b.height;

/** Setting the viewport is a CDP round-trip; skip it when nothing changed. */
async function ensureViewport(page: Page, viewport: Viewport): Promise<void> {
  const key = `${viewport.width}x${viewport.height}`;
  if (pageViewport.get(page) === key) return;
  await page.setViewportSize(viewport);
  pageViewport.set(page, key);
}

/** Media emulation is a CDP round-trip too; skip it when nothing changed. */
async function ensureColorScheme(page: Page, scheme: ColorScheme): Promise<void> {
  if (pageColorScheme.get(page) === scheme) return;
  if (page.setColorScheme) await page.setColorScheme(scheme);
  else await page.send('Emulation.setEmulatedMedia', emulatedMedia(scheme));
  pageColorScheme.set(page, scheme);
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

function assertSelectors(params: StoryParams): void {
  for (const sel of params.mask ?? []) assertCssSelector(sel);
  if (params.waitForSelector) assertCssSelector(params.waitForSelector);
}
