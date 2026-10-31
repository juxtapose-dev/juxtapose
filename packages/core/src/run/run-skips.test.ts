import { beforeEach, expect, test, vi } from 'vitest';
import type { Browser } from '../browser/browser.js';
import type { BaselineStore, StoryManifest } from '../types.js';
import { expandVariants } from '../capture/variants.js';
import { captureStory } from '../capture/capture.js';
import { runCapture, type RunArtifact } from './run.js';

// Exercise the actual orchestration and pool. Only the browser's capture is
// substituted: a live skip is the same null outcome the platform returns.
vi.mock('../capture/capture.js', async (original) => ({
  ...(await original<typeof import('../capture/capture.js')>()),
  captureStory: vi.fn(),
}));
const mk = (storyId: string, params: StoryManifest['params'] = {}): StoryManifest => ({
  storyId,
  title: 'T',
  name: storyId,
  componentPath: '',
  params,
});
beforeEach(() => {
  vi.mocked(captureStory).mockReset();
  vi.mocked(captureStory).mockImplementation(async (_page, story) =>
    story.storyId === 'live' || story.baseStoryId === 'live'
      ? null
      : {
          storyId: story.storyId,
          image: Buffer.from('image'),
          viewport: { width: 1, height: 1 },
          capturedAt: 't',
          durationMs: 1,
        },
  );
});
async function run(stories: StoryManifest[]) {
  const close = vi.fn(async () => {});
  const newContext = vi.fn(async () => ({ newPage: async () => ({}), close }));
  const browser = {
    version: () => 'fixture',
    isConnected: () => true,
    newContext,
  } as unknown as Browser;
  const store = {
    readManifest: async () => ({ version: 1, baselines: {} }),
  } as unknown as BaselineStore;
  const artifact = vi.fn(async (_artifact: RunArtifact) => {});
  const report = await runCapture({
    browser,
    platform: { name: 'fixture' } as never,
    store,
    baseUrl: 'about:blank',
    stories,
    totalCount: stories.length,
    runId: 'r',
    branch: 'b',
    commitSha: 'c',
    recheck: 'off',
    config: { concurrency: 1 },
    onArtifact: artifact,
  });
  return { report, artifact, newContext, close };
}

test('accounts for static, config and live skips exactly once beside captured variants', async () => {
  const stories = expandVariants(
    [mk('own', { skip: true }), mk('config'), mk('live'), mk('normal')],
    { dark: {} },
    { config: { skip: true }, normal__dark: { skip: true } },
  );
  const { report, artifact, close } = await run(stories);
  expect(report.results.map((r) => [r.storyId, r.status])).toEqual([
    ['config', 'skip'],
    ['live', 'skip'],
    ['live__dark', 'skip'],
    ['normal', 'new'],
    ['normal__dark', 'skip'],
    ['own', 'skip'],
  ]);
  expect(report.capturedCount).toBe(stories.length);
  expect(report.summary).toEqual({ pass: 0, fail: 0, new: 1, stale: 0, skip: 5 });
  expect(report.results.find((r) => r.storyId === 'config')?.skippedBy).toEqual([
    'config',
  ]);
  expect(report.results.find((r) => r.storyId === 'normal__dark')?.skippedBy).toEqual([
    'normal__dark',
  ]);
  for (const r of report.results.filter((r) => r.status === 'skip')) {
    expect(r.hash).toBeUndefined();
    expect(r.unstable).toBeUndefined();
    expect(r.unrechecked).toBeUndefined();
  }
  expect(report.results.find((r) => r.storyId === 'own')?.skippedBy).toBeUndefined();
  expect(vi.mocked(captureStory).mock.calls.map((c) => c[1].storyId)).toEqual([
    'live',
    'live__dark',
    'normal',
  ]);
  expect(artifact.mock.calls.map((c) => c[0].storyId)).toEqual(['normal']);
  expect(close).toHaveBeenCalledOnce();
});

test('all static skips remain explicit without opening any capture pages', async () => {
  const stories = expandVariants([mk('a', { skip: true }), mk('b', { skip: true })], {
    dark: {},
  });
  const { report, artifact, newContext } = await run(stories);
  expect(report.results.map((r) => [r.storyId, r.status])).toEqual([
    ['a', 'skip'],
    ['b', 'skip'],
  ]);
  expect(report.summary.skip).toBe(2);
  expect(report.capturedCount).toBe(2);
  expect(newContext).not.toHaveBeenCalled();
  expect(captureStory).not.toHaveBeenCalled();
  expect(artifact).not.toHaveBeenCalled();
});

test('config unskip and disabled variants retain their existing selected-key behavior', async () => {
  const stories = expandVariants(
    [mk('a', { skip: true, variants: { dark: false } })],
    { dark: {}, mobile: {} },
    { a: { skip: false } },
  );
  const { report } = await run(stories);
  expect(report.results.map((r) => [r.storyId, r.status])).toEqual([
    ['a', 'new'],
    ['a__mobile', 'new'],
  ]);
  expect(report.summary.skip).toBe(0);
});
