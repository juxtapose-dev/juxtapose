import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { Browser } from '../browser/browser.js';
import { chromeForTests } from '../browser/__tests__/helpers.js';
import { createUrlPlatform } from '../platforms/urls.js';
import { runCapture } from '../run/run.js';
import { confirmCaptures } from '../run/confirm.js';
import type { BaselineStore, RunArtifact } from '../types.js';
import { captureStory, HttpCaptureError } from './capture.js';

const chrome = chromeForTests();
let server: Server;
let browser: Browser;
let base: string;
let requests: string[] = [];
let failureStatus = 429;
beforeAll(async () => {
  server = createServer((req, res) => {
    requests.push(req.url!);
    const status = req.url === '/bad' ? failureStatus : 200;
    res.writeHead(status, { 'content-type': 'text/html', 'Retry-After': '30' });
    res.end(
      `<h1>${status}</h1>${req.url === '/child' ? '' : '<iframe src="/child"></iframe>'}`,
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

// Real navigation events: child-frame responses must not erase a failed
// top-level status, and a following successful navigation must reset it.
describe.skipIf(!chrome)('HTTP capture failures', () => {
  it.each([404, 429, 503])(
    'rejects HTTP %i and can capture a subsequent valid page',
    async (status) => {
      failureStatus = status;
      const platform = createUrlPlatform([
        { id: 'bad', url: `${base}/bad` },
        { id: 'ok', url: `${base}/ok` },
      ]);
      const stories = await platform.enumerate({ projectRoot: process.cwd() });
      const context = await browser.newContext({ viewport: { width: 320, height: 240 } });
      try {
        const page = await context.newPage();
        const err = await captureStory(
          page,
          stories[0]!,
          { platform, baseUrl: base },
          { width: 320, height: 240 },
        ).catch((e) => e);
        expect(err).toBeInstanceOf(HttpCaptureError);
        expect(err.status).toBe(status);
        expect(err.message).toContain('Retry-After: 30');
        expect(err.image?.length).toBeGreaterThan(0);
        expect(
          (
            await captureStory(
              page,
              stories[1]!,
              { platform, baseUrl: base },
              { width: 320, height: 240 },
            )
          )?.image.length,
        ).toBeGreaterThan(0);
      } finally {
        await context.close();
      }
    },
  );
  it.each([429, 503])(
    'keeps evidence, stops requests, and cannot approve HTTP %i',
    async (status) => {
      failureStatus = status;
      const platform = createUrlPlatform([
        { id: 'bad', url: `${base}/bad` },
        { id: 'next', url: `${base}/next` },
      ]);
      const stories = await platform.enumerate({ projectRoot: process.cwd() });
      const store = {
        readManifest: async () => ({ version: 1, baselines: {} }),
        get: async () => null,
      } as unknown as BaselineStore;
      const artifacts: RunArtifact[] = [];
      const options = {
        browser,
        platform,
        baseUrl: base,
        stories,
        store,
        totalCount: 2,
        config: { concurrency: 1, viewport: { width: 320, height: 240 } },
        runId: 'http',
        branch: 'test',
        commitSha: 'test',
        onArtifact: async (a: RunArtifact) => {
          artifacts.push(a);
        },
      };
      requests = [];
      const report = await runCapture(options);
      expect(report.results).toHaveLength(2);
      for (const result of report.results) {
        expect(result.status).toBe('fail');
        expect(result.error).toContain(`HTTP ${status}`);
        expect(result.hash).toBeUndefined();
        expect(result.rendererRetry).toBeUndefined();
      }
      expect(requests.filter((p) => p === '/bad')).toHaveLength(1);
      expect(requests).not.toContain('/next');
      expect(artifacts).toHaveLength(1);
      expect(artifacts[0]!.current.length).toBeGreaterThan(0);
      const confirmation = await confirmCaptures({
        ...options,
        stories: [stories[0]!],
        hashes: new Map([['bad', 'previous-reviewed-hash']]),
      });
      expect(confirmation[0]!.unstable?.unconfirmed).toContain(`HTTP ${status}`);
    },
  );
});
