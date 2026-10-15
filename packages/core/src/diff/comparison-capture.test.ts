import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { Browser } from '../browser/browser.js';
import { chromeForTests } from '../browser/__tests__/helpers.js';
import { createUrlPlatform } from '../platforms/urls.js';
import { captureStory } from '../capture/capture.js';
import { diffImages } from './diff.js';
import { runCapture } from '../run/run.js';
import { confirmCaptures } from '../run/confirm.js';
import { hashImage } from '../baseline/status.js';
import type { BaselineStore } from '../types.js';

const chrome = chromeForTests();
let browser: Browser;
let server: Server;
let base: string;
let reference: Buffer;
const viewport = { width: 320, height: 160 };
function markup(change: string) {
  return `<!doctype html><style>
    body {margin:16px;background:white;color:#222;font:16px Arial,sans-serif}
    .box {border:1px solid ${change === 'border' ? 'white' : '#222'};width:180px;padding:12px;${change === 'shift' ? 'transform:translateX(1px);' : ''}}
    .text {font-weight:${change === 'weight' ? '700' : '400'};color:${change === 'color' ? '#333' : change === 'subtle' ? '#232323' : '#222'}}
    .icon {display:inline-block;width:8px;height:8px;background:#222;${change === 'icon' ? 'visibility:hidden;' : ''}}
  </style><div class="box"><span class="text">Balance $${change === 'digit' ? '101' : '100'}</span> <span class="icon"></span></div>`;
}
async function capture(change: string) {
  const platform = createUrlPlatform([{ id: change, url: `${base}/${change}` }]);
  const [story] = await platform.enumerate({ projectRoot: process.cwd() });
  const context = await browser.newContext({ viewport });
  try {
    const page = await context.newPage();
    return (await captureStory(page, story!, { platform, baseUrl: base }, viewport))!
      .image;
  } finally {
    await context.close();
  }
}
beforeAll(async () => {
  server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(markup(req.url!.slice(1)));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  if (chrome) {
    browser = await Browser.launch({ executablePath: chrome.path });
    reference = await capture('base');
  }
}, 30_000);
afterAll(async () => {
  await browser?.close();
  server.close();
});
describe.skipIf(!chrome)('Pixelmatch policy against real browser mutations', () => {
  it.each(['digit', 'icon', 'border', 'shift', 'weight', 'color'])(
    'detects %s at threshold 0.05',
    async (change) => {
      const current = await capture(change);
      const diff = await diffImages(reference, current, { threshold: 0.05 });
      expect(diff.mismatchPixels).toBeGreaterThan(0);
    },
  );
  it('runs a real tolerant comparison while approval still requires the exact reviewed hash', async () => {
    const platform = createUrlPlatform([{ id: 'subtle', url: `${base}/subtle` }]);
    const stories = await platform.enumerate({ projectRoot: process.cwd() });
    const hash = hashImage(reference);
    const store = {
      readManifest: async () => ({
        version: 1,
        baselines: { subtle: { hash, commit: 'c', approvedBy: 'test', approvedAt: 't' } },
      }),
      get: async () => reference,
    } as unknown as BaselineStore;
    const options = {
      browser,
      platform,
      baseUrl: base,
      stories,
      store,
      totalCount: 1,
      runId: 'r',
      branch: 'b',
      commitSha: 'c',
      config: {
        concurrency: 1,
        viewport,
        renderer: { shared: false },
        comparison: { mode: 'pixelmatch' as const },
      },
      recheck: 'off' as const,
    };
    const report = await runCapture(options);
    expect(report.results[0]!.status).toBe('pass');
    expect(report.results[0]!.hash).not.toBe(hash);
    expect(report.results[0]!.comparison?.baselineHash).toBe(hash);
    // A one-level text color change is intentionally inside this opt-in
    // tolerance. It must still fail exact mode and exact approval confirmation.
    const exact = await runCapture({
      ...options,
      config: { ...options.config, comparison: { mode: 'exact' } },
    });
    expect(exact.results[0]!.status).toBe('fail');
    const confirmation = await confirmCaptures({
      ...options,
      hashes: new Map([['subtle', hash]]),
    });
    expect(confirmation[0]!.unstable).toBeDefined();
  });
  it('accepts a repeated unchanged capture', async () => {
    expect(
      (await diffImages(reference, await capture('base'), { threshold: 0.05 }))
        .mismatchPixels,
    ).toBe(0);
  });
});
