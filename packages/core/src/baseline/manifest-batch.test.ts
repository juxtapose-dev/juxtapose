import * as fs from 'node:fs/promises';
import { writeManifestFile } from './manifest-file.js';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { CacheBaselineStore } from './cache-store.js';
import { GitBaselineStore } from './git-store.js';
import { approveCapture } from './approve.js';
import { batchApprovals } from './manifest-batch.js';

vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof import('node:fs/promises')>()),
}));

const meta = { commit: 'abc', approvedBy: 'test', approvedAt: '2026-10-16' };
for (const Store of [CacheBaselineStore, GitBaselineStore]) {
  test(`${Store.name}: one commit, unchanged entries, callback rollback`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'jux-batch-'));
    try {
      const store = new Store({ projectRoot: root });
      await store.put('existing', Buffer.from('old'), meta);
      const before = await readFile(path.join(root, 'juxtapose.manifest.json'), 'utf8');
      const writes = vi.spyOn(Store.prototype, 'writeManifest');
      const reads = vi.spyOn(Store.prototype, 'readManifest');
      await batchApprovals(store, async (scoped) => {
        for (const id of ['a', 'b', 'c']) await scoped.put(id, Buffer.from(id), meta);
        expect(await readFile(path.join(root, 'juxtapose.manifest.json'), 'utf8')).toBe(
          before,
        );
      });
      expect(writes).toHaveBeenCalledTimes(1);
      expect(reads).toHaveBeenCalledTimes(1);
      reads.mockRestore();
      writes.mockRestore();
      const committed = await store.readManifest();
      expect(Object.keys(committed.baselines)).toEqual(['a', 'b', 'c', 'existing']);
      expect(committed.baselines.existing).toEqual(JSON.parse(before).baselines.existing);
      await expect(
        batchApprovals(store, async (scoped) => {
          await scoped.put('never-committed', Buffer.from('new'), meta);
          throw new Error('stop');
        }),
      ).rejects.toThrow('stop');
      expect(await store.readManifest()).toEqual(committed);
    } finally {
      vi.restoreAllMocks();
      await rm(root, { recursive: true, force: true });
    }
  });
}

test('commit failure rejects the batch; custom store fallback remains usable', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'jux-batch-'));
  try {
    const store = new CacheBaselineStore({ projectRoot: root });
    const failure = vi
      .spyOn(CacheBaselineStore.prototype, 'writeManifest')
      .mockRejectedValue(new Error('disk full'));
    await expect(
      batchApprovals(store, async (scoped) => {
        await scoped.put('a', Buffer.from('a'), meta);
      }),
    ).rejects.toThrow('disk full');
    failure.mockRestore();
    expect((await store.readManifest()).baselines).toEqual({});
    store.batch = undefined as never;
    await batchApprovals(store, async (scoped) => {
      await scoped.put('a', Buffer.from('a'), meta);
    });
    expect((await store.readManifest()).baselines.a).toBeDefined();
  } finally {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  }
});

test('batch preserves structure and drops stale structure when the next sidecar is corrupt', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'jux-batch-'));
  try {
    const store = new CacheBaselineStore({ projectRoot: root });
    const file = path.join(root, 'a.webp');
    const structure = {
      schema: 'juxtapose.structure/v1',
      structureHash: 'f'.repeat(64),
      viewport: { width: 10, height: 10 },
      contentHeight: 10,
      elements: [],
    };
    await writeFile(path.join(root, 'a.structure.json.gz'), JSON.stringify(structure));
    await batchApprovals(store, async (scoped) => {
      await approveCapture(scoped, 'a', Buffer.from('a'), meta, file);
    });
    expect((await store.readManifest()).baselines.a.structureHash).toBe(
      structure.structureHash,
    );
    expect(await store.getStructure('a')).not.toBeNull();
    await writeFile(path.join(root, 'a.structure.json.gz'), 'corrupt');
    await batchApprovals(store, async (scoped) => {
      await approveCapture(scoped, 'a', Buffer.from('b'), meta, file);
    });
    expect((await store.readManifest()).baselines.a.structure).toBeUndefined();
    expect((await store.readManifest()).baselines.a.structureHash).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a failed manifest write preserves the old file and removes its temporary', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'jux-atomic-'));
  const file = path.join(root, 'juxtapose.manifest.json');
  try {
    await writeFile(file, 'previous contents');
    const realWrite = fs.writeFile;
    const failure = vi.spyOn(fs, 'writeFile').mockImplementation(async (...args) => {
      await realWrite(...args);
      throw new Error('interrupted write');
    });
    await expect(writeManifestFile(file, { version: 1, baselines: {} })).rejects.toThrow(
      'interrupted write',
    );
    failure.mockRestore();
    expect(await readFile(file, 'utf8')).toBe('previous contents');
    expect(await fs.readdir(root)).toEqual(['juxtapose.manifest.json']);
  } finally {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  }
});
