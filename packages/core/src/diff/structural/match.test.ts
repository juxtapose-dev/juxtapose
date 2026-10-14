import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import type { StructureSnapshot } from '../../types.js';
import { greedy, greedyByKey, identityKey, matchElements } from './match.js';

// Real Chromium captures of the corpus page — scripts/capture-diff-fixtures.mjs.
const fixture = JSON.parse(
  readFileSync(
    path.join(import.meta.dirname, '../__fixtures__/structural-corpus.json'),
    'utf8',
  ),
) as { cases: Record<string, { structure: StructureSnapshot }> };
const snap = (name: string) => fixture.cases[name].structure;
const idx = (s: StructureSnapshot, id: string) =>
  s.elements.findIndex((e) => e.id === id);

test('identical snapshots match every element and add/remove nothing', () => {
  const a = snap('noop');
  const m = matchElements(a, a);
  expect(m.pairs).toHaveLength(a.elements.length);
  expect(m.pairs.every(([i, j]) => i === j)).toBe(true);
  expect(m.added).toEqual([]);
  expect(m.removed).toEqual([]);
});

test('an inserted element is one added, siblings after it stay matched', () => {
  const a = snap('noop');
  const b = snap('inserted');
  const m = matchElements(a, b);
  expect(m.added).toEqual([idx(b, 'banner')]);
  expect(m.removed).toEqual([]);
  for (const id of ['row-1', 'row-2', 'row-5', 'chart']) {
    expect(m.pairs).toContainEqual([idx(a, id), idx(b, id)]);
  }
});

test('a removed element is one removed, siblings after it stay matched', () => {
  const a = snap('noop');
  const b = snap('removed');
  const m = matchElements(a, b);
  expect(m.removed).toEqual([idx(a, 'row-1')]);
  expect(m.added).toEqual([]);
  expect(m.pairs).toContainEqual([idx(a, 'row-2'), idx(b, 'row-2')]);
});

test('a button whose text changed is still the same button (second pass by tag)', () => {
  // The corpus button carries a data-testid, which outranks role+name in the
  // key; strip it on both sides so the key really is the name-derived one.
  const strip = (s: StructureSnapshot): StructureSnapshot => ({
    ...s,
    elements: s.elements.map((e) =>
      e.testId === 'save' ? { ...e, testId: undefined } : e,
    ),
  });
  const a = strip(snap('noop'));
  const b = strip(snap('text'));
  const ia = a.elements.findIndex((e) => e.tag === 'button');
  const ib = b.elements.findIndex((e) => e.tag === 'button');
  // its identity key changed (name is the text) …
  expect(identityKey(a.elements[ia])).toBe('button|button=Save');
  expect(identityKey(b.elements[ib])).toBe('button|button=Save changes');
  // … but it is paired, not reported as removed + added
  const m = matchElements(a, b);
  expect(m.pairs).toContainEqual([ia, ib]);
  expect(m.added).toEqual([]);
  expect(m.removed).toEqual([]);
});

test('a replaced element with a different id is removed + added, not paired', () => {
  const a = snap('noop');
  const b = structuredClone(a);
  const r1 = idx(b, 'row-1');
  // swap div#row-1 for a div#banner: same tag, same parent, different id
  b.elements[r1] = { ...b.elements[r1], id: 'banner' };
  const m = matchElements(a, b);
  expect(m.removed).toEqual([idx(a, 'row-1')]);
  expect(m.added).toEqual([r1]);
  expect(m.pairs).not.toContainEqual([idx(a, 'row-1'), r1]);
});

test('pairs are sorted by current index; added and removed ascending', () => {
  const m = matchElements(snap('noop'), snap('inserted'));
  const bs = m.pairs.map(([, j]) => j);
  expect(bs).toEqual([...bs].sort((x, y) => x - y));
});

// Review Focus 5: anonymous siblings. Clone the real rows into five identical
// <li>-like divs (no id, no class), remove the middle one on the current side.
test('one of five identical anonymous siblings removed is one removed, not a cascade', () => {
  const base = structuredClone(snap('noop'));
  const row = base.elements[idx(base, 'row-2')];
  const parent = row.parent!;
  const anon = (k: number) => ({
    ...row,
    id: undefined,
    classes: undefined,
    path: `${base.elements[parent].path}>div:nth-of-type(${k})`,
    rect: { ...row.rect, y: row.rect.y + k * 30 },
  });
  base.elements = base.elements.filter((e) => e.parent !== parent || e.tag === 'h1');
  const a: StructureSnapshot = {
    ...base,
    elements: [...base.elements, ...[1, 2, 3, 4, 5].map(anon)],
  };
  const b: StructureSnapshot = {
    ...base,
    elements: [...base.elements, ...[1, 2, 4, 5].map(anon)],
  };
  const m = matchElements(a, b);
  expect(m.removed).toHaveLength(1);
  // Identical siblings carry no information about WHICH one went, so the LCS
  // reports a fixed one (the last of the run, here the fifth). Pinned so a
  // change in tie-breaking is deliberate; the count is what is reliable.
  expect(m.removed).toEqual([a.elements.length - 1]);
  expect(m.added).toEqual([]);
  // the kept h1 is also a child of `parent`; count only the anonymous divs
  expect(
    m.pairs.filter(
      ([i]) => a.elements[i].parent === parent && a.elements[i].tag === 'div',
    ),
  ).toHaveLength(4);
});

test('a flat parent with thousands of children matches in bounded time', () => {
  const base = snap('noop');
  const row = base.elements[idx(base, 'row-2')];
  const many = (n: number, skip: number) =>
    Array.from({ length: n }, (_, k) => ({
      ...row,
      id: `r${k}`,
      path: `main>div#r${k}`,
    })).filter((_, k) => k !== skip);
  const a: StructureSnapshot = {
    ...base,
    elements: [base.elements[0], ...many(5000, -1).map((e) => ({ ...e, parent: 0 }))],
  };
  const b: StructureSnapshot = {
    ...base,
    elements: [base.elements[0], ...many(5000, 2500).map((e) => ({ ...e, parent: 0 }))],
  };
  const m = matchElements(a, b);
  expect(m.removed).toHaveLength(1);
  expect(m.pairs).toHaveLength(5000);
  // Timing: one warm-up (JIT), then best of 3, so a cold run on a contended
  // CI runner does not flake a bound that is 5× the real budget.
  const ms = bestOf3(() => matchElements(a, b));
  console.log(`matchElements 5000 flat children: ${ms.toFixed(1)} ms`);
  expect(ms).toBeLessThan(250);
});

test('greedyByKey pairs exactly as greedy over key equality', () => {
  // Deterministic pseudo-random lists over a small key alphabet, so keys
  // repeat, go missing on one side, and appear out of order.
  let seed = 7;
  const rand = (m: number) => (seed = (seed * 1103515245 + 12345) % 2 ** 31) % m;
  for (let trial = 0; trial < 300; trial++) {
    const keyA = Array.from({ length: rand(40) }, () => `k${rand(8)}`);
    const keyB = Array.from({ length: rand(40) }, () => `k${rand(8)}`);
    const ca = keyA.map((_, i) => i);
    const cb = keyB.map((_, j) => j);
    expect(greedyByKey(ca, cb, keyA, keyB)).toEqual(
      greedy(ca, cb, (i, j) => keyA[i] === keyB[j]),
    );
  }
});

test('greedyByKey on a flat list where no key matches reads each key once', () => {
  // Every row's name changed, so no identity key survives: greedy compared
  // all n² = 9M pairs before the tag pass paired them.
  const n = 3000;
  let reads = 0;
  const count = (keys: string[]) =>
    new Proxy(keys, {
      get(t, k, r) {
        if (typeof k === 'string' && /^\d+$/.test(k)) reads++;
        return Reflect.get(t, k, r) as unknown;
      },
    });
  const keyA = count(Array.from({ length: n }, (_, k) => `li|listitem=row ${k} a`));
  const keyB = count(Array.from({ length: n }, (_, k) => `li|listitem=row ${k} b`));
  const idx = Array.from({ length: n }, (_, k) => k);
  expect(greedyByKey(idx, idx, keyA, keyB)).toEqual([]);
  expect(reads).toBe(2 * n);
});

function bestOf3(fn: () => unknown): number {
  fn();
  let best = Infinity;
  for (let k = 0; k < 3; k++) {
    const t = performance.now();
    fn();
    best = Math.min(best, performance.now() - t);
  }
  return best;
}
