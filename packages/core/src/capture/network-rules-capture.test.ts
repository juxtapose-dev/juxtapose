// network.external by resource type, and network.rules with placeholders
// (issue #177, part of #147). Real Chrome, through snapPages.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { Socket } from 'node:net';
import { Browser } from '../browser/browser.js';
import { chromeForTests } from '../browser/__tests__/helpers.js';
import type { Snapshot, StoryParams } from '../types.js';
import { snapPages } from './snap.js';
import { applyNetworkPolicy } from './network-policy.js';
import { resolveNetwork } from './network-rules.js';
import type { SettleLayer } from './settle-options.js';

const chrome = chromeForTests();
let server: Server;
let base: string;
let other: string; // the same server under another origin (localhost)
let browser: Browser;
const sockets = new Set<Socket>();
const hits: string[] = [];

const doc = (body: string) =>
  `<!doctype html><body style="margin:0;font:16px sans-serif"><p>final</p>${body}</body>`;

/** A 1x1 PNG whose color changes on every request. */
function randomPng(): Buffer {
  const rnd = () => Math.floor(Math.random() * 256);
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let r = 0xffffffff;
    for (const x of b) r = crcTable[(r ^ x) & 255]! ^ (r >>> 8);
    return (r ^ 0xffffffff) >>> 0;
  };
  const chunk = (t: string, d: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(d.length);
    const td = Buffer.concat([Buffer.from(t), d]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  // filter byte + RGB, stored (uncompressed) deflate block
  const raw = Buffer.from([0, rnd(), rnd(), rnd()]);
  const adler = (() => {
    let a = 1;
    let b = 0;
    for (const x of raw) {
      a = (a + x) % 65521;
      b = (b + a) % 65521;
    }
    return ((b << 16) | a) >>> 0;
  })();
  const z = Buffer.concat([
    Buffer.from([0x78, 0x01, 0x01, raw.length, 0, ~raw.length & 255, 0xff]),
    raw,
    Buffer.alloc(4),
  ]);
  z.writeUInt32BE(adler, z.length - 4);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', z),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const PAGES: Record<string, () => string> = {
  // A cross-origin image whose bytes differ on every request.
  '/rand-img': () =>
    doc(`<img src="${other}/rand.png" width="64" height="64" style="display:block">`),
  // A cross-origin frame whose content differs on every request.
  '/rand-frame': () =>
    doc(`<iframe src="${other}/rand-frame-inner" width="120" height="60"></iframe>`),
  // An image that is never answered.
  '/never-img': () => doc(`<img src="${other}/never.png" width="10" height="10">`),
  '/two-imgs': () =>
    doc(
      `<img src="${other}/a.png" width="10" height="10"><img src="${other}/b.png" width="10" height="10">`,
    ),
  '/own-img': () => doc(`<img src="/own.png" width="10" height="10">`),
  // A credentialed CORS image: needs the exact origin, not `*`.
  '/cred-img': () =>
    doc(
      `<p id="r">pending</p><img crossorigin="use-credentials" src="${other}/cred.png" width="10" height="10" onload="r.textContent='loaded'" onerror="r.textContent='failed'">`,
    ),
  '/video': () => doc(`<video src="${other}/v.mp4" width="40" height="30"></video>`),
};

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    hits.push(`${req.headers.host}${url.pathname}`);
    const page = PAGES[url.pathname];
    if (url.pathname === '/never.png') {
      // holds the connection
    } else if (url.pathname.endsWith('.png')) {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(randomPng());
    } else if (url.pathname === '/rand-frame-inner') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(
        `<!doctype html><body style="background:rgb(${Math.floor(Math.random() * 200)},50,50)">x`,
      );
    } else if (url.pathname === '/v.mp4') {
      res.writeHead(200, { 'content-type': 'video/mp4' });
      res.end(Buffer.alloc(16));
    } else if (page) {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(page());
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  server.on('connection', (s) => sockets.add(s));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  base = `http://127.0.0.1:${port}`;
  other = `http://localhost:${port}`;
  if (chrome) browser = await Browser.launch({ executablePath: chrome.path });
});

afterAll(async () => {
  await browser?.close();
  for (const s of sockets) s.destroy();
  server.close();
});

const hash = (s: Snapshot | undefined) =>
  createHash('sha256')
    .update(s?.image ?? '')
    .digest('hex');

async function snap(path: string, params: StoryParams = {}, project?: SettleLayer) {
  const t0 = Date.now();
  hits.length = 0;
  const { pages } = await snapPages({
    urls: [`${base}${path}`],
    browser,
    viewport: { width: 320, height: 240 },
    params,
    ...(project ? { projectSettle: project } : {}),
  });
  const r = pages[0]!;
  return { snapshot: r.snapshot, error: r.error, ms: Date.now() - t0, hits: [...hits] };
}

describe.skipIf(!chrome)('network.external by resource type', () => {
  it('without a placeholder, a random external image changes the pixels', async () => {
    const a = await snap('/rand-img');
    const b = await snap('/rand-img');
    expect(hash(a.snapshot)).not.toBe(hash(b.snapshot));
  }, 60_000);

  it('an image placeholder is the same bytes every time, and the server is never asked', async () => {
    const params: StoryParams = {
      network: { external: { default: 'allow', images: 'placeholder' } },
    };
    const a = await snap('/rand-img', params);
    const b = await snap('/rand-img', params);
    expect(a.error).toBeUndefined();
    expect(a.snapshot?.settle).toBeUndefined();
    expect(hash(a.snapshot)).toBe(hash(b.snapshot));
    expect(a.hits.some((h) => h.endsWith('/rand.png'))).toBe(false);
    // and it draws something: not the same pixels as a blocked (broken) image
    const blocked = await snap('/rand-img', { network: { external: 'block' } });
    expect(hash(blocked.snapshot)).not.toBe(hash(a.snapshot));
  }, 60_000);

  it('a frame placeholder is a fixed empty document', async () => {
    const params: StoryParams = { network: { external: { frames: 'placeholder' } } };
    const a = await snap('/rand-frame', params);
    const b = await snap('/rand-frame', params);
    expect(a.error).toBeUndefined();
    expect(a.snapshot?.settle).toBeUndefined();
    expect(hash(a.snapshot)).toBe(hash(b.snapshot));
    expect(a.hits.some((h) => h.endsWith('/rand-frame-inner'))).toBe(false);
    const open = await snap('/rand-frame');
    expect(hash(open.snapshot)).not.toBe(hash(a.snapshot));
  }, 60_000);

  // Blocked and placeholder frames can render the same pixels, so read the
  // outcome of the frame request itself: a placeholder finishes, a block fails.
  it('a frame placeholder finishes the frame request; a block fails it', async () => {
    const outcome = async (frames: 'placeholder' | 'block') => {
      const context = await browser.newContext({ viewport: { width: 320, height: 240 } });
      const page = await context.newPage();
      try {
        await applyNetworkPolicy(page, resolveNetwork({ external: { frames } }), base);
        const ids = new Map<string, string>();
        const done: string[] = [];
        page.on?.('Network.requestWillBeSent', (e) =>
          ids.set(e.requestId, e.request.url),
        );
        page.on?.('Network.loadingFinished', (e) =>
          done.push(`finished ${ids.get(e.requestId)}`),
        );
        page.on?.('Network.loadingFailed', (e) =>
          done.push(`failed ${ids.get(e.requestId)}`),
        );
        await page.goto(`${base}/rand-frame`, { waitUntil: 'load' });
        await new Promise((r) => setTimeout(r, 300));
        return done.filter((d) => d.endsWith('/rand-frame-inner'));
      } finally {
        await context.close();
      }
    };
    const url = `${other}/rand-frame-inner`;
    const placeholder = await outcome('placeholder');
    expect(placeholder).toContain(`finished ${url}`);
    expect(placeholder).not.toContain(`failed ${url}`);
    expect(await outcome('block')).toContain(`failed ${url}`);
  }, 60_000);

  it('an image placeholder loads as a use-credentials image', async () => {
    const r = await snap('/cred-img', {
      network: { external: { images: 'placeholder' } },
    });
    expect(r.error).toBeUndefined();
    expect(r.snapshot?.structure?.elements.find((e) => e.id === 'r')?.text).toBe(
      'loaded',
    );
    expect(r.hits.some((h) => h.endsWith('/cred.png'))).toBe(false);
  }, 60_000);

  it('a type entry overrides default, and only for that type', async () => {
    const r = await snap('/two-imgs', {
      network: { external: { default: 'block', images: 'allow' } },
    });
    expect(r.hits.filter((h) => h.endsWith('.png')).length).toBe(2);
    const f = await snap('/rand-frame', {
      network: { external: { default: 'allow', images: 'block' } },
    });
    expect(f.hits.some((h) => h.endsWith('/rand-frame-inner'))).toBe(true);
  }, 60_000);

  it('media placeholder answers as blocked', async () => {
    const r = await snap('/video', { network: { external: { media: 'placeholder' } } });
    expect(r.error).toBeUndefined();
    expect(r.hits.some((h) => h.endsWith('/v.mp4'))).toBe(false);
  }, 60_000);

  it('a placeholder request is never in flight: an image that would hang costs nothing', async () => {
    const r = await snap('/never-img', {
      network: { external: { images: 'placeholder' } },
      settle: { timeout: 1500 },
    });
    expect(r.error).toBeUndefined();
    expect(r.snapshot?.settle).toBeUndefined();
    expect(r.ms).toBeLessThan(6000);
    expect(r.hits.some((h) => h.endsWith('/never.png'))).toBe(false);
  }, 60_000);

  it("the string form is unchanged: 'block' blocks, same-origin passes", async () => {
    const r = await snap('/two-imgs', { network: { external: 'block' } });
    expect(r.hits.some((h) => h.endsWith('.png'))).toBe(false);
    const o = await snap('/own-img', { network: { external: 'block' } });
    expect(o.hits.some((h) => h.endsWith('/own.png'))).toBe(true);
  }, 60_000);
});

describe.skipIf(!chrome)('network.rules', () => {
  it('first match wins, in array order', async () => {
    const allowFirst = await snap('/two-imgs', {
      network: {
        rules: [
          { match: 'http://localhost:*/a.png', action: 'allow' },
          { match: 'http://localhost:*/**', action: 'block' },
        ],
      },
    });
    expect(allowFirst.hits.some((h) => h.endsWith('/a.png'))).toBe(true);
    expect(allowFirst.hits.some((h) => h.endsWith('/b.png'))).toBe(false);
    const blockFirst = await snap('/two-imgs', {
      network: {
        rules: [
          { match: 'http://localhost:*/**', action: 'block' },
          { match: 'http://localhost:*/a.png', action: 'allow' },
        ],
      },
    });
    expect(blockFirst.hits.some((h) => h.endsWith('.png'))).toBe(false);
  }, 60_000);

  it("a rule can match the Storybook's own origin", async () => {
    const r = await snap('/own-img', {
      network: { rules: [{ match: `${base}/own.png`, action: 'block' }] },
    });
    expect(r.hits.some((h) => h.endsWith('/own.png'))).toBe(false);
    const p = await snap('/own-img', {
      network: { rules: [{ match: '/own.png', action: 'placeholder' }] },
    });
    expect(p.hits.some((h) => h.endsWith('/own.png'))).toBe(false);
  }, 60_000);

  it('a rule beats the type defaults', async () => {
    const r = await snap('/two-imgs', {
      network: {
        external: { default: 'block' },
        rules: [{ match: 'http://localhost:*/a.png', action: 'allow' }],
      },
    });
    expect(r.hits.some((h) => h.endsWith('/a.png'))).toBe(true);
    expect(r.hits.some((h) => h.endsWith('/b.png'))).toBe(false);
  }, 60_000);

  it('story rules are checked before project rules', async () => {
    const projectBlocks: SettleLayer = {
      network: { rules: [{ match: '**/a.png', action: 'block' }] },
    };
    const storyAllows = await snap(
      '/two-imgs',
      { network: { rules: [{ match: '**/a.png', action: 'allow' }] } },
      projectBlocks,
    );
    expect(storyAllows.hits.some((h) => h.endsWith('/a.png'))).toBe(true);
    const projectAllows: SettleLayer = {
      network: { rules: [{ match: '**/a.png', action: 'allow' }] },
    };
    const storyBlocks = await snap(
      '/two-imgs',
      { network: { rules: [{ match: '**/a.png', action: 'block' }] } },
      projectAllows,
    );
    expect(storyBlocks.hits.some((h) => h.endsWith('/a.png'))).toBe(false);
  }, 60_000);

  it('a type: rule matches by resource type; placeholder on a non-placeholderable URL rule falls back to block', async () => {
    const r = await snap('/two-imgs', {
      network: { rules: [{ match: 'type:Image', action: 'block' }] },
    });
    expect(r.hits.some((h) => h.endsWith('.png'))).toBe(false);
    const f = await snap('/video', {
      network: { rules: [{ match: '**/v.mp4', action: 'placeholder' }] },
    });
    expect(f.hits.some((h) => h.endsWith('/v.mp4'))).toBe(false);
  }, 60_000);
});
