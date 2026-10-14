// The classifier against real captures: a story that flakes for a known
// reason is classified, and applying the suggested patch makes two captures
// byte-identical. Real Chrome, through snapPages.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { Socket } from 'node:net';
import { Browser } from '../browser/browser.js';
import { chromeForTests } from '../browser/__tests__/helpers.js';
import { snapPages } from '../capture/snap.js';
import type { Flake, Snapshot, StoryParams } from '../types.js';
import { analyzeFlake } from './analyze.js';
import { describeFlake } from './describe.js';

const chrome = chromeForTests();
let server: Server;
let base: string;
let other: string; // the same server under another origin (localhost)
let browser: Browser;
const sockets = new Set<Socket>();
let clockTicks = 0;

const STORY = 'card--basic';

const doc = (body: string) =>
  `<!doctype html><body style="margin:0;font:16px sans-serif"><p>final</p>${body}</body>`;

/** A 1x1 PNG of one colour, so each request can come back different. */
function png(rgb: [number, number, number]): Buffer {
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
  const raw = Buffer.from([0, ...rgb]);
  let a = 1;
  let b = 0;
  for (const x of raw) {
    a = (a + x) % 65521;
    b = (b + a) % 65521;
  }
  const z = Buffer.concat([
    Buffer.from([0x78, 0x01, 0x01, raw.length, 0, ~raw.length & 255, 0xff]),
    raw,
    Buffer.alloc(4),
  ]);
  z.writeUInt32BE(((b << 16) | a) >>> 0, z.length - 4);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', z),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const html = (body: string) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(body);
    };
    switch (url.pathname) {
      case '/rand-img':
        return html(
          doc(
            `<img class="cover" src="${other}/rand.png" width="64" height="64" style="display:block">`,
          ),
        );
      case '/rand.png':
        res.writeHead(200, { 'content-type': 'image/png' });
        return void res.end(
          png(
            [1, 2, 3].map(() => Math.floor(Math.random() * 256)) as [
              number,
              number,
              number,
            ],
          ),
        );
      case '/rand-frame':
        return html(
          doc(
            `<iframe class="player" src="${other}/rand-frame-inner" width="120" height="60"></iframe>`,
          ),
        );
      case '/rand-frame-inner':
        return html(
          `<!doctype html><body style="background:rgb(${Math.floor(Math.random() * 200)},50,50)">x`,
        );
      case '/clock':
        // Time text that moves on every load, in a box of fixed width.
        return html(
          doc(
            `<p class="clock" style="display:inline-block;width:120px">10:0${++clockTicks}</p>`,
          ),
        );
      case '/never-img':
        return html(doc(`<img src="${other}/never.png" width="10" height="10">`));
      case '/never.png':
        return; // holds the connection
      default:
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

async function snap(path: string, params: StoryParams = {}): Promise<Snapshot> {
  const { pages } = await snapPages({
    urls: [`${base}${path}`],
    browser,
    viewport: { width: 320, height: 240 },
    params,
  });
  const r = pages[0]!;
  if (!r.snapshot) throw new Error(`no snapshot: ${r.error}`);
  return r.snapshot;
}

const capture = (s: Snapshot) => ({
  image: s.image,
  ...(s.structure ? { structure: s.structure } : {}),
  ...(s.settle ? { settle: s.settle } : {}),
});

async function twoCaptures(path: string, params: StoryParams = {}) {
  const first = await snap(path, params);
  const second = await snap(path, params);
  return { first, second };
}

/** The story's own params after the suggested patch is merged in. */
const patched = (flake: Flake, params: StoryParams = {}): StoryParams => ({
  ...params,
  ...flake.fix!.stories[STORY]!,
});

describe.skipIf(!chrome)('flake classification on real captures', () => {
  it('an external image that changes every request is classified, and the fix holds', async () => {
    const { first, second } = await twoCaptures('/rand-img');
    expect(hash(first)).not.toBe(hash(second));

    const flake = await analyzeFlake({
      storyId: STORY,
      first: capture(first),
      second: capture(second),
    });
    expect(flake.cause).toBe('external-image');
    expect(flake.confidence).toBe('high');
    expect(flake.evidence.host).toBe('localhost:' + new URL(base).port);
    expect(flake.evidence.url).toBe(`${other}/rand.png`);
    expect(flake.evidence.selector).toBe('img.cover');
    expect(flake.fix).toEqual({
      stories: { [STORY]: { network: { external: { images: 'placeholder' } } } },
    });
    expect(describeFlake(flake)).toBe(
      `Unstable: external image from ${flake.evidence.host} in img.cover; fix: stories["${STORY}"].network.external.images = "placeholder"`,
    );

    const params = patched(flake);
    const a = await snap('/rand-img', params);
    const b = await snap('/rand-img', params);
    expect(hash(a)).toBe(hash(b));
  }, 60_000);

  it('an embedded frame from another origin is an embed, and the placeholder holds', async () => {
    const { first, second } = await twoCaptures('/rand-frame');
    expect(hash(first)).not.toBe(hash(second));

    const flake = await analyzeFlake({
      storyId: STORY,
      first: capture(first),
      second: capture(second),
    });
    expect(flake.cause).toBe('embed');
    expect(flake.evidence.selector).toBe('iframe.player');
    expect(flake.fix).toEqual({
      stories: { [STORY]: { network: { external: { frames: 'placeholder' } } } },
    });

    const params = patched(flake);
    const a = await snap('/rand-frame', params);
    const b = await snap('/rand-frame', params);
    expect(hash(a)).toBe(hash(b));
  }, 60_000);

  it('time text that changes is a clock, and masking it makes the captures identical', async () => {
    const { first, second } = await twoCaptures('/clock');
    expect(hash(first)).not.toBe(hash(second));

    const flake = await analyzeFlake({
      storyId: STORY,
      first: capture(first),
      second: capture(second),
    });
    expect(flake.cause).toBe('clock');
    expect(flake.evidence.selector).toBe('p.clock');
    expect(flake.evidence.before).toMatch(/^10:0\d$/);
    expect(flake.evidence.before).not.toBe(flake.evidence.after);
    expect(flake.fix).toEqual({ stories: { [STORY]: { mask: ['p.clock'] } } });

    const params = patched(flake);
    const a = await snap('/clock', params);
    const b = await snap('/clock', params);
    expect(hash(a)).toBe(hash(b));
  }, 60_000);

  it('a request pending at the settle cap is a settle-timeout, and its rule clears the flag', async () => {
    const settle = { timeout: 500 };
    const first = await snap('/never-img', { settle });
    const second = await snap('/never-img', { settle });
    expect(first.settle?.status).toBe('timeout');

    const flake = await analyzeFlake({
      storyId: STORY,
      first: capture(first),
      second: capture(second),
    });
    expect(flake.cause).toBe('settle-timeout');
    expect(flake.fix).toEqual({
      stories: {
        [STORY]: { network: { rules: [{ match: '/never.png', action: 'placeholder' }] } },
      },
    });

    const fixed = await snap('/never-img', patched(flake, { settle }));
    expect(fixed.settle).toBeUndefined();
  }, 60_000);
});
