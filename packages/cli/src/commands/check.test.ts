// `check` decides whether a previous run still blocks. The bug this guards:
// it used to test that a manifest entry *existed*, but `resolveStatus` only
// reports 'changed' when one already does — so every real regression had an
// entry and every real regression was cleared.

import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { encodeStoryId, hashImage } from '@juxtapose/core';
import { afterEach, expect, test } from 'vitest';
import { checkCommand } from './check.js';

const STORY = 'components-button--primary';
const dirs: string[] = [];

afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

/** A project with one failing story whose captured bytes are `captured`, and a
 *  manifest entry recording `approved`. Equal bytes mean the approval landed. */
async function project(captured: Buffer, approved: Buffer) {
  const root = await mkdtemp(path.join(tmpdir(), 'jux-check-'));
  dirs.push(root);

  // `check` never captures, but resolveContext still detects a platform, and
  // detection reads index.json. A stub is enough.
  await mkdir(path.join(root, 'storybook-static'), { recursive: true });
  await writeFile(
    path.join(root, 'storybook-static/index.json'),
    JSON.stringify({ v: 5, entries: {} }),
  );

  const runDir = path.join(root, '.juxtapose/runs/r1');
  await mkdir(path.join(runDir, 'images'), { recursive: true });
  await writeFile(
    path.join(runDir, 'report.json'),
    JSON.stringify({
      runId: 'r1',
      results: [{ storyId: STORY, status: 'fail', mismatchPercent: 12.3 }],
    }),
  );
  await writeFile(
    path.join(runDir, 'images', `${encodeStoryId(STORY)}-current.webp`),
    captured,
  );

  await writeFile(
    path.join(root, 'juxtapose.manifest.json'),
    JSON.stringify({
      version: 1,
      baselines: {
        [STORY]: {
          hash: hashImage(approved),
          commit: 'abc1234',
          approvedBy: 'someone',
          approvedAt: '2026-07-28T00:00:00.000Z',
        },
      },
    }),
  );
  return root;
}

test('a regression blocks even though the manifest has an entry', async () => {
  const root = await project(Buffer.from('new pixels'), Buffer.from('old pixels'));
  expect(await checkCommand({ project: root, json: true })).toBe(1);
});

test('an approval that landed since the run clears it', async () => {
  const same = Buffer.from('identical pixels');
  const root = await project(same, same);
  expect(await checkCommand({ project: root, json: true })).toBe(0);
});

test('a missing capture blocks rather than clearing', async () => {
  const root = await project(Buffer.from('x'), Buffer.from('x'));
  await rm(path.join(root, '.juxtapose/runs/r1/images'), { recursive: true });
  expect(await checkCommand({ project: root, json: true })).toBe(1);
});

test('a passing fresh retry stays visible to JSON and text consumers', async () => {
  const { captureIo } = await import('../io.js');
  const same = Buffer.from('identical pixels');
  const root = await project(same, same);
  const rendererRetry = {
    outcome: 'resolved',
    initialRenderer: { shared: true, clearResourceCache: false },
    initialHash: 'history',
    freshHash: hashImage(same),
  };
  await writeFile(
    path.join(root, '.juxtapose/runs/r1/report.json'),
    JSON.stringify({
      runId: 'r1',
      results: [{ storyId: STORY, status: 'pass', rendererRetry }],
    }),
  );
  const io = captureIo();
  expect(await checkCommand({ project: root, json: true }, { io })).toBe(0);
  expect(JSON.parse(io.stdout()).rendererRetries).toEqual([
    { storyId: STORY, status: 'pass', ...rendererRetry },
  ]);
  const text = captureIo();
  await checkCommand({ project: root }, { io: text });
  expect(text.stdout()).toContain('1 stories passed only after a fresh retry.');
  expect(text.stdout()).toContain('"shared": false');
});

test('a visual-equivalence pass retains its policy and distinct hashes in check output', async () => {
  const { captureIo } = await import('../io.js');
  const current = Buffer.from('current');
  const approved = Buffer.from('approved');
  const root = await project(current, approved);
  const comparison = {
    method: 'pixelmatch',
    version: '6.0.0',
    threshold: 0.05,
    includeAA: false,
    baselineHash: hashImage(approved),
    rawMismatchPixels: 100,
  };
  await writeFile(
    path.join(root, '.juxtapose/runs/r1/report.json'),
    JSON.stringify({
      runId: 'r1',
      results: [{ storyId: STORY, status: 'pass', hash: hashImage(current), comparison }],
    }),
  );
  const io = captureIo();
  expect(await checkCommand({ project: root, json: true }, { io })).toBe(0);
  expect(JSON.parse(io.stdout()).visualEquivalence).toEqual([
    { storyId: STORY, hash: hashImage(current), ...comparison },
  ]);
  const text = captureIo();
  await checkCommand({ project: root }, { io: text });
  expect(text.stdout()).toContain('passed by visual equivalence, not exact hash');
});
