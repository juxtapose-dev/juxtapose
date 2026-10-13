import { describe, it, expect } from 'vitest';
import { TimeoutError, type Page } from '@juxtapose/core';
import { StorybookPlatform } from './index.js';

/** A page whose every wait times out, as a story that never renders would. */
function timingOutPage(): Page {
  const timeout = async () => {
    throw new TimeoutError('jux: timed out');
  };
  return {
    goto: async () => {},
    url: () => '',
    evaluate: async () => undefined as never,
    waitForFunction: timeout,
    waitForSelector: timeout,
    addStyleTag: async () => {},
    setViewportSize: async () => {},
    setColorScheme: async () => {},
    screenshot: async () => Buffer.alloc(0),
    send: async () => ({}) as never,
    onMainResponse: () => () => {},
    clearOrigin: async () => {},
    close: async () => {},
  };
}

describe('StorybookPlatform.settle', () => {
  it('resolves when the render signal times out (a slow story is a diff, not an abort)', async () => {
    const platform = new StorybookPlatform();
    const ctx = {
      story: { storyId: 'a', title: 'a', name: 'a', componentPath: '', params: {} },
      params: {},
      timeoutMs: 1,
    };
    await expect(platform.settle(timingOutPage(), ctx)).resolves.toBeUndefined();
  });
});
