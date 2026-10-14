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

/** The full command line, in Playwright's order so the spike's evidence transfers. */
export function chromeArgs(opts: {
  userDataDir: string;
  args?: string[];
  headless?: boolean;
}): string[] {
  const { headless, args } = deterministicLaunchOptions({
    headless: opts.headless,
    args: opts.args,
  });
  return [
    ...PARITY_CHROMIUM_ARGS,
    '--enable-unsafe-swiftshader',
    ...(headless ? HEADLESS_ARGS : []),
    '--no-sandbox',
    ...args,
    `--user-data-dir=${opts.userDataDir}`,
    '--remote-debugging-pipe',
    '--no-startup-window',
  ];
}
