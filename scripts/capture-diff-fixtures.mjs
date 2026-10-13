// Generates packages/core/src/diff/__fixtures__/structural-corpus.json from
// real Chromium: every corpus operator captured through the real settle
// pipeline, each diffed against `noop` with the real pixel diff.
// Run after `pnpm build`: node scripts/capture-diff-fixtures.mjs
import { createRequire } from 'node:module';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { OPERATORS } from './structural-corpus/page.mjs';
import { startCorpusServer } from './structural-corpus/server.mjs';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(path.join(root, 'packages/core/package.json'));
const { chromium } = require('playwright');
const dist = (p) => import(path.join(root, 'packages/core/dist', p));
const { captureStory } = await dist('capture/capture.js');
const { deterministicLaunchOptions } = await dist('capture/launch.js');
const { createUrlPlatform } = await dist('platforms/urls.js');
const { diffImages } = await dist('diff/diff.js');

const viewport = { width: 640, height: 480 };
const server = await startCorpusServer();
const browser = await chromium.launch(deterministicLaunchOptions());
const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
const page = await context.newPage();

const capture = async (name) => {
  const url = `${server.url}/op/${name}`;
  const platform = createUrlPlatform([{ id: name, url }]);
  const [story] = await platform.enumerate({ projectRoot: root });
  const snap = await captureStory(page, story, { platform, baseUrl: url }, viewport);
  if (!snap?.structure) throw new Error(`no structure for ${name}`);
  return snap;
};
// The base is captured FIRST and again LAST: the fixture's `noop` case is the
// second capture diffed against the first, so a non-zero noop is a real
// determinism failure in the pipeline, not a diff of a buffer against itself.
const base = await capture('noop');
const captured = {};
for (const op of OPERATORS) captured[op.name] = await capture(op.name);
await browser.close();
server.close();

const cases = {};
for (const op of OPERATORS) {
  const { mismatchPixels, mismatchPercent, changedRegions, dimensionMismatch } =
    await diffImages(base.image, captured[op.name].image);
  cases[op.name] = {
    structure: captured[op.name].structure,
    pixels: { mismatchPixels, mismatchPercent, changedRegions, dimensionMismatch },
  };
}
const out = path.join(root, 'packages/core/src/diff/__fixtures__/structural-corpus.json');
await writeFile(out, JSON.stringify({ viewport, cases }) + '\n');
console.log(`wrote ${out}: ${Object.keys(cases).length} cases`);
