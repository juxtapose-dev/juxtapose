import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { encodeStoryId, hashImage } from '@juxtapose/core';
import { diffCommand } from './diff.js';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'jux-runs-'));
});
afterEach(() => rm(root, { recursive: true, force: true }));

async function writeRun(
  runId: string,
  results: Array<{ storyId: string; status?: string; hash?: string; image?: string }>,
) {
  const dir = path.join(root, '.juxtapose', 'runs', runId);
  await mkdir(path.join(dir, 'images'), { recursive: true });
  for (const r of results)
    if (r.image)
      await writeFile(
        path.join(dir, 'images', `${encodeStoryId(r.storyId)}-current.webp`),
        r.image,
      );
  await writeFile(
    path.join(dir, 'report.json'),
    JSON.stringify({
      runId,
      results: results.map(({ storyId, status, hash }) => ({
        storyId,
        status: status ?? 'pass',
        ...(hash ? { hash } : {}),
      })),
    }),
  );
}

async function diffRuns(a: string, b: string, json = true) {
  let out = '';
  let err = '';
  const code = await diffCommand(a, b, { runs: true, json, project: root }, {
    io: { out: (s) => void (out += s), err: (s) => void (err += s) },
  } as never);
  return { code, out, err };
}

test('identical runs exit 0 and count every story', async () => {
  await writeRun('r1', [
    { storyId: 'a--x', hash: 'h1' },
    { storyId: 'b--y', hash: 'h2' },
  ]);
  await writeRun('r2', [
    { storyId: 'b--y', hash: 'h2' },
    { storyId: 'a--x', hash: 'h1' },
  ]);
  const { code, out } = await diffRuns('r1', 'r2');
  expect(code).toBe(0);
  const j = JSON.parse(out);
  expect(j.schema).toBe('juxtapose.run-diff/v1');
  expect(j.summary).toEqual({ identical: 2, different: 0, missing: 0 });
});

test('differing hashes exit 1 and name the story ids', async () => {
  await writeRun('r1', [
    { storyId: 'a--x', hash: 'h1' },
    { storyId: 'b--y', hash: 'h2' },
  ]);
  await writeRun('r2', [
    { storyId: 'a--x', hash: 'h1' },
    { storyId: 'b--y', hash: 'CHANGED' },
  ]);
  const json = await diffRuns('r1', 'r2');
  expect(json.code).toBe(1);
  expect(JSON.parse(json.out).different).toEqual(['b--y']);
  const text = await diffRuns('r1', 'r2', false);
  expect(text.code).toBe(1);
  expect(text.out).toContain('1 identical, 1 different');
  expect(text.out).toContain('b--y');
});

test('a story in only one run is reported as missing and exits 1', async () => {
  await writeRun('r1', [
    { storyId: 'a--x', hash: 'h1' },
    { storyId: 'only-a', hash: 'h3' },
  ]);
  await writeRun('r2', [
    { storyId: 'a--x', hash: 'h1' },
    { storyId: 'only-b', hash: 'h4' },
  ]);
  const { code, out } = await diffRuns('r1', 'r2');
  expect(code).toBe(1);
  expect(JSON.parse(out).missing).toEqual([
    { storyId: 'only-a', in: 'a' },
    { storyId: 'only-b', in: 'b' },
  ]);
});

test('reports without hashes fall back to hashing the run images', async () => {
  await writeRun('r1', [{ storyId: 'a--x', image: 'bytes' }]);
  await writeRun('r2', [{ storyId: 'a--x', image: 'bytes' }]);
  expect((await diffRuns('r1', 'r2')).code).toBe(0);
  await writeRun('r3', [{ storyId: 'a--x', image: 'other' }]);
  expect((await diffRuns('r1', 'r3')).code).toBe(1);
  expect(hashImage(Buffer.from('bytes'))).not.toBe(hashImage(Buffer.from('other')));
});

test('an unknown run is a usage error, a run directory path also works', async () => {
  await writeRun('r1', [{ storyId: 'a', hash: 'h' }]);
  expect((await diffRuns('r1', 'nope')).code).toBe(2);
  const dir = path.join(root, '.juxtapose', 'runs', 'r1');
  expect((await diffRuns(dir, 'r1')).code).toBe(0);
});
