import { resolveRenderer } from './renderer.js';
// Capture one story. The ordering here is load-bearing — see settle.ts for why
// each step exists. Because pass/fail is a byte-exact hash, every source of
// nondeterminism left in this path becomes a false failure somewhere.

import sharp from 'sharp';
import { emulatedMedia, FRESH_RENDERER_URL, type Page } from '../browser/page.js';
import { assertCssSelector } from '../browser/selectors.js';
import type { Platform } from '../platform.js';
import type {
  CaptureTimings,
  ColorScheme,
  Snapshot,
  StoryManifest,
  StoryParams,
  Viewport,
} from '../types.js';
import {
  FREEZE_ANIMATIONS_CSS,
  rerasterLayers,
  waitForPaint,
  waitForSelector,
} from './settle.js';
import {
  installIdleDetector,
  movedSincePaint,
  resetIdle,
  waitForIdle,
  type IdleResult,
} from './idle.js';
import { checkSettle, resolveSettle, type SettleLayer } from './settle-options.js';
import { applyNetworkPolicy, checkNetwork } from './network-policy.js';
import { resolveNetwork, liveNetworkDiffers } from './network-rules.js';
import { layerCapture, layerNetwork } from './layers.js';
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
   * Start every cold capture after a page's first in a new renderer process
   * (issue #153). Default true; false keeps the renderer, faster but the
   * previous story can change this one's pixels. See below.
   */
  freshRenderer?: boolean;
  renderer?: StoryParams['renderer'];
  forceFreshRenderer?: boolean;
  /** Guard live-policy recapture against changing declarations. */
  rendererRecaptured?: boolean;
  /**
   * The renderer processes that hosted a capture in this run, by their
   * inspector isolate id (random 64-bit per process). The pool shares one
   * across its pages so a story that lands in another page's used renderer
   * is caught too; without it each page checks only its own history.
   */
  renderers?: Set<string>;
  /**
   * Capture the structure snapshot beside the pixels. Default true. It costs
   * one CDP call per story (budget: < 30 ms) and explains failures; it never
   * decides one. `JUXTAPOSE_NO_STRUCTURE=1` turns it off for A/B timing.
   */
  structure?: boolean;
  /** Reports which step of the capture is about to run, so the pool's story
   *  budget can name where a wedged story was stuck. */
  onPhase?: (phase: string) => void;
  /** Reports the time settle may legitimately spend (its cap plus `delay`),
   *  once resolved, so the pool's story budget never pre-empts it. */
  onSettleBudget?: (ms: number) => void;
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
/** Each page's own renderer history, when the caller passes no shared set. */
const pageRenderers = new WeakMap<Page, Set<string>>();

export async function captureStory(
  page: Page,
  story: StoryManifest,
  deps: CaptureDeps,
  viewport: Viewport,
  // Returns null when the story declares `skip` in its live params — see below.
): Promise<Snapshot | null> {
  const started = Date.now();
  // Per-phase wall time, for `timings`. Only reads the clock around calls that
  // were already there: nothing is added to, or moved in, the capture path.
  const t0 = performance.now();
  const acc = { navigate: 0, freshRenderer: 0, render: 0, settle: 0, paint: 0 };
  const phase = (name: string) => deps.onPhase?.(name);
  phase('page setup');
  // Copied, not aliased: live params get merged in below, and mutating the
  // manifest entry would leak one story's config into the next run.
  const params: StoryParams = { ...story.params };
  const renderer = resolveRenderer(deps, params.renderer, deps.forceFreshRenderer);
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
    !deps.forceFreshRenderer &&
    warmPages.get(page) === deps.baseUrl &&
    !schemeChanged &&
    !sameStoryOtherCapture &&
    !(params.animations === 'play' && styleInjected.has(page));

  phase('navigation');
  // Before showStory, on every capture, so the story renders in its scheme
  // from the first frame. Memoized, so it costs nothing when unchanged.
  await ensureColorScheme(page, scheme);
  // A cold capture on a page that has shown anything before starts in a new
  // renderer process (issue #153). The renderer keeps font and raster state
  // across navigations, about:blank included, so the previous story changed
  // this one's pixels. Measured with jux 0.9.0 at concurrency 1: Primer's
  // pagelayout pull-request-page after pageheader webhooks hashed 37d0ff51,
  // alone 76cf4695, its heading 0.11 px wider because webhooks measured
  // canvas text at 32.0167px in the macOS system font. Spectrum's
  // card--default after button-group-sizes--vertical-xl hashed 28d933b6,
  // alone 2faf799d, with identical layout and different cover-image edge
  // pixels. A memory-pressure purge cleared neither; a new page or context
  // per story did, at the same cost as this hop.
  //
  // The cost is real: a cold renderer runs the workbench's JS without warm
  // JIT state. A trivial page pays about 30 ms; a Spectrum story about
  // 220 ms (script 34 -> 116 ms, main-thread tasks 120 -> 263 ms), and the
  // full 1,086-story Spectrum pass went from 47 to 83 s at concurrency 8
  // (36 to 70 s at 16). The V8 code cache does not recover it. Without it, a
  // story's hash depends on where the shuffled queue put it.
  //
  // The navigation after a data: URL lands in a new renderer
  // (Chrome 151: a new pid every time; about:blank kept the old one), and,
  // unlike a new page, this keeps the page's init scripts, emulation and
  // network policy.
  //
  // The hop also covers a variant, which shares its story's URL: a URL
  // differing only in its fragment is a same-document navigation, so the
  // cold path below would not reload, and an app that read the scheme at
  // boot would keep the old one, or keep the previous capture's render.
  //
  // With freshRenderer off the page keeps its renderer and is only blanked
  // for those same-URL cases, as before #153.
  if (!warm && (previous !== undefined || deps.forceFreshRenderer) && !renderer.shared) {
    const tFresh = performance.now();
    await page.goto(FRESH_RENDERER_URL);
    acc.freshRenderer = performance.now() - tFresh;
    warmPages.delete(page);
  } else if ((schemeChanged || sameStoryOtherCapture) && warmPages.has(page)) {
    await page.goto('about:blank');
    warmPages.delete(page);
  }
  // Same renderer reused (freshRenderer off): evict Blink's in-memory resource
  // cache so the previous story's image state cannot reach this one's pixels.
  // Disabling and re-enabling the cache right before the navigation made
  // Spectrum's card--default and color-slider--image match their cold hashes
  // after another story at history depths 0, 1 and 3 (3 of 3 repeats), and
  // fixed 4 of the 5 history-sensitive stories in a 146-story sweep with no
  // new mismatches. It keeps the HTTP cache (~2% over plain reuse, against
  // ~9% for disabling the cache through the whole capture). Blanking alone and
  // pulsing after settle did not help.
  if (!warm && previous !== undefined && renderer.shared && renderer.clearResourceCache) {
    await page.send('Network.setCacheDisabled', { cacheDisabled: true });
    await page.send('Network.setCacheDisabled', { cacheDisabled: false });
  }
  pageCapture.set(page, { key: story.storyId, base: id });
  // Before any request of this story: the policy is read from the layers
  // known now (live params arrive after render, too late to block anything).
  checkNetwork(params.network, `story '${story.storyId}'`);
  const policy = resolveNetwork(layerNetwork(deps.settleLayers, params));
  await applyNetworkPolicy(page, policy, deps.baseUrl);
  // Before the render is triggered, so a request or ready() call from this
  // story's render is never mistaken for the previous one's.
  await resetIdle(page, idle, warm);

  const tNav = performance.now();
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
  acc.navigate = performance.now() - tNav;
  // The hop above asks for a new renderer; Chrome decides. Once the browser
  // holds its renderer-process limit, the next navigation reuses a process
  // that already ran a story, silently (measured, Chrome 151: concurrency 8
  // with --renderer-process-limit=8 reused 56 of 56, with 9 none). Our launch
  // sets the limit far above any concurrency (flags.ts), but an adopted or
  // daemon-shared browser, or a caller's lower limit, can still reach it. So
  // the result says so: the isolate id is random per renderer process and
  // matched the CPU-identified pid on 87 of 87 captures, reused or not, for
  // about 0.2 ms a capture.
  const seenRenderer = await rendererSeenBefore(page, deps.renderers);
  const rendererReused = !switched && !renderer.shared && seenRenderer;

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

  phase('platform settle');
  const tRender = performance.now();
  await deps.platform.settle(page, ctx);
  acc.render += performance.now() - tRender;

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
  phase('live params');
  const tLive = performance.now();
  const live = await deps.platform.readLiveParams?.(page, id);
  if (live) {
    Object.assign(params, mergeLiveParams(story, live));
    const liveRenderer = resolveRenderer(deps, params.renderer, deps.forceFreshRenderer);
    if (
      liveRenderer.shared !== renderer.shared ||
      liveRenderer.clearResourceCache !== renderer.clearResourceCache
    ) {
      if (deps.rendererRecaptured)
        throw new Error('renderer settings changed during live-parameter recapture');
      const recaptured = await captureStory(
        page,
        { ...story, params },
        { ...deps, warmSwitch: false, rendererRecaptured: true },
        viewport,
      );
      return recaptured ? { ...recaptured, durationMs: Date.now() - started } : null;
    }
    if (
      live.network !== undefined &&
      deps.settleLayers?.call?.network === undefined &&
      liveNetworkDiffers(policy, deps.settleLayers?.project?.network, params.network)
    ) {
      deps.onWarning?.(
        `jux: ${story.storyId}: the story's live parameters set network ${JSON.stringify(live.network)}, which is read before navigation and was ignored. Declare it in the project config or the command.`,
      );
    }
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
  // Live params are read from the page, so this counts as waiting on the render.
  acc.render += performance.now() - tLive;

  // A story can declare `skip` in params the static index never carried, so
  // this is the first point we can honour it. Signalled rather than returning
  // a snapshot, because capturing and then discarding would still cost the
  // screenshot and would report a meaningless hash.
  if (params.skip === true) return null;

  // Project and call layers around the story's own: waitForSelector and
  // delay are call > story > project; settle merges field by field. Live
  // params can carry a `settle` discovery never saw, so it is checked here;
  // a bad one fails this story with the reason.
  const layered = layerCapture(deps.settleLayers, params);
  Object.assign(params, layered.scalars);
  assertSelectors(params);
  checkSettle(params.settle, `story '${story.storyId}'`);
  const settle = resolveSettle(layered.settle);

  phase('waitForSelector');
  // Settle must never throw on timeout (a slow story is a reviewable diff),
  // so the story budget has to outlast the cap and the fixed delay.
  deps.onSettleBudget?.(
    settle.timeoutMs + (params.delay ?? 0) + (params.waitForSelector ? timeoutMs : 0),
  );
  const tSettle = performance.now();
  if (params.waitForSelector) {
    await waitForSelector(page, params.waitForSelector, timeoutMs);
  }

  phase('idle wait');
  const first = await waitForIdle(page, idle, settle);
  acc.settle += performance.now() - tSettle;

  // Fixed delay is the escape hatch of last resort — it costs the same on
  // every run whether or not it was needed. Prefer waitForSelector.
  phase('delay');
  const tDelay = performance.now();
  if (params.delay && params.delay > 0) {
    await new Promise<void>((r) => setTimeout(r, params.delay));
  }
  acc.settle += performance.now() - tDelay;

  // Last barrier before the shutter: the DOM being quiet does not mean the
  // pixels are final. Style, layout and paint still have to land, and without
  // this the capture intermittently catches an intermediate frame — which a
  // byte-exact hash reports as a failure. Composited layers are rebuilt
  // first so their raster reflects this frame, not the page's history
  // (issue #136).
  phase('paint barrier');
  const tPaint = performance.now();
  await rerasterLayers(page);
  await waitForPaint(page);
  acc.paint += performance.now() - tPaint;

  // Work that landed during the paint barrier (an observer callback, a
  // request the last frame started) gets one more wait, within what is left
  // of the cap. Once: a page that keeps moving is captured, not chased.
  let flagged: IdleResult | undefined = first.status === 'idle' ? undefined : first;
  const tMoved = performance.now();
  if (
    first.status === 'idle' &&
    (await movedSincePaint(page, idle, first.snap, settle))
  ) {
    acc.paint += performance.now() - tMoved;
    const tSecond = performance.now();
    const second = await waitForIdle(
      page,
      idle,
      settle,
      Math.max(100, settle.timeoutMs - first.waitedMs),
    );
    acc.settle += performance.now() - tSecond;
    const tRepaint = performance.now();
    // No idle wait after this rebuild: it keeps every containing block and
    // stacking context and leaves no mutation behind (settle.ts), so it gives
    // the page nothing to react to. With the earlier blanket sheet a
    // latching IntersectionObserver did react, and this path captured it.
    await rerasterLayers(page);
    await waitForPaint(page);
    acc.paint += performance.now() - tRepaint;
    if (second.status !== 'idle') flagged = second;
  } else {
    acc.paint += performance.now() - tMoved;
  }

  // Structure from the same frame the screenshot is about to take: after the
  // paint barrier, before the shutter, with nothing in between that could
  // mutate the page.
  const effective = params.viewport ?? effectiveViewport;
  phase('structure capture');
  const tStructure = performance.now();
  const structure =
    deps.structure !== false && process.env.JUXTAPOSE_NO_STRUCTURE !== '1'
      ? await captureStructure(page, effective, params.mask ?? [])
      : undefined;
  const structureMs = performance.now() - tStructure;

  // A selector matching nothing is not an error — a story that conditionally
  // renders the element shouldn't fail on the branch where it's absent.
  phase('screenshot');
  const tShot = performance.now();
  const png = await page.screenshot(params.mask?.length ? { mask: params.mask } : {});
  const screenshotMs = performance.now() - tShot;

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
  phase('encode');
  const tEncode = performance.now();
  const image = await sharp(png)
    .webp({ lossless: true, effort: deps.webpEffort ?? 0 })
    .toBuffer();
  const encodeMs = performance.now() - tEncode;
  const timings = captureTimings(performance.now() - t0, {
    navigate: acc.navigate,
    freshRenderer: acc.freshRenderer,
    render: acc.render,
    settle: acc.settle,
    paint: acc.paint,
    structure: structureMs,
    screenshot: screenshotMs,
    encode: encodeMs,
  });

  return {
    storyId: story.storyId,
    ...(story.baseStoryId !== undefined ? { baseStoryId: story.baseStoryId } : {}),
    ...(story.variant !== undefined ? { variant: story.variant } : {}),
    image,
    // The live params may have widened or narrowed this after first render,
    // so report what we actually captured at — the agent handoff computes
    // region area as a fraction of it.
    viewport: effective,
    renderer,
    capturedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    timings,
    ...(structure ? { structure } : {}),
    ...(rendererReused ? { rendererReused: true } : {}),
    ...(flagged?.status === 'timeout'
      ? {
          settle: {
            status: 'timeout' as const,
            timeoutMs: settle.timeoutMs,
            pending: flagged.pending ?? [],
            ...(flagged.requests ? { requests: flagged.requests } : {}),
            ...(flagged.requestsOmitted
              ? { requestsOmitted: flagged.requestsOmitted }
              : {}),
            ...(pageOrigin(deps.baseUrl) ? { origin: pageOrigin(deps.baseUrl) } : {}),
          },
        }
      : flagged?.status === 'fallback'
        ? { settle: { status: 'fallback' as const, pending: flagged.pending ?? [] } }
        : {}),
  };
}

/** The phases as 0.1 ms figures, with `other` as whatever the named phases
 *  leave of `totalMs` (page setup, network policy, the freeze, the isolate
 *  check, bookkeeping). Measured with performance.now(), which is monotonic;
 *  durationMs is wall-clock Date.now(). */
function captureTimings(
  totalMs: number,
  named: Omit<CaptureTimings, 'other'>,
): CaptureTimings {
  const r = (ms: number) => Math.round(Math.max(0, ms) * 10) / 10;
  const sum = Object.values(named).reduce((a, b) => a + b, 0);
  return {
    navigate: r(named.navigate),
    freshRenderer: r(named.freshRenderer),
    render: r(named.render),
    settle: r(named.settle),
    paint: r(named.paint),
    structure: r(named.structure),
    screenshot: r(named.screenshot),
    encode: r(named.encode),
    other: r(totalMs - sum),
  };
}

/**
 * Whether the page's current renderer process already hosted a capture, then
 * records it. A browser without Runtime.getIsolateId answers false: unknown
 * is not evidence of reuse.
 */
async function rendererSeenBefore(page: Page, shared?: Set<string>): Promise<boolean> {
  let seen = shared ?? pageRenderers.get(page);
  if (!seen) pageRenderers.set(page, (seen = new Set()));
  const id = await page
    .send('Runtime.getIsolateId')
    .then((r) => r.id)
    .catch(() => undefined);
  if (id === undefined) return false;
  if (seen.has(id)) return true;
  seen.add(id);
  return false;
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
 * Inject the freeze stylesheet, once per page, and freeze open shadow roots,
 * on every capture.
 *
 * Note the interaction with warm-page reuse: the style tag survives a story
 * switch but not a navigation, so a story with `animations: 'play'` landing on
 * an already-frozen page would still be frozen. The warm check above excludes
 * those stories for that reason, forcing them down the cold path where the
 * navigation clears the tag.
 */
async function freezeAnimations(page: Page, params: StoryParams): Promise<void> {
  if (params.animations === 'play') return;
  if (!styleInjected.has(page)) {
    await page.addStyleTag({ content: FREEZE_ANIMATIONS_CSS }).catch(() => {});
    styleInjected.add(page);
  }
  // A document stylesheet stops at a shadow boundary (issue #152): the idle
  // init script adopts the same rules into every open shadow root of this
  // document, now and as later ones attach, until the next navigation.
  // Every capture, not once per page like the style tag: a warm switch can
  // add declarative roots (no attachShadow call), and this walk finds them
  // before the render signal. One that appears later still gets frozen,
  // when the idle wait starts. Closed roots are out of reach. Without the
  // init script (it could not be installed) shadow roots stay unfrozen, as
  // they always were.
  await page
    .evaluate(
      (css: string) =>
        (
          window as unknown as { __juxIdle?: { freeze?: (css: string) => void } }
        ).__juxIdle?.freeze?.(css),
      FREEZE_ANIMATIONS_CSS,
    )
    .catch(() => {});
}

function assertSelectors(params: StoryParams): void {
  for (const sel of params.mask ?? []) assertCssSelector(sel);
  if (params.waitForSelector) assertCssSelector(params.waitForSelector);
}

/** The origin of the workbench the pages are served from, or undefined. */
function pageOrigin(baseUrl: string): string | undefined {
  try {
    const u = new URL(baseUrl);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : undefined;
  } catch {
    return undefined;
  }
}
