#!/usr/bin/env node
// Guard the invariant the whole design rests on: capture the same unchanged
// stories N times and assert every story hashes identically every time.
//
// This deserves to be a first-class check rather than a unit test because the
// failure mode is a race, and a race that reproduces once in five runs will
// pass a single-shot test all day. Unit tests cover the pure functions; this
// covers the thing that actually breaks.
//
// Exit 0 if every story is byte-stable across every run, 1 otherwise, with the
// unstable stories named and their distinct hashes printed.
//
// Usage: node scripts/check-determinism.mjs <exampleDir> [runs]

import { execFile } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import path from 'node:path';

// execFile, not exec: arguments are passed as an array with no shell in the
// middle, so nothing here can be shell-injected via a path.
const run = promisify(execFile);

const exampleDir = path.resolve(process.argv[2] ?? 'examples/storybook');
const runs = Number(process.argv[3] ?? 3);
const cli = path.resolve('packages/cli/dist/index.js');

if (!existsSync(cli)) {
  fail(`built CLI not found at ${cli} — run \`pnpm build\` first`);
}

/** storyId -> Set of distinct image hashes seen across runs */
const seen = new Map();

for (let i = 1; i <= runs; i++) {
  // Each iteration is a fresh capture of unchanged input. Any difference
  // between iterations is by definition nondeterminism in the tool.
  await run('node', [cli, 'run', '--all'], { cwd: exampleDir }).catch((err) => {
    // A non-zero exit is expected whenever stories are new or failing; the
    // report is what we care about, not the status code.
    if (!err.stdout && !err.stderr) throw err;
  });

  const runDir = await latestRun(exampleDir);
  if (!runDir) fail('no run directory produced');

  for (const [storyId, hash] of await hashRun(runDir)) {
    if (!seen.has(storyId)) seen.set(storyId, new Set());
    seen.get(storyId).add(hash);
  }

  process.stderr.write(`  run ${i}/${runs} captured ${seen.size} stories\n`);
}

const unstable = [...seen.entries()].filter(([, hashes]) => hashes.size > 1);

if (unstable.length === 0) {
  process.stdout.write(
    `\ndeterminism: OK — ${seen.size} stories byte-identical across ${runs} runs\n`,
  );
  process.exit(0);
}

process.stdout.write(
  `\ndeterminism: FAILED — ${unstable.length}/${seen.size} stories varied across ${runs} runs\n\n`,
);
for (const [storyId, hashes] of unstable) {
  process.stdout.write(`  ${storyId}\n`);
  for (const h of hashes) process.stdout.write(`    ${h}\n`);
}
process.stdout.write(
  `\nPass/fail is a byte-exact hash, so a story that captures differently on\n` +
    `identical input is a permanently failing build. See CLAUDE.md for the\n` +
    `settle-pipeline invariants this usually indicates.\n`,
);
process.exit(1);

/** Hash every captured image in a run directory. */
async function hashRun(runDir) {
  const imagesDir = path.join(runDir, 'images');
  const out = new Map();
  for (const file of await readdir(imagesDir)) {
    if (!file.endsWith('-current.webp')) continue;
    const storyId = file.replace(/-current\.webp$/, '');
    const bytes = await readFile(path.join(imagesDir, file));
    out.set(storyId, createHash('sha256').update(bytes).digest('hex').slice(0, 16));
  }
  return out;
}

async function latestRun(dir) {
  const runsRoot = path.join(dir, '.juxtapose', 'runs');
  if (!existsSync(runsRoot)) return null;
  const entries = await readdir(runsRoot);
  let newest = null;
  for (const e of entries) {
    const candidate = path.join(runsRoot, e);
    if (!existsSync(path.join(candidate, 'report.json'))) continue;
    if (!newest || e > path.basename(newest)) newest = candidate;
  }
  return newest;
}

function fail(msg) {
  process.stderr.write(`check-determinism: ${msg}\n`);
  process.exit(1);
}
