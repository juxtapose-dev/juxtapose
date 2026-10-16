import { globToRegExp } from './url-pattern.js';

/** ID globs use the same *, ** and ? rules as story overrides. */
export function selectStories<T extends { storyId: string; baseStoryId?: string }>(
  items: readonly T[],
  selectors: readonly string[],
): { selected: T[]; unknown: string[] } {
  const patterns = selectors.map(globToRegExp);
  const hit = new Set<number>();
  const selected = items.filter((item) => {
    let matches = false;
    patterns.forEach((pattern, i) => {
      if (
        pattern.test(item.storyId) ||
        (item.baseStoryId !== undefined && pattern.test(item.baseStoryId))
      ) {
        hit.add(i);
        matches = true;
      }
    });
    return matches;
  });
  return { selected, unknown: selectors.filter((_, i) => !hit.has(i)) };
}

/** Conservatively include bases whose not-yet-discovered variant IDs could
 * match. A literal prefix narrows common component globs without hiding variants. */
export function discoveryStoryIds(
  items: readonly { storyId: string }[],
  selectors: readonly string[],
): string[] {
  const patterns = selectors.map((selector) => ({
    pattern: globToRegExp(selector),
    prefix: selector.split(/[?*]/, 1)[0]!,
    glob: /[?*]/.test(selector),
  }));
  return items
    .filter(({ storyId }) =>
      patterns.some(
        ({ pattern, prefix, glob }) =>
          pattern.test(storyId) ||
          prefix.startsWith(`${storyId}__`) ||
          (glob && storyId.startsWith(prefix)),
      ),
    )
    .map((item) => item.storyId);
}
