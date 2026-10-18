import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
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
    expect(snap?.emulation).toMatch(/^pixel-8\|portrait\|m1t1\|ua:/);
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
});
