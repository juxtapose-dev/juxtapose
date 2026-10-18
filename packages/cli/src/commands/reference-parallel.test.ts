import { expect, test, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const tracker = vi.hoisted(() => ({
  active: 0,
  peak: 0,
  finished: [] as string[],
  firstGate: Promise.resolve(),
  releaseFirst: () => {},
}));
vi.mock('@juxtapose/core', async (original) => {
  const core = await original<typeof import('@juxtapose/core')>();
  return {
    ...core,
    compareDesignReference: async (
      input: Parameters<typeof core.compareDesignReference>[0],
    ) => {
      tracker.active++;
      tracker.peak = Math.max(tracker.peak, tracker.active);
      try {
        const result = await core.compareDesignReference(input);
        // Force a peer to complete first, independent of machine I/O timings.
        if (input.name === 'a0') await tracker.firstGate;
        return result;
      } finally {
        tracker.active--;
        tracker.finished.push(input.name);
        if (input.name === 'a1') tracker.releaseFirst();
      }
    },
  };
});
import { evaluateReferences } from './reference.js';

// Actual tiny PNG/WebP pixels keep this independent of browser/native capture.
const white = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAwAAAAICAYAAADN5B7xAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAE0lEQVQYlWP4TyJgGNVABCA5lADspH6QblB3gwAAAABJRU5ErkJggg==',
  'base64',
);
const black = Buffer.from('UklGRhoAAABXRUJQVlA4TA4AAAAvC8ABAAcQEf0PRET/Aw==', 'base64');

test('bounded overlap retains name order, omissions and per-target failures', async () => {
  tracker.firstGate = new Promise<void>((resolve) => {
    tracker.releaseFirst = resolve;
  });
  const root = await mkdtemp(path.join(tmpdir(), 'jux-reference-parallel-'));
  try {
    const run = path.join(root, '.juxtapose/runs/r1');
    await mkdir(path.join(run, 'images'), { recursive: true });
    await mkdir(path.join(root, 'design'));
    await writeFile(path.join(root, 'design/target.png'), white);
    await writeFile(path.join(run, 'images/card-current.webp'), black);
    await writeFile(
      path.join(run, 'report.json'),
      JSON.stringify({
        runId: 'r1',
        results: [
          { storyId: 'card', status: 'fail', viewport: { width: 12, height: 8 } },
        ],
      }),
    );
    const target = {
      storyId: 'card',
      image: 'design/target.png',
      viewport: { width: 12, height: 8 },
    };
    const names = Array.from({ length: 9 }, (_, i) => `a${i}`);
    const designReferences = {
      ...Object.fromEntries([...names].reverse().map((name) => [name, target])),
      broken: { ...target, image: 'design/missing.png' },
      omitted: { ...target, storyId: 'absent' },
    };
    await writeFile(
      path.join(root, 'juxtapose.config.json'),
      JSON.stringify({ designReferences }),
    );
    const result = await evaluateReferences({ project: root });
    expect(tracker.peak).toBeGreaterThan(1);
    expect(tracker.peak).toBeLessThanOrEqual(4);
    expect(tracker.active).toBe(0);
    expect(tracker.finished[0]).not.toBe('a0');
    expect(result.states.map((state) => state.name)).toEqual([...names, 'broken']);
    expect(result.summary).toMatchObject({ fail: 9, error: 1, notCaptured: 1 });
    expect(result.states.at(-1)).toMatchObject({ name: 'broken', status: 'error' });
    // Disk-cache hits retain exactly the same evidence and ordering.
    expect(await evaluateReferences({ project: root })).toEqual(result);
    const first = result.states[0]!;
    expect('regions' in first && first.regions.length).toBeGreaterThan(0);
    const regionId = 'regions' in first ? first.regions[0]!.id : '';
    const named = await evaluateReferences({ project: root, name: 'a0', regionId });
    tracker.firstGate = new Promise<void>((resolve) => {
      tracker.releaseFirst = resolve;
    });
    const aggregate = await evaluateReferences({ project: root, regionId });
    expect(aggregate.crop).toEqual(named.crop);
    expect(aggregate.crop?.regionId).toBe(regionId);
    expect(aggregate.states).toEqual(result.states);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
