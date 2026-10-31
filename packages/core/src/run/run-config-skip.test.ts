import { expect, test, vi } from 'vitest';
import type { Browser } from '../browser/browser.js';
import type { BaselineStore, StoryManifest } from '../types.js';
import { buildHandoffPrompt } from '../agent/handoff.js';
import { expandVariants } from '../capture/variants.js';
import { runCapture } from './run.js';

// The pool does not yield pre-known skips; orchestration accounts for them
// and retains config attribution for the handoff.
vi.mock('../capture/pool.js', () => ({
  capturePool: (stories: StoryManifest[]) =>
    (async function* () {
      for (const story of stories.filter((s) => s.params.skip !== true)) {
        yield {
          story,
          snapshot: {
            storyId: story.storyId,
            image: Buffer.from('x'),
            viewport: { width: 1, height: 1 },
            capturedAt: 't',
            durationMs: 1,
          },
        };
      }
    })(),
}));
vi.mock('../capture/env.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../capture/env.js')>()),
  captureEnv: () => ({ browser: 'x', os: 'y', encoder: 'z' }),
}));

const store: BaselineStore = {
  get: async () => null,
  put: async () => {},
  remove: async () => {},
  readManifest: async () => ({ version: 1, baselines: {} }),
} as unknown as BaselineStore;

test('config and story skips are reported, with glob attribution only for config skips', async () => {
  const mk = (storyId: string, params = {}) => ({
    storyId,
    title: 'T',
    name: storyId,
    componentPath: '',
    params,
  });
  const stories = expandVariants(
    [mk('a--clock'), mk('a--own', { skip: true }), mk('a--ok')],
    undefined,
    { 'a--cl*': { skip: true } },
  );
  const report = await runCapture({
    browser: {} as Browser,
    platform: { name: 'x' } as never,
    store,
    baseUrl: 'about:blank',
    stories,
    totalCount: stories.length,
    runId: 'r',
    branch: 'b',
    commitSha: 'c',
  });
  const skip = report.results.filter((r) => r.status === 'skip');
  expect(skip.map((r) => [r.storyId, r.skippedBy])).toEqual([
    ['a--clock', ['a--cl*']],
    ['a--own', undefined],
  ]);
  expect(report.summary.skip).toBe(2);

  const prompt = buildHandoffPrompt({
    storyId: 'a--clock',
    storyTitle: 'T',
    status: 'skip',
    skippedBy: ['a--cl*'],
    mismatchPercent: 0,
    mismatchPixels: 0,
    changedRegions: [],
    viewport: { width: 1, height: 1 },
    componentPath: '',
    images: {},
    projectRoot: '/p',
  });
  expect(prompt).toContain('skipped by the project config');
  expect(prompt).toContain('`a--cl*`');
});
