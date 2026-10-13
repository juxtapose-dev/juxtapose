import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { structuralDiff } from '../diff/structural.js';
import type {
  ChangedRegion,
  DiffResult,
  StructuralVerdict,
  StructureSnapshot,
} from '../types.js';
import { computeGroups } from './groups.js';

// Real verdicts from the corpus fixture, so the signatures are the ones
// production computes.
const fixture = JSON.parse(
  readFileSync(
    path.join(import.meta.dirname, '../diff/__fixtures__/structural-corpus.json'),
    'utf8',
  ),
) as {
  cases: Record<
    string,
    {
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
  >;
};
const verdict = (name: string) =>
  structuralDiff({
    baseline: fixture.cases[fixture.cases[name].against].structure,
    current: fixture.cases[name].structure,
    imagesIdentical: fixture.cases[name].imagesIdentical,
    pixels: fixture.cases[name].pixels,
    escalate: { command: `jux handoff ${name}` },
  });
const fail = (storyId: string, op: string): DiffResult => ({
  storyId,
  status: 'fail',
  mismatchPixels: 1,
  mismatchPercent: 0.1,
  changedRegions: [],
  durationMs: 1,
  structural: verdict(op),
});

test('two stories with the same change share a group; a lone change does not', () => {
  const groups = computeGroups([
    fail('b--one', 'color'),
    fail('a--two', 'color'),
    fail('c--three', 'padding'),
  ]);
  expect(groups).toEqual([
    {
      signature: verdict('color').signature,
      summary: `${verdict('color').change} — 2 stories`,
      storyIds: ['a--two', 'b--one'],
    },
  ]);
});

test('only failing results with a verdict count', () => {
  const pass: DiffResult = { ...fail('p', 'color'), status: 'pass' };
  const noVerdict: DiffResult = { ...fail('n', 'color'), structural: undefined };
  expect(computeGroups([pass, noVerdict, fail('x', 'color')])).toEqual([]);
});

test('groups sort by size, then signature, with ids in code-unit order', () => {
  const groups = computeGroups([
    fail('Z', 'padding'),
    fail('a', 'padding'),
    fail('b', 'padding'),
    fail('y', 'color'),
    fail('x', 'color'),
  ]);
  expect(groups.map((g) => g.storyIds)).toEqual([
    ['Z', 'a', 'b'], // 'Z' < 'a' by code unit
    ['x', 'y'],
  ]);
  const flipped = computeGroups([
    fail('x', 'color'),
    fail('y', 'color'),
    fail('b', 'padding'),
    fail('a', 'padding'),
    fail('Z', 'padding'),
  ]);
  expect(JSON.stringify(flipped)).toBe(JSON.stringify(groups));
});

// Review Focus 3. One verdict reused for every result: building 5,000 real
// verdicts is ~300 ms of structuralDiff that has nothing to do with grouping.
test('5,000 failing stories with one signature are one group, under 50 ms', () => {
  const v = verdict('color');
  const one = fail('story', 'color');
  const results = Array.from({ length: 5000 }, (_, k) => ({
    ...one,
    storyId: `story-${k}`,
    structural: v,
  }));
  const groups = computeGroups(results);
  expect(groups).toHaveLength(1);
  expect(groups[0].storyIds).toHaveLength(5000);
  // Timing: one warm-up, then best of 3, so a cold run on a contended CI
  // runner does not flake it. Measured 0.4 ms.
  computeGroups(results);
  let ms = Infinity;
  for (let k = 0; k < 3; k++) {
    const t = performance.now();
    computeGroups(results);
    ms = Math.min(ms, performance.now() - t);
  }
  console.log(`computeGroups 5000 results: ${ms.toFixed(1)} ms (best of 3)`);
  expect(ms).toBeLessThan(50);
});

test('500 distinct shared signatures are 500 groups, each small', () => {
  const v = verdict('color');
  const results: DiffResult[] = [];
  for (let s = 0; s < 500; s++) {
    for (const k of [0, 1])
      results.push({
        ...fail(`s${s}-${k}`, 'color'),
        structural: { ...v, signature: `sig-${s}` },
      });
  }
  const groups = computeGroups(results);
  expect(groups).toHaveLength(500);
  expect(JSON.stringify(groups[0]).length).toBeLessThan(600);
});

// The same change on three pages whose buttons carry different names: the
// signature matches (it abstracts to role|tag), and the text a human reads
// must not name any one page's button.
function namedButton(name: string): StructuralVerdict {
  const c = fixture.cases.color;
  const rename = (snap: StructureSnapshot): StructureSnapshot => ({
    ...snap,
    elements: snap.elements.map((e) => (e.role === 'button' ? { ...e, name } : e)),
  });
  return structuralDiff({
    baseline: rename(fixture.cases[c.against].structure),
    current: rename(c.structure),
    imagesIdentical: c.imagesIdentical,
    pixels: c.pixels,
    escalate: { command: 'jux handoff x' },
  });
}

test("a group describes the shared change, not one page's element names", () => {
  const results = ['Save', 'Cancel', 'Delete'].map((n, k) => ({
    ...fail(`button--${k}`, 'color'),
    structural: namedButton(n),
  }));
  expect(new Set(results.map((r) => r.structural!.signature)).size).toBe(1);
  expect(results[0].structural!.summary).toContain('[name=');
  const [g] = computeGroups(results);
  expect(g.summary).not.toContain('[name=');
  expect(g.summary).toBe('style-only (color): button color #ffffff→#fef08a — 3 stories');
});

// A signature with no facts is shared by unrelated failures: every
// identical, drifting, resized or structure-less story hashes alike.
test('stories with no deltas never group, whatever their class', () => {
  const noop = fixture.cases.noop;
  const base = {
    baseline: noop.structure,
    current: noop.structure,
    imagesIdentical: false,
    pixels: noop.pixels,
    escalate: { command: 'jux handoff x' },
  };
  const variants: StructuralVerdict[] = [
    structuralDiff({ ...base, imagesIdentical: true }),
    structuralDiff({
      ...base,
      pixels: {
        ...noop.pixels,
        changedRegions: fixture.cases.canvas.pixels.changedRegions,
      },
    }),
    structuralDiff({ ...base, pixels: { ...noop.pixels, dimensionMismatch: true } }),
    structuralDiff({ ...base, baseline: undefined }),
  ];
  expect(variants.map((v) => v.deltaCount)).toEqual([0, 0, 0, 0]);
  for (const v of variants) {
    const results = [0, 1, 2].map((k) => ({
      ...fail(`s${k}`, 'noop'),
      structural: v,
    }));
    expect(computeGroups(results), v.classification).toEqual([]);
  }
});
