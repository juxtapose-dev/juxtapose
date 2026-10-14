import { expect, test, vi } from 'vitest';
import type { Browser } from '../browser/browser.js';
import type { BaselineStore, StoryManifest } from '../types.js';
import { runCapture } from './run.js';

// Approval requires two identical captures (#148): the run captures each new
// or failing story again, and never a passing one.

const captures: string[] = [];
let flaky = new Set<string>();

vi.mock('../capture/pool.js', () => ({
  capturePool: (stories: StoryManifest[]) =>
    (async function* () {
      for (const story of stories) {
        captures.push(story.storyId);
        const n = captures.filter((id) => id === story.storyId).length;
        const body = flaky.has(story.storyId) ? `${story.storyId}-${n}` : story.storyId;
        yield {
          story,
          durationMs: 1,
          snapshot: { image: Buffer.from(body), viewport: { width: 1, height: 1 } },
        };
      }
    })(),
}));
vi.mock('../capture/env.js', () => ({
  captureEnv: () => ({ browser: 'x', os: 'y', encoder: 'z' }),
}));
const story = (storyId: string): StoryManifest => ({
  storyId,
  title: 't',
  name: storyId,
  componentPath: '',
  params: {},
});

async function hashOf(body: string): Promise<string> {
  const { hashImage } = await import('../baseline/status.js');
  return hashImage(Buffer.from(body));
}

async function run(ids: string[], baselined: string[] = []) {
  captures.length = 0;
  const baselines = Object.fromEntries(
    await Promise.all(
      baselined.map(async (id) => [
        id,
        { hash: await hashOf(id), commit: 'c', approvedBy: 'u', approvedAt: 'a' },
      ]),
    ),
  );
  const store: BaselineStore = {
    get: async () => null,
    put: async () => {},
    remove: async () => {},
    readManifest: async () => ({ version: 1, baselines }),
    writeManifest: async () => {},
  };
  return runCapture({
    browser: {} as Browser,
    platform: { name: 'x' } as never,
    store,
    baseUrl: 'about:blank',
    stories: ids.map(story),
    totalCount: ids.length,
    runId: 'r',
    branch: 'b',
    commitSha: 'c',
  });
}

test('a new story whose captures differ is marked unstable with both hashes', async () => {
  flaky = new Set(['rand']);
  const r = await run(['rand', 'steady']);
  const rand = r.results.find((x) => x.storyId === 'rand')!;
  const steady = r.results.find((x) => x.storyId === 'steady')!;
  expect(rand.status).toBe('new');
  expect(rand.unstable?.hashes[0]).not.toBe(rand.unstable?.hashes[1]);
  expect(rand.unstable?.hashes[0]).toBe(rand.hash);
  expect(steady.unstable).toBeUndefined();
});

test('passing stories are captured exactly once; new ones twice', async () => {
  flaky = new Set();
  const r = await run(['ok', 'fresh'], ['ok']);
  expect(r.results.find((x) => x.storyId === 'ok')!.status).toBe('pass');
  expect(captures.filter((id) => id === 'ok')).toHaveLength(1);
  expect(captures.filter((id) => id === 'fresh')).toHaveLength(2);
});

test('an all-green run captures each story once', async () => {
  flaky = new Set();
  await run(['a', 'b'], ['a', 'b']);
  expect(captures).toEqual(['a', 'b']);
});
