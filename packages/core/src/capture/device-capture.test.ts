import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import sharp from 'sharp';
import { Browser, type BrowserContext } from '../browser/browser.js';
import { chromeForTests } from '../browser/__tests__/helpers.js';
import { createUrlPlatform } from '../platforms/urls.js';
import type { Platform } from '../platform.js';
import type { StoryManifest } from '../types.js';
import { captureStory } from './capture.js';

// Prints what device emulation changes, so a capture that kept a previous
// device's touch, pointer or UA has different pixels from one that did not.
const PAGE = `<!doctype html><body style="margin:0;font:20px monospace">
<pre id="out"></pre>
<script>
document.getElementById('out').textContent = [
  'touch ' + navigator.maxTouchPoints,
  'coarse ' + matchMedia('(pointer: coarse)').matches,
  'mobile ' + (navigator.userAgentData ? navigator.userAgentData.mobile : 'n/a'),
  navigator.userAgent.replace(/(.{30})/g, '$1\\n'),
].join('\\n');
</script>`;

// A desktop-only layout: 980px wide, taller than any phone, with a marker at
// half its width. Without a viewport meta a phone lays it out 980px wide and
// zooms out to fit; with one at initial-scale 1 it overflows at scale 1.
const wide = (meta: string) => `<!doctype html>${meta}
<body style="margin:0;width:980px;height:3000px;background:#fff">
<div id="mark" style="position:absolute;top:100px;left:490px;width:100px;height:100px;background:#f00"></div>`;

interface Seen {
  path: string;
  ua: string;
  mobile: string | undefined;
}

const chrome = chromeForTests();
let server: Server;
let browser: Browser;
let base: string;
let seen: Seen[] = [];
beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url?.startsWith('/page')) {
      seen.push({
        path: req.url,
        ua: req.headers['user-agent'] ?? '',
        mobile: req.headers['sec-ch-ua-mobile'] as string | undefined,
      });
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(
      req.url === '/wide'
        ? wide('')
        : req.url === '/wide-meta'
          ? wide('<meta name="viewport" content="width=device-width, initial-scale=1">')
          : PAGE,
    );
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  if (chrome) browser = await Browser.launch({ executablePath: chrome.path });
}, 30_000);
afterAll(async () => {
  await browser?.close();
  server.close();
});
beforeEach(() => {
  seen = [];
});

const viewport = { width: 400, height: 300 };
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const mobileUa = (ua: string) => /Mobile|iPhone|Android/.test(ua);

async function withPage<T>(
  fn: (page: Awaited<ReturnType<BrowserContext['newPage']>>) => Promise<T>,
): Promise<T> {
  const context = await browser.newContext({ viewport });
  try {
    return await fn(await context.newPage());
  } finally {
    await context.close();
  }
}

async function story(platform: Platform, params: StoryManifest['params'] = {}) {
  const [s] = await platform.enumerate({ projectRoot: process.cwd() });
  return { ...s!, params: { ...s!.params, ...params } };
}

describe.skipIf(!chrome)('device emulation in capture', () => {
  it('navigates under the device UA and records the device', async () => {
    const platform = createUrlPlatform([{ id: 'p', url: `${base}/page` }]);
    const snap = await withPage(async (page) =>
      captureStory(
        page,
        await story(platform, { device: 'pixel-8' }),
        { platform, baseUrl: base },
        viewport,
      ),
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]!.ua).toContain('Pixel 8');
    expect(seen[0]!.mobile).toBe('?1');
    expect(snap?.device).toBe('pixel-8');
    expect(snap?.emulation).toMatch(/^portrait\|m1t1\|ua:[0-9a-f]{8}$/);
    expect(snap?.viewport).toEqual({ width: 412, height: 915 });
  }, 30_000);

  it('resets a page that had a device to a fresh page’s pixels', async () => {
    const platform = createUrlPlatform([{ id: 'p', url: `${base}/page` }]);
    const fresh = await withPage(async (page) =>
      captureStory(page, await story(platform), { platform, baseUrl: base }, viewport),
    );
    seen = [];
    const [withDevice, after] = await withPage(async (page) => [
      await captureStory(
        page,
        await story(platform, { device: 'pixel-8' }),
        { platform, baseUrl: base },
        viewport,
      ),
      await captureStory(
        page,
        await story(platform),
        { platform, baseUrl: base },
        viewport,
      ),
    ]);
    expect(seen.map((s) => mobileUa(s.ua))).toEqual([true, false]);
    expect(seen[1]!.mobile).toBe('?0');
    expect(sha(withDevice!.image)).not.toBe(sha(fresh!.image));
    expect(sha(after!.image)).toBe(sha(fresh!.image));
    expect(after!.viewport).toEqual(viewport);
    expect(after!.emulation).toBeUndefined();
    expect(after!.device).toBeUndefined();
    expect('emulation' in after!).toBe(false);
  }, 30_000);

  it('navigates rather than warm-switching to a story with another device', async () => {
    let switched = 0;
    const urls = createUrlPlatform([
      { id: 'a', url: `${base}/page?a`, params: { device: 'pixel-8' } },
      { id: 'b', url: `${base}/page?b`, params: { device: 'iphone-15' } },
    ]);
    const platform: Platform = {
      ...urls,
      switchStory: async () => {
        switched++;
        return true;
      },
    };
    const [a, b] = await urls.enumerate({ projectRoot: process.cwd() });
    const deps = { platform, baseUrl: base, warmSwitch: true };
    const snaps = await withPage(async (page) => [
      await captureStory(page, a!, deps, viewport),
      await captureStory(page, b!, deps, viewport),
    ]);
    expect(switched).toBe(0);
    expect(seen.map((s) => s.path)).toEqual(['/page?a', '/page?b']);
    expect(seen[0]!.ua).toContain('Pixel 8');
    expect(seen[1]!.ua).toContain('iPhone');
    expect(snaps.map((s) => s?.device)).toEqual(['pixel-8', 'iphone-15']);
  }, 30_000);

  it('fails the capture of an unknown device before navigating', async () => {
    const platform = createUrlPlatform([{ id: 'p', url: `${base}/page` }]);
    await expect(
      withPage(async (page) =>
        captureStory(
          page,
          await story(platform, { device: 'pixel-9z' }),
          { platform, baseUrl: base },
          viewport,
        ),
      ),
    ).rejects.toThrow(/^unknown device 'pixel-9z'; did you mean /);
    expect(seen).toEqual([]);
  }, 30_000);

  it('recaptures once under a device the live params declare', async () => {
    const urls = createUrlPlatform([{ id: 'p', url: `${base}/page` }]);
    let reads = 0;
    const platform: Platform = {
      ...urls,
      readLiveParams: async () => {
        reads++;
        return { device: 'mobile' };
      },
    };
    const snap = await withPage(async (page) =>
      captureStory(page, await story(urls), { platform, baseUrl: base }, viewport),
    );
    expect(snap?.device).toBe('mobile');
    expect(snap?.viewport).toEqual({ width: 393, height: 852 });
    expect(seen.map((s) => mobileUa(s.ua))).toEqual([false, true]);
    expect(seen[1]!.ua).toContain('iPhone');
    expect(reads).toBe(2);
  }, 30_000);

  it('captures a page with no viewport meta zoomed out, as the phone shows it', async () => {
    const platform = createUrlPlatform([{ id: 'w', url: `${base}/wide` }]);
    const s = await story(platform, { device: 'iphone-15', fullPage: true });
    const [snap, again] = await withPage(async (page) => [
      await captureStory(page, s, { platform, baseUrl: base }, viewport),
      await captureStory(page, s, { platform, baseUrl: base }, viewport),
    ]);
    expect(sha(again!.image)).toBe(sha(snap!.image));
    const scale = 393 / 980;
    const { info } = await sharp(snap!.image).toBuffer({ resolveWithObject: true });
    expect(Math.abs(info.width - 393)).toBeLessThanOrEqual(1);
    expect(Math.abs(info.height - 3000 * scale)).toBeLessThanOrEqual(1);
    expect(snap?.viewport).toEqual({ width: info.width, height: info.height });
    expect(snap?.layoutViewport).toEqual({ width: 393, height: 852 });
    // In image pixels like the rects: nothing was left below the fold.
    expect(snap!.structure!.contentHeight).toBeLessThanOrEqual(info.height);
    const mark = snap?.structure?.elements.find((e) => e.id === 'mark');
    expect(Math.abs(mark!.rect.x - 490 * scale)).toBeLessThanOrEqual(2);
    expect(Math.abs(mark!.rect.y - 100 * scale)).toBeLessThanOrEqual(2);
    expect(Math.abs(mark!.rect.w - 100 * scale)).toBeLessThanOrEqual(2);
    // The marker's centre is red in the image, where the rect says it is.
    const { data } = await sharp(snap!.image).raw().toBuffer({ resolveWithObject: true });
    const cx = Math.round(mark!.rect.x + mark!.rect.w / 2);
    const cy = Math.round(mark!.rect.y + mark!.rect.h / 2);
    const at = (cy * info.width + cx) * info.channels;
    expect([...data.subarray(at, at + 3)]).toEqual([255, 0, 0]);
  }, 30_000);

  it('captures the same page with a viewport meta at scale 1', async () => {
    const platform = createUrlPlatform([{ id: 'w', url: `${base}/wide-meta` }]);
    const snap = await withPage(async (page) =>
      captureStory(
        page,
        await story(platform, { device: 'iphone-15', fullPage: true }),
        { platform, baseUrl: base },
        viewport,
      ),
    );
    const { info } = await sharp(snap!.image).toBuffer({ resolveWithObject: true });
    expect(snap?.viewport).toEqual({ width: 980, height: 3000 });
    expect([info.width, info.height]).toEqual([980, 3000]);
    const mark = snap?.structure?.elements.find((e) => e.id === 'mark');
    expect(mark?.rect).toEqual({ x: 490, y: 100, w: 100, h: 100 });
  }, 30_000);

  it('records structure in image pixels for a zoomed viewport capture', async () => {
    const platform = createUrlPlatform([{ id: 'w', url: `${base}/wide` }]);
    const snap = await withPage(async (page) =>
      captureStory(
        page,
        await story(platform, { device: 'iphone-15' }),
        { platform, baseUrl: base },
        viewport,
      ),
    );
    const scale = 393 / 980;
    const { data, info } = await sharp(snap!.image)
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect(Math.abs(info.width - 393)).toBeLessThanOrEqual(1);
    const mark = snap?.structure?.elements.find((e) => e.id === 'mark');
    expect(Math.abs(mark!.rect.x - 490 * scale)).toBeLessThanOrEqual(2);
    expect(Math.abs(mark!.rect.y - 100 * scale)).toBeLessThanOrEqual(2);
    expect(Math.abs(mark!.rect.w - 100 * scale)).toBeLessThanOrEqual(2);
    const cx = Math.round(mark!.rect.x + mark!.rect.w / 2);
    const cy = Math.round(mark!.rect.y + mark!.rect.h / 2);
    const at = (cy * info.width + cx) * info.channels;
    expect([...data.subarray(at, at + 3)]).toEqual([255, 0, 0]);
    expect(snap!.structure!.contentHeight).toBeCloseTo(3000 * scale, 0);
  }, 30_000);

  it('records a meta-viewport page’s viewport capture unscaled', async () => {
    const platform = createUrlPlatform([{ id: 'w', url: `${base}/wide-meta` }]);
    const snap = await withPage(async (page) =>
      captureStory(
        page,
        await story(platform, { device: 'iphone-15' }),
        { platform, baseUrl: base },
        viewport,
      ),
    );
    const { info } = await sharp(snap!.image).toBuffer({ resolveWithObject: true });
    expect([info.width, info.height]).toEqual([393, 852]);
    // At scale 1 the marker (left 490) is past the 393px viewport, so it is
    // not recorded; scaled, it would be at x 196.
    const ids = snap!.structure!.elements.map((e) => e.id);
    expect(ids).not.toContain('mark');
    expect(snap!.structure!.contentHeight).toBe(3000);
  }, 30_000);
});
