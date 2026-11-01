/* global document */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { Browser } from '../browser/browser.js';
import { chromeForTests } from '../browser/__tests__/helpers.js';
import { normalizeStructure, STRUCTURE_PROPS } from '../capture/structure.js';
import {
  mapRetainedElements,
  installDomMappingGuard,
  finishDomMappingGuard,
} from './dom-mapping.js';
const chrome = chromeForTests();
let server: Server, base: string, browser: Browser;
const html = `<!doctype html><style>body{margin:0;font:16px Arial}div{width:100px;height:20px}#pseudo::before{content:'icon'}</style><main><div id="unique">first</div><div id="pseudo">second</div><div data-testid="a&gt;[&quot;\\x">third</div><span id="odd&gt;[&quot;\\id">escaped</span><x-host></x-host><div style="height:1500px">long</div></main><script>document.querySelector('x-host').attachShadow({mode:'open'}).innerHTML='<span style="display:block;width:30px;height:20px">shadow</span>';</script>`;
beforeAll(async () => {
  server = createServer((_req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(html);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  if (chrome) browser = await Browser.launch({ executablePath: chrome.path });
});
afterAll(async () => {
  await browser?.close();
  server?.closeAllConnections();
  server?.close();
});
const mapSource = mapRetainedElements.toString(),
  installSource = installDomMappingGuard.toString(),
  finishSource = finishDomMappingGuard.toString();
async function fixture(
  scale = 1,
  origin = { x: 0, y: 0 },
  scroll = 0,
  guardKey?: string,
) {
  const context = await browser.newContext({ viewport: { width: 400, height: 300 } });
  const page = await context.newPage();
  await page.goto(base);
  if (scroll) await page.evaluate((y) => globalThis.scrollTo(0, y), scroll);
  if (guardKey)
    expect(
      (await page.evaluate(`(${installSource})(document,${JSON.stringify(guardKey)})`))
        .status,
    ).toBe('available');
  const raw = await page.send('DOMSnapshot.captureSnapshot', {
    computedStyles: [...STRUCTURE_PROPS, 'visibility'],
    includePaintOrder: true,
  });
  const snapshot = normalizeStructure(raw, { width: 400, height: 300 }, scale, origin);
  return { context, page, snapshot };
}
describe.skipIf(!chrome)('retained DOM mapping against real Chromium snapshots', () => {
  it('maps literal escaped identities and open shadow content, skips pseudo nodes, and preserves DOM/pixels', async () => {
    const key = 'jux_components_parity_123456789';
    const { context, page, snapshot } = await fixture(1, { x: 0, y: 0 }, 0, key);
    try {
      const before = await page.screenshot();
      const dom = await page.evaluate(() => document.documentElement.outerHTML);
      const result = await page.evaluate(
        `(()=>{const m=(${mapSource})(document,${JSON.stringify(snapshot.elements)},{scale:1,origin:{x:0,y:0}});return {...m,guard:(${finishSource})(document,${JSON.stringify(key)}),elements:m.elements.map(e=>({tag:e.tagName.toLowerCase(),id:e.id,text:e.textContent}))};})()`,
      );
      expect(result.status).toBe('available');
      expect(result.guard.status).toBe('available');
      expect(result.indices).toEqual(
        snapshot.elements.flatMap((e, i) => (e.tag.startsWith('::') ? [] : [i])),
      );
      expect(result.elements.some((e: { text: string }) => e.text === 'shadow')).toBe(
        true,
      );
      expect(result.elements.some((e: { id: string }) => e.id.startsWith('odd>['))).toBe(
        true,
      );
      expect((await page.screenshot()).equals(before)).toBe(true);
      expect(await page.evaluate(() => document.documentElement.outerHTML)).toBe(dom);
    } finally {
      await context.close();
    }
  });
  it('rejects duplicate raw IDs even when geometry distinguishes the elements', async () => {
    const { context, page } = await fixture();
    try {
      await page.evaluate(() => {
        const a = document.createElement('div');
        a.id = 'unique';
        document.querySelector('main')!.append(a);
      });
      const raw = await page.send('DOMSnapshot.captureSnapshot', {
        computedStyles: [...STRUCTURE_PROPS, 'visibility'],
      });
      const snapshot = normalizeStructure(raw, { width: 400, height: 300 });
      const result = await page.evaluate(
        `(${mapSource})(document,${JSON.stringify(snapshot.elements)},{scale:1,origin:{x:0,y:0}})`,
      );
      expect(result).toMatchObject({
        status: 'unavailable',
        reason: 'dom-changed',
        elements: [],
        indices: [],
      });
    } finally {
      await context.close();
    }
  });
  it('rejects moved or missing nodes and verifies scaled, scrolled coordinates', async () => {
    const { context, page } = await fixture(1, { x: 0, y: 0 }, 40);
    try {
      const raw = await page.send('DOMSnapshot.captureSnapshot', {
        computedStyles: [...STRUCTURE_PROPS, 'visibility'],
      });
      for (const scale of [1, 1.5]) {
        const origin = { x: 0, y: 25 };
        const snapshot = normalizeStructure(
          raw,
          { width: 400, height: 300 },
          scale,
          origin,
        );
        expect(
          (
            await page.evaluate(
              `(${mapSource})(document,${JSON.stringify(snapshot.elements)},{scale:${scale},origin:${JSON.stringify(origin)},scroll:{x:0,y:40}})`,
            )
          ).status,
        ).toBe('available');
      }
      const snapshot = normalizeStructure(raw, { width: 400, height: 300 });
      await page.evaluate(() =>
        document
          .querySelector('main')!
          .setAttribute('style', 'transform:translateY(2px)'),
      );
      expect(
        (
          await page.evaluate(
            `(${mapSource})(document,${JSON.stringify(snapshot.elements)},{scale:1,origin:{x:0,y:0}})`,
          )
        ).reason,
      ).toBe('dom-changed');
      await page.evaluate(() => document.querySelector('#unique')!.remove());
      expect(
        (
          await page.evaluate(
            `(${mapSource})(document,${JSON.stringify(snapshot.elements)},{scale:1,origin:{x:0,y:0}})`,
          )
        ).status,
      ).toBe('unavailable');
    } finally {
      await context.close();
    }
  });
  it('mutation guard rejects same-shape replacement and shadow mutations, then removes its state', async () => {
    const { context, page, snapshot } = await fixture();
    try {
      const key = 'jux_components_test_123456789';
      expect(
        (await page.evaluate(`(${installSource})(document,${JSON.stringify(key)})`))
          .status,
      ).toBe('available');
      await page.evaluate(() => {
        const e = document.querySelector('#unique')!;
        e.replaceWith(e.cloneNode(true));
      });
      const result = await page.evaluate(
        `(()=>{const mapped=(${mapSource})(document,${JSON.stringify(snapshot.elements)},{scale:1,origin:{x:0,y:0}});return {mapped:mapped.status,guard:(${finishSource})(document,${JSON.stringify(key)}),removed:!Object.hasOwn(globalThis,${JSON.stringify(key)})};})()`,
      );
      expect(result).toMatchObject({
        mapped: 'available',
        guard: { status: 'unavailable', reason: 'dom-changed' },
        removed: true,
      });
      await page.evaluate(`(${installSource})(document,${JSON.stringify(key)})`);
      await page.evaluate(() =>
        document
          .querySelector('x-host')!
          .shadowRoot!.firstElementChild!.setAttribute('title', 'changed'),
      );
      expect(
        (await page.evaluate(`(${finishSource})(document,${JSON.stringify(key)})`))
          .reason,
      ).toBe('dom-changed');
      await page.evaluate(`(${installSource})(document,${JSON.stringify(key)})`);
      await page.evaluate(() => {
        document.querySelector('#unique')!.firstChild!.nodeValue = 'changed text';
      });
      expect(
        (await page.evaluate(`(${finishSource})(document,${JSON.stringify(key)})`))
          .reason,
      ).toBe('dom-changed');
    } finally {
      await context.close();
    }
  });
  it('returns masked before traversal and detects newly attached open roots', async () => {
    const { context, page, snapshot } = await fixture();
    try {
      expect(
        await page.evaluate(
          `(${installSource})(null,'jux_components_mask_123456789',[document.body])`,
        ),
      ).toMatchObject({ status: 'unavailable', reason: 'masked' });
      expect(
        await page.evaluate(
          `(${mapSource})(null,${JSON.stringify(snapshot.elements)},{scale:1,origin:{x:0,y:0}},[document.body])`,
        ),
      ).toMatchObject({ status: 'unavailable', reason: 'masked', elements: [] });
      const key = 'jux_components_test_123456789';
      await page.evaluate(`(${installSource})(document,${JSON.stringify(key)})`);
      await page.evaluate(() =>
        document.querySelector('#unique')!.attachShadow({ mode: 'open' }),
      );
      expect(
        (await page.evaluate(`(${finishSource})(document,${JSON.stringify(key)})`))
          .reason,
      ).toBe('dom-changed');
    } finally {
      await context.close();
    }
  });
});
