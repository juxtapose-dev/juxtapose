// "Did you mean": edit distance between short identifiers.

export function distance(a: string, b: string): number {
  // Every row has b.length + 1 cells and j stays within 1..b.length, so the
  // indexed reads below are always in range.
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++)
      row[j] = Math.min(
        prev[j]! + 1,
        row[j - 1]! + 1,
        prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    prev = row;
  }
  return prev[b.length]!;
}

/** Up to `limit` candidates within `max` edits of `input`, nearest first
 *  (ties in the order given). */
export function closest(
  input: string,
  candidates: readonly string[],
  max = Math.max(2, Math.floor(input.length / 3)),
  limit = 3,
): string[] {
  return candidates
    .map((c, i) => ({ c, i, d: distance(input.toLowerCase(), c.toLowerCase()) }))
    .filter((x) => x.d <= max)
    .sort((a, b) => a.d - b.d || a.i - b.i)
    .slice(0, limit)
    .map((x) => x.c);
}
