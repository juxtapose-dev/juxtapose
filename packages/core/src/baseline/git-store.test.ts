import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { GitBaselineStore } from './git-store.js';

const meta = { commit: 'abc', approvedBy: 't', approvedAt: '2026-10-12T00:00:00Z' };

test('structure sidecar is written beside the image and read back', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'jux-store-'));
  const store = new GitBaselineStore({ projectRoot: root });
  await store.put('Components/Button--primary', Buffer.from('img'), {
    ...meta,
    structureHash: 'h1',
  });
  await store.putStructure('Components/Button--primary', Buffer.from('gz'));
  expect(await store.getStructure('Components/Button--primary')).toEqual(
    Buffer.from('gz'),
  );
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
