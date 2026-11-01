import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { createBaselineStore, resolveChrome, type StoryManifest } from '@juxtapose/core';
import { Browser } from '@juxtapose/core/browser';
import type { Context } from '../context.js';
import { captureIo } from '../io.js';
import { EXIT } from '../exit-codes.js';

let context: Context;
vi.mock('../context.js', async (original) => ({
  ...(await original<typeof import('../context.js')>()),
  resolveContext: async () => context,
}));
const discoveries: Promise<StoryManifest[]>[] = [];
vi.mock('@juxtapose/core', async (original) => {
  const actual = await original<typeof import('@juxtapose/core')>();
  return {
    ...actual,
    prepareCaptures: (...args: Parameters<typeof actual.prepareCaptures>) => {
      const work = actual.prepareCaptures(...args);
      discoveries.push(work);
      return work;
    },
  };
});
const { configCommand } = await import('./config.js');

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
let browser: Browser;
beforeAll(async () => {
  const chrome = resolveChrome();
  if (!chrome) throw new Error('This cancellation regression requires jux Chromium.');
  browser = await Browser.launch({ executablePath: chrome.path });
});
afterAll(async () => {
  await browser?.close();
});
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'jux-explain-cancel-'));
  context = {
    projectRoot: root,
    config: {},
    json: true,
    store: createBaselineStore(root, undefined),
    platform: {
      name: 'urls',
      configDirs: [],
      storyFileGlobs: [],
      detect: async () => true,
      enumerate: async () => [
        {
          storyId: 'home',
          title: 'Home',
          name: 'Home',
          componentPath: 'home.ts',
          params: {},
        },
      ],
      previewUrl: () => 'about:blank',
      showStory: async () => {},
      settle: async () => {},
    },
  };
  return root;
}

test.each(['live', 'discovery'] as const)(
  'cancelled %s closes a context that finishes opening after cleanup',
  async (mode) => {
    const root = fixture();
    if (mode === 'live') context.platform.readLiveParams = async () => ({});
    else context.platform.discoverParams = async () => new Map();
    const made = deferred<Awaited<ReturnType<Browser['newContext']>>>();
    const release = deferred<void>();
    const realNewContext = browser.newContext.bind(browser);
    vi.spyOn(browser, 'newContext').mockImplementationOnce(async (options) => {
      const owned = await realNewContext(options);
      made.resolve(owned);
      await release.promise;
      return owned;
    });
    const abort = new AbortController();
    const io = captureIo();
    const running = configCommand(
      { explain: 'home' },
      { browser: async () => browser, signal: abort.signal, io },
    );
    const owned = await made.promise;
    const close = vi.spyOn(owned, 'close');
    const newPage = vi.spyOn(owned, 'newPage');
    try {
      abort.abort();
      expect(await running).toBe(EXIT.failure);
      release.resolve();
      await expect.poll(() => close.mock.calls.length).toBeGreaterThan(0);
      expect(newPage).not.toHaveBeenCalled();
      await expect(owned.newPage()).rejects.toThrow();
      expect(io.stdout()).toBe('');
    } finally {
      release.resolve();
      await owned.close();
      vi.restoreAllMocks();
      rmSync(root, { recursive: true, force: true });
    }
  },
  15000,
);

test('cancelling active discovery closes its context and does not cache its late result', async () => {
  const root = fixture();
  const entered = deferred<void>();
  const release = deferred<void>();
  const finished = deferred<void>();
  context.platform.discoveryKey = async () => 'fixed-build';
  context.platform.discoverParams = async () => {
    entered.resolve();
    await release.promise;
    finished.resolve();
    return new Map([['home', { delay: 999 }]]);
  };
  const realNewContext = browser.newContext.bind(browser);
  let owned: Awaited<ReturnType<Browser['newContext']>> | undefined;
  vi.spyOn(browser, 'newContext').mockImplementationOnce(async (options) => {
    owned = await realNewContext(options);
    return owned;
  });
  const abort = new AbortController();
  const io = captureIo();
  const running = configCommand(
    { explain: 'home' },
    { browser: async () => browser, signal: abort.signal, io },
  );
  await entered.promise;
  const current = owned;
  if (!current) throw new Error('Discovery did not own a browser context');
  const close = vi.spyOn(current, 'close');
  try {
    abort.abort();
    expect(await running).toBe(EXIT.failure);
    expect(close).toHaveBeenCalled();
    const active = discoveries.at(-1);
    if (!active) throw new Error('Discovery operation was not observed');
    let settled = false;
    void active.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await expect.poll(() => settled).toBe(true);
    release.resolve();
    await finished.promise;
    // Await the real core operation, including any asynchronous cache write.
    await Promise.allSettled(discoveries);
    expect(
      existsSync(path.join(root, '.juxtapose/runs/.cache/discovered-params.json')),
    ).toBe(false);
    expect(io.stdout()).toBe('');
  } finally {
    release.resolve();
    await current.close();
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);
