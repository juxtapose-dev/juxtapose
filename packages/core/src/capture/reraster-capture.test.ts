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
import { rerasterLayers } from './settle.js';

const chrome = chromeForTests();
let server: Server;
let base: string;
let browser: Browser;

// Fractional widths (gap, padding) so the frozen translateX(-100%) lands on
// a fractional pixel offset.
const ITEMS =
  '<span>BITCOIN HITS ALL-TIME HIGH</span><span>NEW REACT VERSION RELEASED</span>';
const marquee = (
  motion: string,
  items = ITEMS,
  script = '',
  inline = '',
) => `<!doctype html><style>
body { margin: 0; font: 15px/1.4 sans-serif }
.root { display: flex; overflow: hidden; width: 600px }
.c { display: flex; flex-shrink: 0; gap: 37.3px; padding-right: 19.31px;
     will-change: transform; ${motion} }
@keyframes mq { from { transform: translateX(0) } to { transform: translateX(-100%) } }
</style><div class="root">${`<div class="c" style="${inline}">${items}</div>`.repeat(2)}</div>
<script async src="/slow.js"></script><script>${script}</script>`;
const STATIC = 'transform: translateX(-100%)';
const INLINE_IMPORTANT = 'will-change: transform !important';
// Two frames after load, then a late item in every .c under root.
const GROW = (root: string) =>
  `addEventListener('load', () => requestAnimationFrame(() => requestAnimationFrame(() =>
     setTimeout(() => { for (const c of ${root}.querySelectorAll('.c')) c.insertAdjacentHTML('beforeend', '<span>MORE</span>'); }, 50))));`;
const shadowMarquee = (
  items: string,
  script = '',
) => `<!doctype html><style>body { margin: 0 }</style>
<script>customElements.define('x-mq', class extends HTMLElement { constructor() { super();
  this.attachShadow({ mode: 'open' }).innerHTML = \`<style>
  .root { display: flex; overflow: hidden; width: 600px; font: 15px/1.4 sans-serif }
  .c { display: flex; flex-shrink: 0; gap: 37.3px; padding-right: 19.31px;
       will-change: transform; ${STATIC} }</style>
  <div class="root">${`<div class="c">${items}</div>`.repeat(2)}</div>\`; } });</script>
<x-mq></x-mq><script async src="/slow.js"></script><script>${script}</script>`;
// A will-change: transform parent, a position: fixed child #f, and a label
// #b the page's script writes its state into.
const observed = (parent: string, child: string, script: string) => `<!doctype html>
<style>body { margin: 0; font: 15px sans-serif } #b { height: 20px }</style><div id="b">init</div>
<div style="will-change: transform; ${parent}"><div id="f" style="position: fixed; ${child}"></div></div>
<script>const b = document.getElementById('b'), f = document.getElementById('f'); ${script}</script>`;
const RO_DELAYS = [30, 45, 60];

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
  // The marquee inside an open shadow root, born wide vs widened late.
  '/shadow-wide': shadowMarquee(ITEMS + '<span>MORE</span>'),
  '/shadow-grows': shadowMarquee(
    ITEMS,
    GROW("document.querySelector('x-mq').shadowRoot"),
  ),
  // will-change from an inline !important declaration, not the stylesheet.
  '/inline-wide': marquee(STATIC, ITEMS + '<span>MORE</span>', '', INLINE_IMPORTANT),
  '/inline-grows': marquee(STATIC, ITEMS, GROW('document'), INLINE_IMPORTANT),
  // A fixed child whose containing block is its will-change parent, parked
  // below the fold, observed by a "reveal once seen" IntersectionObserver.
  '/io-once': observed(
    'margin-top:2000px;height:10px',
    'top:0;left:0;width:10px;height:10px',
    `new IntersectionObserver((es) => { for (const e of es) if (e.isIntersecting) b.textContent = 'SEEN'; }).observe(f);`,
  ),
  '/io-control': observed(
    'margin-top:2000px;height:10px',
    'top:0;left:0;width:10px;height:10px',
    '',
  ),
  // A fixed child sized by its will-change parent (300px wide); the page
  // picks its layout from a ResizeObserver, a timer later.
  ...Object.fromEntries(
    RO_DELAYS.map((ms) => [
      `/ro-${ms}`,
      observed(
        'width:300px;height:30px',
        'top:30px;left:0;width:100%;height:10px;background:#09c',
        `new ResizeObserver((es) => { const w = es[0].contentRect.width; setTimeout(() => { b.textContent = w > 500 ? 'wide layout' : 'compact layout'; }, ${ms}); }).observe(f);`,
      ),
    ]),
  ),
  '/ro-control': observed(
    'width:300px;height:30px',
    'top:30px;left:0;width:100%;height:10px;background:#09c',
    `b.textContent = 'compact layout';`,
  ),
  '/restore': `<!doctype html><style>.wc { will-change: transform }</style>
<div id="a" class="wc">a</div><div id="b" style="will-change: opacity; color: red">b</div>
<div id="c" style="color: blue" class="wc">c</div>`,
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
}, 30_000);

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

// Several captures per test; under a loaded machine 5 s is not enough.
describe.skipIf(!chrome)('will-change layers in Chrome', { timeout: 30_000 }, () => {
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

  // The first fix adopted a `will-change: auto` sheet, which reached neither
  // shadow roots nor inline !important declarations: stale on 4 of 4 tries.
  it('rebuilds a will-change layer inside an open shadow root', async () => {
    const [born, grown] = await snap('/shadow-wide', '/shadow-grows');
    expect(grown!.equals(born!)).toBe(true);
  });

  it('rebuilds a layer whose will-change is an inline !important declaration', async () => {
    const [born, grown] = await snap('/inline-wide', '/inline-grows');
    expect(grown!.equals(born!)).toBe(true);
  });

  // Dropping will-change dropped the containing block its fixed child is
  // placed by. The child landed in the viewport for two frames and the
  // observer latched "SEEN" on 6 of 6 captures.
  it('keeps the containing block, so an IntersectionObserver never sees the fixed child', async () => {
    const [control, ...seen] = await snap(
      '/io-control',
      '/io-once',
      '/io-once',
      '/io-once',
    );
    for (const s of seen) expect(s.equals(control!)).toBe(true);
  });

  // The fixed child briefly took the viewport's width; a ResizeObserver
  // reacting through a 30 ms timer captured "wide layout" on 4 of 6.
  it('keeps the containing block, so a ResizeObserver reaction never lands', async () => {
    // 30 ms flaked about half the time on main, so it gets more tries.
    const paths = RO_DELAYS.flatMap((ms) =>
      Array.from({ length: ms === 30 ? 6 : 3 }, () => `/ro-${ms}`),
    );
    const [control, ...rest] = await snap('/ro-control', ...paths);
    rest.forEach((s, i) => expect(s.equals(control!), paths[i]).toBe(true));
  });

  it('puts each inline declaration back as it was, on time or on timeout', async () => {
    const ctx = await browser.newContext({ viewport: { width: 640, height: 60 } });
    try {
      const page = await ctx.newPage();
      await page.goto(`${base}/restore`);
      const read = () =>
        page.evaluate<Array<string | null>>(
          "['a', 'b', 'c'].map((id) => document.getElementById(id).getAttribute('style'))",
        );
      const willChange = () =>
        page.evaluate<string>(
          "getComputedStyle(document.getElementById('a')).willChange",
        );
      const before = await read();
      await rerasterLayers(page);
      expect(await read()).toEqual(before);
      // A 0 ms cap resolves through the timeout before either frame: the
      // override must come off there too, not stay for the screenshot.
      await rerasterLayers(page, 0);
      expect(await willChange()).toBe('transform');
      expect(await read()).toEqual(before);
    } finally {
      await ctx.close();
    }
  });
});
