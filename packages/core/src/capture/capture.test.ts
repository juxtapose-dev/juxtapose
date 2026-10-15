// packages/core/src/capture/capture.test.ts
import { beforeAll, describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { captureStory, type CaptureDeps } from './capture.js';
import type { Page } from '../browser/page.js';
import type { Platform } from '../platform.js';
import type { StoryManifest, StoryParams } from '../types.js';

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
    setColorScheme: async (scheme: 'light' | 'dark') => {
      calls.push(`setColorScheme:${scheme}`);
    },
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

describe('captureStory cache pulse on a reused renderer', () => {
  let png: Buffer;
  beforeAll(async () => {
    png = await sharp({
      create: { width: 1, height: 1, channels: 3, background: 'white' },
    })
      .png()
      .toBuffer();
  });

  it('recaptures when live renderer settings change, before taking a screenshot', async () => {
    const page = recordingPage();
    let screenshots = 0;
    page.screenshot = async () => {
      screenshots++;
      return png;
    };
    let reads = 0;
    const result = await captureStory(
      page,
      story({}),
      {
        platform: {
          ...platform,
          readLiveParams: async () => {
            reads++;
            return { renderer: { shared: false } };
          },
        },
        baseUrl: 'x',
        structure: false,
        renderer: { shared: true },
      },
      { width: 1, height: 1 },
    );
    expect(reads).toBe(2);
    expect(screenshots).toBe(1);
    expect(result?.renderer?.shared).toBe(false);
  });

  it('forced fresh capture ignores a live request to share the renderer', async () => {
    const page = recordingPage();
    page.screenshot = async () => png;
    let reads = 0;
    const result = await captureStory(
      page,
      story({}),
      {
        platform: {
          ...platform,
          readLiveParams: async () => {
            reads++;
            return { renderer: { shared: true, clearResourceCache: true } };
          },
        },
        baseUrl: 'x',
        structure: false,
        forceFreshRenderer: true,
      },
      { width: 1, height: 1 },
    );
    expect(reads).toBe(1);
    expect(result?.renderer).toEqual({ shared: false, clearResourceCache: false });
  });

  function setup(
    options: Pick<CaptureDeps, 'freshRenderer' | 'warmSwitch' | 'renderer'>,
  ) {
    const page = recordingPage();
    const events: unknown[] = [];
    page.screenshot = async () => png;
    page.send = (async (method: string, params?: object) => {
      if (method === 'Network.setCacheDisabled') events.push(params);
      return {};
    }) as Page['send'];
    const p: Platform = {
      ...platform,
      showStory: async (page, id) => {
        events.push(`show:${id}`);
        await platform.showStory(page, id, 'x');
      },
      switchStory: async (_page, id) => {
        events.push(`switch:${id}`);
        return true;
      },
    };
    const capture = async (id: string) => {
      const result = await captureStory(
        page,
        { ...story({}), storyId: id },
        { platform: p, baseUrl: 'x', structure: false, ...options },
        { width: 1, height: 1 },
      );
      expect(result).not.toBeNull();
    };
    return { capture, events };
  }

  it('pulses exactly true then false before showing the second cold story', async () => {
    const { capture, events } = setup({
      renderer: { shared: true, clearResourceCache: true },
    });
    await capture('first');
    events.length = 0;
    await capture('second');
    expect(events).toEqual([
      { cacheDisabled: true },
      { cacheDisabled: false },
      'show:second',
    ]);
  });

  it('does not pulse for shared rendering unless explicitly enabled', async () => {
    const { capture, events } = setup({ renderer: { shared: true } });
    await capture('first');
    await capture('second');
    expect(events).toEqual(['show:first', 'show:second']);
  });

  it('does not pulse on the first capture on a page', async () => {
    const { capture, events } = setup({
      renderer: { shared: true, clearResourceCache: true },
    });
    await capture('first');
    expect(events).toEqual(['show:first']);
  });

  it.each([undefined, true])(
    'does not pulse with freshRenderer %s, including on a second capture',
    async (freshRenderer) => {
      const { capture, events } = setup({ freshRenderer });
      await capture('first');
      await capture('second');
      expect(events).toEqual(['show:first', 'show:second']);
    },
  );

  it('does not pulse when the second story takes the warm-switch path', async () => {
    const { capture, events } = setup({
      renderer: { shared: true, clearResourceCache: true },
      warmSwitch: true,
    });
    await capture('first');
    await capture('second');
    expect(events).toEqual(['show:first', 'switch:second']);
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
    const relevant = page.calls.filter(
      (c) => c.startsWith('setColorScheme') || c === 'goto',
    );
    // dark before the first navigation; light before the second; nothing on
    // the third because the page is already light.
    expect(relevant).toEqual([
      'setColorScheme:dark',
      'goto',
      'setColorScheme:light',
      // Every cold capture on a page that has shown a story hops to a fresh
      // renderer first (#153), which also makes a same-URL story boot fresh
      // rather than navigating in-document.
      'goto',
      'goto',
      'goto',
      'goto',
    ]);
  });

  it('falls back to raw CDP media emulation on a Page without setColorScheme', async () => {
    const page = recordingPage();
    const sent: unknown[] = [];
    delete (page as Partial<Page>).setColorScheme;
    page.send = (async (method: string, params?: object) => {
      sent.push([method, params]);
      return {};
    }) as Page['send'];
    await capture(page, variant, spyPlatform([]));
    // The settle init script is installed first; the media call is next.
    expect(sent.map((c) => (c as [string])[0]).slice(0, 2)).toEqual([
      'Page.addScriptToEvaluateOnNewDocument',
      'Emulation.setEmulatedMedia',
    ]);
    expect(sent[1]).toEqual([
      'Emulation.setEmulatedMedia',
      {
        media: '',
        features: [
          { name: 'prefers-color-scheme', value: 'dark' },
          { name: 'prefers-reduced-motion', value: 'no-preference' },
          { name: 'forced-colors', value: 'none' },
          { name: 'prefers-contrast', value: 'no-preference' },
        ],
      },
    ]);
  });

  it('warns when the live preview declares the variant differently', async () => {
    const warnings: string[] = [];
    const run = (live: StoryParams) =>
      captureStory(
        recordingPage(),
        variant,
        {
          platform: { ...platform, readLiveParams: async () => live },
          baseUrl: 'x',
          structure: false,
          onWarning: (m) => warnings.push(m),
        },
        { width: 10, height: 10 },
      ).catch(() => null);
    // Same settings as expanded: nothing to say.
    await run({ variants: { dark: { colorScheme: 'dark' } } });
    // Another variant's declaration is not this capture's concern.
    await run({ variants: { mobile: { viewport: { width: 1, height: 1 } } } });
    expect(warnings).toEqual([]);
    await run({ variants: { dark: { colorScheme: 'dark', delay: 50 } } });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(
      "btn__dark: the story's live parameters declare variant 'dark' differently",
    );
    expect(warnings[0]).toContain('where discovery reads them before capture');
  });

  it('compares live and expanded settings structurally, not by key order', async () => {
    const warnings: string[] = [];
    const mobile: StoryManifest = {
      ...variant,
      storyId: 'btn__mobile',
      variant: 'mobile',
      params: { viewport: { width: 375, height: 812 } },
      variantParams: { viewport: { width: 375, height: 812 } },
    };
    await captureStory(
      recordingPage(),
      mobile,
      {
        platform: {
          ...platform,
          readLiveParams: async () => ({
            variants: { mobile: { viewport: { height: 812, width: 375 } } },
          }),
        },
        baseUrl: 'x',
        structure: false,
        onWarning: (m) => warnings.push(m),
      },
      { width: 10, height: 10 },
    ).catch(() => null);
    expect(warnings).toEqual([]);
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
