import { readFileSync } from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { expect, test, vi } from 'vitest';
import type { Browser } from '../browser/browser.js';
import { encodeStructure } from '../capture/structure.js';
import { hashImage } from '../baseline/status.js';
import type { BaselineStore, ChangedRegion, StructureSnapshot } from '../types.js';
import { runCapture } from './run.js';

// Drive runCapture with a stubbed pool: we test the judge, not the browser.
const dims = vi.hoisted(() => ({ on: false }));
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
  diffImages: async () => ({ ...fixture.cases.color.pixels, dimensionMismatch: dims.on }),
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
function store(
  sidecar: 'ok' | 'missing' | 'corrupt' | 'unsupported' | 'malformed',
): BaselineStore & {
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
        "it's a story": {
          ...meta,
          hash: 'not-the-current-hash',
          structureHash: BASE.structureHash,
        },
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
        : sidecar === 'malformed'
          ? gzipSync(Buffer.from('{"structureHash":"x","elements":42}'))
          : sidecar === 'corrupt'
            ? Buffer.from('zzz')
            : null,
    ),
  };
}

const run = (
  s: BaselineStore,
  storyId = 's',
  extra: Partial<Parameters<typeof runCapture>[0]> = {},
) =>
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
    ...extra,
  });

test('a failing story with sidecars on both sides carries a verdict', async () => {
  const r = await run(store('ok'));
  expect(r.results[0].status).toBe('fail');
  expect(r.results[0].structural?.classification).toBe('style-only');
  // In run mode the next command is the handoff for this story.
  expect(r.results[0].structural?.escalate.command).toBe('jux handoff s');
});

// Every printed command is pasteable: an id with a space or a quote is
// shell-quoted like the CLI's own hints.
test('the handoff escalate command shell-quotes the story id', async () => {
  const r = await run(store('ok'), "it's a story");
  expect(r.results[0].structural?.escalate.command).toBe(
    "jux handoff 'it'\\''s a story'",
  );
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

test('a malformed decoded baseline never fails the run: still fail, no structural', async () => {
  const r = await run(store('malformed'));
  expect(r.results[0].status).toBe('fail');
  expect(r.results[0].structural).toBeUndefined();
  expect(r.results[0].mismatchPixels).toBeGreaterThan(0);
});

test('a store whose getStructure throws never fails the run', async () => {
  const s = store('ok');
  s.getStructure!.mockRejectedValue(new Error('disk'));
  const r = await run(s);
  expect(r.results[0].status).toBe('fail');
  expect(r.results[0].structural?.flags).toContain('no-baseline-structure');
});

test('a baseline missing from the store has no structural', async () => {
  const s = { ...store('ok'), get: async () => null };
  const r = await run(s);
  expect(r.results[0].error).toBe('baseline missing from store');
  expect(r.results[0].structural).toBeUndefined();
});

test('a dimension mismatch carries the error and still a verdict', async () => {
  dims.on = true;
  try {
    const r = await run(store('ok'));
    expect(r.results[0].error).toBe('viewport size changed since baseline');
    expect(r.results[0].structural).toBeDefined();
  } finally {
    dims.on = false;
  }
});

test('with a cause index, a failing verdict carries the cause', async () => {
  const cause = {
    kind: 'in-closure' as const,
    files: [{ path: 'src/x.ts', distance: 1 }],
  };
  const causeFor = vi.fn(async () => cause);
  const r = await run(store('ok'), 's', { cause: { causeFor } });
  expect(r.results[0].structural?.cause).toEqual(cause);
  expect(causeFor).toHaveBeenCalledWith('');
});

// Verification 5: the index is never consulted for a passing story.
test('a passing story never asks the cause index', async () => {
  const causeFor = vi.fn(async () => ({ kind: 'unknown' as const, files: [] }));
  const r = await run(store('ok'), 'green', { cause: { causeFor } });
  expect(r.results[0].status).toBe('pass');
  expect(causeFor).not.toHaveBeenCalled();
});

test('a cause index that throws leaves the verdict without a cause, run intact', async () => {
  const causeFor = vi.fn(async () => {
    throw new Error('git exploded');
  });
  const r = await run(store('ok'), 's', { cause: { causeFor } });
  expect(r.results[0].status).toBe('fail');
  expect(r.results[0].structural?.classification).toBe('style-only');
  expect(r.results[0].structural?.cause).toBeUndefined();
});

test('two failing stories with the same change are one group on the report', async () => {
  const s = store('ok');
  // The store's manifest only knows 's'; a second id with the same baseline
  // row is enough, since the stub pool yields the same current capture.
  const manifest = await s.readManifest();
  s.readManifest = async () => ({
    ...manifest,
    baselines: { ...manifest.baselines, s2: manifest.baselines.s },
  });
  const r = await runCapture({
    browser: {} as Browser,
    platform: { name: 'x' } as never,
    store: s,
    baseUrl: 'about:blank',
    stories: ['s2', 's'].map((storyId) => ({
      storyId,
      title: 't',
      name: 'n',
      componentPath: '',
      params: {},
    })),
    totalCount: 2,
    runId: 'r',
    branch: 'b',
    commitSha: 'c',
  });
  expect(r.results.map((x) => x.storyId)).toEqual(['s', 's2']);
  expect(r.groups).toEqual([
    {
      signature: r.results[0].structural!.signature,
      summary: `${r.results[0].structural!.change} — 2 stories`,
      storyIds: ['s', 's2'],
    },
  ]);
});

test('a run with no shared signature has no groups key', async () => {
  const r = await run(store('ok'));
  expect('groups' in r).toBe(false);
});
