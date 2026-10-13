// Capture an example N times and assert every story's structureHash is
// identical across runs. The structure counterpart of check-determinism.mjs:
// an unstable sidecar would make the structural diff report phantom changes.
// Also fails if a captured story has no sidecar: a silently absent structure
// must not pass.
// Usage: node scripts/check-structure-determinism.mjs <exampleDir> <runs>
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const [dir, n = '3'] = process.argv.slice(2);
const example = path.resolve(dir);
const cli = path.join(root, 'packages/cli/dist/index.js');
const { decodeStructure, encodeStoryId } = await import(
  path.join(root, 'packages/core/dist/index.js')
);

const seen = new Map(); // storyId -> Set(hash)
const missing = new Set();
for (let i = 0; i < Number(n); i++) {
  let out;
  try {
    out = execFileSync('node', [cli, 'run', '--all', '--json'], {
      cwd: example,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (e) {
    // exit 1 is expected when nothing is approved; the report is still on stdout
    out = e.stdout;
  }
  const report = JSON.parse(String(out).trim().split('\n').at(-1));
  const images = path.join(example, '.juxtapose/runs', report.runId, 'images');
  for (const r of report.results) {
    // stale stories were not captured; skipped ones are not captured by design
    if (r.status === 'skip' || r.status === 'stale') continue;
    const file = path.join(
      images,
      `${encodeStoryId(r.storyId)}-current.structure.json.gz`,
    );
    if (!existsSync(file)) {
      missing.add(r.storyId);
      continue;
    }
    const hash = decodeStructure(readFileSync(file)).structureHash;
    if (!seen.has(r.storyId)) seen.set(r.storyId, new Set());
    seen.get(r.storyId).add(hash);
  }
}
const unstable = [...seen].filter(([, s]) => s.size > 1).map(([id]) => id);
if (missing.size) {
  console.error(`FAIL — ${missing.size} captured stories have no structure sidecar:`);
  for (const id of missing) console.error(`  ${id}`);
}
if (seen.size === 0) {
  console.error('FAIL — no structure sidecars found');
}
if (unstable.length) {
  console.error(
    `FAIL — ${unstable.length}/${seen.size} stories unstable:\n  ${unstable.join('\n  ')}`,
  );
}
if (missing.size || seen.size === 0 || unstable.length) process.exit(1);
console.log(`OK — ${seen.size} structure snapshots identical across ${n} runs`);
