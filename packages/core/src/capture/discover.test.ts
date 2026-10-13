// prepareCaptures: discovered params merge over the index (the preview wins),
// a failed discovery warns and keeps the index params, and variants expand
// from the merged result.

import { describe, expect, it } from 'vitest';
import type { Browser } from '../browser/browser.js';
import type { Platform } from '../platform.js';
import type { StoryManifest, StoryParams } from '../types.js';
import { prepareCaptures } from './discover.js';

const story = (id: string, params: StoryParams = {}): StoryManifest => ({
  storyId: id,
  title: id,
  name: id,
  componentPath: `/src/${id}.tsx`,
  params,
});

/** Opens a page that is never used: the fake platform ignores it. */
function fakeBrowser(): Browser & { closed: number } {
  const b = {
    closed: 0,
    newContext: async () => ({
      newPage: async () => ({}),
      close: async () => {
        b.closed++;
      },
    }),
  };
  return b as unknown as Browser & { closed: number };
}

const platform = (discover?: Platform['discoverParams']): Platform => ({
  name: 'fake',
  detect: async () => true,
  enumerate: async () => [],
  showStory: async () => {},
  previewUrl: () => '',
  settle: async () => {},
  configDirs: [],
  storyFileGlobs: [],
  ...(discover ? { discoverParams: discover } : {}),
});

const opts = (p: Platform, browser = fakeBrowser(), warnings: string[] = []) => ({
  platform: p,
  browser,
  baseUrl: 'http://x',
  viewport: { width: 10, height: 10 },
  onWarning: (m: string) => warnings.push(m),
});

describe('prepareCaptures', () => {
  it('merges discovered params over the index and expands their variants', async () => {
    const p = platform(
      async () =>
        new Map<string, StoryParams>([
          ['a', { threshold: 0.3, variants: { dark: { colorScheme: 'dark' } } }],
        ]),
    );
    const browser = fakeBrowser();
    const out = await prepareCaptures(
      [story('a', { threshold: 0.1, delay: 5 }), story('b')],
      {
        ...opts(p, browser),
        projectVariants: { mobile: { viewport: { width: 375, height: 812 } } },
      },
    );
    expect(out.map((s) => s.storyId)).toEqual([
      'a',
      'a__dark',
      'a__mobile',
      'b',
      'b__mobile',
    ]);
    expect(out[0]!.params).toEqual({ threshold: 0.3, delay: 5 });
    expect(out[1]!.params).toEqual({ threshold: 0.3, delay: 5, colorScheme: 'dark' });
    expect(browser.closed).toBe(1);
  });

  it('a discovered skip is known before capture', async () => {
    const p = platform(async () => new Map([['a', { skip: true }]]));
    const out = await prepareCaptures([story('a')], {
      ...opts(p),
      projectVariants: { dark: {} },
    });
    expect(out).toEqual([story('a', { skip: true })]);
  });

  it('warns and keeps the index params when discovery fails', async () => {
    const warnings: string[] = [];
    const browser = fakeBrowser();
    const p = platform(async () => {
      throw new Error('no Storybook preview store on the page');
    });
    const out = await prepareCaptures(
      [story('a', { delay: 1 })],
      opts(p, browser, warnings),
    );
    expect(out).toEqual([story('a', { delay: 1 })]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/could not read story parameters from the fake preview/);
    expect(browser.closed).toBe(1);
  });

  it('gives up on a preview that never answers', async () => {
    const warnings: string[] = [];
    const p = platform(() => new Promise(() => {}));
    const out = await prepareCaptures([story('a')], {
      ...opts(p, fakeBrowser(), warnings),
      timeoutMs: 20,
    });
    expect(out).toEqual([story('a')]);
    expect(warnings[0]).toMatch(/no answer within 20 ms/);
  });

  it('opens no page for a platform without discovery', async () => {
    const browser = fakeBrowser();
    const out = await prepareCaptures([story('a')], opts(platform(), browser));
    expect(out).toEqual([story('a')]);
    expect(browser.closed).toBe(0);
  });
});

describe('discovery cache', () => {
  it('reuses discovered params for an unchanged key, rediscovers when it changes', async () => {
    const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const path = await import('node:path');
    const dir = mkdtempSync(path.join(tmpdir(), 'jux-discover-cache-'));
    try {
      let key = 'k1';
      let calls = 0;
      const p: Platform = {
        ...platform(async () => {
          calls++;
          return new Map([['a', { variants: { dark: { colorScheme: 'dark' } } }]]);
        }),
        discoveryKey: async () => key,
      };
      const cache = { dir, target: { projectRoot: dir, buildDir: dir } };
      const run = () => prepareCaptures([story('a')], { ...opts(p), cache });
      const first = await run();
      const browser = fakeBrowser();
      const second = await prepareCaptures([story('a')], { ...opts(p, browser), cache });
      expect(second).toEqual(first);
      expect(calls).toBe(1);
      // A hit opens no page at all.
      expect(browser.closed).toBe(0);
      key = 'k2';
      await run();
      expect(calls).toBe(2);
      // A corrupt cache is a miss, not an error.
      writeFileSync(path.join(dir, 'discovered-params.json'), '{not json');
      expect((await run()).map((s) => s.storyId)).toEqual(['a', 'a__dark']);
      expect(calls).toBe(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a failed discovery is not cached', async () => {
    const { mkdtempSync, rmSync, existsSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const path = await import('node:path');
    const dir = mkdtempSync(path.join(tmpdir(), 'jux-discover-fail-'));
    try {
      const p: Platform = {
        ...platform(async () => {
          throw new Error('boom');
        }),
        discoveryKey: async () => 'k',
      };
      await prepareCaptures([story('a')], {
        ...opts(p),
        cache: { dir, target: { projectRoot: dir } },
      });
      expect(existsSync(path.join(dir, 'discovered-params.json'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
