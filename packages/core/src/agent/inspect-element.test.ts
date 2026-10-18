import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import type { StructureSnapshot } from '../types.js';
import { inspectStructureElement, isElementQuery } from './inspect-element.js';
const fixture = JSON.parse(
  readFileSync(
    new URL('../diff/__fixtures__/structural-corpus.json', import.meta.url),
    'utf8',
  ),
);
const snapshot = () => structuredClone(fixture.cases.noop.structure) as StructureSnapshot;
test('returns requested inherited computed values and the actual current rect', () => {
  const s = snapshot(),
    before = JSON.stringify(s),
    result = inspectStructureElement(s, { tag: 'H1' }, [
      'font-size',
      'color',
      'margin-bottom',
    ]);
  expect(result).toMatchObject({
    status: 'measured',
    provenance: 'structure',
    styles: { 'font-size': '24px', color: 'rgb(17, 24, 39)', 'margin-bottom': '12px' },
  });
  expect(result.status === 'measured' && result.element.rect).toEqual(
    s.elements.find((e) => e.tag === 'h1')!.rect,
  );
  expect(
    JSON.stringify(
      inspectStructureElement(s, { tag: 'h1' }, ['margin-bottom', 'color', 'font-size']),
    ),
  ).toBe(JSON.stringify(result));
  if (result.status === 'measured') result.element.rect.x += 100;
  expect(JSON.stringify(s)).toBe(before);
});
test('unchanged duplicates and incomplete captures abstain without guessing', () => {
  const s = snapshot(),
    title = s.elements.find((e) => e.tag === 'h1')!;
  s.elements.push({ ...title });
  expect(inspectStructureElement(s, { tag: 'h1' })).toMatchObject({
    status: 'ambiguous',
    matchingElementsAtLeast: 2,
  });
  s.truncated = { kept: s.elements.length, total: s.elements.length + 1 };
  expect(inspectStructureElement(s, { id: title.id! })).toMatchObject({
    status: 'unavailable',
    reason: 'truncated-structure',
  });
});
test('exact query fields combine and unmatched queries stay explicit', () => {
  const s = snapshot();
  expect(inspectStructureElement(s, { tag: 'button', name: 'absent' })).toMatchObject({
    status: 'not-found',
  });
  expect(isElementQuery({ selector: 'h1' })).toBe(false);
  expect(isElementQuery({})).toBe(false);
  expect(inspectStructureElement(s, { tag: 'h1' }, ['height'])).toMatchObject({
    status: 'measured',
    unavailableProperties: ['height'],
    styles: {},
  });
});
test('long style values are omitted whole while later short properties survive', () => {
  const s = snapshot(),
    title = s.elements.find((e) => e.tag === 'h1')!;
  s.styleCaptureVersion = 2;
  title.styles['grid-template-columns'] = '界'.repeat(4000);
  const r = inspectStructureElement(s, { tag: 'h1' }, [
    'grid-template-columns',
    'font-size',
  ]);
  expect(r).toMatchObject({
    status: 'measured',
    styles: { 'font-size': '24px' },
    omittedStyles: 1,
  });
  expect(JSON.stringify(r)).not.toContain('界');
  expect(Buffer.byteLength(JSON.stringify(r))).toBeLessThanOrEqual(3072);
  title.id = 'x'.repeat(4000);
  expect(inspectStructureElement(s, { tag: 'h1' })).toMatchObject({
    status: 'unavailable',
    reason: 'element-metadata-exceeds-budget',
  });
});

test('old captures do not invent values for properties introduced later', () => {
  const s = snapshot();
  delete s.styleCaptureVersion;
  expect(
    inspectStructureElement(s, { tag: 'h1' }, ['grid-template-columns', 'font-size']),
  ).toMatchObject({
    status: 'measured',
    styles: { 'font-size': '24px' },
    unavailableProperties: ['grid-template-columns'],
  });
});

test('report properties accept measured grid areas, while v2 retains columns and abstains on areas', () => {
  const s = snapshot();
  const title = s.elements.find((e) => e.tag === 'h1')!;
  s.styleCaptureVersion = 3;
  title.styles['grid-template-areas'] = '"main badge" "meta action"';
  title.styles['grid-template-columns'] = '200px 80px';
  const properties = ['grid-template-areas', 'grid-template-columns'];
  expect(inspectStructureElement(s, { tag: 'h1' }, properties)).toMatchObject({
    status: 'measured',
    provenance: 'structure',
    styles: {
      'grid-template-areas': '"main badge" "meta action"',
      'grid-template-columns': '200px 80px',
    },
  });
  s.styleCaptureVersion = 2;
  expect(inspectStructureElement(s, { tag: 'h1' }, properties)).toMatchObject({
    status: 'measured',
    styles: { 'grid-template-columns': '200px 80px' },
    unavailableProperties: ['grid-template-areas'],
  });
  delete s.styleCaptureVersion;
  expect(inspectStructureElement(s, { tag: 'h1' }, properties)).toMatchObject({
    status: 'measured',
    styles: {},
    unavailableProperties: properties,
  });
});

test('uncaptured CSS values preserve known measurements without inventing defaults', () => {
  const result = inspectStructureElement(snapshot(), { tag: 'h1' }, [
    'opacity',
    'image-rendering',
    'transform',
    '--brand-color',
  ]);
  expect(result).toMatchObject({
    status: 'measured',
    styles: { opacity: '1', transform: 'none' },
    unavailableProperties: ['--brand-color', 'image-rendering'],
  });
  expect(() =>
    inspectStructureElement(snapshot(), { tag: 'h1' }, ['color; display:none']),
  ).toThrow('CSS property names');
});

test('unique descendant selects nearest strict ancestor without choosing among duplicate anchors', () => {
  const s = snapshot();
  const template = s.elements[0]!;
  s.elements = [
    { ...template, tag: 'article', parent: null, id: 'outer', styles: {} },
    {
      ...template,
      tag: 'article',
      parent: 0,
      id: 'inner',
      styles: { 'padding-top': '16px' },
    },
    {
      ...template,
      tag: 'strong',
      parent: 1,
      id: 'title',
      text: 'Unique title',
      styles: {},
    },
    { ...template, tag: 'article', parent: null, id: 'other', styles: {} },
  ];
  const query = { text: 'Unique title' };
  const read = () =>
    inspectStructureElement(s, query, ['padding-top'], { tag: 'ARTICLE' });
  expect(read()).toMatchObject({
    status: 'measured',
    element: { id: 'inner' },
    styles: { 'padding-top': '16px' },
  });
  expect(
    inspectStructureElement(s, { id: 'inner' }, ['padding-top'], { tag: 'article' }),
  ).toMatchObject({ status: 'measured', element: { id: 'outer' } });
  expect(
    inspectStructureElement(s, query, ['padding-top'], { tag: 'aside' }),
  ).toMatchObject({ status: 'not-found' });
  s.elements[2]!.parent = 2;
  expect(read()).toMatchObject({ status: 'unavailable', reason: 'invalid-parent-chain' });
  s.elements[2]!.parent = 1;
  s.elements.push({ ...s.elements[2]! });
  expect(read()).toMatchObject({ status: 'ambiguous' });
  s.truncated = { kept: 5, total: 6 };
  expect(read()).toMatchObject({ status: 'unavailable', reason: 'truncated-structure' });
});

test('ancestor search bounds pathological depth and validates query', () => {
  const s = snapshot();
  const template = s.elements[0]!;
  s.elements = Array.from({ length: 67 }, (_, i) => ({
    ...template,
    tag: i === 0 ? 'article' : 'div',
    id: String(i),
    parent: i === 0 ? null : i - 1,
    styles: {},
  }));
  expect(
    inspectStructureElement(s, { id: '66' }, ['padding-top'], { tag: 'article' }),
  ).toMatchObject({ status: 'unavailable', reason: 'ancestor-depth-limit' });
  expect(() => inspectStructureElement(s, { id: '66' }, ['padding-top'], {})).toThrow(
    'ancestor',
  );
});
