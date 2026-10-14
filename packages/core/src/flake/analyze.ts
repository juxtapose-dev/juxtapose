// Turn two captures of one story into observations, then classify them.
//
// Cold path, like diff/: it runs only for a story whose two captures already
// differ (the recheck in run/, or `jux diff --runs`), and it reads what the
// captures already recorded. It asks the browser for nothing, so it cannot
// move a pixel.

import { diffImages } from '../diff/diff.js';
import { computeFacts } from '../diff/structural/deltas.js';
import { matchElements } from '../diff/structural/match.js';
import type {
  CaptureFlag,
  ChangedRegion,
  Flake,
  SettleReport,
  StructureRect,
  StructureSnapshot,
} from '../types.js';
import {
  classifyFlake,
  type ExternalHit,
  type NetworkCoverage,
  type OneSidedElement,
  type TextChange,
} from './classify.js';
import { selectorFor } from './selector.js';

/** One capture of the story: what the run kept of it. */
export interface FlakeCapture {
  image: Buffer;
  structure?: StructureSnapshot;
  settle?: SettleReport;
  flags?: CaptureFlag[];
}

export interface FlakeAnalysisInput {
  storyId: string;
  first: FlakeCapture;
  second: FlakeCapture;
  /** What the story's network config already answers; none when unknown. */
  covered?: NetworkCoverage;
  /** `freshRenderer` is effective for this run; leave undefined when unknown. */
  freshRenderer?: boolean;
}

/** Longest changed text kept in the evidence. */
const MAX_TEXT = 80;
const clip = (s: string) => (s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT - 1)}…` : s);

const area = (r: StructureRect) => Math.max(0, r.w) * Math.max(0, r.h);

/** Pixels of `rect` inside any of the regions. Regions are disjoint boxes of
 *  separate clusters, so their intersections add up. */
function overlapWith(rect: StructureRect, regions: ChangedRegion[]): number {
  let total = 0;
  for (const r of regions) {
    const w = Math.min(rect.x + rect.w, r.x + r.width) - Math.max(rect.x, r.x);
    const h = Math.min(rect.y + rect.h, r.y + r.height) - Math.max(rect.y, r.y);
    if (w > 0 && h > 0) total += w * h;
  }
  return total;
}

function externalHits(
  s: StructureSnapshot | undefined,
  regions: ChangedRegion[],
): ExternalHit[] {
  if (!s) return [];
  const out: ExternalHit[] = [];
  s.elements.forEach((el, i) => {
    if (!el.external) return;
    const overlap = overlapWith(el.rect, regions);
    if (overlap === 0) return;
    const selector = selectorFor(s, i);
    for (const ref of el.external) out.push({ selector, ref, overlap });
  });
  return out;
}

export async function analyzeFlake(input: FlakeAnalysisInput): Promise<Flake> {
  const { storyId, first, second } = input;
  // Threshold 0: the two images are known to differ by hash, so any pixel that
  // differs is evidence. The default tolerance exists to quiet a review diff.
  const pixels = await diffImages(first.image, second.image, { threshold: 0 });
  const a = first.structure;
  const b = second.structure;
  // Structures taken at different sizes, or cut short, cannot be matched
  // element by element; the pixel and settle evidence still stands.
  const comparable =
    a !== undefined &&
    b !== undefined &&
    !pixels.dimensionMismatch &&
    a.viewport.width === b.viewport.width &&
    a.viewport.height === b.viewport.height;

  const textChanges: TextChange[] = [];
  const oneSided: OneSidedElement[] = [];
  if (comparable) {
    const match = matchElements(a, b);
    for (const f of computeFacts(a, b, match)) {
      if (f.delta.kind !== 'text') continue;
      textChanges.push({
        selector: selectorFor(a, f.source.index),
        before: clip(f.delta.from),
        after: clip(f.delta.to),
      });
    }
    if (!a.truncated && !b.truncated) {
      for (const i of match.removed)
        oneSided.push({
          selector: selectorFor(a, i),
          presentIn: 'first',
          area: area(a.elements[i]!.rect),
        });
      for (const j of match.added)
        oneSided.push({
          selector: selectorFor(b, j),
          presentIn: 'second',
          area: area(b.elements[j]!.rect),
        });
    }
  }

  const settlePending = [first.settle, second.settle]
    .filter((s): s is SettleReport => s?.status === 'timeout')
    .flatMap((s) => s.pending);
  const flags = [...new Set([...(first.flags ?? []), ...(second.flags ?? [])])].sort();

  return classifyFlake({
    storyId,
    settlePending: [...new Set(settlePending)],
    flags,
    reused: (['first', 'second'] as const).filter((side) =>
      input[side].flags?.includes('renderer-reused'),
    ),
    ...(input.freshRenderer !== undefined
      ? { freshRendererOn: input.freshRenderer }
      : {}),
    mismatchPercent: pixels.mismatchPercent,
    structureIdentical:
      a !== undefined && b !== undefined && a.structureHash === b.structureHash,
    // Either capture's element can be the one that changed: an image that
    // appeared in only one is still where the pixels moved.
    externals: [
      ...externalHits(a, pixels.changedRegions),
      ...externalHits(b, pixels.changedRegions),
    ],
    textChanges,
    oneSided,
    covered: input.covered ?? { images: false, frames: false },
  });
}
