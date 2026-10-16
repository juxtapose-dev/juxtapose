import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import type { Browser } from '../browser/browser.js';
import type { Platform } from '../platform.js';
import { prepareCaptures } from '../capture/discover.js';

it('passes the same selection to discovery and cache keying before expanding variants', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'jux-selection-cache-'));
  try {
    const discoverParams = vi.fn(
      async (_page, _url, ids?: readonly string[]) =>
        new Map(
          (ids ?? ['a', 'b']).map((id) => [
            id,
            { variants: { dark: { colorScheme: 'dark' as const } } },
          ]),
        ),
    );
    const discoveryKey = vi.fn(async (_target, ids?: readonly string[]) =>
      JSON.stringify(ids ?? null),
    );
    const platform = {
      name: 'fake',
      discoverParams,
      discoveryKey,
    } as unknown as Platform;
    const close = vi.fn(async () => {});
    const browser = {
      newContext: async () => ({ newPage: async () => ({}), close }),
    } as unknown as Browser;
    const stories = ['a', 'b'].map((id) => ({
      storyId: id,
      title: id,
      name: id,
      componentPath: `/${id}.tsx`,
      params: {},
    }));
    const opts = {
      platform,
      browser,
      baseUrl: 'http://x',
      viewport: { width: 10, height: 10 },
      cache: { dir, target: { projectRoot: dir } },
    };
    const partial = await prepareCaptures(stories, { ...opts, storyIds: ['a'] });
    expect(partial.map((s) => s.storyId)).toEqual(['a', 'a__dark', 'b']);
    expect(discoveryKey).toHaveBeenLastCalledWith(opts.cache.target, ['a']);
    expect(discoverParams).toHaveBeenLastCalledWith({}, 'http://x', ['a']);
    await prepareCaptures(stories, { ...opts, storyIds: ['a'] });
    expect(discoverParams).toHaveBeenCalledTimes(1);
    const full = await prepareCaptures(stories, opts);
    expect(full.map((s) => s.storyId)).toEqual(['a', 'a__dark', 'b', 'b__dark']);
    expect(discoverParams).toHaveBeenCalledTimes(2);
    expect(discoverParams).toHaveBeenLastCalledWith({}, 'http://x', undefined);
    await prepareCaptures(stories, { ...opts, storyIds: ['b'] });
    expect(discoverParams).toHaveBeenCalledTimes(3);
    expect(close).toHaveBeenCalledTimes(3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
