// Navigation is bounded by settle, not by `load` (issue #125), and
// `network.external: 'block'` keeps third-party requests out of the capture
// (part of #147). Real Chrome, through snapPages: a subresource whose server
// holds the connection open forever must cost at most the settle cap.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { Socket } from 'node:net';
import { Browser } from '../browser/browser.js';
import { chromeForTests } from '../browser/__tests__/helpers.js';
import type { Snapshot, StoryParams } from '../types.js';
import { snapPages } from './snap.js';

const chrome = chromeForTests();
let server: Server;
let base: string;
let browser: Browser;
const sockets = new Set<Socket>();
const hits: string[] = [];

const doc = (body: string, head = '') =>
  `<!doctype html><head>${head}</head><body style="margin:0;font:16px sans-serif"><p>final</p>${body}</body>`;

const PAGES: Record<string, (port: number) => string> = {
  // Parser-inserted <img>: it holds `load` until the server answers, which
  // is never (Chakra's avatar fallback shape, a 522 after ~20 s).
  '/hung-img': () => doc('<img src="/never-image" width="10" height="10">'),
  // The same image on another origin (localhost, not 127.0.0.1).
  '/external-img': (port) =>
    doc(`<img src="http://localhost:${port}/never-image" width="10" height="10">`),
  '/own-img': () => doc('<img src="/ok.svg" width="10" height="10">'),
  // A top-level redirect to another origin (127.0.0.1 -> localhost): the
  // document that commits is the page, and its own stylesheet is not external.
  '/own-css': () => doc('', '<link rel="stylesheet" href="/own.css">'),
  // A child frame whose request never finishes, then a navigation away.
  '/frame-hang': () => doc('<iframe src="/frame-inner" width="10" height="10"></iframe>'),
  '/frame-inner': () => doc(`<script>fetch('/never-image')</script>`),
  '/static': () => doc(''),
};

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    hits.push(`${req.headers.host}${url.pathname}`);
    const page = PAGES[url.pathname];
    if (url.pathname === '/redir-top') {
      const port = (server.address() as { port: number }).port;
      res.writeHead(302, { location: `http://localhost:${port}/own-css` });
      res.end();
    } else if (url.pathname === '/own.css') {
      res.writeHead(200, { 'content-type': 'text/css' });
      res.end('p{color:red}');
    } else if (url.pathname === '/never-image') {
      // holds the connection
    } else if (url.pathname === '/ok.svg') {
      res.writeHead(200, { 'content-type': 'image/svg+xml' });
      res.end('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>');
    } else if (page) {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(page((server.address() as { port: number }).port));
    } else {
      res.writeHead(404);
      res.end();
    }
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

async function snap(path: string, params: StoryParams = {}) {
  const t0 = Date.now();
  const { pages } = await snapPages({
    urls: [`${base}${path}`],
    browser,
    viewport: { width: 320, height: 240 },
    params,
  });
  const r = pages[0]!;
  return {
    snapshot: r.snapshot as Snapshot | undefined,
    error: r.error,
    ms: Date.now() - t0,
  };
}

describe.skipIf(!chrome)('navigation is bounded by settle', () => {
  it('a subresource that never answers costs the settle cap, flagged, never an error', async () => {
    const { snapshot, error, ms } = await snap('/hung-img', {
      settle: { timeout: 1000 },
    });
    expect(error).toBeUndefined();
    expect(snapshot?.structure?.elements.map((e) => e.text)).toContain('final');
    expect(snapshot?.settle).toMatchObject({ status: 'timeout', timeoutMs: 1000 });
    expect(snapshot?.settle?.pending.join('\n')).toContain('/never-image');
    // main: waits the 30 s load timeout, then errors. Cap plus launch and capture.
    expect(ms).toBeLessThan(1000 + 3000);
  }, 60_000);
});

describe.skipIf(!chrome)("network.external: 'block'", () => {
  it('an external image neither loads nor hangs: unflagged and fast', async () => {
    hits.length = 0;
    const { snapshot, error, ms } = await snap('/external-img', {
      network: { external: 'block' },
    });
    expect(error).toBeUndefined();
    expect(snapshot?.settle).toBeUndefined();
    expect(ms).toBeLessThan(6000);
    expect(hits.some((h) => h.startsWith('localhost'))).toBe(false);
  }, 60_000);

  it("'allow' (the default) lets the external image hold the page to the cap", async () => {
    const { snapshot } = await snap('/external-img', { settle: { timeout: 800 } });
    expect(snapshot?.settle?.status).toBe('timeout');
  }, 60_000);

  it("the page's own origin still loads under 'block'", async () => {
    hits.length = 0;
    const { snapshot, error } = await snap('/own-img', {
      network: { external: 'block' },
    });
    expect(error).toBeUndefined();
    expect(snapshot?.settle).toBeUndefined();
    expect(hits.some((h) => h.endsWith('/ok.svg'))).toBe(true);
  }, 60_000);

  it("a top-level redirect to another origin keeps the new document's own resources", async () => {
    hits.length = 0;
    const { snapshot, error } = await snap('/redir-top', {
      network: { external: 'block' },
    });
    expect(error).toBeUndefined();
    expect(snapshot?.settle).toBeUndefined();
    expect(hits).toContain(`localhost:${new URL(base).port}/own.css`);
  }, 60_000);
});

describe.skipIf(!chrome)('requests left open by a navigated-away document', () => {
  it("a child frame's open request does not pin the next page at the cap", async () => {
    const { pages } = await snapPages({
      urls: [`${base}/frame-hang`, `${base}/static`],
      browser,
      viewport: { width: 320, height: 240 },
      params: { settle: { timeout: 800 } },
    });
    expect(pages[0]!.snapshot?.settle?.status).toBe('timeout');
    expect(pages[1]!.snapshot?.settle).toBeUndefined();
  }, 60_000);
});
