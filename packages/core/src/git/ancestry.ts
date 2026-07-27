// Git ancestry, memoized.
//
// `git merge-base --is-ancestor` forks a process at ~40ms. Most stories in a
// run share a handful of baseline commits, so caching by commit takes this from
// O(stories) forks to O(distinct commits) — roughly 30s to 50ms on a
// 738-story suite. The memoization is not an optimization detail; without it
// the stale check is unaffordable and would get dropped.

import { execFileSync } from 'node:child_process';
import type { AncestryCheck } from '../baseline/status.js';

const SHA_RE = /^[0-9a-f]{40}$/i;

export function createAncestryCheck(cwd: string): AncestryCheck {
  const cache = new Map<string, boolean>();

  return {
    isAncestor(commit: string): boolean {
      // Sentinels like "unknown" predate proper commit tracking. Treat them as
      // valid rather than marking every such baseline stale.
      if (!SHA_RE.test(commit)) return true;

      const hit = cache.get(commit);
      if (hit !== undefined) return hit;

      let result: boolean;
      try {
        execFileSync('git', ['merge-base', '--is-ancestor', commit, 'HEAD'], {
          cwd,
          stdio: 'ignore',
        });
        result = true;
      } catch {
        // Non-zero exit means "not an ancestor". It also means "unknown commit"
        // — e.g. a shallow clone that lacks the object. Both should read as
        // stale: we cannot prove the baseline is reachable from HEAD.
        result = false;
      }

      cache.set(commit, result);
      return result;
    },
  };
}

/** Ancestry check that passes everything. For non-git checkouts, where
 *  staleness is unknowable and blocking on it would be wrong. */
export const alwaysAncestor: AncestryCheck = { isAncestor: () => true };
