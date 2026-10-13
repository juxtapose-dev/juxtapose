// Which failing stories changed the same way. The verdict's signature
// already abstracts the element to role|tag and keeps the values, so "every
// button background #2563eb→#1d4ed8" hashes alike on every page that made
// that change; grouping is a bucket sort on it. Cold path: runs once per
// report, after every story is judged.

import { compareCodeUnits } from '../diff/structural/deltas.js';
import type { DiffResult, RunGroup } from '../types.js';

export function computeGroups(results: DiffResult[]): RunGroup[] {
  const bySignature = new Map<string, { ids: string[]; first: string; change: string }>();
  for (const r of results) {
    // A verdict with no deltas has a signature that depends on the
    // classification alone: unrelated identical, drifting or resized
    // stories would "share" it, and there is no change to state.
    if (r.status !== 'fail' || !r.structural || r.structural.deltaCount === 0) continue;
    const { signature, change, summary } = r.structural;
    const text = change ?? summary;
    const g = bySignature.get(signature);
    if (!g)
      bySignature.set(signature, { ids: [r.storyId], first: r.storyId, change: text });
    else {
      g.ids.push(r.storyId);
      // The wording of the first story in code-unit order, whatever the
      // input order: two verdicts of one signature can word it differently.
      if (compareCodeUnits(r.storyId, g.first) < 0) {
        g.first = r.storyId;
        g.change = text;
      }
    }
  }
  // Collected through a Map, emitted through a sort: insertion order never
  // reaches the report.
  const groups: RunGroup[] = [];
  for (const [signature, g] of bySignature) {
    if (g.ids.length < 2) continue;
    const storyIds = [...g.ids].sort(compareCodeUnits);
    groups.push({
      signature,
      summary: `${g.change} — ${storyIds.length} stories`,
      storyIds,
    });
  }
  return groups.sort(
    (x, y) =>
      y.storyIds.length - x.storyIds.length || compareCodeUnits(x.signature, y.signature),
  );
}
