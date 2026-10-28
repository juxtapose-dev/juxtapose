import type { LayoutBox, RgbaImage } from './index.js';

const MAX_PROPOSALS = 12;
const MAX_OBSERVATIONS = 3;
const MAX_VERIFIED_PIXELS = 4_000_000;
const SAMPLE_STEP = 8;
const RULE =
  'unique sampled match within the stated integer search window; every RGBA byte of the entire reported rectangle then equal; no component identity or CSS cause';

export interface ExactDisplacementObservation {
  currentBox: LayoutBox;
  referenceBox: LayoutBox;
  /** Current minus reference; positive dy means these current pixels are lower. */
  dx: number;
  dy: number;
  pixelsCompared: number;
  provenance: 'measured-from-pixels';
  confidenceRule: 'exact-translation-1';
}
interface Proposal {
  box: LayoutBox;
  changed: number;
  distinct: number;
}

/** First-draft map pixels were exactly 1px low, but a hand-picked crop is not
 * an automatic diagnostic. Propose textured changed tiles across the frame,
 * reject sampling ambiguity, and verify every reported byte. No DOM is needed. */
export function findExactDisplacements(
  reference: RgbaImage,
  current: RgbaImage,
  options: { radius?: number } = {},
) {
  for (const image of [reference, current])
    if (
      !Number.isSafeInteger(image.width) ||
      !Number.isSafeInteger(image.height) ||
      image.width < 1 ||
      image.height < 1 ||
      image.data.length !== image.width * image.height * 4
    )
      throw new Error('exact displacement requires valid RGBA extent');
  if (reference.width !== current.width || reference.height !== current.height)
    throw new Error('exact displacement requires equal image extents');
  const radius = options.radius ?? 8;
  if (!Number.isInteger(radius) || radius < 1 || radius > 64)
    throw new Error('displacement radius must be an integer from 1 to 64');
  const { width, height } = current;
  const tileSize = Math.min(
    128,
    Math.floor((Math.min(width, height) - 2 * radius) / 64) * 64,
  );
  const stats = {
    proposed: 0,
    searched: 0,
    ambiguous: 0,
    noCandidate: 0,
    verificationRejected: 0,
    verificationPixelBudgetUsed: 0,
    omittedProposals: 0,
    omittedObservations: 0,
    verificationBudgetReached: false,
    coveredProposals: 0,
  };
  const observations: ExactDisplacementObservation[] = [];
  const output = () => ({
    schema: 'juxtapose.exact-displacement/v1' as const,
    status: observations.length ? ('measured' as const) : ('abstained' as const),
    ...(!observations.length
      ? {
          reason:
            width * height > 16_777_216
              ? 'frame-budget'
              : tileSize < 64
                ? 'small-extent'
                : !stats.proposed
                  ? 'no-eligible-region'
                  : 'no-unique-byte-equal-region',
        }
      : {}),
    meaning:
      'Exact translated pixels within reported rectangles only. No whole-element/page identity, CSS cause or visual verdict.',
    searchRadius: radius,
    sampleStep: SAMPLE_STEP,
    tileSize: Math.max(0, tileSize),
    confidenceRules: { 'exact-translation-1': RULE },
    observations,
    stats,
  });
  if (tileSize < 64 || width * height > 16_777_216) return output();
  const anchors = (extent: number) => {
    const values: number[] = [],
      last = extent - radius - tileSize;
    for (let x = radius; x <= last; x += tileSize) values.push(x);
    if (values.at(-1) !== last) values.push(last);
    return values;
  };
  const equalPixel = (a: number, b: number) =>
    current.data[a] === reference.data[b] &&
    current.data[a + 1] === reference.data[b + 1] &&
    current.data[a + 2] === reference.data[b + 2] &&
    current.data[a + 3] === reference.data[b + 3];
  const proposals: Proposal[] = [];
  for (const y of anchors(height))
    for (const x of anchors(width)) {
      let changed = 0;
      const colors = new Set<number>();
      for (let yy = 0; yy < tileSize; yy += SAMPLE_STEP)
        for (let xx = 0; xx < tileSize; xx += SAMPLE_STEP) {
          const i = ((y + yy) * width + x + xx) * 4;
          if (current.data[i + 3] === 0 && reference.data[i + 3] === 0) continue;
          if (!equalPixel(i, i)) changed++;
          if (current.data[i + 3] !== 0)
            colors.add(
              ((current.data[i]! << 24) |
                (current.data[i + 1]! << 16) |
                (current.data[i + 2]! << 8) |
                current.data[i + 3]!) >>>
                0,
            );
        }
      if (changed >= 2 && colors.size >= 8)
        proposals.push({
          box: { x, y, width: tileSize, height: tileSize },
          changed,
          distinct: colors.size,
        });
    }
  proposals.sort(
    (a, b) =>
      b.changed - a.changed ||
      b.distinct - a.distinct ||
      a.box.y - b.box.y ||
      a.box.x - b.box.x,
  );
  stats.proposed = proposals.length;
  // On the 60-proposal website case, a spatial heuristic returned the same
  // region as the twelve highest-ranked tiles. Keep the simpler bounded scan.
  const chosen = proposals.slice(0, MAX_PROPOSALS);
  stats.omittedProposals = proposals.length - chosen.length;
  const verify = (box: LayoutBox, dx: number, dy: number): boolean => {
    const pixels = box.width * box.height;
    if (stats.verificationPixelBudgetUsed + pixels > MAX_VERIFIED_PIXELS) {
      stats.verificationBudgetReached = true;
      return false;
    }
    stats.verificationPixelBudgetUsed += pixels;
    for (let y = 0; y < box.height; y++)
      for (let x = 0; x < box.width; x++)
        if (
          !equalPixel(
            ((box.y + y) * width + box.x + x) * 4,
            ((box.y + y + dy) * width + box.x + x + dx) * 4,
          )
        )
          return false;
    return true;
  };
  for (const proposal of chosen) {
    const box = proposal.box;
    if (
      observations.some(
        ({ currentBox: a }) =>
          box.x >= a.x &&
          box.y >= a.y &&
          box.x + box.width <= a.x + a.width &&
          box.y + box.height <= a.y + a.height,
      )
    ) {
      stats.coveredProposals++;
      continue;
    }
    stats.searched++;
    const matches: Array<{ dx: number; dy: number }> = [];
    search: for (let dy = -radius; dy <= radius; dy++)
      for (let dx = -radius; dx <= radius; dx++) {
        let equal = true;
        samples: for (let y = 0; y < box.height; y += SAMPLE_STEP)
          for (let x = 0; x < box.width; x += SAMPLE_STEP)
            if (
              !equalPixel(
                ((box.y + y) * width + box.x + x) * 4,
                ((box.y + y + dy) * width + box.x + x + dx) * 4,
              )
            ) {
              equal = false;
              break samples;
            }
        if (equal) {
          matches.push({ dx, dy });
          if (matches.length > 1) break search;
        }
      }
    if (!matches.length) {
      stats.noCandidate++;
      continue;
    }
    if (matches.length > 1) {
      stats.ambiguous++;
      continue;
    }
    const offset = matches[0]!;
    if (!offset.dx && !offset.dy) continue;
    if (!verify(box, offset.dx, offset.dy)) {
      stats.verificationRejected++;
      continue;
    }
    let merged = false;
    for (const observation of observations) {
      if (observation.dx !== 0 - offset.dx || observation.dy !== 0 - offset.dy) continue;
      const a = observation.currentBox;
      const union = {
        x: Math.min(a.x, box.x),
        y: Math.min(a.y, box.y),
        width: Math.max(a.x + a.width, box.x + box.width) - Math.min(a.x, box.x),
        height: Math.max(a.y + a.height, box.y + box.height) - Math.min(a.y, box.y),
      };
      if (!verify(union, offset.dx, offset.dy)) continue;
      observation.currentBox = union;
      observation.referenceBox = {
        ...union,
        x: union.x + offset.dx,
        y: union.y + offset.dy,
      };
      observation.pixelsCompared = union.width * union.height;
      merged = true;
      break;
    }
    if (!merged)
      observations.push({
        currentBox: box,
        referenceBox: { ...box, x: box.x + offset.dx, y: box.y + offset.dy },
        dx: 0 - offset.dx,
        dy: 0 - offset.dy,
        pixelsCompared: box.width * box.height,
        provenance: 'measured-from-pixels',
        confidenceRule: 'exact-translation-1',
      });
  }
  for (let i = observations.length - 1; i >= 0; i--) {
    const a = observations[i]!;
    if (
      observations.some(
        (b, j) =>
          j !== i &&
          a.dx === b.dx &&
          a.dy === b.dy &&
          a.currentBox.x >= b.currentBox.x &&
          a.currentBox.y >= b.currentBox.y &&
          a.currentBox.x + a.currentBox.width <= b.currentBox.x + b.currentBox.width &&
          a.currentBox.y + a.currentBox.height <= b.currentBox.y + b.currentBox.height,
      )
    )
      observations.splice(i, 1);
  }
  observations.sort(
    (a, b) =>
      b.pixelsCompared - a.pixelsCompared ||
      a.currentBox.y - b.currentBox.y ||
      a.currentBox.x - b.currentBox.x ||
      a.dy - b.dy ||
      a.dx - b.dx,
  );
  stats.omittedObservations = Math.max(0, observations.length - MAX_OBSERVATIONS);
  observations.splice(MAX_OBSERVATIONS);
  return output();
}
