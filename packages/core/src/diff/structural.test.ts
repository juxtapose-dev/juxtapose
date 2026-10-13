import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import type {
  ChangedRegion,
  StructureElement,
  StructureSnapshot,
  StructuralVerdict,
} from '../types.js';
import {
  MAX_DELTAS,
  MAX_VERDICT,
  structuralDiff,
  structuralDiffWithCoverage,
  type StructuralDiffInput,
} from './structural.js';

interface Case {
  against: string;
  structure: StructureSnapshot;
  imagesIdentical: boolean;
  pixels: {
    mismatchPixels: number;
    mismatchPercent: number;
    changedRegions: ChangedRegion[];
    dimensionMismatch: boolean;
  };
}
const fixture = JSON.parse(
  readFileSync(
    path.join(import.meta.dirname, '__fixtures__/structural-corpus.json'),
    'utf8',
  ),
) as { viewport: { width: number; height: number }; cases: Record<string, Case> };
// The same expectations — and the same checker — the end-to-end corpus
// script uses, so the unit test and CI cannot drift apart.
const { OPERATORS, checkVerdict } =
  (await import('../../../../scripts/structural-corpus/page.mjs')) as {
    OPERATORS: Array<{ name: string; expect: { classification: string } }>;
    checkVerdict: (op: { name: string }, v: StructuralVerdict) => string[];
  };
const ESC = { command: 'jux diff noop x --crops' };
const verdict = (name: string, over: Partial<StructuralDiffInput> = {}) =>
  structuralDiff({
    baseline: fixture.cases[fixture.cases[name].against].structure,
    current: fixture.cases[name].structure,
    imagesIdentical: fixture.cases[name].imagesIdentical,
    pixels: fixture.cases[name].pixels,
    escalate: ESC,
    ...over,
  });

for (const op of OPERATORS) {
  test(`corpus operator '${op.name}' → ${op.expect.classification}`, () => {
    const v = verdict(op.name);
    expect(checkVerdict(op, v)).toEqual([]);
    expect(JSON.stringify(v).length).toBeLessThanOrEqual(1500);
    expect(v.summary.length).toBeLessThanOrEqual(300);
  });
}

test('identical: byte-identical images, coverage 1, no flags (the page fits the viewport)', () => {
  const v = verdict('noop');
  expect(v).toMatchObject({
    classification: 'identical',
    coverage: 1,
    explained: 'full',
    deltaCount: 0,
  });
  expect(v.flags).toEqual([]);
  expect(v.summary).toMatch(/^identical/);
});

// Ruling 13: the corpus `background` change differs in bytes but pixelmatch
// marks 0 pixels. That is never `identical`; the deltas are the change.
test('sub-threshold: bytes differ, 0 pixels marked → classified from the deltas', () => {
  const v = verdict('background');
  expect(fixture.cases.background.pixels.mismatchPixels).toBe(0);
  expect(v).toMatchObject({
    classification: 'style-only',
    styleTags: ['color'],
    coverage: 1,
    explained: 'full',
    deltaCount: 1,
  });
  expect(v.flags).toEqual(['sub-threshold']);
  expect(v.summary).toBe(
    'style-only (color): button[name="Save"] background-color #2563eb→#1d4ed8. Pixel diff below tolerance; structure explains it.',
  );
});

// The summary is what an agent reads first: the cause leads, consequences
// follow, and four changed box sides read as their CSS shorthand.
test('summary leads with the cause, not the reflow it caused', () => {
  expect(verdict('padding').summary).toMatch(
    /^style-only \(spacing\): button\[name="Save"\] padding 8px 12px→12px 16px; 6 elements after button\[name="Save"\] moved down 4px;/,
  );
  expect(verdict('removed').summary).toMatch(
    /^element-removed: removed div#row-1 \(608×37 at 16,125\); 5 elements after div#row-1 moved up 37px;/,
  );
  expect(verdict('canvas').summary).toContain('inside canvas#chart');
});

// R16 + R17: the logo sliding right no longer vetoes the rows' shared move,
// and every fact about the button carries the baseline label.
test('font-size: the rows below the button collapse into one shift', () => {
  const v = verdict('font-size');
  expect(v.deltas).toContainEqual(
    expect.objectContaining({
      kind: 'shift',
      after: 'button[name="Save"]',
      dy: -2,
      count: 6,
    }),
  );
});

test('text: one label for every fact about the edited button', () => {
  const v = verdict('text');
  expect(v.summary).not.toContain('Save changes"]');
  expect(v.deltas.filter((d) => 'el' in d && d.el.startsWith('button'))).not.toEqual([]);
  for (const d of v.deltas)
    if ('el' in d && d.el.startsWith('button')) expect(d.el).toBe('button[name="Save"]');
});

test('two changed regions read as "both"', () => {
  expect(verdict('letter-spacing').summary).toMatch(
    /Structure explains both changed regions\.$/,
  );
});

const TAIL =
  /(Structure explains [^.]*|Nothing in the structure explains [^.]*|\d+ of \d+ changed regions unexplained)\.$/;

test('an element with 10 style changes: capped clause, (+N more), tail intact', () => {
  const a = fixture.cases.noop.structure;
  const b = structuredClone(a);
  const save = b.elements.find((e) => e.testId === 'save')!;
  save.styles = {
    ...save.styles,
    color: 'rgb(1, 2, 3)',
    'background-color': 'rgba(10, 20, 30, 0.5)',
    'font-family': `"${'Very Long Corporate Typeface '.repeat(8)}", system-ui, sans-serif`,
    'font-size': '31px',
    'font-weight': '900',
    'font-style': 'italic',
    'letter-spacing': '3px',
    'text-transform': 'uppercase',
    opacity: '0.25',
    'box-shadow':
      'rgba(0, 0, 0, 0.5) 0px 10px 30px 4px, rgba(0, 0, 0, 0.2) 0px 2px 4px 0px',
  };
  const v = structuralDiff({
    baseline: a,
    current: b,
    imagesIdentical: false,
    pixels: fixture.cases.color.pixels,
    escalate: ESC,
  });
  expect(v.deltaCount).toBe(10);
  expect(v.summary.length).toBeLessThanOrEqual(300);
  expect(v.summary).toMatch(/\(\+\d+ more\)/);
  expect(v.summary).toMatch(TAIL);
  expect(v.summary).not.toMatch(/…$/);
  expect(JSON.stringify(v).length).toBeLessThanOrEqual(1500);
});

test('a removed element with a deep unnamed path: label capped at a > boundary', () => {
  const a = structuredClone(fixture.cases.noop.structure);
  const main = a.elements.findIndex((e) => e.tag === 'main');
  const deep = Array.from({ length: 30 }, (_, k) => `div:nth-of-type(${k + 2})`).join(
    '>',
  );
  a.elements.push({
    ...a.elements[main],
    tag: 'div',
    parent: main,
    id: undefined,
    testId: undefined,
    classes: undefined,
    role: undefined,
    name: undefined,
    text: 'gone',
    path: `${a.elements[main].path}>${deep}`,
    rect: { x: 16, y: 400, w: 100, h: 20 },
    styles: {},
  });
  const v = structuralDiff({
    baseline: a,
    current: fixture.cases.noop.structure,
    imagesIdentical: false,
    pixels: fixture.cases.color.pixels,
    escalate: ESC,
  });
  const removed = v.deltas.find((d) => d.kind === 'removed')!;
  expect('el' in removed && removed.el.length).toBeLessThanOrEqual(60);
  expect('el' in removed && removed.el).toMatch(
    /^…>div:nth-of-type\(\d+\)(>div:nth-of-type\(\d+\))*$/,
  );
  expect(v.summary.length).toBeLessThanOrEqual(300);
  expect(v.summary).toMatch(TAIL);
  expect(JSON.stringify(v).length).toBeLessThanOrEqual(1500);
});

test('text delta values are capped at 200 chars in the JSON', () => {
  const b = structuredClone(fixture.cases.text.structure);
  const save = b.elements.find((e) => e.testId === 'save')!;
  save.text = 'x'.repeat(5000);
  const v = verdict('text', { current: b });
  const t = v.deltas.find((d) => d.kind === 'text')!;
  expect(t.kind === 'text' && t.to.length).toBe(200);
  expect(t.kind === 'text' && t.to.endsWith('…')).toBe(true);
});

test('the signature hashes the classification, so fact-free verdicts differ', () => {
  const dims = verdict('color', {
    pixels: { changedRegions: [], dimensionMismatch: true },
  });
  const sigs = new Set([
    verdict('canvas').signature,
    dims.signature,
    verdict('noop').signature,
  ]);
  expect(dims.deltaCount).toBe(0);
  expect(sigs.size).toBe(3);
});

test('imagesIdentical contradicted by the pixels → the pixel evidence wins', () => {
  const v = verdict('canvas', { imagesIdentical: true });
  expect(v.classification).not.toBe('identical');
  expect(v.classification).toBe('unknown');
});

test('zero-area regions are not counted', () => {
  const pixels = {
    changedRegions: [{ x: 600, y: 400, width: 0, height: 5 }],
    dimensionMismatch: false,
  };
  const v = verdict('noop', { imagesIdentical: false, pixels });
  expect(v.unexplainedRegions).toEqual([]);
  expect(v.flags).toEqual(['sub-threshold']);
});

test('sub-threshold with no structural change → render-drift, never identical', () => {
  const v = verdict('noop', { imagesIdentical: false });
  expect(v.classification).toBe('render-drift');
  expect(v.flags).toEqual(['sub-threshold']);
  expect(v.coverage).toBe(1);
});

test('canvas redraw: hash equal, pixels on a self-painting element → unknown + unexplained-pixels', () => {
  const v = verdict('canvas');
  expect(v.classification).toBe('unknown');
  expect(v.explained).toBe('none');
  expect(v.unexplainedRegions.length).toBeGreaterThan(0);
  expect(v.flags).toContain('unexplained-pixels');
});

test('hash equal, pixels elsewhere → render-drift', () => {
  const c = fixture.cases.canvas;
  const r = c.pixels.changedRegions[0];
  // move the region off the canvas onto the heading
  const h1 = c.structure.elements.find((e) => e.id === 'title')!.rect;
  const pixels = {
    ...c.pixels,
    changedRegions: [{ ...r, x: h1.x, y: h1.y, width: 10, height: 10 }],
  };
  expect(verdict('canvas', { pixels }).classification).toBe('render-drift');
});

test('the verdict JSON is byte-identical across calls and has a fixed key order', () => {
  const a = JSON.stringify(verdict('inserted'));
  const b = JSON.stringify(verdict('inserted'));
  expect(a).toBe(b);
  expect(Object.keys(verdict('color'))).toEqual([
    'schema',
    'classification',
    'styleTags',
    'summary',
    'change',
    'deltas',
    'deltaCount',
    'coverage',
    'explained',
    'unexplainedRegions',
    'flags',
    'signature',
    'escalate',
  ]);
});

test('signature abstracts the element but keeps the values', () => {
  const v1 = verdict('color');
  const b = structuredClone(fixture.cases.color.structure);
  // same change on a button with a different name → same signature
  const i = b.elements.findIndex((e) => e.testId === 'save');
  b.elements[i].name = 'Submit';
  b.elements[i].text = 'Submit';
  const a2 = structuredClone(fixture.cases.noop.structure);
  const j = a2.elements.findIndex((e) => e.testId === 'save');
  a2.elements[j].name = 'Submit';
  a2.elements[j].text = 'Submit';
  const v2 = structuralDiff({
    baseline: a2,
    current: b,
    imagesIdentical: false,
    pixels: fixture.cases.color.pixels,
    escalate: ESC,
  });
  expect(v2.signature).toBe(v1.signature);
  expect(verdict('background').signature).not.toBe(v1.signature);
  expect(v1.signature).toMatch(/^[0-9a-f]{64}$/);
});

test('deltas are capped at MAX_DELTAS and the verdict budget; deltaCount keeps the total', () => {
  const a = fixture.cases.noop.structure;
  const b = structuredClone(a);
  // 10 elements × 3 non-inherited props = 30 deltas, past the cap of 20
  for (const e of b.elements) {
    e.styles = {
      ...e.styles,
      opacity: '0.5',
      transform: 'matrix(1, 0, 0, 1, 1, 0)',
      'box-shadow': 'rgb(0, 0, 0) 0px 1px 2px 0px',
    };
  }
  const input: StructuralDiffInput = {
    baseline: a,
    current: b,
    imagesIdentical: false,
    pixels: fixture.cases.color.pixels,
    escalate: ESC,
  };
  const v = structuralDiff(input);
  // Changed in fix round 1: the brief expected exactly MAX_DELTAS (20), but
  // 20 of these deltas are ~2,600 chars; the 1,500 budget now binds first
  // and keeps a prefix. Both caps hold; deltaCount keeps the total.
  expect(v.deltas.length).toBeGreaterThan(0);
  expect(v.deltas.length).toBeLessThanOrEqual(MAX_DELTAS);
  expect(v.deltas).toEqual(
    structuralDiff({ ...input, escalate: { command: '' } }).deltas.slice(
      0,
      v.deltas.length,
    ),
  );
  expect(JSON.stringify(v).length).toBeLessThanOrEqual(MAX_VERDICT);
  expect(v.deltaCount).toBe(b.elements.length * 3);
});

// Review Focus 3
test('missing baseline structure → unknown + no-baseline-structure, and says to re-snap', () => {
  const v = verdict('color', { baseline: undefined });
  expect(v.classification).toBe('unknown');
  expect(v.flags).toContain('no-baseline-structure');
  expect(v.deltas).toEqual([]);
  expect(v.summary).toMatch(/no baseline structure/);
  expect(v.summary).toMatch(/re-snap|re-approve/);
});

// Review: a size change is a size change, with or without structure.
test('dimension mismatch with a structure missing → dimension-change, no region count', () => {
  const v = verdict('color', {
    baseline: undefined,
    pixels: { changedRegions: [], dimensionMismatch: true },
  });
  expect(v.classification).toBe('dimension-change');
  expect(v.flags).toContain('no-baseline-structure');
  expect(v.summary).toMatch(/image dimensions differ/);
  expect(v.summary).not.toMatch(/0 changed region/);
});

test('missing current structure → unknown + no-current-structure', () => {
  const v = verdict('color', { current: undefined });
  expect(v.flags).toContain('no-current-structure');
  expect(v.classification).toBe('unknown');
});

test('missing structure but byte-identical images is still identical', () => {
  const v = verdict('noop', { baseline: undefined });
  expect(v.classification).toBe('identical');
  expect(v.flags).toContain('no-baseline-structure');
});

// Review Focus 1
test('different viewports → dimension-change naming both sizes, exit-worthy, no element blame', () => {
  const current = {
    ...fixture.cases.color.structure,
    viewport: { width: 390, height: 844 },
  };
  const v = verdict('color', {
    current,
    pixels: { changedRegions: [], dimensionMismatch: true },
  });
  expect(v.classification).toBe('dimension-change');
  expect(v.summary).toContain('640×480');
  expect(v.summary).toContain('390×844');
  expect(v.deltas).toEqual([]);
});

// Review Focus 2
test('one side truncated → structure-truncated; the cut tail is a count, not deltas', () => {
  const a = fixture.cases.noop.structure;
  const b: StructureSnapshot = {
    ...a,
    elements: a.elements.slice(0, a.elements.length - 3),
    truncated: { kept: a.elements.length - 3, total: a.elements.length },
  };
  const v = structuralDiff({
    baseline: a,
    current: b,
    imagesIdentical: false,
    pixels: fixture.cases.color.pixels,
    escalate: ESC,
  });
  expect(v.flags).toContain('structure-truncated');
  expect(v.deltas.filter((d) => d.kind === 'removed')).toEqual([]);
  expect(v.summary).toMatch(/truncated/);
});

test('content taller than the viewport on either side → below-fold', () => {
  const tall = { ...fixture.cases.color.structure, contentHeight: 2000 };
  expect(verdict('color', { current: tall }).flags).toContain('below-fold');
  expect(verdict('color').flags).not.toContain('below-fold');
});

test('large-reflow only when a shift is ≥10 elements or |dy| ≥ 50px', () => {
  // Measured: `removed` shifts 5 elements by −37 — under both thresholds.
  expect(verdict('removed').flags).not.toContain('large-reflow');
  // Push the same run 30px further (−67): past the px threshold.
  const b = structuredClone(fixture.cases.removed.structure);
  const row1y = fixture.cases.noop.structure.elements.find((e) => e.id === 'row-1')!.rect
    .y;
  for (const e of b.elements)
    if (e.rect.y >= row1y) e.rect = { ...e.rect, y: e.rect.y - 30 };
  const v = structuralDiff({
    baseline: fixture.cases.noop.structure,
    current: b,
    imagesIdentical: false,
    pixels: fixture.cases.removed.pixels,
    escalate: ESC,
  });
  expect(v.deltas).toContainEqual(
    expect.objectContaining({ kind: 'shift', dy: -67, count: 5 }),
  );
  expect(v.flags).toContain('large-reflow');
  // Measured: `inserted` shifts 6 by +74 — past the px threshold on its own.
  expect(verdict('inserted').flags).toContain('large-reflow');
});

test("escalate carries the caller's command verbatim", () => {
  expect(verdict('color').escalate).toEqual(ESC);
});

// Performance: one warm-up (JIT), then best of 3, so a cold run on a contended
// CI runner cannot flake a bound that is 5× the real budget.
const bestOf3 = (run: () => unknown): number => {
  run();
  let ms = Infinity;
  for (let k = 0; k < 3; k++) {
    const t = performance.now();
    run();
    ms = Math.min(ms, performance.now() - t);
  }
  return ms;
};
const base = fixture.cases.noop.structure;
const row = base.elements.find((e) => e.id === 'row-2')!;
const mainIndex = base.elements.findIndex((e) => e.tag === 'main');

test('5,000-element flat pair (greedy fallback) diffs well under budget', () => {
  const big = (mut: (k: number) => Partial<typeof row>): StructureSnapshot => ({
    ...base,
    elements: [
      ...base.elements,
      ...Array.from({ length: 5000 - base.elements.length }, (_, k) => ({
        ...row,
        parent: mainIndex,
        id: `big-${k}`,
        path: `${base.elements[mainIndex].path}>div#big-${k}`,
        rect: { ...row.rect, y: row.rect.y + k * 20 },
        ...mut(k),
      })),
    ],
  });
  const a = big(() => ({}));
  const b = big((k) => (k % 50 === 0 ? { text: `changed ${k}` } : {}));
  const run = () =>
    structuralDiff({
      baseline: a,
      current: b,
      imagesIdentical: false,
      pixels: fixture.cases.color.pixels,
      escalate: ESC,
    });
  expect(run().deltaCount).toBeGreaterThan(50);
  const ms = bestOf3(run);
  console.log(`structuralDiff 5000×5000 flat: ${ms.toFixed(1)} ms (target < 50)`);
  expect(ms).toBeLessThan(250);
});

// Ruling 14: a realistic tree, so per-parent LCS runs (100² = 10k cells per
// parent, under LCS_CELL_CAP) instead of the flat greedy fallback.
test('5,000-element tree pair (50 parents × 100 children, LCS path) diffs well under budget', () => {
  const PARENTS = 50;
  const CHILDREN = 99; // + the parent itself = 100 per section
  const tree = (current: boolean): StructureSnapshot => {
    const elements: StructureElement[] = [...base.elements];
    let y = 500;
    for (let s = 0; s < PARENTS; s++) {
      const p = elements.length;
      const sectionPath = `${base.elements[mainIndex].path}>section#s-${s}`;
      elements.push({
        ...row,
        tag: 'section',
        parent: mainIndex,
        id: `s-${s}`,
        path: sectionPath,
        rect: { ...row.rect, y, h: CHILDREN * 20 },
      });
      let cy = y;
      for (let k = 0; k < CHILDREN; k++) {
        // Every 10th section loses its 3rd row on the current side, so the
        // LCS has a real gap to align around and the rows below shift up.
        if (current && s % 10 === 0 && k === 2) continue;
        elements.push({
          ...row,
          parent: p,
          id: `s-${s}-r-${k}`,
          path: `${sectionPath}>div#s-${s}-r-${k}`,
          text: current && k % 50 === 0 ? `changed ${s}-${k}` : row.text,
          rect: { ...row.rect, y: cy },
        });
        cy += 20;
      }
      y += CHILDREN * 20;
    }
    return { ...base, elements };
  };
  const a = tree(false);
  const b = tree(true);
  expect(a.elements.length).toBeGreaterThanOrEqual(5000);
  const run = () =>
    structuralDiff({
      baseline: a,
      current: b,
      imagesIdentical: false,
      pixels: fixture.cases.color.pixels,
      escalate: ESC,
    });
  const v = run();
  // The LCS aligned around the gaps: per 10th section one removal and one
  // shift of the 96 rows below it (5 + 5), plus 2 text edits in each of the
  // 50 sections (100) — a cascade of removed+added rows would be far more.
  expect(v.classification).toBe('element-removed');
  expect(v.deltaCount).toBe(110);
  const ms = bestOf3(run);
  console.log(
    `structuralDiff ${a.elements.length}×${b.elements.length} tree (${PARENTS}×${CHILDREN + 1}): ${ms.toFixed(1)} ms (target < 50)`,
  );
  expect(ms).toBeLessThan(250);
});

test('cause sits between flags and signature, and is absent when not given', () => {
  const cause = {
    kind: 'in-closure' as const,
    files: [{ path: 'src/Button.tsx', distance: 1 }],
  };
  expect(Object.keys(verdict('color', { cause }))).toEqual([
    'schema',
    'classification',
    'styleTags',
    'summary',
    'change',
    'deltas',
    'deltaCount',
    'coverage',
    'explained',
    'unexplainedRegions',
    'flags',
    'cause',
    'signature',
    'escalate',
  ]);
  expect(verdict('color', { cause }).cause).toEqual(cause);
  expect('cause' in verdict('color')).toBe(false);
  // the signature is about the change, not about which files caused it
  expect(verdict('color', { cause }).signature).toBe(verdict('color').signature);
});

// Review Focus 5
test('cause fits the budget for any input: ≤5 files, paths ≤80 chars keeping the tail', () => {
  const deep = (k: number) =>
    `packages/${'very-long-workspace-name/'.repeat(10)}src/components/${k}/Button.tsx`;
  const cause = {
    kind: 'in-closure' as const,
    files: Array.from({ length: 200 }, (_, k) => ({ path: deep(k), distance: k })),
  };
  const v = verdict('padding', { cause });
  expect(v.cause?.files).toHaveLength(5);
  for (const f of v.cause!.files) {
    expect(f.path.length).toBeLessThanOrEqual(80);
    expect(f.path).toMatch(/^…/);
    expect(f.path).toMatch(/\/Button\.tsx$/);
  }
  expect(JSON.stringify(v).length).toBeLessThanOrEqual(1500);
  expect(v.deltas.length).toBeGreaterThan(0);
  expect(JSON.stringify(verdict('padding', { cause }))).toBe(JSON.stringify(v));
});

// A clip that lands between the halves of a surrogate pair would leave a
// lone surrogate, which is not valid UTF-8 and breaks a JSON consumer.
test('cause paths are clipped on code point boundaries', () => {
  for (const pad of ['', 'x']) {
    const p = `src/${pad}${'😀'.repeat(60)}.tsx`;
    const v = verdict('padding', {
      cause: { kind: 'in-closure', files: [{ path: p, distance: 1 }] },
    });
    const clipped = v.cause!.files[0].path;
    expect(clipped.length).toBeLessThanOrEqual(80);
    expect(clipped.isWellFormed()).toBe(true);
    expect(clipped).toMatch(/^…😀+\.tsx$/u);
  }
});

test('change states the shared change without per-page labels, and only when there are facts', () => {
  const v = structuralDiff({
    baseline: fixture.cases.noop.structure,
    current: fixture.cases.color.structure,
    imagesIdentical: false,
    pixels: fixture.cases.color.pixels,
    escalate: { command: 'x' },
  });
  expect(v.change).toBe('style-only (color): button color #ffffff→#fef08a');
  expect(v.change!.length).toBeLessThanOrEqual(160);
  expect(Object.keys(v).slice(0, 5)).toEqual([
    'schema',
    'classification',
    'styleTags',
    'summary',
    'change',
  ]);
  const none = structuralDiff({
    baseline: fixture.cases.noop.structure,
    current: fixture.cases.noop.structure,
    imagesIdentical: true,
    pixels: fixture.cases.noop.pixels,
    escalate: { command: 'x' },
  });
  expect('change' in none).toBe(false);
});

test('structuralDiffWithCoverage returns every unexplained region, even the ones the budget drops from the verdict', () => {
  const a = fixture.cases.noop.structure;
  const b = structuredClone(a);
  for (const e of b.elements) {
    e.styles = {
      ...e.styles,
      opacity: '0.5',
      transform: 'matrix(1, 0, 0, 1, 1, 0)',
      'box-shadow': 'rgb(0, 0, 0) 0px 1px 2px 0px',
    };
  }
  const regions = Array.from({ length: 40 }, (_, k) => ({
    x: 16 + k * 10,
    y: 440,
    width: 8,
    height: 8,
  }));
  const input: StructuralDiffInput = {
    baseline: a,
    current: b,
    imagesIdentical: false,
    pixels: { changedRegions: regions, dimensionMismatch: false },
    escalate: ESC,
  };
  const { verdict, unexplainedRegions } = structuralDiffWithCoverage(input);
  expect(unexplainedRegions).toEqual(regions);
  expect(verdict.unexplainedRegions.length).toBeLessThan(regions.length);
  expect(JSON.stringify(verdict).length).toBeLessThanOrEqual(MAX_VERDICT);
  expect(structuralDiff(input)).toEqual(verdict);
});
