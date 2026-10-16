// node scripts/audit-compact-structures.mjs RUN_DIRECTORY
import { readdir, readFile, mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deepStrictEqual } from 'node:assert';
import {
  decodeStructure,
  CacheBaselineStore,
  batchApprovals,
  approveCapture,
} from '../packages/core/dist/index.js';
import {
  compactStructure,
  expandStructure,
  formatCompactStructure,
} from '../packages/core/dist/baseline/structure-file.js';
const run = process.argv[2];
const images = path.join(run, 'images');
const names = (await readdir(images))
  .filter((n) => n.endsWith('-current.structure.json.gz'))
  .sort();
let original = 0,
  compact = 0,
  elements = 0;
for (const name of names) {
  const snapshot = decodeStructure(await readFile(path.join(images, name)));
  deepStrictEqual(expandStructure(compactStructure(snapshot)), snapshot);
  original += Buffer.byteLength(JSON.stringify(snapshot));
  compact += formatCompactStructure(snapshot).length;
  elements += snapshot.elements.length;
}
const root = await mkdtemp(path.join(tmpdir(), 'jux-compact-audit-'));
const store = new CacheBaselineStore({ projectRoot: root });
const before = performance.now();
await batchApprovals(store, async (scoped) => {
  for (const name of names) {
    const id = name.slice(0, -26);
    const image = path.join(images, name.replace('.structure.json.gz', '.webp'));
    await approveCapture(
      scoped,
      id,
      await readFile(image),
      {
        commit: 'benchmark',
        approvedBy: 'benchmark',
        approvedAt: '2026-10-16T00:00:00Z',
      },
      image,
    );
  }
});
const ms = performance.now() - before;
let fileBytes = 0;
for (const name of await readdir(path.join(root, 'juxtapose.structures')))
  fileBytes += (await stat(path.join(root, 'juxtapose.structures', name))).size;
const manifestBytes = (await stat(path.join(root, 'juxtapose.manifest.json'))).size;
// Verify the store reader too, including file checksums and manifest references.
for (const name of names) {
  const id = name.slice(0, -26);
  deepStrictEqual(
    decodeStructure(await store.getStructure(id)),
    decodeStructure(await readFile(path.join(images, name))),
  );
}
console.log(
  JSON.stringify({
    root,
    stories: names.length,
    elements,
    originalCompactJsonBytes: original,
    readableCompactStructureBytes: compact,
    manifestBytes,
    structureDirectoryBytes: fileBytes,
    totalBytes: manifestBytes + fileBytes,
    approvalMs: ms,
  }),
);
