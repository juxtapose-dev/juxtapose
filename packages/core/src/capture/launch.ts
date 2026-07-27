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

/** Build the Playwright launch options for a reproducible capture browser. */
export function deterministicLaunchOptions(opts: LaunchOptions = {}): {
  headless: boolean;
  args: string[];
} {
  return {
    headless: opts.headless ?? true,
    args: [...DETERMINISTIC_CHROMIUM_ARGS, ...(opts.args ?? [])],
  };
}
