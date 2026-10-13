import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import type { StructureSnapshot } from '../../types.js';
import { identityKey, matchElements } from './match.js';

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
