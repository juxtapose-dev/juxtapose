import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import sharp from 'sharp';
import { Browser, type BrowserContext } from './browser.js';
import { CdpPage, PageCrashedError, TimeoutError, type Page } from './page.js';
import { CdpConnection, SendTimeoutError, TargetClosedError } from './cdp.js';
import type { Transport } from './transport.js';
import { launchChrome, type LaunchedChrome } from './launch.js';
import { chromeForTests } from './__tests__/helpers.js';

const chrome = chromeForTests();
let server: Server;
let base: string;
let browser: Browser;

const PAGES: Record<string, string> = {
  '/plain':
    '<!doctype html><body style="margin:0;background:#fff"><div id="box" style="width:100px;height:50px;background:#00f"></div><input id="i" autofocus></body>',
  '/late':
    '<!doctype html><body><script>setTimeout(()=>{const d=document.createElement("div");d.id="late";d.textContent="x";document.body.appendChild(d)},150)</script></body>',
  '/shadow':
    '<!doctype html><body><x-host></x-host><script>customElements.define("x-host",class extends HTMLElement{connectedCallback(){this.attachShadow({mode:"open"}).innerHTML=\'<div class="secret" style="width:20px;height:20px;background:#0f0"></div>\'}})</script></body>',
  // The child frame loads at once; the main document's load waits on a slow
  // image, so a goto that accepted the child's `load` would return early.
  '/iframe':
    '<!doctype html><body><iframe src="/frame"></iframe><img src="/slow-img"><script>window.__mainLoaded=false;addEventListener("load",()=>{window.__mainLoaded=true})</script></body>',
  '/frame': '<!doctype html><body>frame</body>',
  '/alert':
    '<!doctype html><body><script>alert("hi")</script><div id="after">after</div></body>',
  '/worker':
    '<!doctype html><body><script>const w=new Worker(URL.createObjectURL(new Blob(["postMessage(6*7)"],{type:"text/javascript"})));window.__fromWorker=new Promise((r)=>{w.onmessage=(e)=>r(e.data)})</script></body>',
  '/hang': '', // never answered
  // Commits at once; its load waits forever on an image nobody answers.
  '/stuck-load': '<!doctype html><body><img src="/hang"></body>',
};

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/hang') return; // keep the request open forever
    if (req.url === '/slow-img') {
      setTimeout(() => {
        res.writeHead(404);
        res.end();
      }, 400);
      return;
    }
    const body = PAGES[req.url ?? ''];
    if (body === undefined) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(body);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  if (chrome) browser = await Browser.launch({ executablePath: chrome.path });
});
afterAll(async () => {
  await browser?.close();
  server.closeAllConnections();
  server.close();
});

async function withPage(
  fn: (page: Page, ctx: BrowserContext) => Promise<void>,
  opts: { blockServiceWorkers?: boolean } = {},
) {
  const ctx = await browser.newContext({
    viewport: { width: 300, height: 200 },
    ...opts,
  });
  try {
    await fn(await ctx.newPage(), ctx);
  } finally {
    await ctx.close();
  }
}

/** Resolves once the main frame has committed `url` (load may still be pending). */
async function committed(page: Page, url: string): Promise<void> {
  for (let i = 0; i < 200 && page.url() !== url; i++)
    await new Promise((r) => setTimeout(r, 10));
  expect(page.url()).toBe(url);
}

/** Expect `p` to reject within `ms`; returns the error. */
async function rejectsWithin(p: Promise<unknown>, ms: number): Promise<unknown> {
  const t0 = performance.now();
  const err = await p.then(
    () => new Error('resolved'),
    (e: unknown) => e,
  );
  expect(performance.now() - t0).toBeLessThan(ms);
  expect(err).not.toEqual(new Error('resolved'));
  return err;
}

describe.skipIf(!chrome)('CdpPage', () => {
  it('url() keeps the fragment', () =>
    withPage(async (page) => {
      await page.goto(`${base}/plain#frag`);
      expect(page.url()).toBe(`${base}/plain#frag`);
    }));
  it('closing the context rejects a committed goto and in-flight evaluate within 1 s', () =>
    withPage(async (page, ctx) => {
      const url = `${base}/stuck-load`;
      const nav = page.goto(url, { timeout: 20_000 });
      await committed(page, url);
      const ev = page.evaluate('new Promise(() => {})', undefined, { timeout: 20_000 });
      void ctx.close();
      const errs = await Promise.all([rejectsWithin(nav, 1000), rejectsWithin(ev, 1000)]);
      for (const e of errs) expect(e).toBeInstanceOf(TargetClosedError);
    }));
  // The bound is how long the renderer takes to die, not the driver: the
  // browser only learns of a crash once the process is gone. macOS: 1–8 ms.
  // Linux CfT 151 on ubuntu-latest: 2,049 ms (PR #98 CI) — Chrome for Testing
  // builds install in-process stack dumping, which symbolizes the trace in
  // the renderer's signal handler before it dies. 3 s keeps headroom over
  // that while still failing a driver that waits out the 20 s timeouts.
  it('a renderer crash rejects in-flight evaluate and goto well before their timeouts', () =>
    withPage(async (page) => {
      const bound = process.platform === 'linux' ? 3000 : 1000;
      const url = `${base}/stuck-load`;
      const nav = page.goto(url, { timeout: 20_000 });
      await committed(page, url);
      const ev = page.evaluate('new Promise(() => {})', undefined, { timeout: 20_000 });
      // Both settle together; measure them together so a failed bound on one
      // cannot leave the other's rejection unhandled.
      void page.send('Page.crash').catch(() => {});
      const [evErr, navErr] = await Promise.all([
        rejectsWithin(ev, bound),
        rejectsWithin(nav, bound),
      ]);
      expect(evErr).toBeInstanceOf(PageCrashedError);
      expect(navErr).toBeInstanceOf(PageCrashedError);
      await expect(page.evaluate('1')).rejects.toBeInstanceOf(PageCrashedError);
    }));
  it('goto waits for load, evaluate round-trips JSON, url() is the final url', () =>
    withPage(async (page) => {
      await page.goto(`${base}/plain`);
      expect(page.url()).toBe(`${base}/plain`);
      expect(
        await page.evaluate(() => ({
          w: window.innerWidth,
          h: window.innerHeight,
          ready: document.readyState,
        })),
      ).toEqual({ w: 300, h: 200, ready: 'complete' });
      expect(await page.evaluate((a: { n: number }) => a.n * 2, { n: 21 })).toBe(42);
      expect(await page.evaluate('1 + 1')).toBe(2);
    }));
  it('evaluate rejects with the page error message', () =>
    withPage(async (page) => {
      await page.goto(`${base}/plain`);
      await expect(
        page.evaluate(() => {
          throw new Error('boom');
        }),
      ).rejects.toThrow(/boom/);
    }));
  it('evaluate rejects at its node-side timeout', () =>
    withPage(async (page) => {
      await page.goto(`${base}/plain`);
      await expect(
        page.evaluate('new Promise(() => {})', undefined, { timeout: 100 }),
      ).rejects.toBeInstanceOf(SendTimeoutError);
    }));
  it('an alert is dismissed and evaluate returns', () =>
    withPage(async (page) => {
      await page.goto(`${base}/alert`);
      expect(
        await page.evaluate(() => document.getElementById('after')?.textContent),
      ).toBe('after');
      expect(await page.evaluate(() => confirm('x'))).toBe(false);
    }));
  it('goto waits for the main frame load, not a child frame', () =>
    withPage(async (page) => {
      await page.goto(`${base}/iframe`);
      expect(
        await page.evaluate(
          () => (window as unknown as { __mainLoaded: boolean }).__mainLoaded,
        ),
      ).toBe(true);
    }));
  it('a dedicated worker runs (no auto-attach pausing it)', () =>
    withPage(async (page) => {
      await page.goto(`${base}/worker`);
      expect(
        await page.evaluate(
          () => (window as unknown as { __fromWorker: Promise<number> }).__fromWorker,
          undefined,
          { timeout: 2000 },
        ),
      ).toBe(42);
    }));
  it('waitForFunction polls on rAF and waitForSelector sees late elements; both time out with TimeoutError', () =>
    withPage(async (page) => {
      await page.goto(`${base}/late`);
      await page.waitForSelector('#late', { timeout: 2000 });
      await page.waitForFunction((id: string) => !!document.getElementById(id), 'late', {
        timeout: 500,
      });
      await expect(
        page.waitForSelector('#never', { timeout: 100 }),
      ).rejects.toBeInstanceOf(TimeoutError);
      await expect(
        page.waitForFunction(() => false, undefined, { timeout: 100 }),
      ).rejects.toBeInstanceOf(TimeoutError);
      expect(() => page.waitForSelector('text=x')).toThrow(/not a CSS selector/);
    }));
  it('goto rejects on timeout with the url', () =>
    withPage(async (page) => {
      await expect(page.goto(`${base}/hang`, { timeout: 300 })).rejects.toThrow(
        new RegExp(`${base}/hang`),
      );
    }));
  it('setViewportSize changes innerWidth and screenshot is a PNG of the viewport', () =>
    withPage(async (page) => {
      await page.goto(`${base}/plain`);
      await page.setViewportSize({ width: 480, height: 400 });
      expect(await page.evaluate(() => window.innerWidth)).toBe(480);
      const meta = await sharp(await page.screenshot()).metadata();
      expect([meta.format, meta.width, meta.height]).toEqual(['png', 480, 400]);
    }));
  it('a mask paints #F0F over the element, pierces open shadow roots, and leaves no trace', () =>
    withPage(async (page) => {
      await page.goto(`${base}/shadow`);
      await page.waitForSelector('.secret', { timeout: 1000 });
      const png = await page.screenshot({ mask: ['.secret'] });
      const { data } = await sharp(png)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      const px = (x: number, y: number) =>
        Array.from(data.subarray((y * 300 + x) * 4, (y * 300 + x) * 4 + 3));
      expect(px(10, 10)).toEqual([255, 0, 255]);
      expect(await page.evaluate(() => document.querySelector('x-pw-glass'))).toBeNull();
      await expect(page.screenshot({ mask: ['text=secret'] })).rejects.toThrow(
        /not a CSS selector/,
      );
    }));
  it('clearOrigin wipes localStorage; a blocked service worker never registers; onMainResponse sees the status', () =>
    withPage(
      async (page) => {
        const statuses: number[] = [];
        const off = page.onMainResponse((s) => statuses.push(s));
        await page.goto(`${base}/plain`);
        await page.evaluate(() => localStorage.setItem('k', 'v'));
        await page.clearOrigin(base);
        await page.goto(`${base}/plain`);
        expect(await page.evaluate(() => localStorage.getItem('k'))).toBeNull();
        expect(
          await page.evaluate(() => navigator.serviceWorker.register.toString()),
        ).toMatch(/blocked/);
        off();
        await page.goto(`${base}/nope`).catch(() => {});
        expect(statuses).toEqual([200, 200]);
      },
      { blockServiceWorkers: true },
    ));
});

describe.skipIf(!chrome)('Browser', () => {
  it('version() strips the product prefix so manifests stay comparable', () => {
    expect(browser.version()).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
  });
});

describe.skipIf(!chrome)('Browser over a borrowed connection', () => {
  let launched: LaunchedChrome;
  let borrowed: Browser;
  beforeAll(async () => {
    launched = await launchChrome({ executablePath: chrome!.path });
    borrowed = Browser.fromConnection(launched.connection, {
      version: 'HeadlessChrome/151.0.7922.34',
      close: launched.close,
    });
  });
  afterAll(async () => {
    await borrowed?.close();
  });

  it('page init sends exactly the spike list plus Log.enable, and no auto-attach/geolocation/file chooser', async () => {
    const spy = vi.spyOn(launched.connection, 'send');
    const ctx = await borrowed.newContext({ viewport: { width: 800, height: 600 } });
    try {
      await ctx.newPage();
      const pageMethods = spy.mock.calls.filter((c) => c[2]).map((c) => c[0]);
      expect([...pageMethods].sort()).toEqual(
        [
          'Page.enable',
          'Page.setLifecycleEventsEnabled',
          'Runtime.enable',
          'Network.enable',
          'Log.enable',
          'Emulation.setFocusEmulationEnabled',
          'Emulation.setDeviceMetricsOverride',
          'Page.setFontFamilies',
          'Emulation.setEmulatedMedia',
        ].sort(),
      );
      const metrics = spy.mock.calls.find(
        (c) => c[0] === 'Emulation.setDeviceMetricsOverride',
      );
      expect(metrics?.[1]).toEqual({
        mobile: false,
        width: 800,
        height: 600,
        screenWidth: 800,
        screenHeight: 600,
        deviceScaleFactor: 1,
        screenOrientation: { angle: 0, type: 'landscapePrimary' },
      });
    } finally {
      spy.mockRestore();
      await ctx.close();
    }
  });

  it('closing a context (and a timed-out goto) leaves no listeners or pending sends behind', async () => {
    const before = launched.connection.handlerKeyCount;
    const beforeTotal = launched.connection.handlerCount;
    const ctx = await borrowed.newContext({ viewport: { width: 300, height: 200 } });
    const page = await ctx.newPage();
    page.onMainResponse(() => {});
    await page.goto(`${base}/plain`);
    await expect(page.goto(`${base}/hang`, { timeout: 200 })).rejects.toBeInstanceOf(
      TimeoutError,
    );
    await ctx.close();
    expect(launched.connection.handlerKeyCount).toBe(before);
    expect(launched.connection.handlerCount).toBe(beforeTotal);
    expect(launched.connection.pendingCount).toBe(0);
    await expect(page.evaluate('1')).rejects.toThrow(/closed/);
  });

  it('every listener goes with its page: the handler total returns to baseline', async () => {
    const before = launched.connection.handlerCount;
    const ctx = await borrowed.newContext({ viewport: { width: 300, height: 200 } });
    for (let i = 0; i < 3; i++) {
      const page = await ctx.newPage();
      page.onMainResponse(() => {});
      await page.goto(`${base}/plain`);
    }
    expect(launched.connection.handlerCount).toBeGreaterThan(before);
    await ctx.close();
    expect(launched.connection.handlerCount).toBe(before);
  });

  it('isConnected() turns false once the browser is gone', async () => {
    expect(borrowed.isConnected()).toBe(true);
    await borrowed.close();
    expect(borrowed.isConnected()).toBe(false);
  });
});

describe.skipIf(!chrome)('browser death', () => {
  it('killing chrome rejects a committed goto and in-flight evaluate within 1 s', async () => {
    const launched = await launchChrome({ executablePath: chrome!.path });
    const b = Browser.fromConnection(launched.connection, {
      version: 'HeadlessChrome/1.0.0.0',
      close: launched.close,
    });
    try {
      const ctx = await b.newContext({ viewport: { width: 300, height: 200 } });
      const page = await ctx.newPage();
      const url = `${base}/stuck-load`;
      const nav = page.goto(url, { timeout: 20_000 });
      await committed(page, url);
      const ev = page.evaluate('new Promise(() => {})', undefined, { timeout: 20_000 });
      process.kill(launched.pid, 'SIGKILL');
      const errs = await Promise.all([rejectsWithin(nav, 1000), rejectsWithin(ev, 1000)]);
      for (const e of errs) expect(e).toBeInstanceOf(TargetClosedError);
      expect(b.isConnected()).toBe(false);
    } finally {
      await b.close();
    }
  });
});

/**
 * A page that dies with nothing in flight must not leave a rejected promise
 * behind: under Node's default --unhandled-rejections=throw that kills the
 * host (the CLI, the Storybook addon's server) for a crash nobody asked about.
 */
describe.skipIf(!chrome)('a page dying idle leaves no unhandled rejection', () => {
  async function unhandledDuring(fn: () => Promise<void>): Promise<unknown[]> {
    const seen: unknown[] = [];
    const spy = (reason: unknown) => seen.push(reason);
    process.on('unhandledRejection', spy);
    try {
      await fn();
      // unhandledRejection fires after the microtask queue drains; give it a
      // few macrotask turns to arrive.
      for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 20));
    } finally {
      process.off('unhandledRejection', spy);
    }
    return seen;
  }

  /** Poll until the page reports itself unusable; returns that error. */
  async function untilGone(page: Page): Promise<unknown> {
    for (let i = 0; i < 500; i++) {
      const err = await page.evaluate('1').then(
        () => null,
        (e: unknown) => e,
      );
      if (err) return err;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('page never went away');
  }

  it('a renderer crash', async () => {
    const seen = await unhandledDuring(() =>
      withPage(async (page) => {
        await page.goto(`${base}/plain`);
        void page.send('Page.crash').catch(() => {});
        expect(await untilGone(page)).toBeInstanceOf(PageCrashedError);
      }),
    );
    expect(seen).toEqual([]);
  });

  it('a context close', async () => {
    const seen = await unhandledDuring(async () => {
      const ctx = await browser.newContext({ viewport: { width: 300, height: 200 } });
      const page = await ctx.newPage();
      await page.goto(`${base}/plain`);
      await ctx.close();
      expect(await untilGone(page)).toBeInstanceOf(TargetClosedError);
    });
    expect(seen).toEqual([]);
  });

  it('a browser kill', async () => {
    const seen = await unhandledDuring(async () => {
      const launched = await launchChrome({ executablePath: chrome!.path });
      const b = Browser.fromConnection(launched.connection, {
        version: 'HeadlessChrome/1.0.0.0',
        close: launched.close,
      });
      try {
        const ctx = await b.newContext({ viewport: { width: 300, height: 200 } });
        const page = await ctx.newPage();
        await page.goto(`${base}/plain`);
        process.kill(launched.pid, 'SIGKILL');
        expect(await untilGone(page)).toBeInstanceOf(TargetClosedError);
      } finally {
        await b.close();
      }
    });
    expect(seen).toEqual([]);
  });
});

/** Answers every command with {} unless `answer` says otherwise; events on demand. */
class FakeChrome implements Transport {
  onMessage: ((message: string) => void) | null = null;
  onClose: ((reason?: string) => void) | null = null;
  answer: (m: { id: number; method: string }) => object | undefined = () => ({});
  send(message: string): void {
    const m = JSON.parse(message) as { id: number; method: string };
    const result = this.answer(m);
    if (result) this.reply(m.id, result);
  }
  reply(id: number, result: object): void {
    this.onMessage?.(JSON.stringify({ id, result }));
  }
  event(method: string, params: object, sessionId?: string): void {
    this.onMessage?.(JSON.stringify({ method, params, sessionId }));
  }
  close(): void {
    this.onClose?.('closed');
  }
}

describe('CdpPage.goto (fake browser)', () => {
  it("a stale load from the previous document does not end goto; the new document's load does", async () => {
    const fake = new FakeChrome();
    const conn = new CdpConnection(fake);
    const page = await CdpPage.create(conn, 'T', 'S', {
      viewport: { width: 300, height: 200 },
      blockServiceWorkers: false,
      os: 'linux',
    });
    const staleLoad = () =>
      fake.event(
        'Page.lifecycleEvent',
        { name: 'load', frameId: 'T', loaderId: 'OLD' },
        'S',
      );
    fake.answer = (m) => {
      if (m.method === 'Page.navigate') {
        staleLoad(); // before the reply
        fake.reply(m.id, { frameId: 'T', loaderId: 'NEW' });
        setTimeout(staleLoad, 10); // and after goto has seen the reply
        return undefined;
      }
      if (m.method === 'Page.getFrameTree')
        return { frameTree: { frame: { url: 'http://x/next' } } };
      return {};
    };
    let done = false;
    const nav = page.goto('http://x/next', { timeout: 2000 }).then(() => (done = true));
    await new Promise((r) => setTimeout(r, 50));
    expect(done).toBe(false);
    fake.event(
      'Page.lifecycleEvent',
      { name: 'load', frameId: 'T', loaderId: 'NEW' },
      'S',
    );
    await nav;
    expect(page.url()).toBe('http://x/next');
  });
});
