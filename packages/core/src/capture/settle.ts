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
 * Chakra, whose marquee widens when its font loads.
 *
 * Only the elements whose computed `will-change` is not `auto` are touched,
 * through an inline `!important` declaration, in the document and in every
 * open shadow root. The first version adopted a `* { will-change: auto
 * !important }` sheet instead, and that went wrong in four measured ways:
 *  - `will-change: transform` (or filter, perspective) gives an element a
 *    containing block for fixed descendants and a stacking context. Dropping
 *    it moved those descendants to the viewport for two frames, so a latching
 *    IntersectionObserver captured "seen" 6/6, a ResizeObserver reacting
 *    through a 30 ms timer captured the wrong layout 3-4/6, and every such
 *    page took the recheck. Where the computed transform, translate and
 *    filter are all `none`, the element also gets `translate: 0px
 *    !important` for the two frames: an identity 2D transform, with no layer
 *    of its own and the same containing block. 0/6 after, and no recheck.
 *  - An adopted sheet does not reach shadow roots: a marquee in one stayed
 *    stale 4/4. 0/4 after.
 *  - An inline `will-change: transform !important` beats an author
 *    `!important` sheet: stale 4/4. 0/4 after.
 *  - Adopting any `*` sheet forces a whole-document style recalc, which by
 *    itself re-rastered a frozen fill-forwards transform animation with no
 *    will-change (Chakra button--custom-spinner) to a hash a static page
 *    never gives. Touching only will-change elements leaves those alone.
 * The writes run through `__juxIdle.untracked` (idle.ts), so the mutation
 * counter, and with it the recheck in captureStory, never sees them. Each
 * declaration is put back as it was, in the second frame or on timeout.
 * A page with no will-change element, most stories, skips the two frames:
 * 16-18 ms became the scan, 0.7 / 1.9 / 6.9 ms on 200 / 2k / 10k elements.
 *
 * Scope: this rebuilds `will-change: transform` layers. A layer promoted
 * another way (`translateZ(0)`, `translate3d`, `backdrop-filter`) or by
 * `will-change: opacity` or `filter` keeps its first raster: stale 3-4/4 when
 * it grows after that raster, before and after this. Will-change on a
 * pseudo-element is not reached either, since it takes no inline style.
 * Those need a different mechanism than a style toggle (see #145).
 */
export async function rerasterLayers(page: Page, timeoutMs = 1000): Promise<void> {
  await page
    .evaluate(
      (cap) =>
        new Promise<void>((resolve) => {
          // will-change values that give the element a containing block for
          // fixed descendants, as a transform or filter would.
          const CB = /transform|translate|rotate|scale|filter|perspective/;
          type Saved = {
            el: HTMLElement | SVGElement;
            attr: string | null;
            css: string;
            props: Array<[string, string, string]>;
          };
          const hits: Array<[HTMLElement | SVGElement, boolean]> = [];
          const visit = (root: Document | ShadowRoot) => {
            const els = root.querySelectorAll<HTMLElement | SVGElement>('*');
            for (let i = 0; i < els.length; i++) {
              const el = els[i]!;
              const cs = getComputedStyle(el);
              if (cs.willChange !== 'auto' && el.style) {
                hits.push([
                  el,
                  CB.test(cs.willChange) &&
                    cs.transform === 'none' &&
                    cs.translate === 'none' &&
                    cs.filter === 'none',
                ]);
              }
              if (el.shadowRoot) visit(el.shadowRoot);
            }
          };
          visit(document);
          if (hits.length === 0) {
            resolve();
            return;
          }
          const idle = (
            window as unknown as {
              __juxIdle?: { untracked?: (fn: () => void) => void };
            }
          ).__juxIdle;
          const quiet = (fn: () => void) => (idle?.untracked ? idle.untracked(fn) : fn());
          const saved: Saved[] = [];
          quiet(() => {
            for (const [el, keepCb] of hits) {
              const s = el.style;
              const props: Saved['props'] = [];
              const set = (prop: string, value: string) => {
                props.push([prop, s.getPropertyValue(prop), s.getPropertyPriority(prop)]);
                s.setProperty(prop, value, 'important');
              };
              const attr = el.getAttribute('style');
              const css = s.cssText;
              set('will-change', 'auto');
              if (keepCb) set('translate', '0px');
              saved.push({ el, attr, css, props });
            }
          });
          // Per declaration, so a page that wrote other inline styles in these
          // two frames keeps its writes; the attribute text itself too when
          // nothing else changed.
          let restored = false;
          const restore = () => {
            if (restored) return;
            restored = true;
            quiet(() => {
              for (const { el, attr, css, props } of saved) {
                for (const [prop, value, priority] of props) {
                  if (value) el.style.setProperty(prop, value, priority);
                  else el.style.removeProperty(prop);
                }
                if (el.style.cssText !== css) continue;
                // Read first: Chrome serializes a CSSOM-edited style attribute
                // lazily, and without this read removeAttribute was undone by
                // the next read, leaving style="".
                el.getAttribute('style');
                if (attr === null) el.removeAttribute('style');
                else el.setAttribute('style', attr);
              }
            });
          };
          const timer = setTimeout(() => {
            restore();
            resolve();
          }, cap);
          // Two frames: the second is committed without the layers.
          requestAnimationFrame(() =>
            requestAnimationFrame(() => {
              clearTimeout(timer);
              restore();
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
