import { beforeEach, expect, test, vi } from 'vitest';
import type { Browser } from '../browser/browser.js';
import type { RecheckMode } from '../config/schema.js';
import type { BaselineStore, ProjectConfig, StoryManifest } from '../types.js';
import { runCapture } from './run.js';

// `recheck` picks which stories the run captures a second time (#195):
// "changed" new and failing ones, "new" new ones only, "off" none.

let seen: string[] = [];
let readFirst = 0;

vi.mock('../capture/pool.js', () => ({
  capturePool: (stories: StoryManifest[]) =>
    (async function* () {
      for (const story of stories) {
        seen.push(story.storyId);
        const n = seen.filter((id) => id === story.storyId).length;
        // Every story captures differently the second time, so a story that
        // is rechecked is marked unstable and one that is not has no mark.
        yield {
          story,
          durationMs: 1,
          snapshot: {
            image: Buffer.from(`${story.storyId}-${n}`),
            viewport: { width: 1, height: 1 },
          },
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

/** `pass` matches its baseline, `fail` has a different one, `fresh` has none. */
async function run(opts: { recheck?: RecheckMode; config?: ProjectConfig } = {}) {
  seen = [];
  const { hashImage } = await import('../baseline/status.js');
  const entry = (body: string) => ({
    hash: hashImage(Buffer.from(body)),
    commit: 'c',
    approvedBy: 'u',
    approvedAt: 'a',
  });
  const store: BaselineStore = {
    get: async () => null,
    put: async () => {},
    remove: async () => {},
    readManifest: async () => ({
      version: 1,
      baselines: { pass: entry('pass-1'), fail: entry('something else') },
    }),
    writeManifest: async () => {},
  };
  return runCapture({
    browser: {} as Browser,
    platform: { name: 'x' } as never,
    store,
    baseUrl: 'about:blank',
    stories: ['pass', 'fail', 'fresh'].map(story),
    totalCount: 3,
    runId: 'r',
    branch: 'b',
    commitSha: 'c',
    ...(opts.config ? { config: opts.config } : {}),
    ...(opts.recheck ? { recheck: opts.recheck } : {}),
    readFirstCapture: async () => {
      readFirst++;
      return undefined;
    },
  });
}

const count = (id: string) => seen.filter((s) => s === id).length;
beforeEach(() => {
  readFirst = 0;
});

test('"changed" (the default) captures new and failing stories twice, passing ones once', async () => {
  const r = await run();
  expect([count('pass'), count('fail'), count('fresh')]).toEqual([1, 2, 2]);
  expect(r.recheck).toBe('changed');
  expect(r.results.find((x) => x.storyId === 'fail')!.unstable).toBeDefined();
  expect(r.results.some((x) => x.unrechecked)).toBe(false);
});

test('"new" captures only new stories twice; a failing one is left to approve', async () => {
  const r = await run({ recheck: 'new' });
  expect([count('pass'), count('fail'), count('fresh')]).toEqual([1, 1, 2]);
  expect(r.recheck).toBe('new');
  const fail = r.results.find((x) => x.storyId === 'fail')!;
  expect(fail.unrechecked).toBe(true);
  expect(fail.unstable).toBeUndefined();
  expect(r.results.find((x) => x.storyId === 'fresh')!.unstable).toBeDefined();
  expect(r.results.find((x) => x.storyId === 'pass')!.unrechecked).toBeUndefined();
});

test('"off" captures every story once, and says nothing was confirmed', async () => {
  const r = await run({ recheck: 'off' });
  expect([count('pass'), count('fail'), count('fresh')]).toEqual([1, 1, 1]);
  expect(r.recheck).toBe('off');
  for (const id of ['fail', 'fresh']) {
    const x = r.results.find((s) => s.storyId === id)!;
    expect(x.unrechecked).toBe(true);
    expect(x.unstable).toBeUndefined();
    expect(x.flake).toBeUndefined();
  }
  expect(readFirst).toBe(0);
});

test('the config sets the mode, and the call overrides it', async () => {
  expect((await run({ config: { recheck: 'off' } })).recheck).toBe('off');
  expect(count('fresh')).toBe(1);
  const r = await run({ config: { recheck: 'off' }, recheck: 'changed' });
  expect(r.recheck).toBe('changed');
  expect(count('fresh')).toBe(2);
});
