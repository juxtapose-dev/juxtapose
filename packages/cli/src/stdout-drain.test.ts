// Regression test for #135: `jux <command> --json` lost everything past the
// first 64 KiB when stdout was a pipe, because index.ts called process.exit()
// while the pipe still held unread bytes. Pipes are asynchronous on macOS, so
// the reader has to be slower than the writer for this to show.

import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, test } from 'vitest';

const CLI = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const dirs: string[] = [];

afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

/** A project whose last run has many failing stories, so `check --json`
 *  prints far more than one pipe buffer. */
async function bigProject(stories: number): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'jux-drain-'));
  dirs.push(root);
  await mkdir(path.join(root, 'storybook-static'), { recursive: true });
  await writeFile(
    path.join(root, 'storybook-static/index.json'),
    JSON.stringify({ v: 5, entries: {} }),
  );
  const runDir = path.join(root, '.juxtapose/runs/r1');
  await mkdir(runDir, { recursive: true });
  const results = Array.from({ length: stories }, (_, i) => ({
    storyId: `components-section-${String(i).padStart(5, '0')}--${'x'.repeat(60)}`,
    status: 'fail',
    mismatchPercent: 1,
  }));
  await writeFile(
    path.join(runDir, 'report.json'),
    JSON.stringify({ runId: 'r1', results }),
  );
  await writeFile(
    path.join(root, 'juxtapose.manifest.json'),
    JSON.stringify({ version: 1, baselines: {} }),
  );
  return root;
}

test('--json output larger than the pipe buffer arrives whole through a slow reader', async () => {
  const root = await bigProject(3000);
  const child = spawn(process.execPath, [CLI, 'check', '--json', '--project', root], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.resume();

  // Do not read at all until the child has had time to fill the pipe and exit.
  await new Promise((r) => setTimeout(r, 1500));
  const chunks: Buffer[] = [];
  for await (const c of child.stdout) {
    chunks.push(c as Buffer);
    await new Promise((r) => setTimeout(r, 5));
  }
  const out = Buffer.concat(chunks).toString('utf8');

  expect(out.length).toBeGreaterThan(65_536);
  const parsed = JSON.parse(out) as { blocking: unknown[] };
  expect(parsed.blocking).toHaveLength(3000);
}, 30_000);
