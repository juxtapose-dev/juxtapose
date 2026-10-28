import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import type { StructureElement, StructureSnapshot } from '../types.js';
import { observeControlGeometry } from './control-geometry.js';
import { structuralDiffWithCoverage } from './structural.js';

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

const namedButton = (name: string, h: number): StructureElement =>
  element('', h, {
    id: undefined,
    tag: 'button',
    role: 'button',
    name,
    parent: 0,
    path: `main>button[name="${name}"]`,
  });
const namedFixture = () => ({
  baseline: snapshot([
    element('toolbar', 80, { tag: 'div', role: undefined }),
    namedButton('Ready', 45),
  ]),
  current: snapshot([
    element('toolbar', 74, { tag: 'div', role: undefined }),
    namedButton('Ready', 39),
  ]),
});
const namedDiff = (
  pair: ReturnType<typeof namedFixture>,
  includeControlGeometry = true,
) =>
  structuralDiffWithCoverage({
    ...pair,
    imagesIdentical: false,
    includeControlGeometry,
    pixels: { changedRegions: [], dimensionMismatch: false },
    escalate: { command: 'report' },
  });

test('recovers unique named controls only from already suppressed pairs, without changing the verdict', () => {
  const pair = namedFixture();
  expect(observeControlGeometry(pair.baseline, pair.current).observations).toEqual([]);
  const detailed = namedDiff(pair);
  expect(detailed.verdict).toEqual(namedDiff(pair, false).verdict);
  expect(detailed.controlGeometry?.observations).toEqual([
    expect.objectContaining({
      tag: 'button',
      role: 'button',
      name: 'Ready',
      height: { approved: 45, current: 39 },
      provenance: 'structure',
      suppressedResize: true,
    }),
  ]);
  expect(detailed.controlGeometry?.observations[0]).not.toHaveProperty('id');
  expect(detailed.controlGeometry?.observations[0]?.confidenceRule).toContain(
    'suppressed structural pair',
  );
  pair.current.elements[1]!.styles['padding-top'] = '9px';
  expect(namedDiff(pair).controlGeometry).toBeUndefined();
});

test.each([
  'duplicate-approved',
  'duplicate-current',
  'renamed',
  'role-changed',
  'id-added',
  'id-removed',
  'test-id-conflict',
  'empty-id',
  'unnamed',
  'truncated-approved',
  'truncated-current',
  'viewport',
  'invalid-size',
])('named suppressed controls abstain on %s', (reason) => {
  const pair = namedFixture();
  const old = pair.baseline.elements[1]!,
    now = pair.current.elements[1]!;
  if (reason === 'duplicate-approved')
    pair.baseline.elements.push({ ...old, id: 'other' });
  if (reason === 'duplicate-current') pair.current.elements.push({ ...now, id: 'other' });
  if (reason === 'renamed') now.name = 'Dispatch';
  if (reason === 'role-changed') now.role = 'switch';
  if (reason === 'id-added') now.id = 'ready';
  if (reason === 'id-removed') old.id = 'ready';
  if (reason === 'test-id-conflict') {
    old.testId = 'old';
    now.testId = 'new';
  }
  if (reason === 'empty-id') old.id = '';
  if (reason === 'unnamed') old.name = now.name = '';
  if (reason === 'truncated-approved') pair.baseline.truncated = { kept: 2, total: 3 };
  if (reason === 'truncated-current') pair.current.truncated = { kept: 2, total: 3 };
  if (reason === 'viewport') pair.current.viewport.width += 1;
  if (reason === 'invalid-size') now.rect.h = NaN;
  expect(namedDiff(pair).controlGeometry?.observations ?? []).toEqual([]);
});

test('context filtering cannot hide a duplicate named identity', () => {
  const pair = namedFixture();
  for (const side of [pair.baseline, pair.current]) {
    side.elements.push({
      ...namedButton('Ready', 45),
      id: 'preview',
      parent: null,
      path: 'button#preview',
    });
    side.contextElementIds = ['preview'];
  }
  expect(namedDiff(pair).controlGeometry).toBeUndefined();
});

test('sibling insertion and reordering do not transfer named control measurements', () => {
  const pair = namedFixture();
  pair.baseline.elements.push(namedButton('Delayed', 55));
  pair.current.elements.push(namedButton('Delayed', 49));
  pair.current.elements.splice(1, 0, namedButton('New', 30));
  pair.current.elements.reverse();
  // Keep the parent first; reorder just the controls under it.
  pair.current.elements.unshift(pair.current.elements.pop()!);
  const result = namedDiff(pair);
  for (const observation of result.controlGeometry?.observations ?? []) {
    expect(observation.height).toEqual(
      observation.name === 'Ready'
        ? { approved: 45, current: 39 }
        : { approved: 55, current: 49 },
    );
    expect(['Ready', 'Delayed']).toContain(observation.name);
  }
  expect(result.controlGeometry?.observations.length).toBeGreaterThan(0);
});

test('named observations keep whole identities and existing count/UTF-8 bounds', () => {
  const pair = namedFixture();
  for (const name of ['Delayed', 'Other', '界'.repeat(500), 'Last']) {
    pair.baseline.elements.push(namedButton(name, 45));
    pair.current.elements.push(namedButton(name, 39));
  }
  const result = namedDiff(pair).controlGeometry!;
  expect(result.observations.length).toBeLessThanOrEqual(3);
  expect(result.omitted).toBe(5 - result.observations.length);
  expect(Buffer.byteLength(JSON.stringify(result.observations))).toBeLessThanOrEqual(
    1024,
  );
  expect(
    result.observations.every((observation) => !observation.name?.includes('界')),
  ).toBe(true);
  expect(namedDiff(pair).controlGeometry).toEqual(result);
});

test('no approved structure cannot produce approved named-control dimensions', () => {
  const { current } = namedFixture();
  expect(
    structuralDiffWithCoverage({
      current,
      imagesIdentical: false,
      includeControlGeometry: true,
      pixels: { changedRegions: [], dimensionMismatch: false },
      escalate: { command: 'report' },
    }).controlGeometry,
  ).toBeUndefined();
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

test('collects suppressed-resize evidence in the existing structural pass without changing its verdict', () => {
  const baseline = snapshot([
    element('field', 80, { tag: 'div', role: undefined }),
    element('name', 49, { parent: 0 }),
  ]);
  const current = snapshot([
    element('field', 67, { tag: 'div', role: undefined }),
    element('name', 36, { parent: 0 }),
  ]);
  const input = {
    baseline,
    current,
    imagesIdentical: false,
    pixels: { changedRegions: [], dimensionMismatch: false },
    escalate: { command: 'report' },
  };
  const ordinary = structuralDiffWithCoverage(input);
  const detailed = structuralDiffWithCoverage({ ...input, includeControlGeometry: true });
  expect(ordinary).not.toHaveProperty('controlGeometry');
  expect(detailed.verdict).toEqual(ordinary.verdict);
  expect(detailed.controlGeometry?.observations[0]).toMatchObject({
    id: 'name',
    suppressedResize: true,
  });
  current.elements[1]!.styles['padding-top'] = '12px';
  expect(
    structuralDiffWithCoverage({ ...input, includeControlGeometry: true }).controlGeometry
      ?.observations[0],
  ).not.toHaveProperty('suppressedResize');
});

test('prioritizes suppressed measurements before the count and byte budgets', () => {
  const ids = ['a', 'b', 'c', 'z'];
  const result = observeControlGeometry(
    snapshot(ids.map((id) => element(id, 49))),
    snapshot(ids.map((id) => element(id, 36))),
    { ids: new Set(['z']), testIds: new Set() },
  );
  expect(result.observations.map((item) => item.id)).toEqual(['z', 'a', 'b']);
  expect(result.observations[0]!.suppressedResize).toBe(true);
  expect(result.omitted).toBe(1);
  expect(Buffer.byteLength(JSON.stringify(result.observations))).toBeLessThanOrEqual(
    1024,
  );
});

test('adapter context filtering cannot hide a duplicate identity from measured evidence', () => {
  const baseline = snapshot([
    element('name', 80, { tag: 'div', role: undefined, path: 'div#name' }),
    element('name', 49, { parent: 0, path: 'div#name>input#name' }),
  ]);
  baseline.contextElementIds = ['name'];
  const current = structuredClone(baseline);
  current.elements[0]!.rect.h -= 13;
  current.elements[1]!.rect.h -= 13;
  const result = structuralDiffWithCoverage({
    baseline,
    current,
    imagesIdentical: false,
    includeControlGeometry: true,
    pixels: { changedRegions: [], dimensionMismatch: false },
    escalate: { command: 'report' },
  });
  expect(result.controlGeometry).toBeUndefined();
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
