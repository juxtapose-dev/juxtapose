// Frozen pre-structure-2 implementation for output-equivalence tests.
// Which element on the baseline side is which element on the current side.
//
// Positional paths alone would report every sibling after an insertion as
// changed. Instead children are aligned per parent with an LCS over an
// identity key, recursing into matches, so an insertion is one `added` and the
// rest stay matched. LCS is per parent, so cost is Σ(children²) — small for
// real DOMs; a pathological flat parent falls back to in-order key pairing.

import type { StructureElement, StructureSnapshot } from '../../../types.js';

export interface ElementMatch {
  /** [baseline index, current index], sorted by current index. */
  pairs: Array<[number, number]>;
  /** Current indices of unmatched subtree roots, ascending. */
  added: number[];
  /** Baseline indices of unmatched subtree roots, ascending. */
  removed: number[];
}

/** Above this many DP cells for one parent, pair greedily instead. */
const LCS_CELL_CAP = 250_000;

/** What makes an element "the same one" across captures: tag plus the most
 *  stable identity it carries. Masked stand-ins have only their tag. */
export function identityKey(el: StructureElement): string {
  if (el.id !== undefined) return `${el.tag}#${el.id}`;
  if (el.testId !== undefined) return `${el.tag}[${el.testId}]`;
  if (el.role && el.name) return `${el.tag}|${el.role}=${el.name}`;
  if (el.classes?.length) return `${el.tag}.${el.classes.join('.')}`;
  return el.tag;
}

export function matchElements(a: StructureSnapshot, b: StructureSnapshot): ElementMatch {
  const childrenA = childLists(a.elements);
  const childrenB = childLists(b.elements);
  const keyA = a.elements.map(identityKey);
  const keyB = b.elements.map(identityKey);
  const pairs: Array<[number, number]> = [];
  const added: number[] = [];
  const removed: number[] = [];

  const walk = (pa: number, pb: number): void => {
    const ca = childrenA.get(pa) ?? [];
    const cb = childrenB.get(pb) ?? [];
    const first = align(ca, cb, (i, j) => keyA[i] === keyB[j], [keyA, keyB]);
    // A text edit changes a name-derived key, a toggled class changes a
    // class-derived one. Pair what is left by tag, in order, so those read as
    // `text`/`attr` deltas rather than removed + added.
    // Never across conflicting explicit identities: `div#row-1` removed and
    // `div#banner` added are two different elements, not one edited one.
    // i and j come from childLists over these same element arrays.
    const second = align(first.leftA, first.leftB, (i, j) =>
      sameKind(a.elements[i]!, b.elements[j]!),
    );
    for (const [i, j] of [...first.matched, ...second.matched]) {
      pairs.push([i, j]);
      walk(i, j);
    }
    removed.push(...second.leftA);
    added.push(...second.leftB);
  };
  walk(-1, -1);

  pairs.sort((p, q) => p[1] - q[1]);
  added.sort((x, y) => x - y);
  removed.sort((x, y) => x - y);
  return { pairs, added, removed };
}

/** Tag equal, and no explicit id or testId present on both sides and unequal. */
function sameKind(x: StructureElement, y: StructureElement): boolean {
  if (x.tag !== y.tag) return false;
  if (x.id !== undefined && y.id !== undefined && x.id !== y.id) return false;
  if (x.testId !== undefined && y.testId !== undefined && x.testId !== y.testId)
    return false;
  return true;
}

/** Children in document order, keyed by parent index; -1 is the root. */
function childLists(elements: StructureElement[]): Map<number, number[]> {
  const m = new Map<number, number[]>();
  elements.forEach((e, i) => {
    const p = e.parent ?? -1;
    const list = m.get(p);
    if (list) list.push(i);
    else m.set(p, [i]);
  });
  return m;
}

interface Alignment {
  matched: Array<[number, number]>;
  leftA: number[];
  leftB: number[];
}

/** Order-preserving alignment of two sibling lists under `same`. `keys`, when
 *  given, are what `same` compares: same(i, j) is keys[0][i] === keys[1][j]. */
function align(
  ca: number[],
  cb: number[],
  same: (i: number, j: number) => boolean,
  keys?: [string[], string[]],
): Alignment {
  const matched =
    ca.length * cb.length <= LCS_CELL_CAP
      ? lcs(ca, cb, same)
      : keys
        ? greedyByKey(ca, cb, keys[0], keys[1])
        : greedy(ca, cb, same);
  const usedA = new Set(matched.map(([i]) => i));
  const usedB = new Set(matched.map(([, j]) => j));
  return {
    matched,
    leftA: ca.filter((i) => !usedA.has(i)),
    leftB: cb.filter((j) => !usedB.has(j)),
  };
}

function lcs(
  ca: number[],
  cb: number[],
  same: (i: number, j: number) => boolean,
): Array<[number, number]> {
  const n = ca.length;
  const m = cb.length;
  // L[i][j] = LCS length of ca[i..] and cb[j..]
  const L: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  // Every read below has i <= n and j <= m: L has n + 1 rows of m + 1 cells,
  // and ca/cb are read only at i < n, j < m.
  for (let i = n - 1; i >= 0; i--) {
    const row = L[i]!;
    const below = L[i + 1]!;
    for (let j = m - 1; j >= 0; j--) {
      row[j] = same(ca[i]!, cb[j]!)
        ? below[j + 1]! + 1
        : Math.max(below[j]!, row[j + 1]!);
    }
  }
  const out: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    const ai = ca[i]!;
    const bj = cb[j]!;
    if (same(ai, bj)) {
      out.push([ai, bj]);
      i++;
      j++;
    } else if (L[i + 1]![j]! >= L[i]![j + 1]!) i++;
    else j++;
  }
  return out;
}

/** In-order pairing: each a takes the first unused b after the last pairing
 *  that is `same`. Linear-ish, order-preserving, and good enough for a parent
 *  with thousands of children where an exact LCS would cost seconds.
 *  Failure mode: it never looks backwards, so a reordered list degrades to
 *  many removed/added pairs instead of a minimal edit.
 *  Quadratic when little matches: each a scans every b left. Exported for
 *  the test that holds greedyByKey to the same output. @internal */
export function greedy(
  ca: number[],
  cb: number[],
  same: (i: number, j: number) => boolean,
): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let j = 0;
  for (const i of ca) {
    let k = j;
    while (k < cb.length && !same(i, cb[k]!)) k++; // k < cb.length
    if (k < cb.length) {
      out.push([i, cb[k]!]);
      j = k + 1;
    }
  }
  return out;
}

/** greedy, for a `same` that is key equality: the first b at or after the
 *  scan position with a's key is found by binary search over that key's
 *  positions in cb instead of a scan. Same output as greedy. A flat parent of
 *  4999 rows whose every name changed matches no key in the first pass, and
 *  greedy compared all 25M pairs: that diff took 240-1050 ms, 56-90 ms now.
 *  @internal */
export function greedyByKey(
  ca: number[],
  cb: number[],
  keyA: readonly string[],
  keyB: readonly string[],
): Array<[number, number]> {
  // key -> its positions in cb, ascending
  const positions = new Map<string, number[]>();
  cb.forEach((j, k) => {
    const key = keyB[j]!; // cb indexes keyB's elements
    const list = positions.get(key);
    if (list) list.push(k);
    else positions.set(key, [k]);
  });
  const out: Array<[number, number]> = [];
  let j = 0;
  for (const i of ca) {
    const list = positions.get(keyA[i]!); // ca indexes keyA's elements
    if (!list) continue;
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (list[m]! < j)
        lo = m + 1; // lo <= m < hi <= list.length
      else hi = m;
    }
    if (lo < list.length) {
      const k = list[lo]!; // lo < list.length
      out.push([i, cb[k]!]); // k is a position in cb
      j = k + 1;
    }
  }
  return out;
}
