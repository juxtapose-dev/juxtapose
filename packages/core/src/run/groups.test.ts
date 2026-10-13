import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { structuralDiff } from '../diff/structural.js';
import type { ChangedRegion, DiffResult, StructureSnapshot } from '../types.js';
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
      summary: verdict('color').summary,
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
  // runner does not flake it. Measured 1.2 ms in pre-flight.
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
