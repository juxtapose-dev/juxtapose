import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import type { Browser } from 'playwright';
import { encodeStructure } from '../capture/structure.js';
import { hashImage } from '../baseline/status.js';
import type { BaselineStore, ChangedRegion, StructureSnapshot } from '../types.js';
import { runCapture } from './run.js';

// Drive runCapture with a stubbed pool: we test the judge, not the browser.
vi.mock('../capture/pool.js', () => ({
  capturePool: (stories: Array<{ storyId: string }>) =>
    (async function* () {
      for (const story of stories) yield { story, snapshot: current(story.storyId) };
    })(),
}));
vi.mock('../capture/env.js', () => ({
  captureEnv: () => ({ browser: 'x', os: 'y', encoder: 'z' }),
}));
// The pixel diff is the real one from the fixture (the `color` operator
// against the base), not a hand-written region list.
const fixture = JSON.parse(
  readFileSync(
    path.join(import.meta.dirname, '../diff/__fixtures__/structural-corpus.json'),
    'utf8',
  ),
) as {
  cases: Record<
    string,
    {
      structure: StructureSnapshot;
      pixels: {
        mismatchPixels: number;
        mismatchPercent: number;
        changedRegions: ChangedRegion[];
        dimensionMismatch: boolean;
      };
    }
  >;
};
const BASE = fixture.cases.noop.structure;
const CUR = fixture.cases.color.structure;
vi.mock('../diff/diff.js', async (orig) => ({
  ...(await orig<typeof import('../diff/diff.js')>()),
  diffImages: async () => fixture.cases.color.pixels,
}));

function current(storyId: string) {
  return {
    storyId,
    image: Buffer.from('current-bytes'),
    viewport: BASE.viewport,
    capturedAt: 't',
    durationMs: 1,
    ...(storyId === 'no-current' ? {} : { structure: CUR }),
  };
}

const meta = { commit: 'c', approvedBy: 'a', approvedAt: 't' };
function store(sidecar: 'ok' | 'missing' | 'corrupt' | 'unsupported'): BaselineStore & {
  getStructure?: ReturnType<typeof vi.fn>;
} {
  const base: BaselineStore = {
    get: async () => Buffer.from('baseline-bytes'),
    put: async () => {},
    remove: async () => {},
    readManifest: async () => ({
      version: 1,
      baselines: {
        s: { ...meta, hash: 'not-the-current-hash', structureHash: BASE.structureHash },
        'no-current': { ...meta, hash: 'nope' },
        // hash equals the captured bytes: this story passes
        green: {
          ...meta,
          hash: hashImage(Buffer.from('current-bytes')),
          structureHash: BASE.structureHash,
        },
      },
    }),
    writeManifest: async () => {},
  };
  if (sidecar === 'unsupported') return base;
  return {
    ...base,
    getStructure: vi.fn(async () =>
      sidecar === 'ok'
        ? encodeStructure(BASE)
        : sidecar === 'corrupt'
          ? Buffer.from('zzz')
          : null,
    ),
  };
}

const run = (s: BaselineStore, storyId = 's') =>
  runCapture({
    browser: {} as Browser,
    platform: { name: 'x' } as never,
    store: s,
    baseUrl: 'about:blank',
    stories: [{ storyId, title: 't', name: 'n', componentPath: '', params: {} }],
    totalCount: 1,
    runId: 'r',
    branch: 'b',
    commitSha: 'c',
  });

test('a failing story with sidecars on both sides carries a verdict', async () => {
  const r = await run(store('ok'));
  expect(r.results[0].status).toBe('fail');
  expect(r.results[0].structural?.classification).toBe('style-only');
  // In run mode the next command is the handoff for this story.
  expect(r.results[0].structural?.escalate.command).toBe('jux handoff s');
});

// Verification 5: a green story never reads a sidecar.
test('a passing story never calls getStructure and carries no structural', async () => {
  const s = store('ok');
  const r = await run(s, 'green');
  expect(r.results[0].status).toBe('pass');
  expect(r.results[0].structural).toBeUndefined();
  expect(s.getStructure).not.toHaveBeenCalled();
});

test('baseline sidecar missing (hash in manifest, no file) → no-baseline-structure, no throw', async () => {
  const r = await run(store('missing'));
  expect(r.results[0].structural?.flags).toContain('no-baseline-structure');
});

test('corrupt baseline sidecar reads as absent', async () => {
  const r = await run(store('corrupt'));
  expect(r.results[0].structural?.flags).toContain('no-baseline-structure');
});

test('a store without getStructure still produces a verdict flagged no-baseline-structure', async () => {
  const r = await run(store('unsupported'));
  expect(r.results[0].structural?.flags).toContain('no-baseline-structure');
});

test('no current structure → no structural at all', async () => {
  const r = await run(store('ok'), 'no-current');
  expect(r.results[0].structural).toBeUndefined();
});
