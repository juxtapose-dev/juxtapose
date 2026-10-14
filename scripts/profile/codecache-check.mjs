#!/usr/bin/env node
// Would Chrome's V8 code cache help if captures ran in the browser's default
// context instead of a Target.createBrowserContext one?
//
// jux gives each pool worker its own browser context. Those are off-the-record
// (in-memory HTTP cache, no persisted code cache, as far as Chrome documents).
// The default context has the profile's disk cache and the "Code Cache" that
// skips parse/compile of a script seen before. This captures the same N
// stories on one page per mode, ABAB-interleaved over ROUNDS rounds, and
// compares the mean navigate+render time of every story after the 3rd, and
// the WebP hashes between modes (they must agree for the idea to be usable).
//
// Usage: node scripts/profile/codecache-check.mjs <buildDir> [count=12] [rounds=2]

import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '../..');
const dist = (p) => pathToFileURL(path.join(root, p)).href;
const { Browser, BrowserContext, resolveOrAdoptChrome } = await import(
  dist('packages/core/dist/browser/index.js')
);
const { captureStory } = await import(dist('packages/core/dist/capture/capture.js'));
const { serveStatic } = await import(dist('packages/cli/dist/serve-static.js'));
const { StorybookPlatform } = await import(
  dist('packages/adapter-storybook/dist/index.js')
);

const [buildArg, countArg = '12', roundsArg = '2'] = process.argv.slice(2);
const buildDir = path.resolve(buildArg);
const platform = new StorybookPlatform();
const all = await platform.enumerate({ buildDir, projectRoot: process.cwd() });
const n = Math.min(Number(countArg), all.length);
const sample = Array.from({ length: n }, (_, i) => all[Math.floor((i * all.length) / n)]);
const server = await serveStatic(buildDir);
const chrome = await resolveOrAdoptChrome({}).catch(() => undefined);
const executablePath = chrome?.path ?? chrome ?? process.env.JUX_CHROME;
const viewport = { width: 800, height: 600 };
const sha = (b) => createHash('sha256').update(b).digest('hex').slice(0, 10);

async function run(mode) {
  // A fresh browser per run, so the default context's cache starts empty.
  const browser = await Browser.launch({ executablePath });
  const context =
    mode === 'default'
      ? new BrowserContext(browser.connection, undefined, { viewport }, process.platform)
      : await browser.newContext({ viewport });
  const page = await context.newPage();
  const rows = [];
  for (const story of sample) {
    const s = await captureStory(
      page,
      story,
      { platform, baseUrl: server.url },
      viewport,
    );
    rows.push({ id: story.storyId, t: s.timings, hash: sha(s.image), ms: s.durationMs });
  }
  await browser.close();
  return rows;
}

const results = { incognito: [], default: [] };
for (let r = 0; r < Number(roundsArg); r++)
  for (const mode of r % 2 ? ['default', 'incognito'] : ['incognito', 'default'])
    results[mode].push(await run(mode));
await server.close();

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
for (const mode of ['incognito', 'default']) {
  const warm = results[mode].flatMap((rows) => rows.slice(3));
  console.log(
    `${mode.padEnd(10)} stories>3: navigate ${mean(warm.map((x) => x.t.navigate)).toFixed(0)} ms, render ${mean(warm.map((x) => x.t.render)).toFixed(0)} ms, total ${mean(warm.map((x) => x.ms)).toFixed(0)} ms (n=${warm.length})`,
  );
}
const a = results.incognito[0];
const b = results.default[0];
console.log(
  `hashes identical between modes: ${a.filter((x, i) => x.hash === b[i].hash).length}/${a.length}`,
);
