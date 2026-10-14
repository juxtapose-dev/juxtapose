import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import net from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { Browser } from '../browser/browser.js';
import { CdpConnection } from '../browser/cdp.js';
import { SocketTransport } from '../browser/transport.js';
import { CHROME_VERSION } from '../browser/pins.js';
import { daemonPaths } from '../browser/daemon/state.js';
import { startSupervisor } from '../browser/daemon/supervisor.js';
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
    // /busy holds the renderer's main thread from DOMContentLoaded on.
    res.end(
      req.url === '/busy'
        ? `<!doctype html><body><script>addEventListener('DOMContentLoaded',()=>{const t=Date.now();while(Date.now()-t<90000);})</script>busy</body>`
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
afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * `crash` kills its renderer (Page.crash) and fails at once; `close` closes
 * its own target with an evaluate in flight; `die` closes the whole browser;
 * every other story navigates after a pause, so the worker that failed fast
 * is the one that picks up the next story.
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
      if (id === 'close') {
        const hung = page.evaluate('new Promise(() => {})');
        await new Promise((r) => setTimeout(r, 100));
        const { targetId } = page as unknown as { targetId: string };
        await connectionOf(browser).send('Target.closeTarget', { targetId });
        await hung;
      }
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

const connectionOf = (b: Browser) =>
  (b as unknown as { connection: CdpConnection }).connection;

/**
 * A browser through an in-process supervisor, as `jux` gets it from the warm
 * daemon; `done` stops the supervisor and removes its state dir.
 */
async function daemonBrowser(): Promise<{ browser: Browser; done: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'jux-pool-'));
  const paths = daemonPaths(dir, `p${randomBytes(4).toString('hex')}`);
  const sup = await startSupervisor({
    executablePath: chrome!.path,
    paths,
    key: 'pool-test',
    idleMinutes: 10,
  });
  const done = async () => {
    await sup.stop();
    await rm(dir, { recursive: true, force: true });
  };
  try {
    const sock = net.connect(paths.socket);
    await new Promise<void>((r, e) => {
      sock.once('connect', r);
      sock.once('error', e);
    });
    const t = new SocketTransport(sock);
    const c = new CdpConnection(t);
    const ready = c.once('jux.ready');
    t.send(JSON.stringify({ jux: 'hello', version: CHROME_VERSION }));
    const { product } = await ready;
    return {
      browser: Browser.fromConnection(c, {
        version: product,
        close: async () => c.close(),
      }),
      done,
    };
  } catch (e) {
    await done();
    throw e;
  }
}

async function run(
  ids: string[],
  concurrency: number,
  via: 'fresh' | 'daemon' = 'fresh',
) {
  // Identity shuffle: j = floor(0.9999 * (i + 1)) = i, so the queue keeps
  // the order given and the crashing story is taken first.
  vi.spyOn(Math, 'random').mockReturnValue(0.9999);
  const d =
    via === 'daemon'
      ? await daemonBrowser()
      : {
          browser: await Browser.launch({ executablePath: chrome!.path }),
          done: async () => {},
        };
  const { browser } = d;
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
    await d.done();
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

  // PR #102 re-review N1: through the daemon, the closed target's in-flight
  // evaluate rejected with CdpError (the supervisor answered it before
  // forwarding the detach), the pool kept the dead page, and the next story
  // on that worker failed too: FAIL CdpError, FAIL TargetClosedError, PASS.
  for (const via of ['fresh', 'daemon'] as const) {
    it(`${via}: a target closed mid-story is FAIL TargetClosedError, then PASS, PASS`, async () => {
      expect(await run(['close', 'ok1', 'ok2'], 1, via)).toEqual([
        'FAIL TargetClosedError',
        'PASS',
        'PASS',
      ]);
    });
  }

  it('daemon: crash, ok, ok at concurrency 1 is FAIL, PASS, PASS', async () => {
    expect(await run(['crash', 'ok1', 'ok2'], 1, 'daemon')).toEqual([
      'FAIL PageCrashedError',
      'PASS',
      'PASS',
    ]);
  });

  // At the default 60 s budget the 30 s navigation cap fires first, as a
  // TimeoutError the pool did not treat as a dead page: every later story on
  // the worker failed at 30 s each (#163 review: busy, ok, ok, ok all failed).
  it('a busy page that trips the navigation cap does not fail the stories after it', async () => {
    const results = await run(['busy', 'ok1', 'ok2'], 1);
    expect(results[0]).toMatch(/^FAIL /);
    expect(results.slice(1)).toEqual(['PASS', 'PASS']);
  }, 90_000);

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
