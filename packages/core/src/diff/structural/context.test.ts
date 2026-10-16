import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import type { StructureElement, StructureSnapshot } from '../../types.js';
import { structuralDiff } from '../structural.js';
import { componentStructure } from './context.js';
import { compactStructure, expandStructure } from '../../baseline/structure-file.js';

const ids = new Set(['preview-root']);
const rootPath = 'html:nth-of-type(1)>body:nth-of-type(1)>div#preview-root';
const element = (over: Partial<StructureElement>): StructureElement => ({
  path: `${rootPath}>div`,
  parent: 0,
  tag: 'div',
  rect: { x: 0, y: 0, w: 100, h: 20 },
  paintOrder: 1,
  styles: {},
  ...over,
});
const snapshot = (elements: StructureElement[]): StructureSnapshot => ({
  schema: 'juxtapose.structure/v1',
  viewport: { width: 640, height: 480 },
  structureHash: JSON.stringify(elements),
  contentHeight: 480,
  elements,
});
const root = (over: Partial<StructureElement> = {}) =>
  element({
    path: rootPath,
    parent: null,
    id: 'preview-root',
    ...over,
  });
const diff = (baseline: StructureSnapshot, current: StructureSnapshot) =>
  structuralDiff({
    baseline,
    current,
    imagesIdentical: false,
    pixels: {
      changedRegions: [{ x: 0, y: 0, width: 100, height: 20 }],
      dimensionMismatch: false,
    },
    escalate: { command: 'jux diff test' },
  });

test('new adapter context removes wrapper noise against an old baseline without rewriting it', () => {
  const before = snapshot([root(), element({ text: 'Old' })]);
  const after = snapshot([
    root({ rect: { x: 0, y: 0, w: 100, h: 40 } }),
    element({ text: 'New' }),
  ]);
  expect(diff(before, after).deltas.some((d) => d.el === 'div#preview-root')).toBe(true);
  after.contextElementIds = [...ids];
  const original = JSON.stringify(before);
  const verdict = diff(before, after);
  expect(verdict.deltas).toEqual([{ kind: 'text', el: 'div', from: 'Old', to: 'New' }]);
  expect(JSON.stringify(verdict)).not.toContain('preview-root');
  expect(JSON.stringify(before)).toBe(original);
});

test('inherited preview styles are attributed to the component; overrides and sibling portals survive', () => {
  const before = snapshot([
    root({ styles: { color: 'red', 'background-color': 'white' } }),
    element({}),
    element({ path: `${rootPath}>div>span`, parent: 1, tag: 'span' }),
    element({ path: `${rootPath}>p`, tag: 'p', styles: { color: 'green' } }),
    element({ path: 'div#portal', id: 'portal', parent: null, text: 'Before' }),
  ]);
  const after = structuredClone(before);
  after.elements[0].styles.color = 'blue';
  after.elements[4].text = 'After';
  after.contextElementIds = [...ids];
  const view = componentStructure(before, ids)!;
  expect(view.elements.map((e) => e.parent)).toEqual([null, 0, null, null]);
  expect(view.elements[0].styles).toEqual({ color: 'red' });
  expect(view.elements[2].styles).toEqual({ color: 'green' });
  const facts = diff(before, after).deltas;
  expect(facts).toContainEqual({
    kind: 'style',
    el: 'div',
    prop: 'color',
    from: 'red',
    to: 'blue',
  });
  expect(facts).toContainEqual({
    kind: 'text',
    el: 'div#portal',
    from: 'Before',
    to: 'After',
  });
  expect(facts.filter((d) => d.kind === 'style')).toHaveLength(1);
});

test('framework-only paint stays unexplained, never counted as component coverage or render drift', () => {
  const before = snapshot([
    root({ styles: { 'background-color': 'white' } }),
    element({}),
  ]);
  const after = snapshot([
    root({ styles: { 'background-color': 'black' } }),
    element({}),
  ]);
  after.contextElementIds = [...ids];
  const result = diff(before, after);
  expect(result.deltaCount).toBe(0);
  expect(result.explained).toBe('none');
  expect(result.classification).toBe('unknown');
});

test('a wrapper without a visible box on one side does not turn its child into an addition', () => {
  const before = snapshot([root(), element({})]);
  const after = snapshot([element({ parent: null })]);
  after.contextElementIds = [...ids];
  expect(diff(before, after).deltaCount).toBe(0);
});

test('an ordinary component with the same ID is untouched outside adapter context', () => {
  const before = snapshot([root(), element({})]);
  expect(componentStructure(before, new Set())).toBe(before);
  const nested = snapshot([
    element({ parent: null, path: 'main', tag: 'main' }),
    root({ parent: 0, path: 'main>div#preview-root' }),
  ]);
  expect(componentStructure(nested, ids)).toBe(nested);
});

test('committed compact baselines retain adapter context for offline diffs', () => {
  const captured = snapshot([root(), element({ text: 'Save' })]);
  captured.contextElementIds = [...ids];
  const restored = expandStructure(
    JSON.parse(JSON.stringify(compactStructure(captured))),
  );
  expect(restored).toEqual(captured);
  expect(
    componentStructure(restored, new Set(restored.contextElementIds))!.elements,
  ).toEqual([element({ path: 'div', parent: null, text: 'Save' })]);
});

test('a real Chromium corpus keeps its component verdict when wrapped by a resizing workbench', () => {
  const { cases } = JSON.parse(
    readFileSync(
      new URL('../__fixtures__/structural-corpus.json', import.meta.url),
      'utf8',
    ),
  );
  const wrap = (s: StructureSnapshot, height: number): StructureSnapshot => ({
    ...s,
    contextElementIds: [...ids],
    elements: [
      root({ rect: { x: 0, y: 0, w: 640, h: height } }),
      ...s.elements.map((el) => ({
        ...el,
        parent: el.parent === null ? 0 : el.parent + 1,
        path: `${rootPath}>${el.path.replace(/^html:nth-of-type\(1\)>body:nth-of-type\(1\)>/, '')}`,
      })),
    ],
  });
  const input = {
    imagesIdentical: false,
    pixels: cases.padding.pixels,
    escalate: { command: 'jux diff test' },
  };
  expect(
    structuralDiff({
      ...input,
      baseline: wrap(cases.noop.structure, 366),
      current: wrap(cases.padding.structure, 370),
    }),
  ).toEqual(
    structuralDiff({
      ...input,
      baseline: cases.noop.structure,
      current: cases.padding.structure,
    }),
  );
});
