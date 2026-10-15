import type { DiffResult } from '../types.js';

/** These are successful comparisons, not byte-identical captures or approvals. */
export function describeVisualEquivalence(results: readonly DiffResult[]): string {
  const equivalent = results.filter((r) => r.status === 'pass' && r.comparison);
  if (!equivalent.length) return '';
  return [
    `${equivalent.length} capture(s) passed by visual equivalence, not exact hash. Approved baselines are unchanged.`,
    ...equivalent.map(
      (r) =>
        `${r.storyId}: Pixelmatch ${r.comparison!.version} threshold ${r.comparison!.threshold}, antialias filtering; ${r.comparison!.rawMismatchPixels} exact pixel differences, 0 after filtering.`,
    ),
  ].join('\n');
}
