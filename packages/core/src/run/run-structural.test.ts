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
vi.mock('../capture/env.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../capture/env.js')>()),
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
    ...(storyId === 'no-current'
      ? {}
      : { structure: storyId === 'geometry' ? fixture.cases.padding.structure : CUR }),
    ...(storyId.startsWith('capped')
      ? {
          settle: {
            status: 'timeout' as const,
            timeoutMs: 1500,
            pending: ['1 request to /api/feed in flight (Fetch)'],
          },
        }
      : {}),
  };
}

const gone = async () => ({
  kind: 'unavailable' as const,
  reason: 'not-in-cache' as const,
});
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
        geometry: {
          ...meta,
          hash: 'not-the-current-hash',
          structureHash: BASE.structureHash,
        },
        "it's a story": {
          ...meta,
          hash: 'not-the-current-hash',
          structureHash: BASE.structureHash,
        },
        'no-current': { ...meta, hash: 'nope' },
        capped: { ...meta, hash: 'nope', structureHash: BASE.structureHash },
        'capped-green': { ...meta, hash: hashImage(Buffer.from('current-bytes')) },
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

test('saves measured control detail separately using the one existing sidecar read', async () => {
  const baseline = store('ok');
  const report = await run(baseline, 'geometry', {
    recheck: 'off',
    config: { renderer: { shared: false } },
  });
  const result = report.results[0];
  expect(result.status).toBe('fail');
  expect(result.controlGeometry?.observations).toEqual([
    expect.objectContaining({
      testId: 'save',
      height: { approved: 44, current: 52 },
      width: { approved: 65.38, current: 73.38 },
      provenance: 'structure',
    }),
  ]);
  expect(baseline.getStructure).toHaveBeenCalledTimes(1);
  expect(result.structural).not.toHaveProperty('controlGeometry');
  expect(JSON.stringify(result.structural).length).toBeLessThanOrEqual(1500);
  const restored = JSON.parse(JSON.stringify(report));
  expect(restored.results[0].controlGeometry).toEqual(result.controlGeometry);
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
  expect(r.results[0].controlGeometry).toBeUndefined();
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

// decodeStructure rejects the wrong shape at the boundary, so a malformed
// sidecar reads as absent, like a corrupt one, instead of throwing later
// inside the structural diff and losing the verdict.
test('a malformed decoded baseline never fails the run: still fail, reads as absent', async () => {
  const r = await run(store('malformed'));
  expect(r.results[0].status).toBe('fail');
  expect(r.results[0].structural?.flags).toContain('no-baseline-structure');
  expect(r.results[0].mismatchPixels).toBeGreaterThan(0);
});

test('a store whose getStructure throws never fails the run', async () => {
  const s = store('ok');
  s.getStructure!.mockRejectedValue(new Error('disk'));
  const r = await run(s);
  expect(r.results[0].status).toBe('fail');
  expect(r.results[0].structural?.flags).toContain('no-baseline-structure');
});

// The cache store holds hashes and structure in the repo but not the image, so
// a failing story with a cold cache must still be reported by hash and
// structure instead of erroring.
test('a baseline image missing from the store fails by hash with structure only', async () => {
  const s = { ...store('ok'), get: async () => null, lookup: gone };
  const r = await run(s);
  expect(r.results[0].status).toBe('fail');
  expect(r.results[0].error).toBeUndefined();
  expect(r.results[0].baselineImage).toBe('unavailable');
  expect(r.results[0].structural?.classification).toBe('style-only');
  // No pixel diff ran, so no pixel numbers are claimed.
  expect(r.results[0].mismatchPixels).toBe(0);
  expect(r.results[0].changedRegions).toEqual([]);
});

test('a missing baseline image and a missing sidecar still do not throw', async () => {
  const s = { ...store('missing'), get: async () => null, lookup: gone };
  const r = await run(s);
  expect(r.results[0].status).toBe('fail');
  expect(r.results[0].baselineImage).toBe('unavailable');
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

test('a capture at the settle cap is flagged on every status, in the verdict too', async () => {
  const settle = {
    status: 'timeout',
    timeoutMs: 1500,
    pending: ['1 request to /api/feed in flight (Fetch)'],
  };
  const failed = (await run(store('ok'), 'capped')).results[0]!;
  expect(failed.status).toBe('fail');
  expect(failed.flags).toEqual(['settle-timeout']);
  expect(failed.settle).toEqual(settle);
  expect(failed.structural?.flags.at(-1)).toBe('settle-timeout');
  // A pass is still a pass, and still says it was captured at the cap.
  const passed = (await run(store('ok'), 'capped-green')).results[0]!;
  expect(passed.status).toBe('pass');
  expect(passed.flags).toEqual(['settle-timeout']);
  // And a capture that settled carries neither key.
  const green = (await run(store('ok'), 'green')).results[0]!;
  expect(green).not.toHaveProperty('flags');
  expect(green).not.toHaveProperty('settle');
});

// #129: a determinism check between runs reads this instead of re-hashing
// images/*-current.webp by hand.
test('every captured result carries the sha256 the baseline compares', async () => {
  const pass = await run(store('ok'), 'green');
  expect(pass.results[0].status).toBe('pass');
  expect(pass.results[0].hash).toBe(hashImage(Buffer.from('current-bytes')));
  // A failure records the current capture's hash too, not the baseline's.
  const fail = await run(store('ok'));
  expect(fail.results[0].hash).toBe(hashImage(Buffer.from('current-bytes')));
});

test('unavailable image never claims a pixel comparison, whatever the verdict', async () => {
  // Identical structure, a style change, and a missing baseline sidecar: the
  // three summary branches that used to say "below tolerance".
  const same = store('ok');
  same.getStructure!.mockResolvedValue(encodeStructure(CUR));
  for (const s of [same, store('ok'), store('missing')]) {
    const r = await run({ ...s, get: async () => null, lookup: gone });
    const v = r.results[0].structural!;
    expect(v.summary).not.toMatch(/tolerance|changed region/);
    expect(v.summary).toMatch(/no pixel diff|no baseline image/i);
    expect(v.flags).not.toContain('sub-threshold');
  }
});

// A repo-backed store's image is supposed to be there, so its absence stays an
// error with the wording it always had.
test('a store that cannot say why keeps the original error', async () => {
  const r = await run({ ...store('ok'), get: async () => null });
  expect(r.results[0].error).toBe('baseline missing from store');
  expect(r.results[0].baselineImage).toBeUndefined();
});
