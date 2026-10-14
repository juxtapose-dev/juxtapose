import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { expect, test } from 'vitest';
import { GitBaselineStore, encodeStoryId } from './git-store.js';

const meta = { commit: 'abc', approvedBy: 't', approvedAt: '2026-10-12T00:00:00Z' };

test('structure sidecar is written beside the image and read back', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'jux-store-'));
  const store = new GitBaselineStore({ projectRoot: root });
  await store.put('Components/Button--primary', Buffer.from('img'), {
    ...meta,
    structureHash: 'h1',
  });
  // Approval hands over readable JSON; this layout's `.json.gz` file holds it
  // compressed.
  await store.putStructure('Components/Button--primary', Buffer.from('{"a":1}'));
  expect(
    gunzipSync((await store.getStructure('Components/Button--primary'))!).toString(),
  ).toBe('{"a":1}');
  const manifest = JSON.parse(
    await readFile(path.join(root, 'juxtapose.manifest.json'), 'utf8'),
  );
  expect(manifest.baselines['Components/Button--primary'].structureHash).toBe('h1');
});

test('a missing sidecar reads as null', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'jux-store-'));
  const store = new GitBaselineStore({ projectRoot: root });
  expect(await store.getStructure('nope')).toBeNull();
});

test('remove deletes the sidecar too', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'jux-store-'));
  const store = new GitBaselineStore({ projectRoot: root });
  await store.put('a', Buffer.from('img'), meta);
  await store.putStructure('a', Buffer.from('gz'));
  await store.remove('a');
  expect(await store.getStructure('a')).toBeNull();
});

test('putting an image without a sidecar drops the previous sidecar', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'jux-store-'));
  const store = new GitBaselineStore({ projectRoot: root });
  await store.put('a', Buffer.from('img1'), meta);
  await store.putStructure('a', Buffer.from('gz'));
  await store.put('a', Buffer.from('img2'), meta);
  expect(await store.getStructure('a')).toBeNull();
});

test('locate names the baseline image path, present or not', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'jux-store-'));
  const store = new GitBaselineStore({ projectRoot: root });
  const where = store.locate('Components/Button--primary');
  expect(where).toBe(
    path.join(
      root,
      '.juxtapose/baselines',
      `${encodeStoryId('Components/Button--primary')}.webp`,
    ),
  );
  await store.put('Components/Button--primary', Buffer.from('img'), meta);
  expect(await readFile(where)).toEqual(Buffer.from('img'));
  const custom = new GitBaselineStore({ projectRoot: root, dir: 'shots' });
  expect(custom.locate('x')).toBe(path.join(root, 'shots', 'x.webp'));
});

test('a manifest whose baselines is null or an array reads as empty', async () => {
  for (const baselines of [null, []]) {
    const root = await mkdtemp(path.join(tmpdir(), 'jux-store-'));
    await writeFile(
      path.join(root, 'juxtapose.manifest.json'),
      JSON.stringify({ version: 1, baselines }),
    );
    const store = new GitBaselineStore({ projectRoot: root });
    expect(await store.readManifest()).toEqual({ version: 1, baselines: {} });
  }
});
