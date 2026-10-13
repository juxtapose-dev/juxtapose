// Copies examples/storybook's Vite manifest into the cause fixture. A real
// Storybook build bundles components into chunks with no `src`, which a
// hand-written manifest never shows; the cause test must see the real shape.
// Run after `pnpm --filter example-storybook build`:
//   node scripts/capture-cause-manifest.mjs
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as prettier from 'prettier';

const root = path.resolve(import.meta.dirname, '..');
const src = path.join(root, 'examples/storybook/storybook-static/.vite/manifest.json');
const out = path.join(
  root,
  'packages/core/src/analysis/__fixtures__/storybook-manifest.json',
);
const manifest = JSON.parse(await readFile(src, 'utf8'));
// Formatted with the repo's prettier so the committed bytes ARE the output.
await writeFile(
  out,
  await prettier.format(JSON.stringify(manifest), { parser: 'json', filepath: out }),
);
const entries = Object.values(manifest);
console.log(
  `wrote ${out}: ${entries.length} entries, ${entries.filter((e) => !e.src).length} without src`,
);
