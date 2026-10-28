import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import type { Delta, StructureElement, StructureSnapshot } from '../../types.js';
import { computeCoverage } from './coverage.js';
import { computeFacts as referenceComputeFacts } from './__tests__/deltas.reference.js';
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

// Deferred from PR (b): a child whose box changed exactly as its parent's did
// only followed it. On the 12-item reorder probe the item's `span.meta moved
// down 222px` read as a second change beside the item's own move.
test('a child that moved exactly with its parent is not listed (nested-reorder)', () => {
  const d = deltas(snap('nested'), snap('nested-reorder'));
  expect(d.some((x) => 'el' in x && x.el.startsWith('span.meta'))).toBe(false);
  expect(d).toContainEqual({ kind: 'moved', el: 'div#row-1', dx: 0, dy: 111 });
  // rows 1–4 moved; row 5, the canvas and every span did not get a fact
  expect(d.filter((x) => x.kind === 'moved')).toHaveLength(4);
});

test('a child that moved differently from its parent is still listed', () => {
  const a = snap('nested');
  const b = structuredClone(a);
  const row = b.elements.findIndex((e) => e.id === 'row-2');
  const span = b.elements.findIndex((e) => e.parent === row && e.tag === 'span');
  b.elements[row].rect = { ...b.elements[row].rect, y: b.elements[row].rect.y + 10 };
  b.elements[span].rect = { ...b.elements[span].rect, y: b.elements[span].rect.y + 12 };
  const d = deltas(a, b);
  expect(d).toContainEqual({ kind: 'moved', el: 'div#row-2', dx: 0, dy: 10 });
  expect(d).toContainEqual({ kind: 'moved', el: 'span.meta', dx: 0, dy: 12 });
});

test('a child resized exactly like its parent is not listed either', () => {
  const a = snap('nested');
  const b = structuredClone(a);
  const row = b.elements.findIndex((e) => e.id === 'row-2');
  const span = b.elements.findIndex((e) => e.parent === row && e.tag === 'span');
  for (const k of [row, span])
    b.elements[k].rect = { ...b.elements[k].rect, w: b.elements[k].rect.w + 8 };
  const d = deltas(a, b);
  expect(d).toEqual([{ kind: 'resized', el: 'div#row-2', dw: 8, dh: 0 }]);
});

test('a grandchild following a parent that itself followed is suppressed too', () => {
  const a = snap('nested');
  const b = structuredClone(a);
  const main = b.elements.findIndex((e) => e.tag === 'main');
  const row = b.elements.findIndex((e) => e.id === 'row-2');
  const span = b.elements.findIndex((e) => e.parent === row && e.tag === 'span');
  for (const k of [main, row, span])
    b.elements[k].rect = { ...b.elements[k].rect, y: b.elements[k].rect.y + 10 };
  const d = deltas(a, b);
  // Compared on rects, not on facts: row-2's own move is suppressed and the
  // span still reads as following it, so only `main` is listed.
  const moved = d.filter(
    (x): x is Extract<Delta, { kind: 'moved' }> => x.kind === 'moved',
  );
  expect(moved.map((x) => x.el)).toEqual(['main']);
});

test('an element whose parent did not move keeps every move (inserted: 8, as before)', () => {
  // Measured before this change on the real `inserted` capture: the button,
  // the img, five rows and the canvas move (8 facts); `main` resizes but
  // does not move, so none of its children follows it. The count must not
  // change.
  const d = deltas(snap('noop'), snap('inserted'));
  expect(d.filter((x) => x.kind === 'moved')).toHaveLength(8);
});

// Suppressing a following child must not lose its pixels. The parent's rect
// usually contains the child's, but not when the child overflows it: then a
// changed region over the child alone intersected no fact and was reported
// unexplained. The suppressed child's rects ride on the ancestor's fact.
test('a suppressed child that overflows its parent keeps its pixels explained', () => {
  const a = snap('nested');
  const row = a.elements.findIndex((e) => e.id === 'row-2');
  const span = a.elements.findIndex((e) => e.parent === row && e.tag === 'span');
  const base = structuredClone(a);
  // The span hangs out past the row's right edge, as an overflowing badge would.
  const r = base.elements[row].rect;
  base.elements[span].rect = { x: r.x + r.w + 20, y: r.y, w: 30, h: r.h };
  const cur = structuredClone(base);
  for (const k of [row, span])
    cur.elements[k].rect = { ...cur.elements[k].rect, y: cur.elements[k].rect.y + 10 };
  const facts = computeFacts(base, cur, matchElements(base, cur));
  expect(facts.map((f) => f.delta)).toEqual([
    { kind: 'moved', el: 'div#row-2', dx: 0, dy: 10 },
  ]);
  const s = cur.elements[span].rect;
  const cov = computeCoverage([{ x: s.x, y: s.y, width: s.w, height: s.h }], facts);
  expect(cov.explained).toBe('full');
  expect(facts[0].rects).toContainEqual(s);
});

test('a child that both moved and resized exactly with its parent is not listed', () => {
  const a = snap('nested');
  const b = structuredClone(a);
  const row = b.elements.findIndex((e) => e.id === 'row-2');
  const span = b.elements.findIndex((e) => e.parent === row && e.tag === 'span');
  for (const k of [row, span]) {
    const r = b.elements[k].rect;
    b.elements[k].rect = { ...r, y: r.y + 10, w: r.w + 8 };
  }
  expect(deltas(a, b)).toEqual([
    { kind: 'resized', el: 'div#row-2', dw: 8, dh: 0 },
    { kind: 'moved', el: 'div#row-2', dx: 0, dy: 10 },
  ]);
  // Mixed: it followed the move but resized on its own, so only its resize is listed.
  const r = b.elements[span].rect;
  b.elements[span].rect = { ...r, w: r.w + 4 };
  expect(deltas(a, b)).toEqual([
    { kind: 'resized', el: 'div#row-2', dw: 8, dh: 0 },
    { kind: 'moved', el: 'div#row-2', dx: 0, dy: 10 },
    { kind: 'resized', el: 'span.meta', dw: 12, dh: 0 },
  ]);
});

// Operation counts, not timings: they do not move with machine load.
const node = (
  parent: number | null,
  y: number,
  extra: Partial<StructureElement> = {},
): StructureElement => ({
  path: `p${y}`,
  parent,
  tag: 'div',
  rect: { x: 0, y, w: 100, h: 1 },
  paintOrder: 0,
  styles: {},
  ...extra,
});
const structure = (elements: StructureElement[]): StructureSnapshot => ({
  ...snap('noop'),
  structureHash: '',
  elements,
});
/** The snapshot with its element reads counted. */
function counted(s: StructureSnapshot): { s: StructureSnapshot; reads: () => number } {
  let reads = 0;
  const elements = new Proxy(s.elements, {
    get(t, k, r) {
      if (typeof k === 'string' && /^\d+$/.test(k)) reads++;
      return Reflect.get(t, k, r) as unknown;
    },
  });
  return { s: { ...s, elements }, reads: () => reads };
}

test('an unstored inherited style is resolved once per element, not walked per read', () => {
  // One 1000-deep chain whose root colour changed. Walking up for every
  // element's every inherited prop read 13M elements; resolved once, 82k.
  const n = 1000;
  const chain = (color: string) =>
    structure(
      Array.from({ length: n }, (_, k) =>
        node(k === 0 ? null : k - 1, k, k === 0 ? { styles: { color } } : {}),
      ),
    );
  const a = counted(chain('rgb(0, 0, 1)'));
  const b = counted(chain('rgb(0, 0, 2)'));
  const match = matchElements(a.s, b.s);
  const before = a.reads() + b.reads();
  const facts = computeFacts(a.s, b.s, match);
  expect(facts.map((f) => f.delta)).toEqual([
    {
      kind: 'style',
      el: 'p0',
      prop: 'color',
      from: 'rgb(0, 0, 1)',
      to: 'rgb(0, 0, 2)',
    },
  ]);
  expect(a.reads() + b.reads() - before).toBeLessThan(200 * n);
});

test('removed elements find their predecessor in one sweep, not a scan back each', () => {
  // A 2000-row list removed: scanning back from each row was 2M lookups; one sweep is ~2k.
  const n = 2000;
  const a = structure([
    node(null, 0),
    ...Array.from({ length: n }, (_, k) => node(0, k + 1, { classes: ['row'] })),
  ]);
  const b = structure([node(null, 0)]);
  const match = matchElements(a, b);
  const get = vi.spyOn(Map.prototype, 'get');
  let facts;
  let gets: number;
  try {
    facts = computeFacts(a, b, match);
    gets = get.mock.calls.length;
  } finally {
    get.mockRestore();
  }
  expect(facts.filter((f) => f.delta.kind === 'removed')).toHaveLength(n);
  expect(facts.every((f) => f.order === 0.5)).toBe(true);
  expect(gets).toBeLessThan(10 * n);
});

test('deep-chain followers preserve reference fact and rect order with linear ancestor reads', () => {
  const n = 1000;
  for (const mixed of [false, true]) {
    const a = structure(
      Array.from({ length: n }, (_, k) => node(k === 0 ? null : k - 1, k)),
    );
    const b = structure(
      a.elements.map((e, k) => ({
        ...e,
        rect: { ...e.rect, y: e.rect.y + (mixed && k >= 400 ? 20 : 10), w: e.rect.w + 8 },
        ...(mixed && k === 200 ? { text: 'edited' } : {}),
      })),
    );
    // Reverse pair traversal exercises cached paths before their parents are
    // followers; fact discovery and attachment order must remain independent.
    const pairs = a.elements.map((_, i): [number, number] => [i, i]).reverse();
    const match = { pairs, added: [], removed: [] };
    const countedA = counted(a);
    const actual = computeFacts(countedA.s, b, match);
    const operations = countedA.reads();
    const old = referenceComputeFacts(a, b, match);
    expect(JSON.stringify(actual)).toBe(JSON.stringify(old));
    // The old follower loop alone reads n(n-1)/2 ancestors (~500k).
    expect(operations).toBeLessThan(120 * n);
    expect(actual.some((f) => f.rects.length > 500)).toBe(true);
  }
});

test('optional evidence collector finds only otherwise unexplained suppressed resizes', () => {
  const a = structure([
    node(null, 0, { id: 'field', rect: { x: 0, y: 0, w: 200, h: 80 } }),
    node(0, 1, {
      id: 'name',
      tag: 'input',
      role: 'textbox',
      rect: { x: 0, y: 20, w: 200, h: 49 },
      styles: { 'padding-top': '8px' },
    }),
  ]);
  const b = structuredClone(a);
  b.elements[0]!.rect.h -= 13;
  b.elements[1]!.rect.h -= 13;
  const selected: Array<[number, number]> = [];
  const matches = matchElements(a, b);
  expect(computeFacts(a, b, matches, (i, j) => selected.push([i, j]))).toEqual(
    computeFacts(a, b, matches),
  );
  expect(selected).toEqual([[1, 1]]);
  // An existing direct style fact already supplies repair evidence. The
  // collector does not assert that this style caused the size change.
  b.elements[1]!.styles['padding-top'] = '12px';
  const withStyle: Array<[number, number]> = [];
  computeFacts(a, b, matches, (i, j) => withStyle.push([i, j]));
  expect(withStyle).toEqual([]);
});

test('collecting suppressed geometry leaves every captured corpus fact unchanged', () => {
  for (const { structure: current } of Object.values(fixture.cases)) {
    const baseline = snap('noop');
    const matches = matchElements(baseline, current);
    const selected: number[] = [];
    expect(computeFacts(baseline, current, matches, (i) => selected.push(i))).toEqual(
      computeFacts(baseline, current, matches),
    );
  }
});
