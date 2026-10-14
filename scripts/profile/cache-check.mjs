#!/usr/bin/env node
// Does Chrome reuse its HTTP cache across story navigations in jux's setup?
// Counts the requests the static server actually receives per story while one
// page captures N stories in a row (one browser context, as a pool worker has).
// A cached script bundle shows as a request that never arrives after story 1.
//
// Usage: node scripts/profile/cache-check.mjs <buildDir> [count=8]
//
// Also reports, per story, the CDP view: requests the page made and how many
// were served from the memory/disk cache (Network.responseReceived fromDiskCache,
// Network.requestServedFromCache).

import http from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const hits = [];
const origCreate = http.createServer;
http.createServer = function (...a) {
  const listener = a.at(-1);
  a[a.length - 1] = (req, res) => {
    hits.push({
      url: req.url,
      inm: req.headers['if-none-match'],
      cc: req.headers['cache-control'],
    });
    return listener(req, res);
  };
  return origCreate.apply(this, a);
};
syncBuiltinESMExports();

const root = path.resolve(import.meta.dirname, '../..');
const dist = (p) => pathToFileURL(path.join(root, p)).href;
const { Browser, resolveOrAdoptChrome } = await import(
  dist('packages/core/dist/browser/index.js')
);
const { captureStory } = await import(dist('packages/core/dist/capture/capture.js'));
const { serveStatic } = await import(dist('packages/cli/dist/serve-static.js'));
const { StorybookPlatform } = await import(
  dist('packages/adapter-storybook/dist/index.js')
);

const [buildArg, countArg = '8'] = process.argv.slice(2);
const buildDir = path.resolve(buildArg);
const platform = new StorybookPlatform();
const all = await platform.enumerate({ buildDir, projectRoot: process.cwd() });
const n = Math.min(Number(countArg), all.length);
const sample = Array.from({ length: n }, (_, i) => all[Math.floor((i * all.length) / n)]);
const server = await serveStatic(buildDir);
const chrome = await resolveOrAdoptChrome({}).catch(() => undefined);
const browser = await Browser.launch({
  executablePath: chrome?.path ?? chrome ?? process.env.JUX_CHROME,
});
const viewport = { width: 800, height: 600 };
const context = await browser.newContext({ viewport });
const page = await context.newPage();

// CDP-side cache accounting for the page's session.
const stat = { requests: 0, fromCache: 0, fromDisk: 0, bytes: 0 };
page.on?.('Network.requestWillBeSent', () => stat.requests++);
page.on?.('Network.requestServedFromCache', () => stat.fromCache++);
page.on?.('Network.responseReceived', (p) => {
  if (p.response?.fromDiskCache) stat.fromDisk++;
});
page.on?.('Network.loadingFinished', (p) => (stat.bytes += p.encodedDataLength ?? 0));

console.log(
  'story'.padEnd(44),
  'server hits',
  'bytes(MB)',
  'cdp requests',
  'servedFromCache',
  'fromDiskCache',
);
for (const story of sample) {
  hits.length = 0;
  Object.assign(stat, { requests: 0, fromCache: 0, fromDisk: 0, bytes: 0 });
  await captureStory(page, story, { platform, baseUrl: server.url }, viewport);
  const js = hits.filter((h) => /\.js(\?|$)/.test(h.url ?? '')).length;
  console.log(
    story.storyId.slice(0, 43).padEnd(44),
    String(hits.length).padStart(11),
    (stat.bytes / 1e6).toFixed(2).padStart(9),
    String(stat.requests).padStart(12),
    String(stat.fromCache).padStart(15),
    String(stat.fromDisk).padStart(13),
    `(js hits ${js}, conditional ${hits.filter((h) => h.inm).length})`,
  );
}
await browser.close();
await server.close();
