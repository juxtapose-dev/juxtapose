#!/usr/bin/env node
// Bounded Chrome tracing diagnostic; does not change production capture or baselines.
import { writeFileSync, mkdtempSync } from 'node:fs';
import { Browser } from '../packages/core/dist/browser/browser.js';
import { launchChrome } from '../packages/core/dist/browser/launch.js';
import { resolveChrome } from '../packages/core/dist/browser/resolve.js';
import { captureStory } from '../packages/core/dist/capture/capture.js';
import { StorybookPlatform } from '../packages/adapter-storybook/dist/index.js';
import { serveStatic } from '../packages/cli/dist/serve-static.js';
process.env.JUX_STATE_DIR = mkdtempSync('/tmp/jux-trace-state-');
const buildDir = process.argv[2] ?? 'examples/storybook/storybook-profile';
const storyId = process.argv[3] ?? 'profile--nested-large';
const count = Number(process.argv[4] ?? 5);
if (!Number.isInteger(count) || count < 1 || count > 20)
  throw new Error('Use 1..20 screenshot repetitions');
const out = mkdtempSync('/tmp/jux-screenshot-trace-');
const timings = [];
console.log(out);
const platform = new StorybookPlatform();
const story = (await platform.enumerate({ buildDir, projectRoot: process.cwd() })).find(
  (s) => s.storyId === storyId,
);
if (!story) throw new Error(`Story not found: ${storyId}`);
const server = await serveStatic(buildDir);
let launched, browser;
try {
  launched = await launchChrome({ executablePath: resolveChrome().path });
  const cdp = launched.connection;
  const { product } = await cdp.send('Browser.getVersion');
  browser = Browser.fromConnection(cdp, { version: product, close: launched.close });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  await captureStory(
    page,
    story,
    { platform, baseUrl: server.url, structure: false, renderer: { shared: true } },
    { width: 1280, height: 800 },
  );
  const before = await page.screenshot({ format: 'webp' });
  await cdp.send('Tracing.start', {
    transferMode: 'ReturnAsStream',
    categories:
      'toplevel,devtools,devtools.timeline,blink,viz,cc,gpu,benchmark,latency,disabled-by-default-devtools.timeline',
  });
  for (let i = 0; i < count; i++) {
    await page.evaluate(`console.timeStamp('screenshot-start-${i}')`);
    const start = performance.now();
    const shot = await page.screenshot({ format: 'webp' });
    timings.push(performance.now() - start);
    await page.evaluate(`console.timeStamp('screenshot-end-${i}')`);
    if (!before.equals(shot)) throw new Error('Pixels changed during trace');
  }
  const complete = cdp.once('Tracing.tracingComplete');
  await cdp.send('Tracing.end');
  const { stream } = await complete;
  let trace = '';
  for (;;) {
    const chunk = await cdp.send('IO.read', { handle: stream });
    trace += chunk.base64Encoded
      ? Buffer.from(chunk.data, 'base64').toString()
      : chunk.data;
    if (chunk.eof) break;
  }
  await cdp.send('IO.close', { handle: stream });
  writeFileSync(out + '/trace.json', trace);
  const encodingMs = JSON.parse(trace)
    .traceEvents.filter(
      (event) => event.name === 'EncodeBitmapAsWebp' && event.ph === 'X',
    )
    .map((event) => event.dur / 1000);
  if (encodingMs.length !== count) throw new Error('Incomplete WebP encoding trace');
  const pixelsStable = before.equals(await page.screenshot({ format: 'webp' }));
  writeFileSync(
    out + '/metadata.json',
    JSON.stringify(
      {
        storyId,
        count,
        product,
        node: process.version,
        buildDir,
        timings,
        encodingMs,
        pixelsStable,
        note: 'Traced diagnostic round trips, not end-to-end capture timings. Trace events nest: do not sum inclusive spans.',
      },
      null,
      2,
    ),
  );
  if (!pixelsStable) throw new Error('Pixels changed during trace');
  console.log(JSON.stringify({ out, timings, pixelsStable }));
} finally {
  try {
    if (browser) await browser.close();
    else await launched?.close();
  } finally {
    await server.close();
  }
}
