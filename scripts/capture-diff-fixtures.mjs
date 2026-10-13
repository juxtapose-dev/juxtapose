// Generates packages/core/src/diff/__fixtures__/structural-corpus.json from
// real Chromium: every corpus operator captured through the real settle
// pipeline, each diffed against `noop` with the real pixel diff.
// Run after `pnpm build`: node scripts/capture-diff-fixtures.mjs
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as prettier from 'prettier';
import { OPERATORS } from './structural-corpus/page.mjs';
import { startCorpusServer } from './structural-corpus/server.mjs';

const root = path.resolve(import.meta.dirname, '..');
const dist = (p) => import(path.join(root, 'packages/core/dist', p));
const { captureStory } = await dist('capture/capture.js');
const { acquireBrowser } = await dist('index.js');
const { createUrlPlatform } = await dist('platforms/urls.js');
const { diffImages } = await dist('diff/diff.js');

const viewport = { width: 640, height: 480 };
const server = await startCorpusServer();
let browser;
try {
  browser = await acquireBrowser();
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();

  const capture = async (name) => {
    const url = `${server.url}/op/${name}`;
    const platform = createUrlPlatform([{ id: name, url }]);
    const [story] = await platform.enumerate({ projectRoot: root });
    const snap = await captureStory(page, story, { platform, baseUrl: url }, viewport);
    if (!snap?.structure) throw new Error(`no structure for ${name}`);
    return snap;
  };
  // The base is captured first, and `noop` is then captured again as an
  // ordinary operator: the fixture's `noop` case is the second capture diffed
  // against the first, so a non-zero noop is a real determinism failure in the
  // pipeline, not a diff of a buffer against itself.
  const base = await capture('noop');
  const captured = {};
  for (const op of OPERATORS) captured[op.name] = await capture(op.name);

  const cases = {};
  for (const op of OPERATORS) {
    // The first `noop` capture is the base for everything that does not name
    // its own baseline; `nested-reorder` is diffed against `nested`.
    const against = op.against ? captured[op.against] : base;
    const { mismatchPixels, mismatchPercent, changedRegions, dimensionMismatch } =
      await diffImages(against.image, captured[op.name].image);
    cases[op.name] = {
      against: op.against ?? 'noop',
      structure: captured[op.name].structure,
      // Byte equality, the pass/fail authority — not "0 mismatch pixels":
      // `background` changes the bytes while pixelmatch marks nothing.
      imagesIdentical: against.image.equals(captured[op.name].image),
      pixels: { mismatchPixels, mismatchPercent, changedRegions, dimensionMismatch },
    };
  }
  const out = path.join(
    root,
    'packages/core/src/diff/__fixtures__/structural-corpus.json',
  );
  // Formatted with the repo's prettier so the committed bytes ARE the output
  // and `prettier --check` passes without a second step.
  await writeFile(
    out,
    await prettier.format(JSON.stringify({ viewport, cases }), {
      parser: 'json',
      filepath: out,
    }),
  );
  console.log(`wrote ${out}: ${Object.keys(cases).length} cases`);
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  await browser?.close();
  server.close();
}
