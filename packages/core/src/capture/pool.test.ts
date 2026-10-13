import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { Browser } from '../browser/browser.js';
import { chromeForTests } from '../browser/__tests__/helpers.js';
import type { Platform } from '../platform.js';
import type { StoryManifest } from '../types.js';
import { capturePool, type CaptureOutcome } from './pool.js';

const chrome = chromeForTests();
let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><body style="margin:0">${req.url}</body>`);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => {
  server.closeAllConnections();
  server.close();
});
afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * `crash` kills its renderer (Page.crash) and fails at once; `die` closes the
 * whole browser; every other story navigates after a pause, so the worker
 * that failed fast is the one that picks up the next story.
 */
function platformFor(browser: Browser): Platform {
  return {
    name: 'fake',
    detect: async () => true,
    enumerate: async () => [],
    previewUrl: () => '',
    configDirs: [],
    storyFileGlobs: [],
    settle: async () => {},
    showStory: async (page, id) => {
      if (id === 'crash') await page.send('Page.crash');
      if (id === 'die') await browser.close();
      await new Promise((r) => setTimeout(r, 150));
      await page.goto(`${base}/${id}`);
    },
  };
}

const story = (id: string): StoryManifest => ({
  storyId: id,
  title: id,
  name: id,
  componentPath: '',
  params: {},
});

async function run(ids: string[], concurrency: number) {
  // Identity shuffle: j = floor(0.9999 * (i + 1)) = i, so the queue keeps
  // the order given and the crashing story is taken first.
  vi.spyOn(Math, 'random').mockReturnValue(0.9999);
  const browser = await Browser.launch({ executablePath: chrome!.path });
  const out = new Map<string, CaptureOutcome>();
  try {
    for await (const o of capturePool(ids.map(story), {
      browser,
      platform: platformFor(browser),
      baseUrl: base,
      viewport: { width: 100, height: 50 },
      concurrency,
    })) {
      out.set(o.story.storyId, o);
    }
  } finally {
    await browser.close();
  }
  return ids.map((id) => {
    const o = out.get(id);
    return o?.snapshot ? 'PASS' : `FAIL ${o?.error?.name ?? 'missing'}`;
  });
}

describe.skipIf(!chrome)('capturePool after a renderer crash', () => {
  it('crash, ok, ok at concurrency 1 is FAIL, PASS, PASS', async () => {
    expect(await run(['crash', 'ok1', 'ok2'], 1)).toEqual([
      'FAIL PageCrashedError',
      'PASS',
      'PASS',
    ]);
  });

  it('crash, ok, ok at concurrency 2 is FAIL, PASS, PASS', async () => {
    expect(await run(['crash', 'ok1', 'ok2'], 2)).toEqual([
      'FAIL PageCrashedError',
      'PASS',
      'PASS',
    ]);
  });

  it('a dead browser fails the rest with one clear browser error', async () => {
    const results = await run(['die', 'ok1', 'ok2', 'ok3'], 1);
    expect(results[0]).toMatch(/^FAIL /);
    expect(results.slice(1)).toEqual([
      'FAIL BrowserDiedError',
      'FAIL BrowserDiedError',
      'FAIL BrowserDiedError',
    ]);
  });
});
