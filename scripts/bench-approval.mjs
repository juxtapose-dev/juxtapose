// Replay a real run without Chrome. Each trial gets a fresh cache/project.
// node scripts/bench-approval.mjs RUN_DIR OLD_CORE_DIST [REPETITIONS]
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
const [run, oldDist, repeats = '3'] = process.argv.slice(2);
const current = await import('../packages/core/dist/index.js');
const old = await import(pathToFileURL(path.resolve(oldDist, 'index.js')));
const images = path.join(run, 'images');
const names = (await readdir(images)).filter((n) => n.endsWith('-current.webp')).sort();
const meta = {
  commit: 'benchmark',
  approvedBy: 'benchmark',
  approvedAt: '2026-10-16T00:00:00Z',
};
let audit;
for (let trial = 0; trial < Number(repeats); trial++) {
  for (const [label, core] of [
    ['before', old],
    ['after', current],
  ]) {
    const root = await mkdtemp(path.join(tmpdir(), 'jux-approval-bench-'));
    const store = new core.CacheBaselineStore({ projectRoot: root });
    const begin = performance.now();
    const apply = async (scoped) => {
      for (const name of names) {
        const file = path.join(images, name);
        await core.approveCapture(
          scoped,
          name.slice(0, -13),
          await readFile(file),
          meta,
          file,
        );
      }
    };
    if (label === 'after') await core.batchApprovals(store, apply);
    else await apply(store);
    const ms = performance.now() - begin;
    const bytes = await readFile(path.join(root, 'juxtapose.manifest.json'));
    console.log(
      JSON.stringify({
        trial,
        label,
        stories: names.length,
        ms,
        manifestBytes: bytes.length,
      }),
    );
    if (label === 'before') audit = bytes;
    else if (!bytes.equals(audit)) throw new Error('manifest parity failed');
    await rm(root, { recursive: true, force: true });
  }
}
const manifest = JSON.parse(audit);
const totals = {};
let individualGzip = 0;
for (const entry of Object.values(manifest.baselines)) {
  if (!entry.structure) continue;
  individualGzip += gzipSync(JSON.stringify(entry.structure)).length;
  for (const el of entry.structure.elements)
    for (const [key, value] of Object.entries(el))
      totals[key] =
        (totals[key] ?? 0) + Buffer.byteLength(JSON.stringify({ [key]: value }));
}
const stripped = structuredClone(manifest);
for (const entry of Object.values(stripped.baselines)) delete entry.structure;
console.log(
  JSON.stringify({
    audit: {
      formatted: audit.length,
      compact: Buffer.byteLength(JSON.stringify(manifest)),
      gzip: gzipSync(audit).length,
      manifestWithoutStructures: Buffer.byteLength(JSON.stringify(stripped)),
      individualStructureGzip: individualGzip,
      elementFieldBytes: totals,
    },
  }),
);
