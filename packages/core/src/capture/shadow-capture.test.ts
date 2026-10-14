// Issue #152 against a real Chrome, through snapPages (the whole capture
// pipeline): the animation freeze, the idle wait's mutation counter and its
// image wait must reach inside open shadow roots, the way web component
// libraries (Lit, Spectrum Web Components) render everything.
//
// Spectrum Web Components field test, jux 0.9.0: 31 of the 33 stories that
// captured differently on two passes were animations inside shadow DOM
// (spinners, progress bars, pulses, dialog and tooltip transitions).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { Socket } from 'node:net';
import sharp from 'sharp';
import { Browser } from '../browser/browser.js';
import { chromeForTests } from '../browser/__tests__/helpers.js';
import type { Snapshot, StoryParams } from '../types.js';
import { snapPages } from './snap.js';

const chrome = chromeForTests();
let server: Server;
let base: string;
let browser: Browser;
let png: Buffer;
const sockets = new Set<Socket>();

const BOX =
  'width:80px;height:80px;margin:20px;background:linear-gradient(90deg,red,blue)';
const SPIN = '@keyframes spin { to { transform: rotate(360deg) } }';

/** An <x-box> whose open shadow root gets `css` and `html`, either in a
 *  <style> element or (`adopt`) through adoptedStyleSheets set after the
 *  root is attached, the way Lit applies a component's styles. */
const host = (css: string, html = '<div></div>', how: 'style' | 'adopt' = 'style') =>
  `<script>customElements.define('x-box', class extends HTMLElement { constructor() { super();
    const root = this.attachShadow({ mode: 'open' });
    ${
      how === 'style'
        ? `root.innerHTML = ${JSON.stringify(`<style>${css}</style>${html}`)};`
        : `const s = new CSSStyleSheet(); s.replaceSync(${JSON.stringify(css)});
           root.adoptedStyleSheets = [s]; root.innerHTML = ${JSON.stringify(html)};`
    } } });</script>`;
const doc = (body: string) =>
  `<!doctype html><body style="margin:0;font:16px sans-serif">${body}</body>`;
const late = (ms: number) =>
  `<script>addEventListener('load', () => setTimeout(() => document.body.append(document.createElement('x-box')), ${ms}));</script>`;

const PAGES: Record<string, string> = {
  // Where every frozen box below ends up: no animation, opacity 1.
  '/static': doc(host(`div { ${BOX} }`) + '<x-box></x-box>'),
  '/spin': doc(
    host(`${SPIN} div { ${BOX}; animation: spin 1s linear infinite }`) +
      '<x-box></x-box>',
  ),
  // Lit's shape: the root is attached first, its styles adopted after.
  '/spin-adopted': doc(
    host(
      `${SPIN} div { ${BOX}; animation: spin 1s linear infinite }`,
      '<div></div>',
      'adopt',
    ) + '<x-box></x-box>',
  ),
  // Attached after load, so after the freeze has been applied.
  '/spin-late': doc(
    host(`${SPIN} div { ${BOX}; animation: spin 1s linear infinite }`) + late(50),
  ),
  '/spin-late-adopted': doc(
    host(
      `${SPIN} div { ${BOX}; animation: spin 1s linear infinite }`,
      '<div></div>',
      'adopt',
    ) + late(50),
  ),
  // A tooltip-style fade-in, triggered after the first frame.
  '/fade': doc(
    host(
      `div { ${BOX}; opacity: 0; transition: opacity 2s linear } div.on { opacity: 1 }`,
    ) +
      `<x-box></x-box><script>addEventListener('load', () => setTimeout(() =>
        document.querySelector('x-box').shadowRoot.querySelector('div').classList.add('on'), 30));</script>`,
  ),
  // A staged reveal inside a shadow root: one function re-arming itself every
  // 100 ms and changing the shadow DOM at each step. A re-armed paced timer
  // counts only if the DOM changed since the last fire, so the change has to
  // be seen.
  '/chain': doc(
    host('', '<div id="out"></div>') +
      `<x-box></x-box><script>
      const out = document.querySelector('x-box').shadowRoot.getElementById('out');
      const add = (t) => { const p = document.createElement('div'); p.textContent = t; out.appendChild(p); };
      let n = 0; function step() { add('step ' + ++n); if (n < 4) setTimeout(step, 100); else add('final'); }
      setTimeout(step, 100);</script>`,
  ),
  // An image added inside a shadow root after load. Its request is ignored
  // by the network wait in the tests, so only the image wait can hold it.
  '/img-ready': doc(
    host('img { display: block }', '<img src="/img/0" width="20" height="20">') +
      '<x-box></x-box>',
  ),
  '/img-late': doc(
    host('img { display: block }', '<div id="slot"></div>') +
      `<x-box></x-box><script>addEventListener('load', () => setTimeout(() => {
        const i = document.createElement('img'); i.width = 20; i.height = 20; i.src = '/img/400';
        const slot = document.querySelector('x-box').shadowRoot.getElementById('slot'); slot.replaceWith(i); }, 0));</script>`,
  ),
  '/img-never': doc(
    host('', '<div id="slot"></div>') +
      `<x-box></x-box><script>addEventListener('load', () => setTimeout(() => {
        const i = document.createElement('img'); i.width = 20; i.height = 20; i.src = '/never-image';
        document.querySelector('x-box').shadowRoot.getElementById('slot').replaceWith(i); }, 0));</script>`,
  ),
  // Same rule as the light DOM: a lazy image that isn't rendered never loads.
  '/img-hidden-lazy': doc(
    host(
      '',
      '<img loading="lazy" src="/never-image" style="display:none" width="10" height="10">',
    ) + '<x-box></x-box>',
  ),
};

beforeAll(async () => {
  png = await sharp({
    create: { width: 20, height: 20, channels: 3, background: { r: 200, g: 0, b: 0 } },
  })
    .png()
    .toBuffer();
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const img = /^\/img\/(\d+)$/.exec(url.pathname);
    if (img) {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'image/png' });
        res.end(png);
      }, Number(img[1]));
    } else if (url.pathname === '/never-image') {
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
}, 30_000);

afterAll(async () => {
  await browser?.close();
  for (const s of sockets) s.destroy();
  server.close();
});

async function snap(paths: string[], params: StoryParams = {}): Promise<Snapshot[]> {
  const { pages } = await snapPages({
    urls: paths.map((p) => `${base}${p}`),
    browser,
    viewport: { width: 200, height: 140 },
    params,
  });
  return pages.map((p) => {
    if (!p.snapshot) throw new Error(p.error);
    return p.snapshot;
  });
}

const texts = (s: Snapshot) => (s.structure?.elements ?? []).map((e) => e.text ?? '');
const IGNORE_IMG: StoryParams = {
  settle: { network: { ignore: ['/img/*', '/never-image'] } },
};

describe.skipIf(!chrome)('open shadow roots in Chrome', { timeout: 30_000 }, () => {
  // On 255fc28 the light-DOM freeze sheet stopped at the shadow boundary:
  // every capture caught the spinner at whatever angle it had reached.
  it.each(['/spin', '/spin-adopted', '/fade'])(
    'freezes a CSS animation or transition inside a shadow root (%s)',
    async (path) => {
      const [still, a, b] = await snap(['/static', path, path]);
      expect(a!.image.equals(still!.image)).toBe(true);
      expect(b!.image.equals(still!.image)).toBe(true);
    },
  );

  it.each(['/spin-late', '/spin-late-adopted'])(
    'freezes a shadow root attached after the freeze was applied (%s)',
    async (path) => {
      const [still, a, b] = await snap(['/static', path, path]);
      expect(a!.image.equals(still!.image)).toBe(true);
      expect(b!.image.equals(still!.image)).toBe(true);
    },
  );

  // On 255fc28 the re-armed timer's shadow-DOM change went unseen, the timer
  // stopped counting, and the capture caught 'step 2'.
  it('counts mutations inside a shadow root, so a staged reveal there is waited out', async () => {
    const [s] = await snap(['/chain']);
    expect(texts(s!)).toContain('final');
    expect(s!.settle).toBeUndefined();
  });

  it('waits for an image that starts loading late inside a shadow root', async () => {
    const [ready, slow] = await snap(['/img-ready', '/img-late'], IGNORE_IMG);
    expect(slow!.image.equals(ready!.image)).toBe(true);
    expect(slow!.settle).toBeUndefined();
  });

  it('names an image inside a shadow root that never loads', async () => {
    const [s] = await snap(['/img-never'], {
      settle: { timeout: 600, network: { ignore: ['/never-image'] } },
    });
    expect(s!.settle).toEqual({
      status: 'timeout',
      timeoutMs: 600,
      pending: ['1 image still loading: /never-image'],
    });
  });

  it('does not wait for a hidden lazy image inside a shadow root', async () => {
    const [s] = await snap(['/img-hidden-lazy']);
    expect(s!.settle).toBeUndefined();
  });
});
