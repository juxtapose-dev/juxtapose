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
}): boolean {
  return !r.error && r.mismatchPixels === 0 && r.mismatchPercent === 0;
}

/** A failing story's magnitude, in words that stay true for sub-threshold changes. */
export function describeMagnitude(r: Parameters<typeof isSubThreshold>[0]): string {
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
