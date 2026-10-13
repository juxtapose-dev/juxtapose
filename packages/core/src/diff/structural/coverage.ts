// Does the structure explain the pixels? A changed region is explained when
// it intersects the old or new rect of some delta's element. Coverage is by
// region area: the diff carries bounding boxes, not per-pixel membership, and
// boxes are what an agent reads back.

import type { ChangedRegion, StructureRect } from '../../types.js';
import type { Fact } from './deltas.js';

export interface Coverage {
  /** Changed regions with area; zero-area boxes carry no pixels. */
  regionCount: number;
  coverage: number;
  explained: 'full' | 'partial' | 'none';
  unexplainedRegions: ChangedRegion[];
}

export function intersects(r: ChangedRegion, rect: StructureRect): boolean {
  return (
    r.x < rect.x + rect.w &&
    r.x + r.width > rect.x &&
    r.y < rect.y + rect.h &&
    r.y + r.height > rect.y
  );
}

export function computeCoverage(regions: ChangedRegion[], facts: Fact[]): Coverage {
  // No marked regions: nothing is left unexplained. That includes a change
  // below the pixel diff's tolerance, where the deltas are the whole story.
  const real = regions.filter((r) => r.width > 0 && r.height > 0);
  if (real.length === 0)
    return { regionCount: 0, coverage: 1, explained: 'full', unexplainedRegions: [] };
  const rects = facts.flatMap((f) => f.rects);
  let total = 0;
  let explained = 0;
  const unexplainedRegions: ChangedRegion[] = [];
  for (const r of real) {
    const area = r.width * r.height;
    total += area;
    if (rects.some((rect) => intersects(r, rect))) explained += area;
    else unexplainedRegions.push(r);
  }
  const coverage = total === 0 ? 1 : Math.round((explained / total) * 1000) / 1000;
  return {
    regionCount: real.length,
    coverage,
    explained: coverage >= 0.98 ? 'full' : coverage >= 0.5 ? 'partial' : 'none',
    unexplainedRegions,
  };
}
