import { beforeEach, expect, test, vi } from 'vitest';
import { runCapture } from './run.js';
import { hashImage } from '../baseline/status.js';
import type { BaselineStore, StoryManifest } from '../types.js';
import type { PoolOptions } from '../capture/pool.js';

let calls: { ids: string[]; options: PoolOptions }[];
let retry: 'match' | 'mismatch' | 'error' | 'reused' | 'skip';
let mismatches: string[];
vi.mock('../capture/env.js', () => ({
  captureEnv: () => ({ browser: 'x', os: 'y', encoder: 'z' }),
}));
vi.mock('../capture/pool.js', () => ({
  capturePool: (stories: StoryManifest[], options: PoolOptions) =>
    (async function* () {
      const first = calls.length === 0;
      calls.push({ ids: stories.map((s) => s.storyId), options });
      for (const story of stories.slice().reverse()) {
        if (!first && retry === 'error') {
          yield { story, error: new Error('retry failed'), durationMs: 1 };
          continue;
        }
        if (!first && retry === 'skip') {
          yield { story, skipped: true, durationMs: 1 };
          continue;
        }
        const body = first
          ? mismatches.includes(story.storyId)
            ? 'history'
            : 'baseline'
          : retry === 'mismatch'
            ? 'changed'
            : 'baseline';
        yield {
          story,
          durationMs: 1,
          snapshot: {
            storyId: story.storyId,
            image: Buffer.from(body),
            viewport: { width: 1, height: 1 },
            durationMs: 1,
            renderer: { shared: first, clearResourceCache: false },
            rendererReused: !first && retry === 'reused',
          },
        };
      }
    })(),
}));

beforeEach(() => {
  calls = [];
  retry = 'match';
  mismatches = ['s00'];
});
async function run(recheck: 'changed' | 'new' | 'off' = 'off') {
  const stories: StoryManifest[] = Array.from({ length: 10 }, (_, i) => ({
    storyId: `s${String(i).padStart(2, '0')}`,
    title: 't',
    name: 'n',
    componentPath: '',
    params: {},
  }));
  const store = {
    readManifest: async () => ({
      version: 1,
      baselines: Object.fromEntries(
        stories.map((s) => [
          s.storyId,
          {
            hash: hashImage(Buffer.from('baseline')),
            commit: 'c',
            approvedBy: 'u',
            approvedAt: 'a',
          },
        ]),
      ),
    }),
    get: async () => null,
    lookup: async () => null,
  } as unknown as BaselineStore;
  const artifacts: { storyId: string; status: string; current: Buffer }[] = [];
  const report = await runCapture({
    browser: {} as never,
    platform: {} as never,
    store,
    baseUrl: 'x',
    stories,
    totalCount: 10,
    config: { renderer: { shared: true } },
    recheck,
    runId: 'r',
    branch: 'b',
    commitSha: 'c',
    onArtifact: async (a) => {
      artifacts.push(a);
    },
  });
  return { report, artifacts };
}

test.each(['changed', 'new', 'off'] as const)(
  'fresh baseline match passes independently of recheck %s',
  async (mode) => {
    const { report, artifacts } = await run(mode);
    const result = report.results[0]!;
    expect(result).toMatchObject({
      status: 'pass',
      hash: hashImage(Buffer.from('baseline')),
      rendererRetry: { outcome: 'resolved' },
      durationMs: 2,
    });
    expect(result.unstable).toBeUndefined();
    expect(result.unrechecked).toBeUndefined();
    expect(calls).toHaveLength(2);
    expect(calls[1]!.options).toMatchObject({
      forceFreshRenderer: true,
      warmSwitch: false,
    });
    expect(calls[0]!.options.renderers).toBe(calls[1]!.options.renderers);
    expect(artifacts.at(-1)?.current.toString()).toBe('baseline');
  },
);

test('caps retries deterministically, regardless of completion order', async () => {
  mismatches = ['s09', 's00'];
  const { report } = await run();
  expect(calls[1]!.ids).toEqual(['s00']);
  expect(report.results[9]).toMatchObject({
    status: 'fail',
    rendererRetry: { outcome: 'cap' },
    unrechecked: true,
  });
});

test.each(['error', 'reused', 'skip'] as const)('fails closed on %s', async (outcome) => {
  retry = outcome;
  const { report } = await run('changed');
  expect(report.results[0]).toMatchObject({
    status: 'fail',
    rendererRetry: { outcome: 'unconfirmed' },
  });
  expect(report.results[0]!.unstable?.unconfirmed).toBeTruthy();
  expect(calls).toHaveLength(2);
});

test('a fresh mismatch becomes current and is confirmed fresh against fresh', async () => {
  retry = 'mismatch';
  const { report, artifacts } = await run('changed');
  expect(report.results[0]).toMatchObject({
    status: 'fail',
    hash: hashImage(Buffer.from('changed')),
    rendererRetry: { outcome: 'mismatch' },
  });
  expect(report.results[0]!.unstable).toBeUndefined();
  expect(calls).toHaveLength(3);
  expect(calls[2]!.options.forceFreshRenderer).toBe(true);
  expect(artifacts.at(-1)?.current.toString()).toBe('changed');
});
