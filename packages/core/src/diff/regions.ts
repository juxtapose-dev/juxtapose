// Turn a pixelmatch diff buffer into a handful of bounding boxes.
//
// Why: a one-word text change produces hundreds of disconnected changed pixels.
// Reporting those raw is useless to a human and to an agent. Merging them into
// gap-tolerant boxes turns "412 changed pixels" into "one region, at the
// heading" — which is reviewable.

import type { ChangedRegion } from '../types.js';

interface Box {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

const DEFAULT_GAP = 8;

/**
 * Is this pixel one pixelmatch marked as changed?
 *
 * Subtle and worth stating, because getting it wrong is silent: pixelmatch
 * writes the WHOLE frame into the diff buffer, not just the differences.
 * Unchanged pixels come back as the faded original at full alpha; changed
 * pixels are painted in its diff colour, red by default.
 *
 * So testing `alpha > 0` matches every pixel in the image and collapses every
 * report into one full-viewport region — which is exactly the bug this
 * replaced. Test for the red marking instead.
 */
function isChanged(diff: Buffer, offset: number): boolean {
  return diff[offset] > 200 && diff[offset + 1] < 100 && diff[offset + 2] < 100;
}

/**
 * Extract merged bounding boxes of changed pixel clusters.
 *
 * Boxes within `gap` pixels of each other merge, so antialiased edges and
 * inter-letter spacing don't fragment one logical change into many.
 */
export function computeChangedRegions(
  diff: Buffer,
  width: number,
  height: number,
  gap: number = DEFAULT_GAP,
): ChangedRegion[] {
  // Pass 1: per-row runs of changed pixels. Rows are cheap to scan and
  // collapse most of the pixel count immediately.
  const spans: { y: number; x1: number; x2: number }[] = [];
  for (let y = 0; y < height; y++) {
    let start = -1;
    for (let x = 0; x <= width; x++) {
      const changed = x < width && isChanged(diff, (y * width + x) * 4);
      if (changed && start === -1) start = x;
      else if (!changed && start !== -1) {
        spans.push({ y, x1: start, x2: x - 1 });
        start = -1;
      }
    }
  }

  // Pass 2: merge spans into boxes.
  //
  // Unlike a naive greedy merge, a span that touches several existing boxes
  // must merge *all* of them together — otherwise a change shaped like a "U"
  // reports as two regions that a later span should have joined.
  const boxes: Box[] = [];
  for (const span of spans) {
    const touched: number[] = [];
    for (let i = 0; i < boxes.length; i++) {
      if (overlaps(span, boxes[i], gap)) touched.push(i);
    }

    if (touched.length === 0) {
      boxes.push({ x1: span.x1, y1: span.y, x2: span.x2, y2: span.y });
      continue;
    }

    const target = boxes[touched[0]];
    target.x1 = Math.min(target.x1, span.x1);
    target.x2 = Math.max(target.x2, span.x2);
    target.y1 = Math.min(target.y1, span.y);
    target.y2 = Math.max(target.y2, span.y);

    // Fold any other boxes this span bridged into the first, back-to-front so
    // the splices don't shift indices we still need.
    for (let i = touched.length - 1; i >= 1; i--) {
      const other = boxes[touched[i]];
      target.x1 = Math.min(target.x1, other.x1);
      target.x2 = Math.max(target.x2, other.x2);
      target.y1 = Math.min(target.y1, other.y1);
      target.y2 = Math.max(target.y2, other.y2);
      boxes.splice(touched[i], 1);
    }
  }

  return boxes.map((b) => ({
    x: b.x1,
    y: b.y1,
    width: b.x2 - b.x1 + 1,
    height: b.y2 - b.y1 + 1,
  }));
}

function overlaps(
  span: { y: number; x1: number; x2: number },
  box: Box,
  gap: number,
): boolean {
  return (
    span.y >= box.y1 - gap &&
    span.y <= box.y2 + gap &&
    span.x1 <= box.x2 + gap &&
    span.x2 >= box.x1 - gap
  );
}
