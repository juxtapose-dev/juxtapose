// The event-driven settle wait against a real Chrome, through snapPages (the
// whole capture pipeline). Each page renders its final state late, by a route
// the old 150 ms quiet window missed or hung on; the structure snapshot says
// whether the capture saw the final state, and `settle` whether it hit the cap.

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
  // Promise steps that each wait a task (a 0 ms timer from a fresh
  // resolver, so no single function re-arms itself): microtasks alone finish
  // before any check could run, so this is the case that needs tracking.
  '/microtasks': page(
    `let p = Promise.resolve(); for (let i = 0; i < 20; i++) p = p.then(() => new Promise((r) => setTimeout(r, 0))).then(() => { document.title = String(Math.random()); });
     p.then(() => add('final'));`,
  ),
  // An event stream never finishes while the page is open.
  '/stream': page(`const es = new EventSource('/sse'); add('final');`),
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
  // A Worker's script request never gets loadingFinished on the page session;
  // its answer arrives after 120 ms.
  '/worker': page(`const w = new Worker('/w.js'); w.onmessage = (e) => add(e.data);`),
  // React-scheduler shape: 60 MessageChannel slices of 5 ms each.
  '/sched': page(
    `const ch = new MessageChannel(); let n = 0; add('rendering');
     ch.port1.onmessage = () => { const t = performance.now(); while (performance.now() - t < 5) {}
       if (++n < 60) ch.port2.postMessage(null); else document.querySelector('#out p').textContent = 'final'; };
     ch.port2.postMessage(null);`,
  ),
  // Polls forever without touching the DOM; also runs a 300 ms chain of
  // distinct timers, which must still be waited for.
  '/timer-poll': page(
    `(function poll() { setTimeout(poll, 200); })(); setTimeout(() => setTimeout(() => add('final'), 150), 150);`,
  ),
  // Keeps requests in flight across the next navigation. Another host name
  // for the same server, so the hanging requests don't use up the six
  // connections the next page's navigation needs.
  '/poller': page(
    `setInterval(() => fetch('http://localhost:' + location.port + '/never?' + Math.random(), { mode: 'no-cors' }).catch(() => {}), 2); add('final');`,
  ),
  '/static': page(`add('final');`),
  '/hidden-lazy': page(
    `add('final');`,
    '<img loading="lazy" src="/never-image" style="display:none" width="10" height="10">',
  ),
  // An animation loop stops being counted after 3 frames, so the idle wait
  // returns while it runs on; its 5th frame, inside the paint barrier,
  // schedules the last change without touching the DOM yet.
  '/late-frame': page(
    `let n = 0; (function f() { if (++n === 5) setTimeout(() => add('final'), 60); else requestAnimationFrame(f); })();`,
  ),
  '/port-remove': page(
    `const ch = new MessageChannel(); const f = () => add('removed listener fired'); ch.port1.addEventListener('message', f);
     ch.port1.removeEventListener('message', f); ch.port1.start(); ch.port2.postMessage(1); add('final');`,
  ),
  // A finite chain of one function re-arming itself every 100 ms, changing
  // the DOM each step: a staged reveal, a retry with backoff.
  '/self-chain': page(
    `let n = 0; function step() { add('step ' + ++n); if (n < 3) setTimeout(step, 100); else add('final'); } setTimeout(step, 100);`,
  ),
  // Polls that re-arm through a fresh closure or arrow every time, never
  // touching the DOM.
  '/poll-closure': page(
    `function poll() { setTimeout(function () { poll(); }, 200); } poll(); add('final');`,
  ),
  '/poll-arrow': page(
    `const poll = () => { setTimeout(() => poll(), 200); }; poll(); add('final');`,
  ),
  // A subclass of Worker must keep its methods and its instanceof.
  '/worker-subclass': page(
    `class MyWorker extends Worker { hello() { return 'subclass ok'; } }
     const w = new MyWorker('/w.js'); add(typeof w.hello === 'function' ? w.hello() : 'method lost'); add(String(w instanceof MyWorker));`,
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
    } else if (url.pathname === '/w.js') {
      res.writeHead(200, { 'content-type': 'text/javascript' });
      res.end(`setTimeout(() => postMessage('final'), 120);`);
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

  it('waits out a promise chain that yields a task at every step', async () => {
    const s = await snap('/microtasks');
    expect(texts(s)).toContain('final');
    expect(s.settle).toBeUndefined();
  });

  it('does not wait for an EventSource by default', async () => {
    const s = await snap('/stream');
    expect(s.settle).toBeUndefined();
    expect(texts(s)).toContain('final');
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
    expect(s.settle).toMatchObject({
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
    const s = await snap('/hang', { settle: { timeout: 600 } });
    expect(texts(s)).toContain('final');
    expect(s.settle).toMatchObject({
      status: 'timeout',
      timeoutMs: 600,
      pending: ['1 request to /never in flight (Fetch)'],
    });
    // The full URL and type, for the flake classifier, and the page's origin.
    const settle = s.settle as {
      requests?: Array<{ url: string; type: string }>;
      origin?: string;
    };
    expect(settle.requests).toHaveLength(1);
    expect(settle.requests![0]).toMatchObject({ type: 'Fetch' });
    expect(new URL(settle.requests![0]!.url).pathname).toBe('/never');
    expect(settle.origin).toBe(new URL(settle.requests![0]!.url).origin);
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
    const s = await snap('/lazy-image');
    expect(s.settle).toBeUndefined();
  });

  it('waits for a Worker to answer, and its script request does not pin the cap', async () => {
    const s = await snap('/worker');
    expect(texts(s)).toContain('final');
    expect(s.settle).toBeUndefined();
  });

  it('waits out continuous MessageChannel work (60 slices of 5 ms)', async () => {
    const s = await snap('/sched');
    expect(texts(s)).toContain('final');
    expect(texts(s)).not.toContain('rendering');
    expect(s.settle).toBeUndefined();
  });

  it('a timer that re-arms itself forever does not pin the cap; other timers are still waited for', async () => {
    const s = await snap('/timer-poll');
    expect(texts(s)).toContain('final');
    expect(s.settle).toBeUndefined();
  });

  it("the previous page's requests do not leak into the next page's wait", async () => {
    // The leak needs a request started between the navigation's start and its
    // commit, which a 2 ms poller hits about 2 times in 3: three rounds.
    for (let round = 0; round < 3; round++) {
      const { pages } = await snapPages({
        urls: [`${base}/poller`, `${base}/static`],
        browser,
        viewport: { width: 320, height: 240 },
      });
      expect(pages[0]!.snapshot?.settle?.status).toBe('timeout');
      expect(pages[1]!.snapshot?.settle).toBeUndefined();
    }
  }, 30_000);

  it('a hidden lazy image is not waited for', async () => {
    const s = await snap('/hidden-lazy');
    expect(s.settle).toBeUndefined();
  });

  it('work that lands during the paint barrier gets another wait', async () => {
    const s = await snap('/late-frame');
    expect(texts(s)).toContain('final');
  });

  it('a removed MessagePort listener stays removed', async () => {
    const s = await snap('/port-remove');
    expect(texts(s)).toContain('final');
    expect(texts(s)).not.toContain('removed listener fired');
  });

  it('waits out a function that re-arms itself while it changes the DOM', async () => {
    const s = await snap('/self-chain');
    expect(texts(s)).toContain('final');
    expect(s.settle).toBeUndefined();
  });

  it.each(['/poll-closure', '/poll-arrow'])(
    'a poll re-armed through a fresh closure or arrow does not pin the cap (%s)',
    async (path) => {
      const s = await snap(path);
      expect(texts(s)).toContain('final');
      expect(s.settle).toBeUndefined();
    },
  );

  it('a Worker subclass keeps its methods and instanceof', async () => {
    const s = await snap('/worker-subclass');
    expect(texts(s)).toContain('subclass ok');
    expect(texts(s)).toContain('true');
  });
});
