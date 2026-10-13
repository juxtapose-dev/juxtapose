// Variants against a real Chrome: the color scheme reaches the page, a pooled
// page can't carry it into the next story, and a variant viewport is the size
// captured. Under a byte-exact hash the second is the one that matters: a
// dark scheme leaking into a default capture would fail it on queue order.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import sharp from 'sharp';
import { Browser } from '../browser/browser.js';
import { chromeForTests } from '../browser/__tests__/helpers.js';
import type { Platform } from '../platform.js';
import type { Snapshot, StoryManifest } from '../types.js';
import { capturePool } from './pool.js';
import { expandVariants } from './variants.js';

const chrome = chromeForTests();
let server: Server;
let base: string;

// Light or dark from the media query alone, so the pixels say which scheme
// the page saw.
const PAGE = `<!doctype html><style>
  body { margin: 0; background: rgb(250, 250, 250); color: rgb(10, 10, 10); font: 16px sans-serif; }
  @media (prefers-color-scheme: dark) {
    body { background: rgb(10, 10, 10); color: rgb(250, 250, 250); }
  }
</style><body><p>Hello variants</p></body>`;

beforeAll(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(PAGE);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => {
  server.closeAllConnections();
  server.close();
});

const platform: Platform = {
  name: 'fake',
  detect: async () => true,
  enumerate: async () => [],
  previewUrl: () => '',
  configDirs: [],
  storyFileGlobs: [],
  settle: async () => {},
  showStory: async (page, id) => {
    // A capture key reaching the platform would be a bug; fail loudly.
    if (id.includes('__')) throw new Error(`platform got capture key ${id}`);
    await page.goto(`${base}/${id}`);
  },
};

const stories = expandVariants(
  [{ storyId: 'card', title: 'Card', name: 'card', componentPath: '', params: {} }],
  {
    dark: { colorScheme: 'dark' },
    mobile: { viewport: { width: 375, height: 812 } },
  },
);
const pick = (key: string): StoryManifest => stories.find((s) => s.storyId === key)!;

/** Capture in exactly this order on one page (concurrency 1: no shuffle). */
async function captureInOrder(browser: Browser, keys: string[]): Promise<Snapshot[]> {
  const out: Snapshot[] = [];
  for await (const o of capturePool(keys.map(pick), {
    browser,
    platform,
    baseUrl: base,
    viewport: { width: 200, height: 100 },
    concurrency: 1,
  })) {
    if (!o.snapshot) throw o.error ?? new Error(`no snapshot for ${o.story.storyId}`);
    out.push(o.snapshot);
  }
  return out;
}

/** Mean luminance of the top-left pixel row, 0-255. */
async function topLeft(image: Buffer): Promise<number> {
  const { data } = await sharp(image)
    .extract({ left: 0, top: 0, width: 4, height: 1 })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return (data[0]! + data[1]! + data[2]!) / 3;
}

describe.skipIf(!chrome)('variant capture in Chrome', () => {
  it('dark captures dark; the default right after on the same page is light and byte-identical to one taken alone', async () => {
    const browser = await Browser.launch({ executablePath: chrome!.path });
    try {
      const [dark, afterDark] = await captureInOrder(browser, ['card__dark', 'card']);
      const [alone] = await captureInOrder(browser, ['card']);
      expect(dark!.variant).toBe('dark');
      expect(dark!.baseStoryId).toBe('card');
      expect(await topLeft(dark!.image)).toBeLessThan(20);
      expect(await topLeft(afterDark!.image)).toBeGreaterThan(240);
      expect(afterDark!.storyId).toBe('card');
      expect(afterDark).not.toHaveProperty('variant');
      expect(afterDark!.image.equals(alone!.image)).toBe(true);
    } finally {
      await browser.close();
    }
  });

  it('a 375x812 variant is captured at 375x812', async () => {
    const browser = await Browser.launch({ executablePath: chrome!.path });
    try {
      const [mobile, after] = await captureInOrder(browser, ['card__mobile', 'card']);
      expect(mobile!.viewport).toEqual({ width: 375, height: 812 });
      const meta = await sharp(mobile!.image).metadata();
      expect([meta.width, meta.height]).toEqual([375, 812]);
      // And the next default capture is back at the project viewport.
      expect(after!.viewport).toEqual({ width: 200, height: 100 });
      const back = await sharp(after!.image).metadata();
      expect([back.width, back.height]).toEqual([200, 100]);
    } finally {
      await browser.close();
    }
  });
});

// An app that reads matchMedia once at boot, as many theme providers do. A
// warm switch re-renders without a reload, so it would keep the scheme the
// page booted under: before the fix, card then card__dark captured both
// light and the reverse both dark.
const BOOT_ONCE = `<!doctype html><body style="margin:0"><script>
const dark = matchMedia('(prefers-color-scheme: dark)').matches;
document.body.style.background = dark ? 'rgb(10,10,10)' : 'rgb(250,250,250)';
window.__render = (id) => { document.body.dataset.story = id; };
</script></body>`;

describe.skipIf(!chrome)('variant capture with warm switching', () => {
  let bootServer: Server;
  let bootBase: string;
  beforeAll(async () => {
    bootServer = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(BOOT_ONCE);
    });
    await new Promise<void>((r) => bootServer.listen(0, '127.0.0.1', r));
    bootBase = `http://127.0.0.1:${(bootServer.address() as { port: number }).port}/`;
  });
  afterAll(() => {
    bootServer.closeAllConnections();
    bootServer.close();
  });

  const warmPlatform = (): Platform => ({
    ...platform,
    showStory: async (page, id) => {
      await page.goto(`${bootBase}#${id}`);
    },
    switchStory: async (page, id) => {
      await page.evaluate(
        (i) => (window as unknown as { __render(i: string): void }).__render(i),
        id,
      );
      return true;
    },
  });

  it.each([
    [
      ['card', 'card__dark'],
      ['light', 'dark'],
    ],
    [
      ['card__dark', 'card'],
      ['dark', 'light'],
    ],
  ])('%j captures %j: a scheme change forces a cold load', async (order, want) => {
    const browser = await Browser.launch({ executablePath: chrome!.path });
    try {
      const got: string[] = [];
      for await (const o of capturePool(order.map(pick), {
        browser,
        platform: warmPlatform(),
        baseUrl: bootBase,
        viewport: { width: 50, height: 50 },
        concurrency: 1,
        warmSwitch: true,
      })) {
        if (!o.snapshot) throw o.error ?? new Error('no snapshot');
        got.push((await topLeft(o.snapshot.image)) < 128 ? 'dark' : 'light');
      }
      expect(got).toEqual(want);
    } finally {
      await browser.close();
    }
  });
});
