import { expect, test } from 'vitest';
import type { StructureElement, StructureSnapshot } from '../types.js';
import { selectorsFor as referenceSelectorsFor } from './__tests__/selector.reference.js';
import { describeSelector, selectorsFor } from './selector.js';

const el = (k: number, extra: Partial<StructureElement> = {}): StructureElement => ({
  path: `main>li:nth-of-type(${k})`,
  parent: 0,
  tag: 'li',
  rect: { x: 0, y: k, w: 100, h: 1 },
  paintOrder: 0,
  styles: {},
  ...extra,
});

test('selectorsFor describes every element of a long list in one pass, as describeSelector does', () => {
  // analyzeFlake describes each one-sided element. Counting uniqueness by
  // filtering every element per call read n² = 4M elements here; ~10k now.
  const n = 2000;
  const rows: StructureElement[] = [
    { ...el(0), path: 'main', parent: null, tag: 'main' },
    ...Array.from({ length: n }, (_, k) =>
      el(k + 1, {
        classes: k === 7 ? ['row', 'only'] : ['row'],
        ...(k === 3 ? { id: 'third' } : {}),
        ...(k === 5 ? { testId: 'fifth' } : {}),
      }),
    ),
  ];
  let reads = 0;
  const elements = new Proxy(rows, {
    get(t, k, r) {
      if (typeof k === 'string' && /^\d+$/.test(k)) reads++;
      return Reflect.get(t, k, r) as unknown;
    },
  });
  const s: StructureSnapshot = {
    schema: 'juxtapose.structure/v1',
    viewport: { width: 1280, height: 800 },
    structureHash: '',
    contentHeight: 800,
    elements,
  };
  const describe = selectorsFor(s).describe;
  const all = rows.map((_, i) => describe(i));
  expect(reads).toBeLessThan(10 * n);
  expect(all[4]).toEqual({ selector: '#third', stable: true });
  expect(all[6]).toEqual({ selector: '[data-testid="fifth"]', stable: true });
  expect(all[8]).toEqual({ selector: 'li.row.only', stable: true });
  expect(all[1]).toEqual({ selector: 'main>li:nth-of-type(1)', stable: false });
  expect(all[0]).toEqual({ selector: 'main', stable: false });
  // The one-off form agrees.
  for (const i of [0, 1, 4, 6, 8, n]) expect(describeSelector(s, i)).toEqual(all[i]);
});

test('class permutations and duplicates preserve selector bytes and emitted class order', () => {
  const rows = [
    el(1, { classes: ['z', 'a', 'z'] }),
    el(2, { classes: ['a', 'z'] }),
    el(3, { tag: 'p', classes: ['z', 'a', 'z'] }),
    el(4, { classes: ['only', 'first', 'only'] }),
    el(5, { classes: ['css-abc123', 'only-generated-neighbor'] }),
  ];
  const s: StructureSnapshot = {
    schema: 'juxtapose.structure/v1',
    viewport: { width: 100, height: 100 },
    structureHash: '',
    contentHeight: 100,
    elements: rows,
  };
  const actual = selectorsFor(s);
  const old = referenceSelectorsFor(s);
  const output = rows.map((_, i) => actual.describe(i));
  expect(JSON.stringify(output)).toBe(
    JSON.stringify(rows.map((_, i) => old.describe(i))),
  );
  expect(output[2].selector).toBe('p.z.a.z');
  expect(output[3].selector).toBe('li.only.first.only');
});
