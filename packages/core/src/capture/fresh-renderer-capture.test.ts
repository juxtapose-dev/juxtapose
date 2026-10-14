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
async function renderers(): Promise<number[]> {
  const { connection } = browser as unknown as { connection: CdpConnection };
  const { processInfo } = await connection.send('SystemInfo.getProcessInfo');
  return processInfo.filter((p) => p.type === 'renderer').map((p) => p.id);
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

    // The platform-independent half: the font carry-over above needs the
    // macOS system font, but every story after the first must start in a
    // renderer process no earlier story ran in. On main: the same process.
    it('starts every story after the first in a new renderer process', async () => {
      const viewport = { width: 480, height: 64 };
      const context = await browser.newContext({ viewport });
      try {
        const page = await context.newPage();
        const seen = new Set<number>();
        for (const [k, path] of ['/plain', '/plain', '/heading'].entries()) {
          const url = `${base}${path}`;
          const platform = createUrlPlatform([{ id: `s${k}`, url }]);
          const [story] = await platform.enumerate({ projectRoot: process.cwd() });
          const before = new Set(await renderers());
          await captureStory(page, story!, { platform, baseUrl: url }, viewport);
          const fresh = (await renderers()).filter((id) => !before.has(id));
          if (k > 0) {
            // A process born during this capture, never one an earlier one used.
            expect(fresh.length).toBeGreaterThan(0);
            for (const id of fresh) expect(seen.has(id)).toBe(false);
          }
          for (const id of await renderers()) seen.add(id);
        }
      } finally {
        await context.close();
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
