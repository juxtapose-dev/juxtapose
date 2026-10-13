// discoverParams in a real Chrome, against a page shaped like Storybook's
// preview: the store appears asynchronously after load (as the real one
// does), and extract() is only complete after cacheAllCSFFiles(). The real
// thing is exercised by the examples (Storybook 8.6) and was checked by hand
// on 10.6; this pins the evaluate code without a Storybook build.

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

const PREVIEW = `<!doctype html><body><script>
let cached = false;
setTimeout(() => {
  window.__STORYBOOK_PREVIEW__ = {
    storyStoreValue: { cacheAllCSFFiles: async () => { cached = true; } },
    extract: async () => cached ? {
      'card--default': { parameters: { juxtapose: { variants: { dark: { colorScheme: 'dark' } } } } },
      'card--plain': { parameters: { layout: 'centered' } },
      'card--skipped': { parameters: { juxtapose: { skip: true } } },
    } : {},
  };
}, 50);
</script></body>`;

const NOT_STORYBOOK = `<!doctype html><body>nothing here</body>`;

let server: Server;
let base: string;
beforeAll(async () => {
  server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(req.url?.startsWith('/broken/') ? NOT_STORYBOOK : PREVIEW);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => {
  server.closeAllConnections();
  server.close();
});

describe.skipIf(!chrome)('StorybookPlatform.discoverParams', () => {
  it('returns every story that declares juxtapose params, after caching all CSF files', async () => {
    const browser = await Browser.launch({ executablePath: chrome!.path });
    try {
      const context = await browser.newContext({ viewport: { width: 100, height: 100 } });
      const page = await context.newPage();
      const found = await new StorybookPlatform().discoverParams(page, base);
      expect(Object.fromEntries(found)).toEqual({
        'card--default': { variants: { dark: { colorScheme: 'dark' } } },
        'card--skipped': { skip: true },
      });
    } finally {
      await browser.close();
    }
  });

  it('throws on a page with no Storybook preview, for core to warn about', async () => {
    const browser = await Browser.launch({ executablePath: chrome!.path });
    try {
      const context = await browser.newContext({ viewport: { width: 100, height: 100 } });
      const page = await context.newPage();
      await expect(
        new StorybookPlatform().discoverParams(page, `${base}/broken`),
      ).rejects.toThrow(/no Storybook preview store/);
    } finally {
      await browser.close();
    }
  }, 30_000);
});
