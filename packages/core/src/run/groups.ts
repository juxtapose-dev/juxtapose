// Which failing stories changed the same way. The verdict's signature
// already abstracts the element to role|tag and keeps the values, so "every
// button background #2563eb→#1d4ed8" hashes alike on every page that made
// that change; grouping is a bucket sort on it. Cold path: runs once per
// report, after every story is judged.

import { compareCodeUnits } from '../diff/structural/deltas.js';
import type { DiffResult, RunGroup } from '../types.js';

export function computeGroups(results: DiffResult[]): RunGroup[] {
  const bySignature = new Map<
    string,
    { ids: string[]; summaries: Map<string, string> }
  >();
  for (const r of results) {
    if (r.status !== 'fail' || !r.structural) continue;
    const { signature, summary } = r.structural;
    let g = bySignature.get(signature);
    if (!g) bySignature.set(signature, (g = { ids: [], summaries: new Map() }));
    g.ids.push(r.storyId);
    g.summaries.set(r.storyId, summary);
  }
  // Collected through a Map, emitted through a sort: insertion order never
  // reaches the report.
  const groups: RunGroup[] = [];
  for (const [signature, g] of bySignature) {
    if (g.ids.length < 2) continue;
    const storyIds = [...g.ids].sort(compareCodeUnits);
    groups.push({ signature, summary: g.summaries.get(storyIds[0])!, storyIds });
  }
  return groups.sort(
    (x, y) =>
      y.storyIds.length - x.storyIds.length || compareCodeUnits(x.signature, y.signature),
  );
}
