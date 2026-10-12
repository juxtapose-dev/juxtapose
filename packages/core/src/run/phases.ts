// Wall-time per stage of a run.
//
// A run reports one total today, which is enough to know it was slow and not
// enough to know why. The phases have very different cost profiles — capture
// dominates, diff is a cold path that only runs for stories that already
// failed, and enumerate/affected are fixed overhead — so the total alone
// cannot distinguish "700 stories" from "7 stories and a broken diff".

export interface Phases {
  /** Time a promise-returning step, recording it under `name`. */
  time<T>(name: string, fn: () => Promise<T>): Promise<T>;
  /** Add to a phase directly, for work not shaped like a single call. */
  add(name: string, ms: number): void;
  /** Count of things a phase handled, e.g. how many diffs actually ran. */
  count(name: string, n?: number): void;
  readonly timings: Record<string, number>;
  readonly counts: Record<string, number>;
}

export function phases(): Phases {
  const timings: Record<string, number> = {};
  const counts: Record<string, number> = {};

  const add = (name: string, ms: number) => {
    timings[name] = (timings[name] ?? 0) + ms;
  };

  return {
    timings,
    counts,
    add,
    count(name, n = 1) {
      counts[name] = (counts[name] ?? 0) + n;
    },
    async time(name, fn) {
      const started = Date.now();
      try {
        return await fn();
      } finally {
        add(name, Date.now() - started);
      }
    },
  };
}

/**
 * `enumerate 12ms | capture 48.2s | diff(7) 810ms`
 *
 * Phases are printed in insertion order, which is execution order, so the line
 * reads as the run happened. Sub-millisecond phases are dropped: they are noise
 * next to a capture measured in seconds.
 */
export function formatPhases(p: Pick<Phases, 'timings' | 'counts'>): string {
  const parts: string[] = [];
  for (const [name, ms] of Object.entries(p.timings)) {
    if (ms < 1) continue;
    const n = p.counts[name];
    const label = n === undefined ? name : `${name}(${n})`;
    parts.push(`${label} ${ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`}`);
  }
  return parts.join(' | ');
}
