#!/usr/bin/env node
// Do two builds of jux hash a Storybook sample identically?
//
// Usage: node scripts/profile/hash-compare.mjs <buildDir> <otherCli.js> [stories=200]
//
// Runs this checkout's CLI and <otherCli.js> (e.g. origin/main's) over the same
// evenly-strided sample, each with its own state dir, and compares the sha256
// per story. Prints the counts and any differing ids; exit 1 on a difference.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../..');
const [buildArg, otherCli, nArg = '200'] = process.argv.slice(2);
if (!buildArg || !otherCli) {
  console.error('usage: hash-compare.mjs <buildDir> <otherCli.js> [stories]');
  process.exit(2);
}
const buildDir = path.resolve(buildArg);
const index = JSON.parse(readFileSync(path.join(buildDir, 'index.json'), 'utf8'));
const ids = Object.values(index.entries)
  .filter((e) => e.type !== 'docs')
  .map((e) => e.id)
  .sort();
const n = Math.min(Number(nArg), ids.length);
const sample = Array.from({ length: n }, (_, i) => ids[Math.floor((i * ids.length) / n)]);

function hashes(cli) {
  const project = mkdtempSync(path.join(os.tmpdir(), 'jux-hc-project-'));
  const state = mkdtempSync(path.join(os.tmpdir(), 'jux-hc-state-'));
  writeFileSync(
    path.join(project, 'juxtapose.config.json'),
    JSON.stringify({ platform: 'storybook', buildDir }),
  );
  const res = spawnSync(
    'node',
    [
      cli,
      'run',
      ...sample.flatMap((id) => ['--story', id]),
      '--no-recheck',
      '--json',
      '--no-daemon',
      '--concurrency',
      '3',
      '--project',
      project,
    ],
    {
      env: { ...process.env, JUX_STATE_DIR: state },
      encoding: 'utf8',
      maxBuffer: 1 << 29,
    },
  );
  try {
    const { runId } = JSON.parse(res.stdout);
    const report = JSON.parse(
      readFileSync(path.join(project, '.juxtapose/runs', runId, 'report.json'), 'utf8'),
    );
    return Object.fromEntries(
      report.results.map((r) => [r.storyId, r.hash ?? `error:${r.error}`]),
    );
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  }
}

const mine = hashes(path.join(root, 'packages/cli/dist/index.js'));
const other = hashes(path.resolve(otherCli));
const differ = sample.filter((id) => mine[id] !== other[id]);
console.log(
  `${sample.length - differ.length}/${sample.length} story hashes identical between this build and ${otherCli}`,
);
for (const id of differ) console.log(`DIFF ${id} ${mine[id]} ${other[id]}`);
process.exit(differ.length ? 1 : 0);
