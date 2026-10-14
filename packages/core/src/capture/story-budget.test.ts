// One budget bounds a whole story (issue #154). Real Chrome: a page whose main
// thread is busy long after DOMContentLoaded stalls every CDP call, and each
// used to wait out its own 30 s cap in turn.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
    // The loop outlasts the whole test: only discarding the page ends it.
    res.end(
      req.url === '/busy'
        ? `<!doctype html><body><script>addEventListener('DOMContentLoaded',()=>{const t=Date.now();while(Date.now()-t<120000);})</script>busy</body>`
        : `<!doctype html><body style="margin:0">${req.url}</body>`,
    );
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
    await page.goto(`${base}/${id}`);
  },
};

const story = (id: string): StoryManifest => ({
  storyId: id,
  title: id,
  name: id,
  componentPath: '',
  params: {},
});

describe.skipIf(!chrome)('per-story budget', () => {
  it('errors a wedged story once near the budget, then captures the next on the same worker', async () => {
    const browser = await Browser.launch({ executablePath: chrome!.path });
    const out: CaptureOutcome[] = [];
    const started = Date.now();
    try {
      for await (const o of capturePool([story('busy'), story('ok1'), story('ok2')], {
        browser,
        platform,
        baseUrl: base,
        viewport: { width: 100, height: 50 },
        concurrency: 1,
        storyTimeoutMs: 2000,
      })) {
        out.push(o);
      }
    } finally {
      await browser.close();
    }
    const wall = Date.now() - started;

    expect(out.map((o) => o.story.storyId)).toEqual(['busy', 'ok1', 'ok2']);
    const [busy, ok1, ok2] = out;
    expect(busy!.error?.name).toBe('StoryTimeoutError');
    expect(busy!.error?.message).toMatch(/2000 ms budget while in '/);
    // Close to the budget, not a multiple of the 30 s CDP cap.
    expect(busy!.durationMs).toBeGreaterThanOrEqual(1900);
    expect(busy!.durationMs).toBeLessThan(5000);
    expect(ok1!.snapshot).toBeDefined();
    expect(ok2!.snapshot).toBeDefined();
    expect(wall).toBeLessThan(20_000);
  }, 60_000);
});

describe.skipIf(!chrome)('budget vs settle', () => {
  // Settle must never throw on timeout: a story whose settle cap (5 s) is
  // above storyTimeout (2 s) still returns a snapshot flagged settle-timeout.
  it('does not pre-empt settle: a legal settle.timeout above storyTimeout yields a flagged snapshot', async () => {
    const hang = createServer((req, res) => {
      if (req.url === '/hang') return; // never answers
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(
        `<!doctype html><body style="margin:0">x<script>fetch('/hang')</script></body>`,
      );
    });
    await new Promise<void>((r) => hang.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(hang.address() as { port: number }).port}`;
    const browser = await Browser.launch({ executablePath: chrome!.path });
    const out: CaptureOutcome[] = [];
    try {
      for await (const o of capturePool([story('hung')], {
        browser,
        platform: {
          ...platform,
          showStory: async (page, id) => {
            await page.goto(`${url}/${id}`);
          },
        },
        baseUrl: url,
        viewport: { width: 100, height: 50 },
        concurrency: 1,
        storyTimeoutMs: 2000,
        settleLayers: { project: { settle: { timeout: 5000 } } },
      })) {
        out.push(o);
      }
    } finally {
      await browser.close();
      hang.closeAllConnections();
      hang.close();
    }
    expect(out[0]!.error).toBeUndefined();
    expect(out[0]!.snapshot?.settle?.status).toBe('timeout');
    expect(out[0]!.durationMs).toBeGreaterThanOrEqual(4900);
  }, 60_000);
});
