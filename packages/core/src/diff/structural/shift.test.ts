import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import type { StructureSnapshot } from '../../types.js';
import { computeFacts, type Fact } from './deltas.js';
import { matchElements } from './match.js';
import { synthesizeShifts } from './shift.js';

const fixture = JSON.parse(
  readFileSync(
    path.join(import.meta.dirname, '../__fixtures__/structural-corpus.json'),
    'utf8',
  ),
) as { cases: Record<string, { structure: StructureSnapshot }> };
const snap = (n: string) => fixture.cases[n].structure;
const facts = (n: string): Fact[] => {
  const a = snap('noop');
  const b = snap(n);
  return synthesizeShifts(computeFacts(a, b, matchElements(a, b)));
};
const kinds = (fs: Fact[]) => fs.map((f) => f.delta.kind);

test('an inserted banner collapses the rows and canvas below it into one shift', () => {
  // Measured on the real page: the button moves (0, −5) and the img
  // (−69.83, +96) because it drops off the button's line; the five rows and
  // the canvas move (0, +74). Only the latter six form a run.
  const fs = facts('inserted');
  const shifts = fs.filter((f) => f.delta.kind === 'shift');
  expect(shifts).toHaveLength(1);
  expect(shifts[0].delta).toMatchObject({
    kind: 'shift',
    after: 'div#banner',
    dx: 0,
    dy: 74,
    count: 6,
  });
  // the two odd moves stay as `moved`, nothing else does
  const moved = fs
    .filter((f) => f.delta.kind === 'moved')
    .map((f) => (f.delta as { el: string }).el);
  expect(moved).toEqual(['button[name="Save"]', 'img[name="Logo"]']);
  // the shift covers the moved elements' rects (old and new), so coverage can use it
  expect(shifts[0].rects).toHaveLength(12);
});

test('a removed row collapses the rows after it into one upward shift', () => {
  // Measured: rows 2–5 and the canvas move (0, −37).
  const fs = facts('removed');
  const shift = fs.find((f) => f.delta.kind === 'shift')!.delta;
  expect(shift).toMatchObject({
    kind: 'shift',
    after: 'div#row-1',
    dx: 0,
    dy: -37,
    count: 5,
  });
  expect(kinds(fs)).not.toContain('moved');
});

test('a margin change anchors the shift on the element with the style delta', () => {
  // Measured: the rows and canvas move +20; the img, on the button's line, does not.
  const fs = facts('margin');
  expect(kinds(fs)).toContain('style');
  const shift = fs.find((f) => f.delta.kind === 'shift')!.delta;
  expect(shift).toMatchObject({ after: 'button[name="Save"]', dy: 20, count: 6 });
});

test('fewer than three equal moves stay as moved', () => {
  const a = snap('noop');
  const b = snap('removed');
  const raw = computeFacts(a, b, matchElements(a, b));
  const moved = raw.filter((f) => f.delta.kind === 'moved');
  expect(moved.length).toBeGreaterThanOrEqual(3); // the run exists in the real data …
  const trimmed = [...raw.filter((f) => f.delta.kind !== 'moved'), ...moved.slice(0, 2)];
  const out = synthesizeShifts(trimmed); // … and with only two of it, no shift
  expect(kinds(out)).not.toContain('shift');
  expect(kinds(out).filter((k) => k === 'moved')).toHaveLength(2);
});

test('moves with no anchor before them are not collapsed', () => {
  const a = snap('noop');
  const b = structuredClone(a);
  // shove the last four rows down with nothing changed above them
  for (const id of ['row-2', 'row-3', 'row-4', 'row-5']) {
    const e = b.elements.find((x) => x.id === id)!;
    e.rect = { ...e.rect, y: e.rect.y + 7 };
  }
  const fs = synthesizeShifts(computeFacts(a, b, matchElements(a, b)));
  expect(kinds(fs)).not.toContain('shift');
  expect(kinds(fs).filter((k) => k === 'moved')).toHaveLength(4);
});

test('output stays sorted by order', () => {
  const fs = facts('inserted');
  const orders = fs.map((f) => f.order);
  expect(orders).toEqual([...orders].sort((x, y) => x - y));
});
