// Storybook 9+'s addon-a11y runs axe-core in every story's afterEach, after
// the `played` phase jux captures at. axe holds the main thread for as long as
// the document is large: Primer's treeview-features--contain-intrinsic-size
// (10 expanded directories of 1,000 items, 110k elements) blocked it for over
// 100 s, so every CDP call jux made after the render signal waited out the
// story budget. This page stands in for that preview: it reaches `played`,
// then runs a 5 s synchronous "axe" unless the URL's globals set
// `a11y.manual` the way Storybook's URL parser reads them (the real addon
// checks `globals.a11y.manual !== true`; checked by hand on Primer's
// Storybook 10.5 build).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { Browser, resolveChrome } from '@juxtapose/core/browser';
import { StorybookPlatform } from './index.js';

const chrome = (() => {
  try {
    return resolveChrome();
  } catch {
    return null;
  }
})();

const AXE_MS = 5000;

const PREVIEW = `<!doctype html><body><p>story</p><script>
const q = new URLSearchParams(location.search);
const globals = (q.get('globals') ?? '').split(';');
const render = { id: q.get('id'), phase: 'rendering' };
window.__STORYBOOK_PREVIEW__ = { storyRenders: [render] };
document.body.classList.add('sb-main-padded');
setTimeout(() => {
  render.phase = 'played';
  if (globals.includes('a11y.manual:!true')) return void (render.phase = 'completed');
  setTimeout(() => {
    render.phase = 'afterEach';
    const end = Date.now() + ${AXE_MS};
    while (Date.now() < end) {}
    render.phase = 'completed';
  }, 50);
}, 20);
</script></body>`;

let server: Server;
let base: string;
beforeAll(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(PREVIEW);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => {
  server.closeAllConnections();
  server.close();
});

describe.skipIf(!chrome)('StorybookPlatform with addon-a11y', () => {
  it("leaves the page's main thread free after the render signal", async () => {
    const browser = await Browser.launch({ executablePath: chrome!.path });
    try {
      const context = await browser.newContext({ viewport: { width: 200, height: 100 } });
      const page = await context.newPage();
      const platform = new StorybookPlatform();
      const story = {
        storyId: 'a--b',
        title: 'a',
        name: 'b',
        componentPath: '',
        params: {},
      };
      await platform.showStory(page, story.storyId, base);
      await platform.settle(page, { story, params: {}, timeoutMs: 2000 });
      // Past the point the afterEach would have started.
      await new Promise((r) => setTimeout(r, 200));
      const started = Date.now();
      await page.evaluate(() => 1);
      expect(Date.now() - started).toBeLessThan(AXE_MS / 2);
    } finally {
      await browser.close();
    }
  }, 30_000);
});
