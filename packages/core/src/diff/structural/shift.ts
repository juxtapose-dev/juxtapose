// "Everything below the banner moved down 14px because the banner grew 14px"
// is one fact, not forty. Collapse a run of ≥3 matched elements that moved by
// the same (dx, dy), contiguous in document order, into one `shift` anchored
// on the nearest preceding element that changed in some other way.
//
// The anchor set is wider than the spec's added/removed/resized: a margin or
// line-height change moves everything after it without resizing anything the
// LCS can see, and leaving those as 40 `moved` deltas defeats the purpose.

import type { Delta } from '../../types.js';
import { sortFacts, type Fact } from './deltas.js';

const MIN_RUN = 3;

export function synthesizeShifts(facts: Fact[]): Fact[] {
  const anchors = facts.filter(
    (f) => f.delta.kind !== 'moved' && f.delta.kind !== 'shift',
  );
  const moved = facts.filter((f) => f.delta.kind === 'moved');
  if (moved.length < MIN_RUN) return facts;

  // Group by displacement, keeping document order within a group.
  const groups = new Map<string, Fact[]>();
  for (const f of moved) {
    const d = f.delta as Extract<Delta, { kind: 'moved' }>;
    const key = `${d.dx},${d.dy}`;
    const g = groups.get(key);
    if (g) g.push(f);
    else groups.set(key, [f]);
  }

  const collapsed = new Set<Fact>();
  const shifts: Fact[] = [];
  // Deterministic: iterate groups by key, not by insertion.
  for (const key of [...groups.keys()].sort()) {
    const g = groups.get(key)!;
    if (g.length < MIN_RUN) continue;
    const first = g[0].order;
    const last = g[g.length - 1].order;
    // Contiguous: no element with a *different* non-zero move sits inside the
    // run. Unmoved elements inside it (sticky headers, absolutes) are fine.
    const intruder = moved.some(
      (f) => !g.includes(f) && f.order > first && f.order < last,
    );
    if (intruder) continue;
    const anchor = anchors.filter((f) => f.order < first).at(-1);
    if (!anchor) continue;
    const d = g[0].delta as Extract<Delta, { kind: 'moved' }>;
    for (const f of g) collapsed.add(f);
    shifts.push({
      delta: {
        kind: 'shift',
        after: 'el' in anchor.delta ? anchor.delta.el : anchor.delta.after,
        dx: d.dx,
        dy: d.dy,
        count: g.length,
      },
      rects: g.flatMap((f) => f.rects),
      abstract: anchor.abstract,
      order: anchor.order + 0.25,
    });
  }

  if (shifts.length === 0) return facts;
  return sortFacts([...facts.filter((f) => !collapsed.has(f)), ...shifts]);
}
