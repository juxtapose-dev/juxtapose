import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import type { StructureElement, StructureSnapshot } from '../types.js';
import { observeControlGeometry } from './control-geometry.js';

const element = (
  id: string,
  h: number,
  extra: Partial<StructureElement> = {},
): StructureElement => ({
  id,
  tag: 'input',
  role: 'textbox',
  path: `input#${id}`,
  parent: null,
  rect: { x: 10, y: 10, w: 200, h },
  paintOrder: 1,
  styles: {},
  ...extra,
});
const snapshot = (elements: StructureElement[]): StructureSnapshot => ({
  schema: 'juxtapose.structure/v1',
  viewport: { width: 400, height: 600 },
  contentHeight: 600,
  structureHash: 'fixture',
  elements,
});

test('keeps measured control sizes even when parent and child shrink together', () => {
  const a = snapshot([
    element('field', 80, { tag: 'div', role: undefined }),
    element('name', 49, { parent: 0 }),
  ]);
  const b = snapshot([
    element('field', 67, { tag: 'div', role: undefined }),
    element('name', 36, { parent: 0 }),
  ]);
  expect(observeControlGeometry(a, b).observations).toEqual([
    expect.objectContaining({
      id: 'name',
      height: { approved: 49, current: 36 },
      provenance: 'structure',
    }),
  ]);
});

test('does not describe movement or unchanged sizes as resizing', () => {
  const a = snapshot([element('name', 49)]),
    b = snapshot([element('name', 49, { rect: { x: 10, y: 30, w: 200, h: 49 } })]);
  expect(observeControlGeometry(a, b).observations).toEqual([]);
});

test.each(['approved', 'current'] as const)(
  'abstains when %s structure is truncated because identity uniqueness is unknown',
  (side) => {
    const approved = snapshot([element('name', 49)]);
    const current = snapshot([element('name', 36)]);
    const snapshots = { approved, current };
    snapshots[side].truncated = { kept: 1, total: 2 };
    expect(observeControlGeometry(approved, current)).toEqual({
      observations: [],
      omitted: 0,
      abstained: 1,
      incompatible: false,
      unavailable: 'truncated-structure',
    });
  },
);

test.each([
  'duplicate-before',
  'duplicate-after',
  'missing-id',
  'changed-tag',
  'changed-role',
  'invalid-size',
] as const)('abstains on %s', (reason) => {
  const a = snapshot([element('name', 49)]),
    b = snapshot([element('name', 36)]);
  if (reason === 'duplicate-before') a.elements.push(element('name', 49, { tag: 'div' }));
  if (reason === 'duplicate-after') b.elements.push(element('name', 36, { tag: 'div' }));
  if (reason === 'missing-id') delete b.elements[0]!.id;
  if (reason === 'changed-tag') b.elements[0]!.tag = 'select';
  if (reason === 'changed-role') b.elements[0]!.role = 'combobox';
  if (reason === 'invalid-size') b.elements[0]!.rect.h = NaN;
  const result = observeControlGeometry(a, b);
  expect(result.observations).toEqual([]);
  expect(result.abstained).toBeGreaterThan(0);
});

test('requires compatible viewports and gives deterministic bounded results', () => {
  const a = snapshot(['d', 'c', 'b', 'a'].map((id) => element(id, 49))),
    b = snapshot(['a', 'b', 'c', 'd'].map((id) => element(id, 36)));
  const r = observeControlGeometry(a, b);
  expect(r.observations.map((x) => x.id)).toEqual(['a', 'b', 'c']);
  expect(r.omitted).toBe(1);
  expect(observeControlGeometry(snapshot([...a.elements].reverse()), b)).toEqual(r);
  b.viewport.width = 500;
  expect(observeControlGeometry(a, b)).toMatchObject({
    observations: [],
    incompatible: true,
  });
});

test('uses a unique test ID without requiring a DOM ID', () => {
  const a = snapshot([
    element('', 49, { id: undefined, testId: 'save', tag: 'button', role: 'button' }),
  ]);
  const b = snapshot([
    element('', 36, { id: undefined, testId: 'save', tag: 'button', role: 'button' }),
  ]);
  expect(observeControlGeometry(a, b).observations).toEqual([
    expect.objectContaining({ testId: 'save', height: { approved: 49, current: 36 } }),
  ]);
  b.elements.push(element('wrapper', 20, { tag: 'div', testId: 'save' }));
  expect(observeControlGeometry(a, b).observations).toEqual([]);
});

test('bounds UTF-8 evidence bytes without truncating identities or hiding omissions', () => {
  const ids = ['a' + '界'.repeat(400), 'b', 'c', 'd', 'e'];
  const a = snapshot(ids.map((id) => element(id, 49)));
  const b = snapshot(ids.map((id) => element(id, 36)));
  const result = observeControlGeometry(a, b);
  expect(result.observations.map((item) => item.id)).toEqual(['b', 'c', 'd']);
  expect(result.omitted).toBe(2);
  expect(Buffer.byteLength(JSON.stringify(result.observations))).toBeLessThanOrEqual(
    1024,
  );
  expect(observeControlGeometry(snapshot([...a.elements].reverse()), b)).toEqual(result);
  const longIds = ['界'.repeat(100), '語'.repeat(100), '音'.repeat(100)];
  const limited = observeControlGeometry(
    snapshot(longIds.map((id) => element(id, 49))),
    snapshot(longIds.map((id) => element(id, 36))),
  );
  expect(limited.observations).toHaveLength(1);
  expect(limited.omitted).toBe(2);
  expect(Buffer.byteLength(JSON.stringify(limited.observations))).toBeLessThanOrEqual(
    1024,
  );
});

test('does not fall back around duplicate IDs or conflicting test IDs', () => {
  const a = snapshot([element('name', 49, { testId: 'before' })]);
  const b = snapshot([element('name', 36, { testId: 'after' })]);
  expect(observeControlGeometry(a, b).observations).toEqual([]);
  b.elements[0]!.testId = 'before';
  a.elements.push(element('name', 49, { tag: 'div' }));
  expect(observeControlGeometry(a, b).observations).toEqual([]);
});

test('recovers six measured geometry mutations in the captured test-ID corpus', () => {
  const corpus = JSON.parse(
    readFileSync(
      new URL('./__fixtures__/structural-corpus.json', import.meta.url),
      'utf8',
    ),
  ) as { cases: Record<string, { structure: StructureSnapshot }> };
  const baseline = corpus.cases['noop']!.structure;
  const changed = Object.entries(corpus.cases)
    .filter(
      ([, value]) =>
        observeControlGeometry(baseline, value.structure).observations.length,
    )
    .map(([name]) => name);
  expect(changed).toEqual([
    'padding',
    'font-size',
    'font-weight',
    'line-height',
    'letter-spacing',
    'text',
  ]);
  expect(
    observeControlGeometry(baseline, corpus.cases['padding']!.structure).observations[0],
  ).toMatchObject({
    testId: 'save',
    width: { approved: 65.38, current: 73.38 },
    height: { approved: 44, current: 52 },
  });
});
