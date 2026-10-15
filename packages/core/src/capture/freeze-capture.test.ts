// Deterministic clock, random and animated images (issues #146, #182),
// through snapPages against a real Chrome. Each page renders what it read
// from the clock or a random source into the DOM, so the structure snapshot
// says what the page saw; the animated-image page is read back by pixel.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import zlib from 'node:zlib';
import sharp from 'sharp';
import { Browser } from '../browser/browser.js';
import { imageAnimationArgs } from '../browser/flags.js';
import { chromeForTests } from '../browser/__tests__/helpers.js';
import type { Snapshot, StoryParams } from '../types.js';
import { snapPages } from './snap.js';

const chrome = chromeForTests();
let server: Server;
let base: string;
let frozen: Browser;
let playing: Browser;

const SIZE = 40;
const RED = [255, 0, 0] as const;
const BLUE = [0, 0, 255] as const;

/** Two solid frames, red then blue, 100 ms each, looping. */
function frames(): Buffer {
  const b = Buffer.alloc(SIZE * SIZE * 2 * 4);
  for (let i = 0; i < SIZE * SIZE * 2; i++) {
    const c = i < SIZE * SIZE ? RED : BLUE;
    b.set([...c, 255], i * 4);
  }
  return b;
}
const raw = () => ({
  raw: { width: SIZE, height: SIZE * 2, channels: 4 as const, pageHeight: SIZE },
});
const gif = () =>
  sharp(frames(), raw())
    .gif({ loop: 0, delay: [100, 100] })
    .toBuffer();
const webp = () =>
  sharp(frames(), raw())
    .webp({ lossless: true, loop: 0, delay: [100, 100] })
    .toBuffer();

/** sharp writes no APNG, so this builds one: IHDR, acTL, two fcTL frames. */
function apng(): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const t = Buffer.from(type);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(Buffer.concat([t, data])));
    return Buffer.concat([len, t, data, crc]);
  };
  const all = frames();
  const frame = (n: number) => {
    const rows: Buffer[] = [];
    for (let y = 0; y < SIZE; y++) {
      const o = (n * SIZE + y) * SIZE * 4;
      rows.push(Buffer.from([0]), all.subarray(o, o + SIZE * 4));
    }
    return zlib.deflateSync(Buffer.concat(rows));
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0);
  ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const actl = Buffer.alloc(8);
  actl.writeUInt32BE(2, 0);
  const fctl = (seq: number) => {
    const b = Buffer.alloc(26);
    b.writeUInt32BE(seq, 0);
    b.writeUInt32BE(SIZE, 4);
    b.writeUInt32BE(SIZE, 8);
    b.writeUInt16BE(1, 20);
    b.writeUInt16BE(10, 22);
    return b;
  };
  const seq = Buffer.alloc(4);
  seq.writeUInt32BE(2);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('acTL', actl),
    chunk('fcTL', fctl(0)),
    chunk('IDAT', frame(0)),
    chunk('fcTL', fctl(1)),
    chunk('fdAT', Buffer.concat([seq, frame(1)])),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const page = (script: string, body = '') =>
  `<!doctype html><body style="margin:0;font:16px sans-serif">${body}<div id="out"></div><script>
  const add = (t) => { const d = document.createElement('p'); d.textContent = t; document.getElementById('out').appendChild(d); };
  ${script}
  </script></body>`;

const PAGES: Record<string, string> = {
  // One of each format and placement, 40 px apart along the top row.
  '/images': `<!doctype html><body style="margin:0;display:flex">
    <img src="/a.gif"><img src="/a.webp"><img src="/a.png">
    <div style="width:40px;height:40px;background:url(/a.gif)"></div>
    <picture><source srcset="/a.webp" type="image/webp"><img src="/missing.png"></picture></body>`,
  '/canvas': `<!doctype html><body style="margin:0"><canvas width="40" height="40"></canvas><script>
    const img = new Image(); img.onload = () => setTimeout(() => {
      const canvas = document.querySelector('canvas');
      canvas.getContext('2d').drawImage(img, 0, 0);
      canvas.dataset.ready = 'true';
    }, 150); img.src = '/a.gif';
    </script></body>`,
  '/clock': page(
    `add('iso ' + new Date().toISOString()); add('now ' + Date.now()); add('call ' + Date().slice(0, 15));
     add('intl ' + new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', dateStyle: 'medium', timeStyle: 'medium' }).format());`,
  ),
  '/random': page(
    `add('math ' + Math.random()); add('uuid ' + crypto.randomUUID());
     add('bytes ' + crypto.getRandomValues(new Uint8Array(8)).join(','));
     const ids = new Set(); for (let i = 0; i < 1000; i++) ids.add(crypto.randomUUID()); add('unique ' + ids.size);`,
  ),
  // lodash's debounce: the timer re-arms until Date.now() has passed the wait.
  // Under a clock that never moves the call never runs.
  '/timer-object': page(
    `let calls = 0; const delay = { valueOf() { return ++calls; } };
     setTimeout(() => { add('coercions ' + calls); document.body.dataset.ready = 'true'; }, delay);
     try { setTimeout(() => {}, 1n); } catch (error) { add('bigint ' + error.name); }`,
  ),
  '/timer-coercion': page(
    `setTimeout(() => { add('iso ' + new Date().toISOString()); document.body.dataset.ready = 'true'; }, Infinity);`,
  ),
  '/debounce': page(
    `const wait = 200; let last = Date.now();
     const expired = () => { const left = wait - (Date.now() - last); if (left > 0) setTimeout(expired, left); else add('final'); };
     setTimeout(expired, wait);`,
  ),
  // A synchronous wait on the clock: no timer can fire inside it.
  '/spin': page(`const t = Date.now(); while (Date.now() - t < 5) {} add('final');`),
};

beforeAll(async () => {
  const assets: Record<string, [string, Buffer]> = {
    '/a.gif': ['image/gif', await gif()],
    '/a.webp': ['image/webp', await webp()],
    '/a.png': ['image/png', apng()],
  };
  server = createServer((req, res) => {
    const p = new URL(req.url ?? '/', 'http://x').pathname;
    const asset = assets[p];
    if (asset) {
      res.writeHead(200, { 'content-type': asset[0] });
      res.end(asset[1]);
    } else if (PAGES[p]) {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(PAGES[p]);
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  // localhost, not 127.0.0.1: a secure context, so crypto.randomUUID exists.
  base = `http://localhost:${(server.address() as { port: number }).port}`;
  if (chrome) {
    frozen = await Browser.launch({
      executablePath: chrome.path,
      args: imageAnimationArgs(),
    });
    playing = await Browser.launch({ executablePath: chrome.path });
  }
});

afterAll(async () => {
  await frozen?.close();
  await playing?.close();
  server?.close();
});

async function snap(
  path: string,
  params: StoryParams = {},
  browser: Browser = frozen,
): Promise<Snapshot> {
  const { pages } = await snapPages({
    urls: [`${base}${path}`],
    browser,
    viewport: { width: 320, height: 240 },
    params: { ...params, freeze: { clock: true, random: true, ...params.freeze } },
  });
  if (!pages[0]!.snapshot) throw new Error(pages[0]!.error);
  return pages[0]!.snapshot;
}

const texts = (s: Snapshot) => (s.structure?.elements ?? []).map((e) => e.text ?? '');
const line = (s: Snapshot, prefix: string) =>
  texts(s)
    .find((t) => t.startsWith(prefix + ' '))
    ?.slice(prefix.length + 1);

/** 'R' or 'B' for the centre of each of the five 40 px images. */
async function colours(s: Snapshot): Promise<string> {
  const { data, info } = await sharp(s.image).raw().toBuffer({ resolveWithObject: true });
  return [20, 60, 100, 140, 180]
    .map((x) => {
      const o = (20 * info.width + x) * info.channels;
      return data[o]! > 128 ? 'R' : data[o + 2]! > 128 ? 'B' : '?';
    })
    .join('');
}

describe.skipIf(!chrome)('freeze: animated images', () => {
  it('shows the first frame of GIF, WebP and APNG in img, picture and CSS, whenever captured', async () => {
    // 0, 150 and 250 ms land on frames 0, 1 and 0 of a playing image; a
    // frozen one shows frame 0 in all three.
    const shots = [];
    for (const delay of [0, 150, 250]) shots.push(await snap('/images', { delay }));
    for (const s of shots) expect(await colours(s)).toBe('RRRRR');
    expect(new Set(shots.map((s) => s.image.toString('base64'))).size).toBe(1);
  });

  it('freezes animated images drawn into a canvas', async () => {
    const shot = await snap('/canvas', { waitForSelector: 'canvas[data-ready]' });
    expect((await colours(shot))[0]).toBe('R');
  });

  it('without the launch setting the images play (the control)', async () => {
    const seen = new Set<string>();
    for (const delay of [0, 150, 250, 350])
      seen.add(await colours(await snap('/images', { delay }, playing)));
    expect(seen.has('BBBBB')).toBe(true);
  });
});

describe.skipIf(!chrome)('freeze: clock', () => {
  it('starts Date, Date.now, Date() and Intl at 2024-01-01T12:00:00Z', async () => {
    const s = await snap('/clock');
    expect(line(s, 'iso')).toBe('2024-01-01T12:00:00.000Z');
    expect(line(s, 'now')).toBe(String(Date.parse('2024-01-01T12:00:00Z')));
    expect(line(s, 'call')).toMatch(/^(Mon Jan 01|Sun Dec 31) 202[34]$/);
    expect(line(s, 'intl')).toBe('Jan 1, 2024, 12:00:00 PM');
  });

  it('takes another instant, and false keeps the real clock', async () => {
    const at = await snap('/clock', { freeze: { clock: '2030-06-15T08:30:00Z' } });
    expect(line(at, 'iso')).toBe('2030-06-15T08:30:00.000Z');
    const real = await snap('/clock', { freeze: { clock: false } });
    expect(Math.abs(Number(line(real, 'now')) - Date.now())).toBeLessThan(60_000);
  });

  it('advances as timers fire, so a debounce built on Date.now still runs', async () => {
    const s = await snap('/debounce');
    expect(texts(s)).toContain('final');
    expect(s.settle).toBeUndefined();
  });

  it('coerces object delays once and preserves native BigInt rejection', async () => {
    const s = await snap('/timer-object', { waitForSelector: 'body[data-ready]' });
    expect(line(s, 'coercions')).toBe('1');
    expect(line(s, 'bigint')).toBe('TypeError');
  });

  it('keeps Date valid when a timer delay is coerced to zero by the browser', async () => {
    const s = await snap('/timer-coercion', { waitForSelector: 'body[data-ready]' });
    expect(line(s, 'iso')).toBe('2024-01-01T12:00:00.000Z');
  });

  it('lets a synchronous wait on Date.now finish', async () => {
    const s = await snap('/spin');
    expect(texts(s)).toContain('final');
  });
});

describe.skipIf(!chrome)('freeze: random', () => {
  it('draws the same Math.random, getRandomValues and randomUUID sequence every capture', async () => {
    const a = await snap('/random');
    const b = await snap('/random');
    expect(line(a, 'math')).toBe(line(b, 'math'));
    expect(line(a, 'uuid')).toBe(line(b, 'uuid'));
    expect(line(a, 'bytes')).toBe(line(b, 'bytes'));
    expect(line(a, 'uuid')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    // Seeded, not constant: ids stay unique within a page.
    expect(line(a, 'unique')).toBe('1000');
  });

  it('random: false keeps the native sources', async () => {
    const a = await snap('/random', { freeze: { random: false } });
    const b = await snap('/random', { freeze: { random: false } });
    expect(line(a, 'uuid')).not.toBe(line(b, 'uuid'));
  });
});
