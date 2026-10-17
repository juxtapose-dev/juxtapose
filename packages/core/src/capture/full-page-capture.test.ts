import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import sharp from 'sharp';
import { Browser } from '../browser/browser.js';
import { chromeForTests } from '../browser/__tests__/helpers.js';
import { createUrlPlatform } from '../platforms/urls.js';
import { captureStory } from './capture.js';

// A scroll reveal shaped like formhealth.co's: the observer attaches after
// DOMContentLoaded (there, a deferred GSAP bundle), and the reveal is a JS
// tween on a rAF loop, which the idle wait stops counting after three frames.
const PAGE = `<!doctype html><body style="margin:0;height:3000px;background:#fff">
<div id="box" style="position:absolute;top:2000px;left:0;width:100px;height:100px;background:#f00;opacity:0"></div>
<script>
setTimeout(() => {
  const box = document.getElementById('box');
  new IntersectionObserver((entries, io) => {
    if (!entries[0].isIntersecting) return;
    io.disconnect();
    const t0 = performance.now();
    const step = (t) => {
      const p = Math.min(1, (t - t0) / 400);
      box.style.opacity = String(p);
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }).observe(box);
}, 50);
</script>`;

const chrome = chromeForTests();
let server: Server;
let browser: Browser;
let base: string;
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

describe.skipIf(!chrome)('full-page capture', () => {
  it('captures a scroll-triggered JS reveal below the fold at its final state', async () => {
    const platform = createUrlPlatform([{ id: 'reveal', url: `${base}/` }]);
    const [story] = await platform.enumerate({ projectRoot: process.cwd() });
    const context = await browser.newContext({ viewport: { width: 320, height: 240 } });
    try {
      const page = await context.newPage();
      const snap = await captureStory(
        page,
        { ...story!, params: { ...story!.params, fullPage: true } },
        { platform, baseUrl: base },
        { width: 320, height: 240 },
      );
      expect(snap?.viewport).toEqual({ width: 320, height: 3000 });
      const { data, info } = await sharp(snap!.image)
        .raw()
        .toBuffer({ resolveWithObject: true });
      const at = (2050 * info.width + 50) * info.channels;
      expect([...data.subarray(at, at + 3)]).toEqual([255, 0, 0]);
    } finally {
      await context.close();
    }
  }, 30_000);
});
