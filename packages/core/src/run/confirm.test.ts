import { beforeEach, expect, test, vi } from 'vitest';
import type { Browser } from '../browser/browser.js';
import type { StoryManifest } from '../types.js';
import { confirmCaptures } from './confirm.js';

// `jux approve` confirms a story the run captured once (#195): one more
// capture, and it is stable only if the hash matches the run's.

let seen: string[] = [];
let outcome: (id: string) => 'same' | 'differs' | 'error' = () => 'same';

vi.mock('../capture/pool.js', () => ({
  capturePool: (
    stories: StoryManifest[],
    options: { forceFreshRenderer?: boolean; warmSwitch?: boolean },
  ) =>
    (async function* () {
      expect(options.forceFreshRenderer).toBe(true);
      expect(options.warmSwitch).toBe(false);
      for (const story of stories) {
        seen.push(story.storyId);
        const o = outcome(story.storyId);
        if (o === 'error') {
          yield { story, error: new Error('timed out'), durationMs: 1 };
          continue;
        }
        yield {
          story,
          durationMs: 1,
          snapshot: {
            image: Buffer.from(o === 'same' ? story.storyId : `${story.storyId}!`),
            viewport: { width: 1, height: 1 },
          },
        };
      }
    })(),
}));

const story = (storyId: string): StoryManifest => ({
  storyId,
  title: 't',
  name: storyId,
  componentPath: '',
  params: {},
});
const browser = { version: () => '1.0' } as unknown as Browser;

async function confirm(
  ids: string[],
  env?: Parameters<typeof confirmCaptures>[0]['env'],
) {
  const { hashImage } = await import('../baseline/status.js');
  return confirmCaptures({
    browser,
    platform: { name: 'x' } as never,
    baseUrl: 'about:blank',
    stories: ids.map(story),
    hashes: new Map(ids.map((id) => [id, hashImage(Buffer.from(id))])),
    ...(env ? { env } : {}),
  });
}
beforeEach(() => {
  seen = [];
  outcome = () => 'same';
});

test('takes exactly one more capture per story; identical hashes confirm it', async () => {
  const r = await confirm(['a', 'b']);
  expect(seen).toEqual(['a', 'b']);
  expect(r.map((c) => c.unstable)).toEqual([undefined, undefined]);
});

test('a differing capture is unstable with both hashes; an error is unconfirmed', async () => {
  outcome = (id) => (id === 'flaky' ? 'differs' : id === 'slow' ? 'error' : 'same');
  const r = await confirm(['flaky', 'slow', 'steady']);
  const by = Object.fromEntries(r.map((c) => [c.storyId, c.unstable]));
  expect(by['flaky']?.hashes).toHaveLength(2);
  expect(by['flaky']?.unconfirmed).toBeUndefined();
  expect(by['slow']?.unconfirmed).toMatch(/timed out/);
  expect(by['steady']).toBeUndefined();
});

test('a different capture environment confirms nothing and captures nothing', async () => {
  const r = await confirm(['a'], { browser: '0.1', os: 'x', encoder: 'y' });
  expect(seen).toEqual([]);
  expect(r[0]!.unstable?.unconfirmed).toMatch(
    /environment differs.*browser 0\.1 -> 1\.0/,
  );
});
