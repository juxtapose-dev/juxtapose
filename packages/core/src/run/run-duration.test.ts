import { expect, test, vi } from 'vitest';
import type { Browser } from '../browser/browser.js';
import type { BaselineStore } from '../types.js';
import { runCapture } from './run.js';

// An errored story reports the time it really took (issue #154): it used to
// record 0, so a hung story was invisible in slow-story stats.
vi.mock('../capture/pool.js', () => ({
  capturePool: (stories: Array<{ storyId: string }>) =>
    (async function* () {
      for (const story of stories) {
        yield { story, error: new Error('boom'), durationMs: 61_234 };
      }
    })(),
}));
vi.mock('../capture/env.js', () => ({
  captureEnv: () => ({ browser: 'x', os: 'y', encoder: 'z' }),
}));

const store: BaselineStore = {
  get: async () => null,
  put: async () => {},
  remove: async () => {},
  readManifest: async () => ({ version: 1, baselines: {} }),
  writeManifest: async () => {},
};

test('an errored story carries the elapsed durationMs, not 0', async () => {
  const r = await runCapture({
    browser: {} as Browser,
    platform: { name: 'x' } as never,
    store,
    baseUrl: 'about:blank',
    stories: [{ storyId: 's', title: 't', name: 'n', componentPath: '', params: {} }],
    totalCount: 1,
    runId: 'r',
    branch: 'b',
    commitSha: 'c',
  });
  expect(r.results[0]).toMatchObject({
    status: 'fail',
    error: 'boom',
    durationMs: 61_234,
  });
});
