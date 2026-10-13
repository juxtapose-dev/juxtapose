// "Everything below the banner moved down 14px because the banner grew 14px"
// is one fact, not forty. Collapse a run of ≥3 matched elements that moved by
// the same (dx, dy), contiguous in document order, into one `shift` anchored
// on the nearest preceding element that changed in some other way.
//
// The anchor set is wider than the spec's added/removed/resized: a margin or
// line-height change moves everything after it without resizing anything the
// LCS can see, and leaving those as 40 `moved` deltas defeats the purpose.

import type { Delta } from '../../types.js';
import { compareCodeUnits, sortFacts, type Fact } from './deltas.js';

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

  // A fact's position among all moves, in document order: two members of a
  // group are adjacent exactly when no move with another displacement sits
  // between them (unmoved elements in between — sticky headers, absolutes —
  // do not break a run).
  const pos = new Map(moved.map((f, k) => [f, k]));
  const anchorOrders = anchors.map((f) => f.order); // ascending: facts are sorted
  const collapsed = new Set<Fact>();
  const shifts: Fact[] = [];
  // Deterministic: iterate groups by key, not by insertion.
  for (const key of [...groups.keys()].sort(compareCodeUnits)) {
    const g = groups.get(key)!;
    // A different move inside a group splits it rather than vetoing it: in
    // `font-size` the logo slides right between the button and the rows, and
    // the six elements below still moved up together. So does another cause
    // between two members: rows below a second removal moved because of that
    // removal, not the first, so "480 elements after the first" would blame
    // the wrong element (measured on the 50-section perf tree).
    let start = 0;
    for (let k = 1; k <= g.length; k++) {
      if (
        k < g.length &&
        pos.get(g[k])! === pos.get(g[k - 1])! + 1 &&
        !causeBetween(anchorOrders, g[k - 1].order, g[k].order)
      )
        continue;
      const run = g.slice(start, k);
      start = k;
      const shift = run.length >= MIN_RUN ? collapse(run, anchors) : undefined;
      if (!shift) continue;
      for (const f of run) collapsed.add(f);
      shifts.push(shift);
    }
  }

  if (shifts.length === 0) return facts;
  return sortFacts([...facts.filter((f) => !collapsed.has(f)), ...shifts]);
}

/** One contiguous run as a shift on the nearest preceding anchor; none
 *  before it means nothing explains the move, so it stays as moves. */
function collapse(run: Fact[], anchors: Fact[]): Fact | undefined {
  const first = run[0].order;
  const anchor = anchors.filter((f) => f.order < first).at(-1);
  if (!anchor) return undefined;
  const d = run[0].delta as Extract<Delta, { kind: 'moved' }>;
  return {
    delta: {
      kind: 'shift',
      after: 'el' in anchor.delta ? anchor.delta.el : anchor.delta.after,
      dx: d.dx,
      dy: d.dy,
      count: run.length,
    },
    rects: run.flatMap((f) => f.rects),
    abstract: anchor.abstract,
    order: anchor.order + 0.25,
  };
}

/** Some anchor sits strictly between two run members. An anchor at a
 *  member's own position (a moved row whose text also changed) is part of
 *  the run, not a new cause. */
function causeBetween(orders: number[], lo: number, hi: number): boolean {
  let a = 0;
  let b = orders.length;
  while (a < b) {
    const m = (a + b) >> 1;
    if (orders[m] <= lo) a = m + 1;
    else b = m;
  }
  return a < orders.length && orders[a] < hi;
}
