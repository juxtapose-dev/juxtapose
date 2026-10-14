// Issue #153 against a real Chrome. A renderer process keeps font and raster
// state across navigations, so a story's pixels depended on which story the
// same page showed before it. Primer React's PageLayout heading moved 0.11 px
// after PageHeader `webhooks`, whose canvas text measuring set a 32.0167px
// system font; Spectrum's card cover edge changed after a button group.
// Neither a navigation to about:blank nor a memory-pressure purge cleared it.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { Browser } from '../browser/browser.js';
import type { CdpConnection } from '../browser/cdp.js';
import { chromeForTests } from '../browser/__tests__/helpers.js';
import { createUrlPlatform } from '../platforms/urls.js';
import { captureStory } from './capture.js';
import { capturePool } from './pool.js';
import { snapPages } from './snap.js';

const chrome = chromeForTests();
let server: Server;
let base: string;
let browser: Browser;

// Primer's own stack. On macOS it resolves to the system font, whose metrics
// carried over; elsewhere it falls back and the pixel test passes either way.
const STACK =
  '-apple-system, "system-ui", "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif';
const PAGES: Record<string, string> = {
  '/heading': `<!doctype html><style>body { margin: 8px }
h1 { font: 400 32px/48px ${STACK}; margin: 0 }</style><h1>Input validation styles</h1>`,
  // What Primer's webhooks story did: measure text on a canvas at a
  // fractional size. Nothing is drawn on the page.
  '/measure': `<!doctype html><canvas></canvas><script>
const c = document.querySelector('canvas').getContext('2d');
c.font = '32.0167px ${STACK.replaceAll("'", "\\'")}';
c.measureText('Webhooks');</script>`,
  '/plain': '<!doctype html><p>plain</p>',
};

beforeAll(async () => {
  server = createServer((req, res) => {
    const html = PAGES[req.url ?? ''];
    res.writeHead(html ? 200 : 404, { 'content-type': 'text/html' });
    res.end(html ?? '');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  if (chrome) browser = await Browser.launch({ executablePath: chrome.path });
}, 30_000);

afterAll(async () => {
  await browser?.close();
  server.close();
});

async function snap(...paths: string[]): Promise<Buffer[]> {
  const { pages } = await snapPages({
    urls: paths.map((p) => `${base}${p}`),
    browser,
    viewport: { width: 480, height: 64 },
  });
  return pages.map((p) => {
    if (!p.snapshot) throw new Error(p.error);
    return p.snapshot.image;
  });
}

/** The browser's renderer process ids (SystemInfo is browser-target only). */
async function renderers(on: Browser = browser): Promise<number[]> {
  const { connection } = on as unknown as { connection: CdpConnection };
  const { processInfo } = await connection.send('SystemInfo.getProcessInfo');
  return processInfo.filter((p) => p.type === 'renderer').map((p) => p.id);
}

interface PerCapture {
  /** Renderer pids born during the capture that no earlier capture saw. */
  born: number[];
  /** The page's own renderer, by its inspector isolate id: random per
   *  process, so a new id is a new process (it tracked the CPU-identified
   *  pid on 87 of 87 captures, reused or not). */
  isolate: string;
  reused: boolean;
}

/** Capture three pages on one page and report each capture after the first. */
async function capturesOnOnePage(
  deps: { freshRenderer?: boolean },
  on: Browser = browser,
): Promise<(PerCapture & { previous: string })[]> {
  const viewport = { width: 480, height: 64 };
  const context = await on.newContext({ viewport });
  try {
    const page = await context.newPage();
    const seen = new Set<number>();
    const out: PerCapture[] = [];
    for (const [k, path] of ['/plain', '/plain', '/heading'].entries()) {
      const url = `${base}${path}`;
      const platform = createUrlPlatform([{ id: `s${k}`, url }]);
      const [story] = await platform.enumerate({ projectRoot: process.cwd() });
      const snapshot = await captureStory(
        page,
        story!,
        { platform, baseUrl: url, ...deps },
        viewport,
      );
      const now = await renderers(on);
      const { id: isolate } = await page.send('Runtime.getIsolateId');
      out.push({
        born: now.filter((id) => !seen.has(id)),
        isolate,
        reused: snapshot?.rendererReused === true,
      });
      for (const id of now) seen.add(id);
    }
    return out.slice(1).map((c, k) => ({ ...c, previous: out[k]!.isolate }));
  } finally {
    await context.close();
  }
}

describe.skipIf(!chrome)(
  'a story on a reused page in Chrome',
  { timeout: 30_000 },
  () => {
    // On main, macOS: the heading after /measure differed from the heading
    // alone on 4 of 4 runs (the line 0.14 px wider, glyph edges along it).
    it('captures the same pixels whatever the page showed before', async () => {
      const [alone] = await snap('/heading');
      const [, after] = await snap('/measure', '/heading');
      expect(after!.equals(alone!)).toBe(true);
    });

    // The platform-independent half, and the guard on Linux CI: the pixel
    // test above only fails with the macOS system font, but every story
    // after the first must run in a renderer process no earlier story ran
    // in. Checked on the page's own renderer, not just that some process was
    // born. Before #153: the same process every time.
    it('starts every story after the first in a new renderer process', async () => {
      const after = await capturesOnOnePage({});
      const isolates = new Set(after.map((c) => c.isolate));
      expect(isolates.size).toBe(after.length);
      for (const c of after) {
        expect(c.isolate).not.toBe(c.previous);
        expect(c.born.length).toBeGreaterThan(0);
        expect(c.reused).toBe(false);
      }
    });

    // The opt-out restores the old behavior: one renderer for the whole page.
    it('with freshRenderer false, keeps one renderer across captures', async () => {
      const after = await capturesOnOnePage({ freshRenderer: false });
      expect(after.map((c) => c.born)).toEqual([[], []]);
      for (const c of after) expect(c.isolate).toBe(c.previous);
    });

    // At Chrome's renderer-process limit the hop stays in the old process
    // silently (concurrency 8 at a limit of 8: 56 of 56 reused). Our launch
    // lifts the limit; a browser that holds one must flag the capture.
    it('flags a capture whose hop could not get a new renderer', async () => {
      const capped = await Browser.launch({
        executablePath: chrome!.path,
        args: ['--renderer-process-limit=1'],
      });
      try {
        const after = await capturesOnOnePage({}, capped);
        for (const c of after) {
          expect(c.isolate).toBe(c.previous);
          expect(c.reused).toBe(true);
        }
      } finally {
        await capped.close();
      }
    });

    it('warns once per run when the pool sees a reused renderer', async () => {
      const capped = await Browser.launch({
        executablePath: chrome!.path,
        args: ['--renderer-process-limit=1'],
      });
      try {
        const paths = ['/plain', '/heading', '/plain', '/heading'];
        const platform = createUrlPlatform(
          paths.map((p, k) => ({ id: `p${k}`, url: `${base}${p}` })),
        );
        const stories = await platform.enumerate({ projectRoot: process.cwd() });
        const warnings: string[] = [];
        const reused: boolean[] = [];
        for await (const out of capturePool(stories, {
          browser: capped,
          platform,
          baseUrl: base,
          concurrency: 2,
          viewport: { width: 480, height: 64 },
          onWarning: (m) => warnings.push(m),
        })) {
          expect(out.error).toBeUndefined();
          reused.push(out.snapshot?.rendererReused === true);
        }
        expect(reused.filter(Boolean).length).toBeGreaterThan(0);
        expect(warnings.filter((w) => w.includes('renderer-reused'))).toHaveLength(1);
      } finally {
        await capped.close();
      }
    });

    // The hop's own data: document answers 200; a URL that then fails to
    // load must not report it as its status.
    it("never reports the hop's response as a page's status", async () => {
      const dead = createServer();
      await new Promise<void>((r) => dead.listen(0, '127.0.0.1', r));
      const port = (dead.address() as { port: number }).port;
      await new Promise<void>((r) => dead.close(() => r()));
      const { pages } = await snapPages({
        urls: [`${base}/plain`, `http://127.0.0.1:${port}/`],
        browser,
        viewport: { width: 480, height: 64 },
      });
      expect(pages[0]!.status).toBe(200);
      expect(pages[1]!.error).toBeDefined();
      expect(pages[1]!.status).toBeNull();
    });
  },
);
