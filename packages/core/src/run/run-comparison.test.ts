import { beforeAll, expect, test, vi } from 'vitest';
import sharp from 'sharp';
import { runCapture } from './run.js';
import { hashImage } from '../baseline/status.js';
import type { BaselineStore, ProjectConfig, Snapshot, StoryParams } from '../types.js';
import { resolveComparison } from '../diff/comparison.js';
import { describeVisualEquivalence } from '../report/comparison.js';

let baseline: Buffer;
let noise: Buffer;
let changed: Buffer;
let current: Buffer;
let livePolicy: Snapshot['comparison'];
vi.mock('../capture/env.js', () => ({
  captureEnv: () => ({ browser: 'test', os: 'test', encoder: 'test' }),
}));
vi.mock('../capture/pool.js', () => ({
  capturePool: (stories: Array<{ storyId: string }>) =>
    (async function* () {
      for (const story of stories)
        yield {
          story,
          snapshot: {
            storyId: story.storyId,
            image: current,
            comparison: livePolicy,
            viewport: { width: 20, height: 20 },
            durationMs: 1,
          },
        };
    })(),
}));
beforeAll(async () => {
  const pixels = Buffer.alloc(20 * 20 * 3, 255);
  for (let y = 5; y < 15; y++)
    for (let x = 5; x < 15; x++) pixels.fill(80, (y * 20 + x) * 3, (y * 20 + x) * 3 + 3);
  const encode = (b: Buffer) =>
    sharp(b, { raw: { width: 20, height: 20, channels: 3 } })
      .webp({ lossless: true })
      .toBuffer();
  baseline = await encode(pixels);
  const subtle = Buffer.from(pixels);
  subtle.fill(81, (5 * 20 + 5) * 3, (5 * 20 + 5) * 3 + 3);
  noise = await encode(subtle);
  const regression = Buffer.from(pixels);
  regression.fill(0, 0, 3);
  changed = await encode(regression);
});
async function run(
  options: {
    mode?: ProjectConfig['comparison'];
    story?: StoryParams['comparison'];
    live?: Snapshot['comparison'];
    image?: Buffer;
    missing?: boolean;
    corrupt?: boolean;
    stale?: boolean;
    newBaseline?: boolean;
  } = {},
) {
  current = options.image ?? noise;
  livePolicy = options.live;
  const get = vi.fn(async () =>
    options.missing ? null : options.corrupt ? changed : baseline,
  );
  const manifest = {
    version: 1 as const,
    baselines: options.newBaseline
      ? {}
      : {
          s: { hash: hashImage(baseline), commit: 'c', approvedBy: 'a', approvedAt: 't' },
        },
  };
  const before = JSON.stringify(manifest);
  const store = {
    readManifest: async () => manifest,
    get,
    lookup: async () => ({ kind: 'unavailable' }),
  } as unknown as BaselineStore;
  const artifacts: unknown[] = [];
  const report = await runCapture({
    browser: {} as never,
    platform: {} as never,
    baseUrl: 'x',
    store,
    stories: [
      {
        storyId: 's',
        title: 's',
        name: 's',
        componentPath: '',
        params: { comparison: options.story },
      },
    ],
    totalCount: 1,
    config: {
      renderer: { shared: false },
      comparison: options.mode,
      minDiffPercent: 100,
    },
    recheck: 'off',
    runId: 'r',
    branch: 'b',
    commitSha: 'c',
    ancestry: { isAncestor: () => !options.stale },
    onArtifact: async (a) => {
      artifacts.push(a);
    },
  });
  expect(JSON.stringify(manifest)).toBe(before);
  return { result: report.results[0]!, get, artifacts };
}
const perceptual = { mode: 'pixelmatch' } as const;
test('default remains exact even when the reporting diff filters all pixels', async () => {
  const { result } = await run();
  expect(result.status).toBe('fail');
  expect(result.comparison).toBeUndefined();
});
test('exact pass never reads baseline pixels', async () => {
  const { result, get } = await run({ mode: perceptual, image: baseline });
  expect(result.status).toBe('pass');
  expect(result.comparison).toBeUndefined();
  expect(get).not.toHaveBeenCalled();
});
test('opt-in equivalence records both hashes and filtering evidence without changing the manifest', async () => {
  const { result } = await run({ mode: perceptual });
  expect(result.status).toBe('pass');
  expect(result.hash).toBe(hashImage(noise));
  expect(result.comparison).toEqual({
    method: 'pixelmatch',
    threshold: 0.05,
    includeAA: false,
    baselineHash: hashImage(baseline),
    rawMismatchPixels: 1,
  });
  expect(describeVisualEquivalence([result])).toContain('not exact hash');
  expect(result.rendererRetry).toBeUndefined();
});
test('a single remaining pixel fails despite minDiffPercent', async () => {
  const { result } = await run({ mode: perceptual, image: changed });
  expect(result.status).toBe('fail');
  expect(result.mismatchPixels).toBeGreaterThan(0);
});
test.each([{ missing: true }, { corrupt: true }, { stale: true }])(
  'unavailable, corrupt or stale baseline cannot be accepted: %j',
  async (condition) => {
    expect((await run({ mode: perceptual, ...condition })).result.status).not.toBe(
      'pass',
    );
  },
);
test('new captures are still new', async () => {
  expect((await run({ mode: perceptual, newBaseline: true })).result.status).toBe('new');
});
test('story and live policies can require exact comparison', async () => {
  expect((await run({ mode: perceptual, story: { mode: 'exact' } })).result.status).toBe(
    'fail',
  );
  expect((await run({ mode: perceptual, live: { mode: 'exact' } })).result.status).toBe(
    'fail',
  );
  expect((await run({ story: perceptual })).result.status).toBe('pass');
});
test('dimension changes always fail', async () => {
  const image = await sharp({
    create: { width: 21, height: 20, channels: 3, background: 'white' },
  })
    .webp({ lossless: true })
    .toBuffer();
  expect((await run({ mode: perceptual, image })).result.error).toContain('viewport');
});
test.each([
  { mode: 'other' },
  { mode: 'pixelmatch', threshold: -1 },
  { mode: 'pixelmatch', threshold: NaN },
  { mode: 'pixelmatch', threshold: 1.1 },
  { mode: 'pixelmatch', maxDiffPixels: 5 },
])('invalid comparison is rejected: %j', (policy) => {
  expect(() => resolveComparison(policy as never)).toThrow();
});
