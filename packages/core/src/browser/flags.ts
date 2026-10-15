// Browser launch flags for reproducible rasterization.
//
// These matter more here than in most Playwright setups. Pass/fail is a
// byte-exact hash, so a single pixel of GPU rasterization jitter on one
// antialiased corner is a failed build — not a 0.002% mismatch someone can
// wave through.
//
// Measured on a card component with rounded corners: without these flags,
// repeated captures of an unchanged story differed by ~12 pixels out of
// 480,000, each off by exactly 1 in one channel. Invisible to a human, fatal
// to a hash.

/**
 * Chromium flags that make rasterization reproducible across runs.
 *
 * Each is here for a reason; none are cargo-culted:
 *
 * - `--disable-gpu`, `--disable-gpu-rasterization`, `--disable-skia-runtime-opts`
 *   force CPU rasterization down a fixed code path. GPU rasterization is the
 *   direct cause of the off-by-one antialiasing jitter above, and Skia's
 *   runtime CPU-feature detection can pick different SIMD paths on different
 *   machines.
 *
 * - `--force-color-profile=srgb`, `--disable-lcd-text`, `--disable-font-subpixel-positioning`
 *   pin colour management and text rendering. Subpixel positioning and LCD
 *   antialiasing make glyph edges depend on display configuration, which is
 *   exactly the kind of environment coupling that makes a baseline captured on
 *   one machine fail on another.
 *
 * - `--disable-partial-raster` makes every re-raster redraw a whole tile.
 *   With partial raster, a repaint re-rasters only the invalidated rect,
 *   clipped to it, and an antialiased edge lying on that clip (a rounded
 *   border on its own element's rect) gets different coverage than in an
 *   unclipped raster. The bytes then depend on whether something repainted
 *   after the first raster, which is timing (issue #120). Measured on Linux
 *   CI, snapping the structural-corpus pages four per launch through
 *   `snapPages`: 20 of 18,800 captures (about 1 in 940) differed from the
 *   rest, each by the same 2 pixels, off by up to 8, on the button's top-left
 *   corner, and a whole-page repaint before the shutter restored the majority
 *   bytes in 8 of 8. Repainting just the button produces those exact pixels
 *   on every run, on Linux and macOS; page.test.ts guards it. With this flag:
 *   0 of 7,200, and the examples and corpus capture byte-identical to before.
 *
 * - `--hide-scrollbars` keeps a scrollbar's presence from shifting layout by a
 *   few pixels depending on content height.
 *
 * - `--disable-background-timer-throttling` and friends stop Chromium from
 *   throttling a backgrounded renderer, which otherwise makes settle timing
 *   depend on whether the window happens to be focused.
 *
 * - `--renderer-process-limit=1000` keeps the fresh-renderer hop honest
 *   (issue #153). Each cold capture navigates through a data: URL so the
 *   story lands in a new renderer process, but once the browser holds its
 *   renderer limit Chrome reuses a process that already ran a story, and
 *   that story's font and raster state changes this one's pixels. Chrome's
 *   default limit is RAM / 2 / 85 MB, clamped to 3 and half the OS process
 *   limit (render_process_host_impl.cc, Chrome 151): 12 on a 2 GB container,
 *   24 on 4 GB. Measured with an explicit limit: concurrency 8 at 8 reused
 *   56 of 56 captures, at 9 none. A hop briefly holds two renderers per page
 *   (concurrency 16 peaked at 28-32 renderers), so the defaults bite below
 *   2x: concurrency 16 at 24 (4 GB) reused 14 of 128, concurrency 8 at 12
 *   (2 GB) 13 of 64. With 1000: 0 of 64 at 8, 0 of 128 at 16. The flag
 *   only lifts the cap; pages still set
 *   the process count, a median of one per page, and peak renderer memory at
 *   concurrency 16 was 1.50 GB without the hop, 1.51 GB with it under the
 *   default limit and 1.54 GB at 1000. 1000 is beyond any concurrency a
 *   machine has memory for (about 95 MB a page), so memory, not Chrome,
 *   bounds it. capture.ts flags any story that still lands in a used
 *   renderer, for browsers this launch didn't start.
 */
export const DETERMINISTIC_CHROMIUM_ARGS: readonly string[] = [
  '--disable-gpu',
  '--disable-gpu-rasterization',
  '--disable-skia-runtime-opts',
  '--disable-lcd-text',
  '--disable-font-subpixel-positioning',
  '--force-color-profile=srgb',
  '--disable-partial-raster',
  '--hide-scrollbars',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--force-device-scale-factor=1',
  '--renderer-process-limit=1000',
];

export interface LaunchOptions {
  /** Extra flags, appended after the deterministic set so they can override. */
  args?: string[];
  headless?: boolean;
}

/** Our own flags; `chromeArgs` wraps them with the parity set. */
export function deterministicLaunchOptions(opts: LaunchOptions = {}): {
  headless: boolean;
  args: string[];
} {
  return {
    headless: opts.headless ?? true,
    args: [...DETERMINISTIC_CHROMIUM_ARGS, ...(opts.args ?? [])],
  };
}

/**
 * playwright-core 1.62.0's `chromiumSwitches()` plus its headless additions
 * (`lib/coreBundle.js` L34630–34690, L43067–43097), copied verbatim.
 *
 * The byte-identity spike (spec, 2026-10-13) matched 29/29 example stories
 * against the Playwright pipeline with exactly this list. It was not pruned:
 * a Blink feature flag that changes rasterization — PaintHolding,
 * CDPScreenshotNewSurface — would turn every baseline red, and the gain from
 * dropping any of these is unmeasurable. Change only with a determinism run
 * per removed flag.
 */
export const PARITY_CHROMIUM_ARGS: readonly string[] = [
  '--disable-field-trial-config',
  '--disable-background-networking',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-back-forward-cache',
  '--disable-breakpad',
  '--disable-client-side-phishing-detection',
  '--disable-component-extensions-with-background-pages',
  '--disable-component-update',
  '--no-default-browser-check',
  '--disable-default-apps',
  '--disable-dev-shm-usage',
  '--disable-edgeupdater',
  '--disable-extensions',
  '--disable-features=' +
    [
      'AvoidUnnecessaryBeforeUnloadCheckSync',
      'BoundaryEventDispatchTracksNodeRemoval',
      'DestroyProfileOnBrowserClose',
      'DialMediaRouteProvider',
      'GlobalMediaControls',
      'HttpsUpgrades',
      'LensOverlay',
      'MediaRouter',
      'PaintHolding',
      'ThirdPartyStoragePartitioning',
      'BlockOriginHeaderModificationOnRedirect',
      'Translate',
      'AutoDeElevate',
      'OptimizationHints',
      'msForceBrowserSignIn',
      'msEdgeUpdateLaunchServicesPreferredVersion',
    ].join(','),
  '--enable-features=CDPScreenshotNewSurface',
  '--allow-pre-commit-input',
  '--disable-hang-monitor',
  '--disable-ipc-flooding-protection',
  '--disable-popup-blocking',
  '--disable-prompt-on-repost',
  '--disable-renderer-backgrounding',
  '--disable-updater-scheduler',
  '--force-color-profile=srgb',
  '--metrics-recording-only',
  '--no-first-run',
  '--password-store=basic',
  '--use-mock-keychain',
  '--no-service-autorun',
  '--export-tagged-pdf',
  '--disable-search-engine-choice-screen',
  '--unsafely-disable-devtools-self-xss-warnings',
  '--edge-skip-compat-layer-relaunch',
  '--disable-infobars',
  '--disable-search-engine-choice-screen',
  '--disable-sync',
];

const HEADLESS_ARGS = [
  '--headless',
  '--hide-scrollbars',
  '--mute-audio',
  '--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4',
];

/**
 * V8 flags for every renderer. These change speed, not pixels.
 *
 * - `--no-opt` turns off TurboFan. Each cold capture loads the workbench's
 *   bundle once in a fresh renderer (issue #153) and throws the process away,
 *   so optimising compiles are work no later call ever profits from.
 *   Measured on the GitHub runner, 200 Spectrum stories at concurrency 3,
 *   three repeats: 85.7 s to 80.9 s wall (-5.6%), 200 of 200 hashes
 *   identical to a run without it in every repeat. JIT tiers decide how fast
 *   script runs, not what it computes, so layout and raster see the same
 *   inputs. Also byte-identical on a loaded Mac: the examples and the
 *   150-story Chakra and 138-story Primer samples, two passes each.
 *
 * - Maglev stays on. In Chrome 151's V8 `--no-opt` leaves it running
 *   (`--trace-opt` still shows MAGLEV compiles), and adding `--no-maglev`
 *   was hash-identical but no faster on those samples, while a hot loop ran
 *   4x slower with it, so a story heavy in script would pay.
 */
export const V8_FLAGS: readonly string[] = ['--no-opt'];

const JS_FLAGS = '--js-flags=';

/** The full command line, in Playwright's order so the spike's evidence transfers. */
export function chromeArgs(opts: {
  userDataDir: string;
  args?: string[];
  headless?: boolean;
  /** Used by daemon identity to match the supervisor's launch environment. */
  env?: NodeJS.ProcessEnv;
}): string[] {
  const { headless, args } = deterministicLaunchOptions({
    headless: opts.headless,
    args: opts.args,
  });
  // Chrome keeps only the last --js-flags, so a caller's V8 flags join ours
  // in one switch rather than silently replacing them.
  const v8 = [...V8_FLAGS];
  const rest = args.filter((a) => {
    if (!a.startsWith(JS_FLAGS)) return true;
    v8.push(a.slice(JS_FLAGS.length));
    return false;
  });
  return [
    ...PARITY_CHROMIUM_ARGS,
    '--enable-unsafe-swiftshader',
    ...(headless ? HEADLESS_ARGS : []),
    '--no-sandbox',
    ...rest,
    JS_FLAGS + v8.join(' '),
    `--user-data-dir=${opts.userDataDir}`,
    (opts.env ?? process.env).JUX_CDP_JSON === '1'
      ? '--remote-debugging-pipe'
      : '--remote-debugging-pipe=cbor',
    '--no-startup-window',
  ];
}
