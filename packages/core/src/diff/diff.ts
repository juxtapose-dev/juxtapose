// Pixel diff — the COLD path.
//
// This only runs for stories that already failed the hash check in
// baseline/status.ts. It decides nothing; it exists to turn "these bytes
// differ" into something a reviewer or an agent can act on.
//
// Consequence worth keeping in mind while optimizing: on a green run this
// module never executes. Effort spent here pays off only in proportion to how
// broken the run already is.

import sharp from 'sharp';
import pixelmatch from 'pixelmatch';
import type { ChangedRegion, StoryParams, ProjectConfig } from '../types.js';
import { computeChangedRegions } from './regions.js';

const DEFAULT_THRESHOLD = 0.1;
const DEFAULT_MIN_DIFF_PERCENT = 0;

export interface DiffOutput {
  mismatchPixels: number;
  mismatchPercent: number;
  changedRegions: ChangedRegion[];
  /** WebP overlay marking changed pixels. Absent when nothing changed. */
  diffImage?: Buffer;
  /** True when dimensions differ — no pixel comparison was possible. */
  dimensionMismatch: boolean;
}

/**
 * Compare two encoded images.
 *
 * `threshold` is pixelmatch's YIQ colour-distance tolerance (0-1), not a
 * pixel count. `includeAA: false` makes pixelmatch detect and exclude
 * antialiased pixels, which is what keeps sub-pixel text rendering from
 * dominating every diff.
 */
export async function diffImages(
  baseline: Buffer,
  current: Buffer,
  opts: { threshold?: number; minDiffPercent?: number } = {},
): Promise<DiffOutput> {
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
  const minDiffPercent = opts.minDiffPercent ?? DEFAULT_MIN_DIFF_PERCENT;

  // sharp sniffs the format, so baselines can be WebP and current can be PNG
  // without an explicit conversion step.
  const [a, b] = await Promise.all([
    sharp(baseline).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
    sharp(current).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
  ]);

  if (a.info.width !== b.info.width || a.info.height !== b.info.height) {
    // No meaningful pixel comparison exists across different dimensions.
    // Report it as total change rather than inventing a number.
    return {
      mismatchPixels: 0,
      mismatchPercent: 100,
      changedRegions: [],
      dimensionMismatch: true,
    };
  }

  const { width, height } = b.info;
  const diff = Buffer.alloc(width * height * 4);
  const mismatchPixels = pixelmatch(a.data, b.data, diff, width, height, {
    threshold,
    includeAA: false,
  });
  const mismatchPercent = (mismatchPixels / (width * height)) * 100;

  if (mismatchPixels === 0 || mismatchPercent < minDiffPercent) {
    return {
      mismatchPixels,
      mismatchPercent,
      changedRegions: [],
      dimensionMismatch: false,
    };
  }

  const diffImage = await sharp(diff, { raw: { width, height, channels: 4 } })
    .webp({ quality: 90, effort: 0 })
    .toBuffer();

  return {
    mismatchPixels,
    mismatchPercent,
    changedRegions: computeChangedRegions(diff, width, height),
    diffImage,
    dimensionMismatch: false,
  };
}

/** Story params override project config override the built-in default. */
export function resolveThreshold(
  params: StoryParams | undefined,
  config: ProjectConfig | undefined,
): number {
  return clamp(
    firstFinite(params?.threshold, config?.threshold, DEFAULT_THRESHOLD),
    0,
    1,
  );
}

export function resolveMinDiffPercent(
  params: StoryParams | undefined,
  config: ProjectConfig | undefined,
): number {
  return clamp(
    firstFinite(params?.minDiffPercent, config?.minDiffPercent, DEFAULT_MIN_DIFF_PERCENT),
    0,
    100,
  );
}

function firstFinite(...values: (number | undefined)[]): number {
  for (const v of values) {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return 0;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
