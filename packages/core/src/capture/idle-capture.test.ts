// The event-driven settle wait against a real Chrome, through snapPages (the
// whole capture pipeline). Each page renders its final state late, by a route
// the old 150 ms quiet window missed or hung on; the structure snapshot says
// whether the capture saw the final state, and `settle` whether it hit the cap.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
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

const page = (script: string, body = '') =>
  `<!doctype html><body style="margin:0;font:16px sans-serif">${body}<div id="out"></div><script>
  const add = (t) => { const d = document.createElement('p'); d.textContent = t; document.getElementById('out').appendChild(d); };
  ${script}
  </script></body>`;

const PAGES: Record<string, string> = {
  '/timers': page(`setTimeout(() => setTimeout(() => add('final'), 300), 200);`),
  '/fetch-chain': page(
    `fetch('/slow/150/a').then((r) => r.text()).then(() => fetch('/slow/150/b')).then((r) => r.text()).then((t) => add('final ' + t));`,
  ),
  '/microtasks': page(
    `let p = Promise.resolve(); for (let i = 0; i < 50; i++) p = p.then(() => new Promise((r) => queueMicrotask(r))); p.then(() => add('final'));`,
  ),
  // Sockets and streams never finish while the page is open.
  '/socket': page(
    `const ws = new WebSocket('ws://' + location.host + '/ws'); ws.onopen = () => add('open');
     const es = new EventSource('/sse'); add('final');`,
  ),
  // Starts its request after the 1000 ms timer horizon: only `require`
  // knows to wait for it.
  '/late': page(
    `setTimeout(() => fetch('/slow/50/late').then((r) => r.text()).then(() => add('final')), 1200);`,
  ),
  '/ready': page(
    `setTimeout(() => { add('final'); window.__juxtapose.ready(); }, 1200);`,
  ),
  '/hang': page(`fetch('/never'); add('final');`),
  // Added after `load`, so navigation is done and only settle can wait on it.
  '/broken-image': page(
    `add('final'); addEventListener('load', () => { const i = new Image(10, 10); i.src = '/never-image'; document.body.appendChild(i); });`,
  ),
  '/lazy-image': page(
    `add('final');`,
    '<div style="height:5000px"></div><img loading="lazy" src="/never-image" width="10" height="10">',
  ),
};

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const slow = /^\/slow\/(\d+)\/(.*)$/.exec(url.pathname);
    if (slow) {
      setTimeout(() => res.end(slow[2]), Number(slow[1]));
    } else if (url.pathname === '/sse') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: hi\n\n');
    } else if (url.pathname === '/never' || url.pathname === '/never-image') {
      // never answers
    } else if (PAGES[url.pathname]) {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(PAGES[url.pathname]);
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  server.on('connection', (s) => sockets.add(s));
  // The smallest WebSocket server: accept the handshake, never send a frame.
  server.on('upgrade', (req, socket) => {
    sockets.add(socket as Socket);
    const accept = createHash('sha1')
      .update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64');
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  if (chrome) browser = await Browser.launch({ executablePath: chrome.path });
});

afterAll(async () => {
  await browser?.close();
  for (const s of sockets) s.destroy();
  server.close();
});

async function snap(path: string, params: StoryParams = {}): Promise<Snapshot> {
  const { pages } = await snapPages({
    urls: [`${base}${path}`],
    browser,
    viewport: { width: 320, height: 240 },
    params,
  });
  if (!pages[0]!.snapshot) throw new Error(pages[0]!.error);
  return pages[0]!.snapshot;
}

const texts = (s: Snapshot) => (s.structure?.elements ?? []).map((e) => e.text ?? '');

describe.skipIf(!chrome)('event-driven settle in Chrome', () => {
  it('waits out a timer chain (200 ms then 300 ms)', async () => {
    const s = await snap('/timers');
    expect(texts(s)).toContain('final');
    expect(s.settle).toBeUndefined();
  });

  it('waits out a chain of two fetches', async () => {
    const s = await snap('/fetch-chain');
    expect(texts(s)).toContain('final b');
    expect(s.settle).toBeUndefined();
  });

  it('waits out a 50-deep promise and microtask chain', async () => {
    const s = await snap('/microtasks');
    expect(texts(s)).toContain('final');
    expect(s.settle).toBeUndefined();
  });

  it('does not wait for a WebSocket or an EventSource by default', async () => {
    const started = Date.now();
    const s = await snap('/socket');
    expect(s.settle).toBeUndefined();
    expect(texts(s)).toContain('final');
    // Far below the 1500 ms cap: neither was ever counted.
    expect(Date.now() - started).toBeLessThan(1200);
  });

  it('require waits for a request that starts after the timer horizon', async () => {
    const without = await snap('/late');
    expect(texts(without)).not.toContain('final');
    const s = await snap('/late', {
      settle: { timeout: 4000, network: { require: ['/slow/*/late'] } },
    });
    expect(texts(s)).toContain('final');
    expect(s.settle).toBeUndefined();
  });

  it('a require pattern that never matches is a settle-timeout naming it', async () => {
    const s = await snap('/timers', {
      settle: { timeout: 700, network: { require: ['/api/nope'] } },
    });
    expect(s.settle).toEqual({
      status: 'timeout',
      timeoutMs: 700,
      pending: ["no request matching required pattern '/api/nope' has completed"],
    });
  });

  it('settle.ready waits for window.__juxtapose.ready()', async () => {
    const s = await snap('/ready', { settle: { ready: true, timeout: 4000 } });
    expect(texts(s)).toContain('final');
    expect(s.settle).toBeUndefined();
  });

  it('at the cap: captures anyway, flags settle-timeout and names the request', async () => {
    const started = Date.now();
    const s = await snap('/hang', { settle: { timeout: 600 } });
    expect(texts(s)).toContain('final');
    expect(s.settle).toEqual({
      status: 'timeout',
      timeoutMs: 600,
      pending: ['1 request to /never in flight (Fetch)'],
    });
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('an image that never loads is capped, not waited for forever', async () => {
    // The old drain awaited every incomplete image with no cap: this hung.
    const s = await snap('/broken-image', { settle: { timeout: 600 } });
    expect(s.settle?.pending).toEqual([
      '1 request to /never-image in flight (Image)',
      '1 image still loading: /never-image',
    ]);
  });

  it('a lazy image below the fold is not waited for at all', async () => {
    const started = Date.now();
    const s = await snap('/lazy-image');
    expect(s.settle).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(1200);
  });
});
