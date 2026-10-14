// The capture is Chrome's lossless WebP minus its ICC chunk. If Chrome ever
// returned a lossy frame for quality 100, or the ICC chunk came back, or the
// stripped file stopped decoding to the pixels Chrome rendered, the hash would
// still be deterministic and nothing else would notice: the diff would fill
// with compression noise, or the hash would start to depend on the machine's
// colour profile. This is the check that notices.

import { afterAll, beforeAll, describe, expect, it, test } from 'vitest';
import { createServer, type Server } from 'node:http';
import sharp from 'sharp';
import { Browser } from '../browser/browser.js';
import { chromeForTests } from '../browser/__tests__/helpers.js';
import { canonicalWebp, describeEncoderFailures, webpChunks } from './encoder.js';
import { snapPages } from './snap.js';

const riff = (chunks: [string, Buffer][]): Buffer => {
  const body = Buffer.concat(
    chunks.map(([id, data]) => {
      const head = Buffer.alloc(8);
      head.write(id.padEnd(4), 0, 'latin1');
      head.writeUInt32LE(data.length, 4);
      return Buffer.concat([head, data, Buffer.alloc(data.length & 1)]);
    }),
  );
  const head = Buffer.alloc(12);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(body.length + 4, 4);
  head.write('WEBP', 8, 'latin1');
  return Buffer.concat([head, body]);
};

describe('canonicalWebp', () => {
  const vp8x = Buffer.from([0x20, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  it('drops ICCP, clears the VP8X ICC flag, rewrites the RIFF size, and copies VP8L verbatim', () => {
    const bitstream = Buffer.from([0x2f, 1, 2, 3, 4]);
    const out = canonicalWebp(
      riff([
        ['VP8X', vp8x],
        ['ICCP', Buffer.alloc(456, 7)],
        ['VP8L', bitstream],
      ]),
    );
    expect(webpChunks(out)).toEqual(['VP8X', 'VP8L']);
    expect(out[20]! & 0x20).toBe(0);
    expect(out.readUInt32LE(4)).toBe(out.length - 8);
    expect(out.subarray(-6, -1)).toEqual(bitstream);
  });
  it('refuses a lossy frame, a missing bitstream, a truncated file, and a non-WebP', () => {
    expect(() => canonicalWebp(riff([['VP8', Buffer.alloc(10)]]))).toThrow(/VP8 chunk/);
    expect(() => canonicalWebp(riff([['VP8X', vp8x]]))).toThrow(/without a lossless/);
    const ok = riff([['VP8L', Buffer.alloc(10)]]);
    expect(() => canonicalWebp(ok.subarray(0, ok.length - 3))).toThrow(/truncated/);
    expect(() => canonicalWebp(Buffer.alloc(0))).toThrow(/did not return a WebP/);
  });
});

test('describeEncoderFailures names the old encoder once, and counts the unchanged', () => {
  const r = (baselineEncoder?: string, mismatchPixels = 0) => ({
    ...(baselineEncoder ? { baselineEncoder } : {}),
    mismatchPixels,
  });
  expect(describeEncoderFailures([r(), r(undefined, 5)])).toBe('');
  expect(describeEncoderFailures([r('8.17.3'), r('8.17.3', 4), r()])).toBe(
    '2 failing stories were approved with a previous encoder (libvips 8.17.3 (sharp)). ' +
      "Captures are now Chrome's lossless WebP, so their hashes changed whether or not a " +
      'pixel did (1 of 2 show no pixel change in the diff). This is a one-time ' +
      're-baseline: review the run, then `jux approve --all`.',
  );
});

const chrome = chromeForTests();
let server: Server;
let base: string;
let browser: Browser;

// Gradients and translucency are where a colour conversion shows (±1 per
// channel through the ICC on Chrome 151); text is where lossy coding shows.
const PAGE = `<!doctype html><body style="margin:0">
<div style="height:120px;background:linear-gradient(90deg,#f00,#0f0,#00f,#ff0)"></div>
<div style="height:60px;background:radial-gradient(circle,#123,#fe9 40%,#09c)"></div>
<p style="font:13px sans-serif;color:#333">The quick brown fox 0123456789</p>
<div style="width:200px;height:40px;background:rgba(255,0,0,.4)"></div>
<p class="secret" style="font:20px serif">masked</p></body>`;

beforeAll(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(PAGE);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  if (chrome) browser = await Browser.launch({ executablePath: chrome.path });
}, 30_000);

afterAll(async () => {
  await browser?.close();
  server.close();
});

const pixels = async (img: Buffer) =>
  (await sharp(img, { ignoreIcc: true }).ensureAlpha().raw().toBuffer()).toString('hex');

describe.skipIf(!chrome)('a real capture', () => {
  it('is one VP8L bitstream with no ICC chunk, and decodes to the pixels of a PNG capture', async () => {
    const viewport = { width: 400, height: 300 };
    const params = { mask: ['.secret'] };
    const { pages } = await snapPages({ urls: [`${base}/`], browser, viewport, params });
    const image = pages[0]!.snapshot!.image;
    expect(webpChunks(image)).toEqual(['VP8X', 'VP8L']);
    expect(image[20]! & 0x20).toBe(0);
    expect((await sharp(image).metadata()).icc).toBeUndefined();

    // The same frame as PNG, through the same screenshot path and mask.
    const context = await browser.newContext({ viewport });
    try {
      const page = await context.newPage();
      await page.goto(`${base}/`);
      await page.evaluate('document.fonts.ready');
      const png = await page.screenshot({ mask: params.mask });
      const webp = await page.screenshot({ mask: params.mask, format: 'webp' });
      expect(webpChunks(webp)).toContain('ICCP');
      expect(await pixels(canonicalWebp(webp))).toBe(await pixels(png));
      expect(await pixels(image)).toBe(await pixels(png));
    } finally {
      await context.close();
    }
  }, 30_000);
});
