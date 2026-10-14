// Platform-neutral settling. Runs *after* the platform's own render signal
// (Platform.settle) has resolved. Everything here applies to any DOM, which is
// why it lives in core rather than in an adapter.
//
// The order, in captureStory:
//   freeze animations → platform render signal → waitForSelector →
//   event-driven idle wait (idle.ts) → delay → paint barrier → recheck
//
// The idle wait replaced a 150 ms DOM-quiet window plus a `drain` that awaited
// fonts and every incomplete image with no cap; see idle.ts for what was
// measured and why.

import type { Page } from '../browser/page.js';

/**
 * Zero out animations and transitions.
 *
 * Without this, anything mid-animation at screenshot time — spinners, skeleton
 * shimmer, fade-ins, the text caret — makes the story diff against itself on
 * every run. Stories that exist specifically to test animation opt out with
 * `animations: 'play'`.
 */
export const FREEZE_ANIMATIONS_CSS = `
*, *::before, *::after {
  animation-duration: 0s !important;
  animation-delay: 0s !important;
  animation-iteration-count: 1 !important;
  transition-duration: 0s !important;
  transition-delay: 0s !important;
  caret-color: transparent !important;
}
`;

/** Wait for an explicit selector. Escape hatch for async content the network
 *  drain can't observe — SDK init, canvas paint, third-party widgets. */
export async function waitForSelector(
  page: Page,
  selector: string,
  timeoutMs: number,
): Promise<void> {
  // Timing out is swallowed (capture what rendered); a non-CSS selector is a
  // configuration error and throws synchronously from the page before the wait.
  await page.waitForSelector(selector, { timeout: timeoutMs }).catch(() => {});
}

/**
 * Drop and rebuild every `will-change` compositor layer, so each is rastered
 * once, from the page as it stands now.
 *
 * Chrome picks a layer's raster translation (the subpixel offset its content
 * is rasterized at) when it first rasterizes the layer, and keeps it on a
 * `will-change: transform` layer so a moving transform never re-rasters. When
 * the transform changes after that first raster (an animation that ran a
 * frame before the freeze, or a `translateX(-100%)` whose width grew when a
 * font loaded) the layer keeps the old offset, and its glyph antialiasing
 * records the page's history instead of its final state. That history is
 * timing: one Chakra marquee captured 3 different hashes depending on run
 * context (issue #136), with the same frozen transform in all of them.
 *
 * A frame with `will-change: auto` composites the element into its parent;
 * removing the override makes a new layer, rastered at its current
 * transform. Measured on a translateX marquee fixture through snapPages, 40
 * captures per arm: animated 39/40 and load-delayed 40/40 differed from the
 * same page with a static transform; with this, 0/80. On the Chakra story
 * the three contexts now capture one hash, the same one a page frozen from
 * its first frame and then rebuilt this way gives. A device-scale round trip
 * and `--disable-threaded-animation` leave the stale raster; freezing
 * animations from the first frame (an init script) fixes the fixture but not
 * Chakra, whose marquee widens when its font loads. Costs ~19 ms a capture.
 *
 * A constructed stylesheet rather than a style tag: the idle detector and
 * the structure snapshot never see it. Shadow roots are not reached, as with
 * the freeze stylesheet.
 */
export async function rerasterLayers(page: Page, timeoutMs = 1000): Promise<void> {
  await page
    .evaluate(
      (cap) =>
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, cap);
          const sheet = new CSSStyleSheet();
          sheet.replaceSync('*, *::before, *::after { will-change: auto !important; }');
          document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
          // Two frames: the second is committed without the layers.
          requestAnimationFrame(() =>
            requestAnimationFrame(() => {
              document.adoptedStyleSheets = document.adoptedStyleSheets.filter(
                (s) => s !== sheet,
              );
              clearTimeout(timer);
              resolve();
            }),
          );
        }),
      timeoutMs,
    )
    .catch(() => {});
}

/**
 * Block until the compositor has actually presented a frame.
 *
 * The DOM going quiet is not the same as the pixels being final: style
 * recalculation, layout and paint still have to happen, and a screenshot taken
 * in that window catches an intermediate frame.
 *
 * This is not theoretical. Without it, repeated captures of an unchanged story
 * differed by ~12 pixels out of 480,000 — each off by exactly 1 — on the
 * antialiased edges of a rounded corner. Invisible to a human; a failed build
 * under a byte-exact hash. Measured: flaky with no wait, stable from ~50ms,
 * and stable with this barrier and no arbitrary delay at all.
 *
 * Two nested rAFs, then `requestIdleCallback`: the first rAF runs before the
 * next paint, the second after it has been committed, and the idle callback
 * gives any post-paint work a chance to drain. Cheap — a couple of frames at
 * most — and it removes the need for a blanket sleep on every story.
 */
export async function waitForPaint(page: Page, timeoutMs = 1000): Promise<void> {
  await page
    .evaluate(
      (cap) =>
        new Promise<void>((resolve) => {
          const done = () => resolve();
          const timer = setTimeout(done, cap);
          requestAnimationFrame(() =>
            requestAnimationFrame(() => {
              const finish = () => {
                clearTimeout(timer);
                done();
              };
              if (typeof requestIdleCallback === 'function') {
                requestIdleCallback(finish, { timeout: 100 });
              } else {
                finish();
              }
            }),
          );
        }),
      timeoutMs,
    )
    .catch(() => {});
}
