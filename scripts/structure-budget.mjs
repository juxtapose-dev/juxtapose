// Report the cost of structure capture on an example: sidecar size, element
// count, and per-story capture overhead (structure on vs off). Targets from the
// spec — median sidecar < 20 KB gz, overhead < 30 ms — are reported, not
// enforced: a miss goes in the PR, it does not fail CI.
// Usage: node scripts/structure-budget.mjs <exampleDir>
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const example = path.resolve(process.argv[2]);
const cli = path.join(root, 'packages/cli/dist/index.js');
const { decodeStructure } = await import(path.join(root, 'packages/core/dist/index.js'));

const runOnce = (env) => {
  let out;
  try {
    out = execFileSync('node', [cli, 'run', '--all', '--json', '--concurrency', '1'], {
      cwd: example,
      env: { ...process.env, ...env },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (e) {
    out = e.stdout;
  }
  const report = JSON.parse(out.trim().split('\n').at(-1));
  return { report, dir: path.join(example, '.juxtapose/runs', report.runId, 'images') };
};
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

const off = runOnce({ JUXTAPOSE_NO_STRUCTURE: '1' });
const on = runOnce({});
const ms = (r) => new Map(r.report.results.map((x) => [x.storyId, x.durationMs]));
const offMs = ms(off),
  onMs = ms(on);
const overhead = [...onMs].map(([id, t]) => t - (offMs.get(id) ?? t));

const files = readdirSync(on.dir).filter((f) => f.endsWith('.structure.json.gz'));
const sizes = files.map((f) => statSync(path.join(on.dir, f)).size);
const counts = files.map(
  (f) => decodeStructure(readFileSync(path.join(on.dir, f))).elements.length,
);

console.log(`stories: ${files.length}`);
console.log(
  `sidecar gz bytes  median ${median(sizes)}  max ${Math.max(...sizes)}  (target median < 20480)`,
);
console.log(`elements          median ${median(counts)}  max ${Math.max(...counts)}`);
console.log(
  `overhead ms       median ${median(overhead)}  max ${Math.max(...overhead)}  (target median < 30)`,
);
