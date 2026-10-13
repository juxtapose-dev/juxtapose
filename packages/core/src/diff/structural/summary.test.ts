import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import type { Delta, StructureSnapshot, StructuralVerdict } from '../../types.js';
import { structuralDiff } from '../structural.js';
import { describeDeltas } from './summary.js';

const fixture = JSON.parse(
  readFileSync(
    path.join(import.meta.dirname, '../__fixtures__/structural-corpus.json'),
    'utf8',
  ),
) as {
  cases: Record<
    string,
    { structure: StructureSnapshot; imagesIdentical: boolean; pixels: never }
  >;
};
const snap = (n: string) => structuredClone(fixture.cases[n].structure);
const diff = (a: StructureSnapshot, b: StructureSnapshot, pixelsOf = 'color') =>
  structuralDiff({
    baseline: a,
    current: b,
    imagesIdentical: false,
    pixels: fixture.cases[pixelsOf].pixels,
    escalate: { command: 'x' },
  });
const corpus = (n: string, base = 'noop') =>
  structuralDiff({
    baseline: fixture.cases[base].structure,
    current: fixture.cases[n].structure,
    imagesIdentical: fixture.cases[n].imagesIdentical,
    pixels: fixture.cases[n].pixels,
    escalate: { command: 'x' },
  });

/** Rows two and three without ids, so both label as `div.row`, and both
 *  changing colour and background on the current side. */
function twoUnnamedRows(reparent = false): StructuralVerdict {
  const a = snap('noop');
  const b = snap('noop');
  for (const s of [a, b])
    for (const id of ['row-2', 'row-3']) {
      const e = s.elements.find((x) => x.id === id)!;
      delete e.id;
      if (reparent) e.parent = id === 'row-2' ? 1 : 3; // h1#title, img#logo
    }
  for (const e of b.elements.filter(
    (x) => x.name === 'Row two' || x.name === 'Row three',
  ))
    e.styles = {
      ...e.styles,
      color: 'rgb(1, 2, 3)',
      'background-color': 'rgb(4, 5, 6)',
    };
  return diff(a, b);
}

/** Every delta shows up in the human lines: each element group's changes
 *  and each solo delta, counted by what they state. */
function mentions(lines: string[], needle: RegExp): number {
  return lines.join('\n').match(new RegExp(needle, 'g'))?.length ?? 0;
}

test('two same-label siblings each changing stay two elements', () => {
  const v = twoUnnamedRows();
  const els = [...new Set(v.deltas.map((d) => ('el' in d ? d.el : d.after)))];
  // no labelled ancestor (main has no name), so the ordinal on the page
  expect(els).toEqual(['div.row (1st)', 'div.row (2nd)']);
  expect(v.deltaCount).toBe(4);

  const lines = describeDeltas(v.deltas, v.deltaCount);
  expect(lines).toEqual([
    '  div.row (1st)',
    '    background-color rgba(0, 0, 0, 0) → #040506',
    '    color #111827 → #010203',
    '  div.row (2nd)',
    '    background-color rgba(0, 0, 0, 0) → #040506',
    '    color #111827 → #010203',
  ]);
  // the summary names each once and never states a property twice in a clause
  for (const clause of v.summary.split('; '))
    expect(clause.match(/background-color/g)?.length ?? 0).toBeLessThanOrEqual(1);
});

test('same-label elements under different labelled ancestors read by ancestor', () => {
  const v = twoUnnamedRows(true);
  const els = [...new Set(v.deltas.map((d) => ('el' in d ? d.el : d.after)))];
  expect(els).toEqual([
    'div.row in heading[name="Settings"]',
    'div.row in img[name="Logo"]',
  ]);
});

test('a lone label is left alone', () => {
  expect(corpus('color').deltas.map((d) => 'el' in d && d.el)).toEqual([
    'button[name="Save"]',
  ]);
});

test('an older verdict with colliding labels still lists both elements', () => {
  // What a verdict written before labels were made unique looks like.
  const deltas: Delta[] = [
    { kind: 'style', el: 'div.card', prop: 'background-color', from: 'a', to: 'b' },
    { kind: 'style', el: 'div.card', prop: 'border-top-color', from: 'c', to: 'd' },
    { kind: 'style', el: 'div.card', prop: 'background-color', from: 'a', to: 'b' },
  ];
  expect(describeDeltas(deltas)).toEqual([
    '  div.card',
    '    background-color a → b',
    '    border-top-color c → d',
    '  div.card background-color a → b',
  ]);
});

test('reorder: the moved row leads, then the shift it caused', () => {
  const v = corpus('reorder');
  expect(v.summary).toBe(
    'reflow: div#row-1 moved down 111px; 3 elements after div#row-1 moved up 37px. Structure explains all 4 changed regions.',
  );
  expect(describeDeltas(v.deltas, v.deltaCount)).toEqual([
    '  div#row-1 moved down 111px',
    '  3 elements after div#row-1 moved up 37px',
  ]);
});

test('reorder upward: the row that crossed the run is still the anchor', () => {
  // The same reorder read backwards: row one moves up over rows two to four,
  // and now sits before them in the current order.
  const v = corpus('noop', 'reorder');
  expect(v.deltas).toEqual([
    { kind: 'moved', el: 'div#row-1', dx: 0, dy: -111 },
    { kind: 'shift', after: 'div#row-1', dx: 0, dy: 37, count: 3 },
  ]);
});

test('every delta in deltas[] is stated in the human lines', () => {
  for (const name of Object.keys(fixture.cases)) {
    const v = corpus(name);
    const lines = describeDeltas(v.deltas, v.deltaCount);
    const count = (k: Delta['kind']) => v.deltas.filter((d) => d.kind === k).length;
    expect(mentions(lines, / moved (up|down|left|right|[+-])/), name).toBe(
      count('moved') + count('shift'),
    );
    expect(mentions(lines, /\bresized\b/), name).toBe(count('resized'));
    expect(mentions(lines, /\bremoved\b/), name).toBe(count('removed'));
    expect(mentions(lines, /^ {2}added\b/m), name).toBe(count('added'));
  }
});

test('a removal nothing reflowed around reads as hidden or removed', () => {
  const rect = { x: 16, y: 125, w: 608, h: 37 };
  const lone: Delta[] = [{ kind: 'removed', el: 'div#row-1', rect }];
  expect(describeDeltas(lone)).toEqual([
    '  hidden or removed div#row-1 (608×37 at 16,125)',
  ]);
  // more deltas exist than were listed: one of them may be the reflow
  expect(describeDeltas(lone, 3)).toEqual(['  removed div#row-1 (608×37 at 16,125)']);
  // real data: the removed row's followers shifted, so it was removed
  const v = corpus('removed');
  expect(v.summary).toMatch(/^element-removed: removed div#row-1 /);

  // `visibility: hidden` as the capture records it: the row is gone, and
  // nothing moved into its space
  const a = snap('noop');
  const b = snap('removed');
  for (const e of b.elements) {
    const same = a.elements.find((x) => x.path === e.path);
    if (same) e.rect = same.rect;
  }
  const hidden = diff(a, b, 'removed');
  expect(hidden.classification).toBe('element-removed'); // JSON kind unchanged
  expect(hidden.deltas).toEqual([{ kind: 'removed', el: 'div#row-1', rect }]);
  expect(hidden.summary).toMatch(/^element-removed: hidden or removed div#row-1 /);
});
