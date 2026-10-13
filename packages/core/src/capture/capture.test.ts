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
