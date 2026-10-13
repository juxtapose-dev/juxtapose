// The mutation corpus, end to end through the CLI: snap the base page, snap
// each mutated page (one browser launch for all of them), diff every one
// against the base, and assert the classification and delta each operator
// must produce. Also the tier-0 size budget: every verdict <= 1,500 chars,
// distribution printed. Seed for the row-4 benchmark.
// Run after `pnpm build`: node scripts/structural-corpus.mjs
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { OPERATORS, checkVerdict } from './structural-corpus/page.mjs';
import { startCorpusServer } from './structural-corpus/server.mjs';

const exec = promisify(execFile);
const cli = path.resolve(import.meta.dirname, '../packages/cli/dist/index.js');
// The CLI's own slug function, so this script cannot drift from how `jux
// snap` names files.
const { prefixSlugs } = await import(
  path.resolve(import.meta.dirname, '../packages/cli/dist/snap-name.js')
);
const project = mkdtempSync(path.join(tmpdir(), 'jux-corpus-'));
const server = await startCorpusServer();
const BUDGET = 1500;
let failed = 0;
const check = (ok, msg) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`);
  if (!ok) failed++;
};
const jux = async (args) => {
  try {
    return (
      await exec('node', [cli, ...args, '--project', project, '--json'], {
        encoding: 'utf8',
      })
    ).stdout;
  } catch (e) {
    return e.stdout ?? '';
  }
};

try {
  const urls = OPERATORS.map((o) => `${server.url}/op/${o.name}`);
  const slugs = prefixSlugs(urls);

  // Every variant in one launch: `base` is the noop page under its own name.
  await jux(['snap', `${server.url}/op/noop`, '--as', 'base']);
  await jux(['snap', ...urls, '--as-prefix', 'op']);

  const lengths = [];
  for (const [i, op] of OPERATORS.entries()) {
    const baseline = op.against
      ? `op-${slugs.get(`${server.url}/op/${op.against}`)}`
      : 'base';
    const out = await jux(['diff', baseline, `op-${slugs.get(urls[i])}`]);
    let v;
    try {
      v = JSON.parse(out);
    } catch {
      check(false, `${op.name.padEnd(15)} no JSON verdict: ${out.slice(0, 120)}`);
      continue;
    }
    const problems = checkVerdict(op, v);
    const len = out.trim().length;
    lengths.push(len);
    if (len > BUDGET) problems.push(`${len} chars > ${BUDGET}`);
    check(
      problems.length === 0,
      `${op.name.padEnd(15)} ${String(v.classification).padEnd(16)} ${String(len).padStart(5)} chars ${problems.join('; ')}`,
    );
  }

  const sorted = lengths.sort((a, b) => a - b);
  console.log(
    `tier-0 JSON chars: min ${sorted[0]}  median ${sorted[Math.floor(sorted.length / 2)]}  max ${sorted.at(-1)}  (budget ${BUDGET}; ~${Math.round(sorted.at(-1) / 4)} tokens max)`,
  );
  console.log(
    failed
      ? `FAIL ${failed} of ${OPERATORS.length} operators`
      : `ok   ${OPERATORS.length} of ${OPERATORS.length} operators`,
  );
} finally {
  server.close();
  rmSync(project, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
