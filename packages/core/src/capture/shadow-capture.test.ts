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
import { FREEZE_ANIMATIONS_CSS } from './settle.js';

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

const placeholderPage = (shadow: boolean, transition: boolean) => {
  const css =
    'input::placeholder { color: red; opacity: 1; transition: color 60s linear } input.on::placeholder { color: blue }';
  const input = `<input placeholder="Placeholder text" class="${transition ? '' : 'on'}">`;
  return doc(
    (shadow
      ? host(css, input, 'adopt') + '<x-box></x-box>'
      : `<style>${css}</style>${input}`) +
      (transition
        ? `<script>addEventListener('load', () => setTimeout(() => {
      const root = ${shadow ? "document.querySelector('x-box').shadowRoot" : 'document'};
      root.querySelector('input').classList.add('on');
    }, 30));</script>`
        : ''),
  );
};

const PAGES: Record<string, string> = {
  '/placeholder-static': placeholderPage(false, false),
  '/placeholder-transition': placeholderPage(false, true),
  '/placeholder-shadow-static': placeholderPage(true, false),
  '/placeholder-shadow-transition': placeholderPage(true, true),
  // Shadow roots in another document, made after the freeze: a sheet
  // constructed in this document can't be adopted there, and the native
  // calls must still succeed (review of #161).
  '/foreign': doc(
    `<div id="out" style="font: 10px/12px sans-serif; white-space: nowrap"></div><script>
    const out = document.getElementById('out');
    const add = (t) => { const d = document.createElement('div'); d.textContent = t; out.appendChild(d); };
    const tryIt = (name, fn) => { try { fn(); add(name + ' ok'); } catch (e) { add(name + ' threw ' + e.name); } };
    customElements.define('x-ce', class extends HTMLElement { connectedCallback() {
      if (this.shadowRoot) return;
      tryIt('iframe', () => { this.attachShadow({ mode: 'open' }).innerHTML = '<b>ok</b>'; }); } });
    const host = document.createElement('div'); host.attachShadow({ mode: 'open' }).innerHTML = '<i>host</i>';
    document.body.appendChild(host);
    addEventListener('load', () => setTimeout(() => {
      const f = document.createElement('iframe'); document.body.appendChild(f);
      const fd = f.contentDocument;
      fd.body.appendChild(document.createElement('x-ce'));
      tryIt('adopted', () => { fd.adoptNode(host); fd.body.appendChild(host); host.shadowRoot.adoptedStyleSheets = []; });
      tryIt('created', () => { document.implementation.createHTMLDocument('').createElement('div').attachShadow({ mode: 'open' }); });
      tryIt('template', () => { const t = document.createElement('template'); t.innerHTML = '<div></div>';
        t.content.firstChild.attachShadow({ mode: 'open' }); });
      tryIt('set', () => { const r = document.createElement('div').attachShadow({ mode: 'open' });
        const s = new CSSStyleSheet(); r.adoptedStyleSheets = new Set([s]);
        // The page's sheet, then the freeze sheet.
        if (r.adoptedStyleSheets.length !== 2 || r.adoptedStyleSheets[0] !== s) throw new Error('lost'); });
    }, 100));</script>`,
  ),
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

// Assert the rendered color endpoint, not cross-navigation glyph raster identity:
// Linux can rasterize the same glyph edges differently even at the same color.
async function placeholderColors(image: Buffer) {
  const data = await sharp(image).removeAlpha().raw().toBuffer();
  let blue = 0;
  let otherColor = 0;
  for (let i = 0; i < data.length; i += 3) {
    const [r, g, b] = [data[i]!, data[i + 1]!, data[i + 2]!];
    if (r === g && g === b) continue; // White page and gray native input border.
    if (r === g && b === 255) blue++;
    else otherColor++;
  }
  return { blue, otherColor };
}

describe.skipIf(!chrome)('open shadow roots in Chrome', { timeout: 30_000 }, () => {
  it.each([false, true])(
    'stops an already-started transition (shadow=%s)',
    async (shadow) => {
      const context = await browser.newContext({ viewport: { width: 200, height: 140 } });
      try {
        const page = await context.newPage();
        await page.goto(`${base}/static`);
        const result = await page.evaluate(
          async ({ shadow, css }) => {
            document.body.innerHTML = '';
            const host = document.createElement('div');
            document.body.append(host);
            const root = shadow ? host.attachShadow({ mode: 'open' }) : host;
            const box = document.createElement('div');
            box.style.cssText =
              'width:80px;height:80px;background:black;transition:background-color 60s linear';
            root.append(box);
            getComputedStyle(box).backgroundColor;
            box.style.backgroundColor = 'white';
            const started = box.getAnimations();
            await Promise.all(started.map((animation) => animation.ready));
            const before = {
              count: started.length,
              color: getComputedStyle(box).backgroundColor,
            };
            const style = document.createElement('style');
            style.textContent = css;
            root.append(style);
            const color = getComputedStyle(box).backgroundColor;
            return { before, color, running: box.getAnimations().length };
          },
          { shadow, css: FREEZE_ANIMATIONS_CSS },
        );
        expect(result.before.count).toBeGreaterThan(0);
        expect(result.before.color).not.toBe('rgb(255, 255, 255)');
        expect(result.color).toBe('rgb(255, 255, 255)');
        expect(result.running).toBe(0);
        const pixel = await sharp(await page.screenshot())
          .extract({ left: 30, top: 30, width: 1, height: 1 })
          .removeAlpha()
          .raw()
          .toBuffer();
        expect([...pixel]).toEqual([255, 255, 255]);
      } finally {
        await context.close();
      }
    },
  );
  it.each(['placeholder', 'placeholder-shadow'])(
    'freezes placeholder color transitions (%s), retaining the play opt-out',
    async (name) => {
      const [still, frozen] = await snap([`/${name}-static`, `/${name}-transition`]);
      for (const capture of [still!, frozen!]) {
        const colors = await placeholderColors(capture.image);
        expect(colors.blue).toBeGreaterThan(20);
        expect(colors.otherColor).toBe(0);
      }
      const [playing] = await snap([`/${name}-transition`], { animations: 'play' });
      expect((await placeholderColors(playing!.image)).otherColor).toBeGreaterThan(20);
    },
  );
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
    expect(s!.settle).toMatchObject({
      status: 'timeout',
      timeoutMs: 600,
      pending: ['1 image still loading: /never-image'],
    });
  });

  // On the first version of this fix the freeze sheet was forced into roots
  // of other documents: attachShadow threw NotAllowedError after attaching,
  // and so did adoptedStyleSheets = [] on a host moved to an iframe.
  it("never breaks a page's shadow-root calls in another document", async () => {
    const [s] = await snap(['/foreign']);
    expect(texts(s!).filter(Boolean)).toEqual(
      expect.arrayContaining([
        'iframe ok',
        'adopted ok',
        'created ok',
        'template ok',
        'set ok',
      ]),
    );
  });

  it('does not wait for a hidden lazy image inside a shadow root', async () => {
    const [s] = await snap(['/img-hidden-lazy']);
    expect(s!.settle).toBeUndefined();
  });
});
