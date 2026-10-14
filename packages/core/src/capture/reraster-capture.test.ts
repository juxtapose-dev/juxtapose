// Issue #136 against a real Chrome, through snapPages (the whole capture
// pipeline). A `will-change: transform` marquee keeps the raster translation
// its layer got when first rasterized, so if its animation runs for a frame
// before the freeze, the frozen capture keeps mid-flight glyph antialiasing.
// The async script holds `load` back, so the marquee always animates before
// the freeze lands. The same happens with no animation at all when the
// layer's transform changes after its first raster.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { Browser } from '../browser/browser.js';
import { chromeForTests } from '../browser/__tests__/helpers.js';
import { snapPages } from './snap.js';

const chrome = chromeForTests();
let server: Server;
let base: string;
let browser: Browser;

// Fractional widths (gap, padding) so the frozen translateX(-100%) lands on
// a fractional pixel offset.
const ITEMS =
  '<span>BITCOIN HITS ALL-TIME HIGH</span><span>NEW REACT VERSION RELEASED</span>';
const marquee = (motion: string, items = ITEMS, script = '') => `<!doctype html><style>
body { margin: 0; font: 15px/1.4 sans-serif }
.root { display: flex; overflow: hidden; width: 600px }
.c { display: flex; flex-shrink: 0; gap: 37.3px; padding-right: 19.31px;
     will-change: transform; ${motion} }
@keyframes mq { from { transform: translateX(0) } to { transform: translateX(-100%) } }
</style><div class="root">${`<div class="c">${items}</div>`.repeat(2)}</div>
<script async src="/slow.js"></script><script>${script}</script>`;
const STATIC = 'transform: translateX(-100%)';

const PAGES: Record<string, string> = {
  '/animated': marquee('animation: mq 9.7s linear infinite forwards'),
  // Where the freeze puts it, without ever moving.
  '/static': marquee(STATIC),
  '/wide': marquee(STATIC, ITEMS + '<span>MORE</span>'),
  // Two frames after load, then the late item.
  '/grows': marquee(
    STATIC,
    ITEMS,
    `addEventListener('load', () => requestAnimationFrame(() => requestAnimationFrame(() =>
       setTimeout(() => { for (const c of document.querySelectorAll('.c')) c.insertAdjacentHTML('beforeend', '<span>MORE</span>'); }, 50))));`,
  ),
};

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/slow.js') {
      setTimeout(() => res.end(''), 300);
      return;
    }
    const html = PAGES[req.url ?? ''];
    res.writeHead(html ? 200 : 404, { 'content-type': 'text/html' });
    res.end(html ?? '');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  if (chrome) browser = await Browser.launch({ executablePath: chrome.path });
});

afterAll(async () => {
  await browser?.close();
  server.close();
});

async function snap(...paths: string[]): Promise<Buffer[]> {
  const { pages } = await snapPages({
    urls: paths.map((p) => `${base}${p}`),
    browser,
    viewport: { width: 640, height: 60 },
  });
  return pages.map((p) => {
    if (!p.snapshot) throw new Error(p.error);
    return p.snapshot.image;
  });
}

describe.skipIf(!chrome)('will-change layers in Chrome', () => {
  // On main: the animated capture differed from the static one on 40 of 40
  // tries, by glyph antialiasing along the line.
  it('a composited marquee that animated before load captures like its static frame', async () => {
    const [still, animated, again] = await snap('/static', '/animated', '/animated');
    expect(animated!.equals(still!)).toBe(true);
    expect(again!.equals(still!)).toBe(true);
  });

  // No animation at all: the layer is first rastered at one translateX(-100%)
  // and a late item widens it, as a web font finishing does. On main: differed
  // on every try.
  it('a composited marquee that widened after its first raster captures like one born wide', async () => {
    const [born, grown] = await snap('/wide', '/grows');
    expect(grown!.equals(born!)).toBe(true);
  });
});
