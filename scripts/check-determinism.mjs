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
// Usage: node scripts/check-determinism.mjs [--daemon] <exampleDir> [runs]
//
// Without --daemon every run is a fresh launch (JUX_NO_DAEMON=1): that is the
// cold path CI takes, and a local check leaves no warm browser idling. With
// --daemon (run it as `env -u CI pnpm check:determinism --daemon`; any CI
// variable turns the daemon off) it first captures once with a fresh launch
// as the reference, starts the warm browser with `jux browser start`, then
// captures every run through it. It fails unless every story hashes the same
// warm as fresh, and unless every run's browser really was the warm one: with
// JUX_DEBUG each warm connect prints "using the warm browser" and each
// fallback to a private launch prints why, so a run that silently stopped
// using the daemon cannot pass as a warm run.

import { execFile } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import path from 'node:path';

// execFile, not exec: arguments are passed as an array with no shell in the
// middle, so nothing here can be shell-injected via a path.
const run = promisify(execFile);

const argv = process.argv.slice(2);
const daemon = argv.includes('--daemon');
const positional = argv.filter((a) => a !== '--daemon' && a !== '--');
const exampleDir = path.resolve(positional[0] ?? 'examples/storybook');
const runs = Number(positional[1] ?? 3);
const freshEnv = { ...process.env, JUX_NO_DAEMON: '1' };
const warmEnv = { ...process.env, JUX_DEBUG: '1' };
const env = daemon ? warmEnv : freshEnv;
const cli = path.resolve('packages/cli/dist/index.js');

if (!existsSync(cli)) {
  fail(`built CLI not found at ${cli} — run \`pnpm build\` first`);
}

/** storyId -> Set of distinct image hashes seen across runs */
const seen = new Map();
/** storyId -> hash from the fresh-launch reference run (--daemon only) */
let fresh = null;

if (daemon) {
  fresh = await captureRun(freshEnv);
  process.stderr.write(`  fresh reference captured ${fresh.size} stories\n`);
  const started = await run('node', [cli, 'browser', 'start', '--json'], {
    cwd: exampleDir,
    env: warmEnv,
  }).catch((err) => err);
  const out = parseJson(started.stdout);
  if (!out?.ok || !out.daemon?.running)
    fail(
      `the warm browser did not start: ${out?.error ?? started.stderr ?? started.message}`,
    );
}

for (let i = 1; i <= runs; i++) {
  // Each iteration is a fresh capture of unchanged input. Any difference
  // between iterations is by definition nondeterminism in the tool.
  const hashes = await captureRun(env, (stderr) => {
    if (!daemon) return;
    // Any fallback means this run was not (entirely) a warm run; zero warm
    // connects means the daemon path never ran at all (a CI variable left
    // set turns it off without a word).
    const fallback = stderr
      .split('\n')
      .find((l) => /warm browser unavailable|using a private browser/.test(l));
    if (fallback) fail(`run ${i} fell back to a private browser: ${fallback}`);
    if (!stderr.includes('jux: using the warm browser'))
      fail(`run ${i} never connected to the warm browser`);
  });
  for (const [storyId, hash] of hashes) {
    if (!seen.has(storyId)) seen.set(storyId, new Set());
    seen.get(storyId).add(hash);
  }

  process.stderr.write(`  run ${i}/${runs} captured ${seen.size} stories\n`);
}

const unstable = [...seen.entries()].filter(([, hashes]) => hashes.size > 1);
// Warm runs that agree with each other prove nothing if they all disagree
// with a fresh launch the same way: the daemon must be byte-identical to it.
const drifted = fresh
  ? [...seen.entries()].filter(
      ([id, hashes]) => !hashes.has(fresh.get(id)) || hashes.size > 1,
    )
  : [];
const missing = fresh ? [...fresh.keys()].filter((id) => !seen.has(id)) : [];

if (unstable.length === 0 && drifted.length === 0 && missing.length === 0) {
  process.stdout.write(
    `\ndeterminism: OK — ${seen.size} stories byte-identical across ${runs} runs${
      fresh ? ', warm browser identical to a fresh launch' : ''
    }\n`,
  );
  process.exit(0);
}

if (missing.length > 0)
  process.stdout.write(
    `\ndeterminism: FAILED — ${missing.length} stories captured fresh but not warm: ${missing.join(', ')}\n`,
  );
const bad = fresh ? drifted : unstable;
if (bad.length > 0)
  process.stdout.write(
    fresh
      ? `\ndeterminism: FAILED — ${bad.length}/${seen.size} stories differ warm vs fresh (or across ${runs} warm runs)\n\n`
      : `\ndeterminism: FAILED — ${unstable.length}/${seen.size} stories varied across ${runs} runs\n\n`,
  );
for (const [storyId, hashes] of bad) {
  process.stdout.write(`  ${storyId}\n`);
  if (fresh) process.stdout.write(`    ${fresh.get(storyId) ?? '(none)'} fresh\n`);
  for (const h of hashes) process.stdout.write(`    ${h}${fresh ? ' warm' : ''}\n`);
}
process.stdout.write(
  `\nPass/fail is a byte-exact hash, so a story that captures differently on\n` +
    `identical input is a permanently failing build. See CLAUDE.md for the\n` +
    `settle-pipeline invariants this usually indicates.\n`,
);
process.exit(1);

/** One `jux run --all` with `runEnv`; returns storyId -> hash of the new run. */
async function captureRun(runEnv, checkStderr = () => {}) {
  const before = await latestRun(exampleDir);
  const res = await run('node', [cli, 'run', '--all'], {
    cwd: exampleDir,
    env: runEnv,
    maxBuffer: 64 * 1024 * 1024,
  }).catch((err) => {
    // A non-zero exit is expected whenever stories are new or failing; the
    // report is what we care about, not the status code.
    if (!err.stdout && !err.stderr) throw err;
    return err;
  });
  checkStderr(String(res.stderr ?? ''));
  const runDir = await latestRun(exampleDir);
  if (!runDir || runDir === before) fail('no run directory produced');
  return hashRun(runDir);
}

function parseJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

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
