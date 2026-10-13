import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { encodeStructure } from '../capture/structure.js';
import type { BaselineStore, StructureSnapshot } from '../types.js';
import { approveCapture, readRunStructure } from './approve.js';
import { GitBaselineStore } from './git-store.js';

const meta = { commit: 'abc', approvedBy: 't', approvedAt: '2026-10-12T00:00:00Z' };
const structure: StructureSnapshot = {
  schema: 'juxtapose.structure/v1',
  viewport: { width: 10, height: 10 },
  structureHash: 'f'.repeat(64),
  contentHeight: 10,
  elements: [],
};

async function runImage(sidecar?: Buffer) {
  const dir = await mkdtemp(path.join(tmpdir(), 'jux-run-'));
  const image = path.join(dir, 'a-current.webp');
  await writeFile(image, 'img');
  if (sidecar) await writeFile(path.join(dir, 'a-current.structure.json.gz'), sidecar);
  return image;
}

test('readRunStructure: no sidecar is null', async () => {
  expect(await readRunStructure(await runImage())).toBeNull();
});

test('readRunStructure: a corrupt sidecar is null, not a throw', async () => {
  expect(await readRunStructure(await runImage(Buffer.from('not gzip')))).toBeNull();
});

test('readRunStructure: a valid sidecar returns its bytes and hash', async () => {
  const gz = encodeStructure(structure);
  expect(await readRunStructure(await runImage(gz))).toEqual({
    gz,
    structureHash: structure.structureHash,
  });
});

test('approveCapture writes the hash and the sidecar', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'jux-store-'));
  const store = new GitBaselineStore({ projectRoot: root });
  const gz = encodeStructure(structure);
  const image = await runImage(gz);
  expect(await approveCapture(store, 'a', Buffer.from('img'), meta, image)).toEqual({});
  expect(await store.getStructure('a')).toEqual(gz);
  const manifest = JSON.parse(
    await readFile(path.join(root, 'juxtapose.manifest.json'), 'utf8'),
  );
  expect(manifest.baselines.a.structureHash).toBe(structure.structureHash);
});

function memoryStore(putStructure?: BaselineStore['putStructure']) {
  const puts: { storyId: string; structureHash?: string }[] = [];
  const store = {
    get: async () => null,
    put: async (storyId: string, _img: Buffer, m: { structureHash?: string }) => {
      puts.push({ storyId, structureHash: m.structureHash });
    },
    remove: async () => {},
    readManifest: async () => ({ version: 1, baselines: {} }),
    ...(putStructure ? { putStructure } : {}),
  } as unknown as BaselineStore;
  return { store, puts };
}

test('a store without putStructure gets no structureHash', async () => {
  const { store, puts } = memoryStore();
  const image = await runImage(encodeStructure(structure));
  await approveCapture(store, 'a', Buffer.from('img'), meta, image);
  expect(puts).toEqual([{ storyId: 'a', structureHash: undefined }]);
});

test('a putStructure failure is reported, not thrown: the image is approved', async () => {
  const { store, puts } = memoryStore(async () => {
    throw new Error('disk full');
  });
  const image = await runImage(encodeStructure(structure));
  await expect(
    approveCapture(store, 'a', Buffer.from('img'), meta, image),
  ).resolves.toEqual({ structureError: 'disk full' });
  expect(puts).toHaveLength(1);
});
