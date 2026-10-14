// How the mismatch number is written, everywhere it is written.
//
// Shared rather than copied because it is a product rule, not a formatter: a
// real change displaying as "0.00%" reads as a tool bug, so anything below the
// rounding floor says "<0.01%" instead. Five call sites had their own copy.

/** Never show "0.00%" next to the word "changed" — it reads as a tool bug. */
export function formatPercent(pct: number): string {
  if (pct >= 0.01) return `${pct.toFixed(2)}%`;
  return pct > 0 ? '<0.01%' : '0%';
}

/** Regions at most this many px thick on their short side are hairs. */
const NOISE_MAX_THICKNESS = 3;
/** Under this much of the frame differing, a change can still be real: a
 *  font-size, colour, icon or border change routinely lands here. */
export const SMALL_MISMATCH_PERCENT = 0.1;

/**
 * The only evidence on which a surface may call a change rendering noise.
 *
 * Pass/fail is a byte-exact hash, so a small mismatch percentage means a
 * small element changed, not that nothing did. Noise needs POSITIVE structural
 * evidence: both snapshots exist, the structural diff found no element that
 * moved, resized or changed text or style (`render-drift`, no deltas), and
 * every changed region is a thin hairline, the shape antialiasing leaves.
 * A missing snapshot, a delta, a fat region or no regions at all is not
 * evidence; it is "unexplained" and a reader must look.
 */
export function isLikelyRenderingNoise(r: {
  mismatchPercent: number;
  changedRegions: { width: number; height: number }[];
  structural?: {
    classification: string;
    deltaCount: number;
    flags: readonly string[];
  };
}): boolean {
  const v = r.structural;
  if (!v) return false;
  if (v.classification !== 'render-drift' || v.deltaCount > 0) return false;
  if (v.flags.includes('no-baseline-structure')) return false;
  if (v.flags.includes('no-current-structure')) return false;
  if (r.mismatchPercent >= SMALL_MISMATCH_PERCENT) return false;
  return (
    r.changedRegions.length > 0 &&
    r.changedRegions.every((c) => Math.min(c.width, c.height) <= NOISE_MAX_THICKNESS)
  );
}

/**
 * A failure the pixel diff cannot show.
 *
 * Pass/fail is a byte hash; the percentage comes from pixelmatch, which
 * tolerates small colour deltas. A brand colour nudge (#2563eb -> #1d4ed8 on
 * the example Button) fails the hash yet marks zero pixels, and every surface
 * printed "0%" for it: the change a reviewer most needs to look at, labelled
 * as no change. Excludes a crashed capture (it carries `error`, also at 0%)
 * and a dimension change (100%). Structural rather than DiffResult-typed so
 * this module stays importable from the browser.
 */
export function isSubThreshold(r: {
  mismatchPixels: number;
  mismatchPercent: number;
  error?: string;
  baselineImage?: 'unavailable';
}): boolean {
  // No pixel diff ran when the image is unavailable, so "0 pixels marked"
  // says nothing about subtlety.
  return (
    !r.error &&
    r.baselineImage !== 'unavailable' &&
    r.mismatchPixels === 0 &&
    r.mismatchPercent === 0
  );
}

/**
 * The one sentence every surface (run output, PR comment, handoff, HTML
 * report, addon) uses when a story failed its hash but the approved image is
 * not on this machine. Images are never committed, so this is the normal state
 * of a fresh clone or a CI job with a cold cache, not a fault.
 */
export const BASELINE_IMAGE_UNAVAILABLE =
  'baseline image not available (not in cache); structure diff only';

/** A failing story's magnitude, in words that stay true for sub-threshold changes. */
export function describeMagnitude(r: Parameters<typeof isSubThreshold>[0]): string {
  if (r.baselineImage === 'unavailable') return BASELINE_IMAGE_UNAVAILABLE;
  return isSubThreshold(r)
    ? 'subtle change, diff marks no pixels'
    : `${formatPercent(r.mismatchPercent)} changed`;
}

/** The fields a capture's label is made of. Structural so the addon can use
 *  it on what it fetched without importing core's types. */
export interface CaptureRef {
  storyId: string;
  baseStoryId?: string;
  variant?: string;
}

/** `button--primary · dark` for a variant, the bare id for a default capture. */
export function captureLabel(r: CaptureRef): string {
  return r.variant !== undefined && r.baseStoryId !== undefined
    ? `${r.baseStoryId} · ${r.variant}`
    : r.storyId;
}

/** How many distinct stories a set of captures covers. */
export function countStories(results: readonly CaptureRef[]): number {
  return new Set(results.map((r) => r.baseStoryId ?? r.storyId)).size;
}

/** Whether any of these captures is a variant: the cue to say "captures"
 *  rather than "stories", so output without variants reads as it always has. */
export const hasVariants = (results: readonly CaptureRef[]): boolean =>
  results.some((r) => r.variant !== undefined);

/** Byte-identical output across machines needs a locale-free order;
 *  `localeCompare` is not one. */
export const compareCodeUnits = (a: string, b: string): number =>
  a < b ? -1 : a > b ? 1 : 0;
