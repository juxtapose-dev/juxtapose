// packages/core/src/capture/capture.test.ts
import { describe, it, expect } from 'vitest';
import { captureStory } from './capture.js';
import type { Page } from '../browser/page.js';
import type { Platform } from '../platform.js';
import type { StoryManifest } from '../types.js';

function recordingPage(): Page & { calls: string[] } {
  const calls: string[] = [];
  const rec =
    <T>(name: string, value: T) =>
    async () => {
      calls.push(name);
      return value;
    };
  return {
    calls,
    goto: rec('goto', undefined),
    url: () => 'about:blank',
    evaluate: rec('evaluate', undefined as never),
    waitForFunction: rec('waitForFunction', undefined),
    waitForSelector: rec('waitForSelector', undefined),
    addStyleTag: rec('addStyleTag', undefined),
    setViewportSize: rec('setViewportSize', undefined),
    setColorScheme: rec('setColorScheme', undefined),
    screenshot: rec('screenshot', Buffer.alloc(0)),
    send: rec('send', {} as never),
    onMainResponse: () => () => {},
    clearOrigin: rec('clearOrigin', undefined),
    close: rec('close', undefined),
  };
}
const platform: Platform = {
  name: 'fake',
  detect: async () => true,
  enumerate: async () => [],
  showStory: async (page) => {
    await page.goto('x');
  },
  previewUrl: () => '',
  settle: async () => {},
  configDirs: [],
  storyFileGlobs: [],
};
const story = (params: StoryManifest['params']): StoryManifest => ({
  storyId: 's',
  title: 's',
  name: 's',
  componentPath: '',
  params,
});

describe('captureStory', () => {
  it('a non-CSS mask fails the story before the page is touched', async () => {
    const page = recordingPage();
    await expect(
      captureStory(
        page,
        story({ mask: ['text=x'] }),
        { platform, baseUrl: 'x', structure: false },
        { width: 10, height: 10 },
      ),
    ).rejects.toThrow("jux: selector 'text=x' is not a CSS selector");
    expect(page.calls).toEqual([]);
  });
  it('a non-CSS mask from live params fails the story before the shutter', async () => {
    const page = recordingPage();
    await expect(
      captureStory(
        page,
        story({}),
        {
          platform: { ...platform, readLiveParams: async () => ({ mask: ['text=x'] }) },
          baseUrl: 'x',
          structure: false,
        },
        { width: 10, height: 10 },
      ),
    ).rejects.toThrow("jux: selector 'text=x' is not a CSS selector");
    expect(page.calls).not.toContain('screenshot');
  });
  it('a non-CSS waitForSelector fails the story the same way', async () => {
    const page = recordingPage();
    await expect(
      captureStory(
        page,
        story({ waitForSelector: 'div >> span' }),
        { platform, baseUrl: 'x', structure: false },
        { width: 10, height: 10 },
      ),
    ).rejects.toThrow(/not a CSS selector/);
    expect(page.calls).toEqual([]);
  });
});

describe('captureStory with variants', () => {
  const variant: StoryManifest = {
    storyId: 'btn__dark',
    baseStoryId: 'btn',
    variant: 'dark',
    title: 'T',
    name: 'btn',
    componentPath: '',
    params: { colorScheme: 'dark' },
    variantParams: { colorScheme: 'dark' },
  };
  const plain: StoryManifest = { ...story({}), storyId: 'other' };

  /** Records every id a platform call receives. The fake screenshot is not an
   *  image, so the capture rejects at encode, after every platform call. */
  function spyPlatform(ids: string[]): Platform {
    return {
      ...platform,
      showStory: async (page, id) => {
        ids.push(`show:${id}`);
        await page.goto('x');
      },
      settle: async (_page, ctx) => {
        ids.push(`settle:${ctx.story.storyId}`);
      },
      readLiveParams: async (_page, id) => {
        ids.push(`live:${id}`);
        return undefined;
      },
      switchStory: async (_page, id) => {
        ids.push(`switch:${id}`);
        return false;
      },
    };
  }

  const capture = (page: Page, s: StoryManifest, p: Platform) =>
    captureStory(
      page,
      s,
      { platform: p, baseUrl: 'x', structure: false },
      { width: 10, height: 10 },
    ).catch(() => null);

  it("every platform call receives the platform's own id, never the capture key", async () => {
    const ids: string[] = [];
    await capture(recordingPage(), variant, spyPlatform(ids));
    expect(ids).toEqual(['show:btn', 'settle:btn', 'live:btn']);
  });

  it('sets the scheme before showStory, resets to light for a default capture, and memoizes', async () => {
    const page = recordingPage();
    const p = spyPlatform([]);
    await capture(page, variant, p);
    await capture(page, plain, p);
    await capture(page, plain, p);
    const relevant = page.calls.filter((c) => c === 'setColorScheme' || c === 'goto');
    // dark before the first navigation; light before the second; nothing on
    // the third because the page is already light.
    expect(relevant).toEqual([
      'setColorScheme',
      'goto',
      'setColorScheme',
      'goto',
      'goto',
    ]);
  });

  it("a story's live opt-out of a variant skips that capture", async () => {
    const page = recordingPage();
    const result = await captureStory(
      page,
      variant,
      {
        platform: {
          ...platform,
          readLiveParams: async () => ({ variants: { dark: false } }),
        },
        baseUrl: 'x',
        structure: false,
      },
      { width: 10, height: 10 },
    );
    expect(result).toBeNull();
    expect(page.calls).not.toContain('screenshot');
  });
});
