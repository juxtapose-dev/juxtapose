import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import type { Delta, StructureSnapshot } from '../../types.js';
import { computeFacts } from './deltas.js';
import { label } from './label.js';
import { matchElements } from './match.js';

const fixture = JSON.parse(
  readFileSync(
    path.join(import.meta.dirname, '../__fixtures__/structural-corpus.json'),
    'utf8',
  ),
) as { cases: Record<string, { structure: StructureSnapshot }> };
const snap = (n: string) => fixture.cases[n].structure;
const deltas = (a: StructureSnapshot, b: StructureSnapshot): Delta[] =>
  computeFacts(a, b, matchElements(a, b)).map((f) => f.delta);
const vs = (n: string) => deltas(snap('noop'), snap(n));

test('identical snapshots produce no facts', () => {
  expect(deltas(snap('noop'), snap('noop'))).toEqual([]);
});

test('a colour change is one style delta on the button, old → new', () => {
  const d = vs('color');
  expect(d).toContainEqual({
    kind: 'style',
    el: 'button[name="Save"]',
    prop: 'color',
    from: 'rgb(255, 255, 255)',
    to: 'rgb(254, 240, 138)',
  });
  expect(d.filter((x) => x.kind === 'style')).toHaveLength(1);
});

test('a text change is one text delta; the name attr is not repeated', () => {
  const d = vs('text');
  expect(d.filter((x) => x.kind === 'text')).toEqual([
    { kind: 'text', el: 'button[name="Save"]', from: 'Save', to: 'Save changes' },
  ]);
  expect(d.some((x) => x.kind === 'attr' && x.attr === 'name')).toBe(false);
});

test('an src swap is one attr delta with filenames', () => {
  expect(vs('img-src')).toContainEqual({
    kind: 'attr',
    el: 'img[name="Logo"]',
    attr: 'src',
    from: 'logo-a.svg',
    to: 'logo-b.svg',
  });
});

test('added and removed carry the rect; descendants are not listed', () => {
  const ins = vs('inserted');
  const added = ins.filter((x) => x.kind === 'added');
  expect(added).toHaveLength(1);
  expect(added[0]).toMatchObject({ el: 'div#banner', rect: { w: expect.any(Number) } });
  const rem = vs('removed').filter((x) => x.kind === 'removed');
  expect(rem).toEqual([{ kind: 'removed', el: 'div#row-1', rect: expect.any(Object) }]);
});

test('padding grows the button (resized) and moves what follows (moved)', () => {
  const d = vs('padding');
  expect(d).toContainEqual(
    expect.objectContaining({ kind: 'resized', el: 'button[name="Save"]' }),
  );
  expect(d.filter((x) => x.kind === 'moved').length).toBeGreaterThanOrEqual(3);
});

test('an inherited change is reported once, where it originates — and without phantom border colours', () => {
  const a = snap('noop');
  const b = structuredClone(a);
  const main = b.elements.findIndex((e) => e.tag === 'main');
  b.elements[main].styles.color = 'rgb(1, 2, 3)';
  const d = deltas(a, b);
  // main and the rows have no borders: currentColor must not surface as
  // border-*-color deltas on any of them (the rows' 1px top border is set
  // explicitly, so it is stored, not inherited from color).
  expect(d).toEqual([
    {
      kind: 'style',
      el: 'main',
      prop: 'color',
      from: 'rgb(17, 24, 39)',
      to: 'rgb(1, 2, 3)',
    },
  ]);
});

test('a text change is labelled from the baseline, not the new text', () => {
  const d = vs('text').find((x) => x.kind === 'text')!;
  expect(d.el).toBe('button[name="Save"]');
});

test('a masked element yields geometry only, never text or style', () => {
  const a = structuredClone(snap('noop'));
  const b = structuredClone(a);
  const i = a.elements.findIndex((e) => e.id === 'row-3');
  for (const s of [a, b]) {
    const e = s.elements[i];
    s.elements[i] = {
      path: e.path,
      parent: e.parent,
      tag: 'masked',
      rect: e.rect,
      paintOrder: e.paintOrder,
      styles: {},
    };
  }
  b.elements[i].rect = {
    ...b.elements[i].rect,
    y: b.elements[i].rect.y + 10,
    w: b.elements[i].rect.w + 5,
  };
  // a sneaky text/style on the masked stand-in must be ignored even if present
  (b.elements[i] as { text?: string }).text = 'leaked';
  b.elements[i].styles = { color: 'rgb(9, 9, 9)' };
  const d = deltas(a, b);
  expect(d.map((x) => x.kind).sort()).toEqual(['moved', 'resized']);
  expect(d.every((x) => x.kind !== 'text' && x.kind !== 'style')).toBe(true);
});

test('facts are ordered by current document position, then kind', () => {
  const facts = computeFacts(
    snap('noop'),
    snap('padding'),
    matchElements(snap('noop'), snap('padding')),
  );
  const orders = facts.map((f) => f.order);
  expect(orders).toEqual([...orders].sort((x, y) => x - y));
});

test('labels prefer role+name, then id, then testid, then class, then a short path', () => {
  const s = snap('noop');
  const by = (p: (e: StructureSnapshot['elements'][number]) => boolean) =>
    label(s.elements.find(p)!);
  expect(by((e) => e.testId === 'save')).toBe('button[name="Save"]');
  expect(by((e) => e.id === 'row-1')).toBe('div#row-1');
  expect(by((e) => e.tag === 'main')).toBe('main');
  expect(
    label({
      ...s.elements[0],
      id: undefined,
      role: undefined,
      name: undefined,
      classes: ['card', 'x'],
      tag: 'div',
    }),
  ).toBe('div.card');
});
