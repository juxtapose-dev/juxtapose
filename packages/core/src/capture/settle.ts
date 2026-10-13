// Platform-neutral settling. Runs *after* the platform's own render signal
// (Platform.settle) has resolved. Everything here applies to any DOM, which is
// why it lives in core rather than in an adapter.
//
// The ordering matters and is not arbitrary:
//   arm → platform render signal → DOM/network quiescence → fonts → images
// Arming must happen before the render is triggered, or the observer misses
// the mutations it is supposed to be watching.

import type { Page } from '../browser/page.js';

/** Quiet period with no DOM mutations and no in-flight fetches before we
 *  declare the page settled. */
export const DOM_IDLE_MS = 150;
/** Hard cap on waiting for quiescence. A story that never goes idle — a
 *  spinner that survived the CSS freeze, a polling widget — still gets
 *  captured rather than hanging the run. Kept tight: this cost is paid on
 *  every such story, times the whole suite. */
export const DOM_IDLE_TIMEOUT_MS = 500;

/**
 * Installed via evaluate before each story render. Resolves `window.__juxWait`
 * once the DOM has been mutation-free for `idleMs`, or `timeoutMs` elapses.
 *
 * Counts in-flight fetches too: a story that fires a request on mount would
 * otherwise report "idle" in the gap between mount and response, and we'd
 * screenshot the loading state — intermittently.
 */
const SETTLE_SCRIPT = `
  var done = false;
  window.__juxWait = new Promise(function (resolve) {
    var pending = 0;
    var idleTimer = null;

    function finish() {
      if (done) return;
      done = true;
      observer.disconnect();
      clearTimeout(idleTimer);
      clearTimeout(capTimer);
      if (window.__juxFetchOrig) {
        window.fetch = window.__juxFetchOrig;
        delete window.__juxFetchOrig;
      }
      resolve();
    }

    var capTimer = setTimeout(finish, timeoutMs);

    function scheduleIdle() {
      clearTimeout(idleTimer);
      if (pending === 0) idleTimer = setTimeout(finish, idleMs);
    }

    if (!window.__juxFetchOrig) {
      window.__juxFetchOrig = window.fetch;
      window.fetch = function () {
        pending++;
        clearTimeout(idleTimer);
        return window.__juxFetchOrig.apply(this, arguments).finally(function () {
          pending--;
          scheduleIdle();
        });
      };
    }

    var observer = new MutationObserver(scheduleIdle);
    observer.observe(document.documentElement, {
      childList: true, subtree: true, attributes: true, characterData: true,
    });
    scheduleIdle();
  });
`;

/** Arm the quiescence observer. Call before triggering a story render. */
export async function armSettle(page: Page): Promise<void> {
  await page
    .evaluate(
      `(function (idleMs, timeoutMs) { ${SETTLE_SCRIPT} })(${DOM_IDLE_MS}, ${DOM_IDLE_TIMEOUT_MS})`,
    )
    .catch(() => {});
}

/**
 * Await quiescence, webfonts and image decode in a single round trip.
 *
 * Deliberately one `evaluate` rather than three. At ~1.2s per story and 8
 * parallel pages, CDP round-trips are a measurable share of wall clock; the
 * original tool cut per-story time meaningfully by collapsing these.
 */
export async function drain(page: Page): Promise<void> {
  // The window cast inside is a cast, not a global Window augmentation: the
  // callback runs in the page, and declaring the hook globally would leak it
  // into core's public types. (Comments stay out here: TypeScript keeps them
  // in the callback's source, which is what the page evaluates.)
  await page
    .evaluate(async () => {
      const w = window as unknown as { __juxWait?: Promise<void> };

      await (w.__juxWait ?? Promise.resolve());

      // Webfonts: a story captured mid-swap diffs against one captured after,
      // for every glyph on the page.
      await document.fonts?.ready?.catch?.(() => {});

      // Decode, not just load — an undecoded image can still paint late.
      await Promise.all(
        Array.from(document.images).map((img) =>
          img.complete
            ? Promise.resolve()
            : new Promise<void>((r) => {
                img.addEventListener('load', () => r(), { once: true });
                img.addEventListener('error', () => r(), { once: true });
              }),
        ),
      );
    })
    .catch(() => {});
}

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
