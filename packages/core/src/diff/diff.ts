// Pixel diff — the COLD path.
//
// This only runs for stories that already failed the hash check in
// baseline/status.ts. It explains mismatches and supplies the pixel count for
// the explicit visual-equivalence policy in run/run.ts.
//
// Consequence worth keeping in mind while optimizing: on a green run this
// module never executes. Effort spent here pays off only in proportion to how
// broken the run already is.

import sharp from 'sharp';
import pixelmatch from 'pixelmatch';
import type { ChangedRegion, StoryParams, ProjectConfig } from '../types.js';
import {
  computeChangedRegions,
  computeChangedRegionsWithCounts,
  type CountedRegion,
} from './regions.js';
import { visibleColorPairs, type VisibleColorEvidence } from './color-pairs.js';

const DEFAULT_THRESHOLD = 0.1;
const DEFAULT_MIN_DIFF_PERCENT = 0;

export interface DiffOutput {
  mismatchPixels: number;
  /** Exact differing pixels before perceptual/antialias filtering. */
  rawMismatchPixels?: number;
  mismatchPercent: number;
  changedRegions: ChangedRegion[];
  /** Only when requested: regions ranked by exact marked-pixel count. */
  rankedChangedRegions?: CountedRegion[];
  /** WebP overlay marking changed pixels. Absent when nothing changed. */
  diffImage?: Buffer;
  /** True when dimensions differ — no pixel comparison was possible. */
  dimensionMismatch: boolean;
  /** Optional sampled pixel evidence for design-reference feedback. */
  visibleColors?: VisibleColorEvidence;
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
  opts: {
    threshold?: number;
    minDiffPercent?: number;
    includeVisibleColors?: boolean;
    /** Rank marked-pixel regions without sampling color pairs. */
    includeRegionCounts?: boolean;
  } = {},
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
  let rawMismatchPixels = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    if (
      a.data[i] !== b.data[i] ||
      a.data[i + 1] !== b.data[i + 1] ||
      a.data[i + 2] !== b.data[i + 2] ||
      a.data[i + 3] !== b.data[i + 3]
    )
      rawMismatchPixels++;
  }
  const diff = Buffer.alloc(width * height * 4);
  const mismatchPixels = pixelmatch(a.data, b.data, diff, width, height, {
    threshold,
    includeAA: false,
    diffMask: opts.includeVisibleColors || opts.includeRegionCounts || false,
  });
  const mismatchPercent = (mismatchPixels / (width * height)) * 100;
  const visibleColors = opts.includeVisibleColors
    ? visibleColorPairs(a.data, b.data, diff, width, height)
    : undefined;

  if (mismatchPixels === 0 || mismatchPercent < minDiffPercent) {
    return {
      mismatchPixels,
      rawMismatchPixels,
      mismatchPercent,
      changedRegions: [],
      dimensionMismatch: false,
      ...(visibleColors ? { visibleColors } : {}),
    };
  }

  // Lossless: the overlay is a sparse mask of flat colour, which lossless
  // compresses better than lossy anyway, and blurring the marked pixels would
  // defeat the point of the image.
  const diffImagePromise = sharp(diff, { raw: { width, height, channels: 4 } })
    .webp({ lossless: true, effort: 0 })
    .toBuffer();

  const counted =
    opts.includeVisibleColors || opts.includeRegionCounts
      ? computeChangedRegionsWithCounts(diff, width, height)
      : undefined;
  const changedRegions = counted
    ? counted.map(({ changedPixels: _changedPixels, ...region }) => region)
    : computeChangedRegions(diff, width, height);
  const rankedChangedRegions = counted
    ? [...counted].sort(
        (a, b) => b.changedPixels - a.changedPixels || a.y - b.y || a.x - b.x,
      )
    : undefined;
  const diffImage = await diffImagePromise;
  return {
    mismatchPixels,
    rawMismatchPixels,
    mismatchPercent,
    changedRegions,
    ...(rankedChangedRegions ? { rankedChangedRegions } : {}),
    diffImage,
    dimensionMismatch: false,
    ...(visibleColors ? { visibleColors } : {}),
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
