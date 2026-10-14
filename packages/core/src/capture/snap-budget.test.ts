// A wedged URL costs its own budget once and no more (issue #163). Before, it
// poisoned the page shared by every later URL: three URLs, 90 s, all failed.
// Real Chrome, through snapPages.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { Socket } from 'node:net';
import { Browser } from '../browser/browser.js';
import { chromeForTests } from '../browser/__tests__/helpers.js';
import { snapPages } from './snap.js';

const chrome = chromeForTests();
let server: Server;
let base: string;
let browser: Browser;
const sockets = new Set<Socket>();

beforeAll(async () => {
  server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    // /busy holds the renderer's main thread from DOMContentLoaded on.
    res.end(
      req.url === '/busy'
        ? `<!doctype html><body><script>addEventListener('DOMContentLoaded',()=>{const t=Date.now();while(Date.now()-t<90000);})</script>busy</body>`
        : `<!doctype html><body style="margin:0"><p>page ${req.url}</p></body>`,
    );
  });
  server.on('connection', (s) => sockets.add(s));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  if (chrome) browser = await Browser.launch({ executablePath: chrome.path });
});

afterAll(async () => {
  await browser?.close();
  for (const s of sockets) s.destroy();
  server.close();
});

describe.skipIf(!chrome)('snapPages per-URL budget', () => {
  it('a wedged URL errors once within its budget; later URLs on the origin capture', async () => {
    const t0 = Date.now();
    const { pages } = await snapPages({
      urls: [`${base}/busy`, `${base}/ok1`, `${base}/ok2`],
      browser,
      viewport: { width: 320, height: 240 },
      storyTimeoutMs: 3000,
    });
    const ms = Date.now() - t0;
    expect(pages[0]!.error).toMatch(/exceeded its \d+ ms budget while in '/);
    expect(pages[0]!.snapshot).toBeUndefined();
    for (const p of pages.slice(1)) {
      expect(p.error).toBeUndefined();
      expect(p.snapshot?.structure?.elements.map((e) => e.text).join(' ')).toContain(
        'page /ok',
      );
    }
    // Budget, the 5 s close cap at worst, and two ordinary captures.
    expect(ms).toBeLessThan(3000 + 5000 + 6000);
  }, 60_000);

  it('at the default budget the 30 s navigation cap is what fires; the page is still replaced', async () => {
    const { pages } = await snapPages({
      urls: [`${base}/busy`, `${base}/ok1`, `${base}/ok2`],
      browser,
      viewport: { width: 320, height: 240 },
    });
    expect(pages[0]!.error).toMatch(/DOMContentLoaded within 30000 ms/);
    expect(pages.slice(1).map((p) => p.error)).toEqual([undefined, undefined]);
  }, 90_000);
});
