import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  decodeStructure,
  encodeStructure,
  formatStructure,
} from '../capture/structure.js';
import type { BaselineStore, StructureSnapshot } from '../types.js';
import { approveCapture, readRunStructure } from './approve.js';
import { GitBaselineStore } from './git-store.js';

const meta = { commit: 'abc', approvedBy: 't', approvedAt: '2026-10-12T00:00:00Z' };
const structure: StructureSnapshot = {
  schema: 'juxtapose.structure/v1',
  viewport: { width: 10, height: 10 },
  structureHash: 'f'.repeat(64),
  contentHeight: 10,
  elements: [
    {
      path: 'html>body',
      parent: null,
      tag: 'body',
      rect: { x: 0, y: 0, w: 10, h: 10 },
      paintOrder: 0,
      styles: {},
    },
    {
      path: 'html>body>div#a',
      parent: 0,
      tag: 'div',
      id: 'a',
      rect: { x: 1, y: 1, w: 5, h: 5 },
      paintOrder: 1,
      styles: { color: 'red' },
    },
  ],
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
    stored: formatStructure(structure),
    structureHash: structure.structureHash,
  });
});

test('approveCapture writes the hash and the sidecar', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'jux-store-'));
  const store = new GitBaselineStore({ projectRoot: root });
  const gz = encodeStructure(structure);
  const image = await runImage(gz);
  expect(await approveCapture(store, 'a', Buffer.from('img'), meta, image)).toEqual({});
  expect(decodeStructure((await store.getStructure('a'))!)).toEqual(structure);
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

import { UnstableCaptureError } from './approve.js';

describe('UnstableCaptureError', () => {
  test("names the story and does not name one surface's flag only", () => {
    const msg = new UnstableCaptureError('card--x', { hashes: ['a', 'b'] }).message;
    expect(msg).toContain('card--x');
    expect(msg).toContain('--allow-unstable');
    expect(msg).toContain('allowUnstable');
  });
  test('an unconfirmed capture says the recheck failed, with the reason', () => {
    const msg = new UnstableCaptureError('s', {
      hashes: ['a'],
      unconfirmed: 'timed out',
    }).message;
    expect(msg).toMatch(/recheck/i);
    expect(msg).toContain('timed out');
  });
  test('does not suggest freshRenderer when it is already on', () => {
    const on = new UnstableCaptureError(
      's',
      { hashes: ['a', 'b'] },
      { freshRenderer: true },
    );
    expect(on.message).not.toContain('freshRenderer');
    const off = new UnstableCaptureError(
      's',
      { hashes: ['a', 'b'] },
      { freshRenderer: false },
    );
    expect(off.message).toContain('freshRenderer');
  });
});

test('the repo-backed store preserves structure evidence in readable files', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'jux-store-'));
  const store = new GitBaselineStore({ projectRoot: root });
  const image = await runImage(encodeStructure(structure));
  await approveCapture(store, 'a', Buffer.from('img'), meta, image);
  expect(JSON.parse((await store.getStructure('a'))!.toString())).toEqual(structure);
});

test('approval persists the emulation fingerprint, and omits the key without one', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'jux-emu-'));
  const store = new GitBaselineStore({ projectRoot: root });
  const image = await runImage();
  await approveCapture(
    store,
    'm',
    Buffer.from('img'),
    { ...meta, emulation: 'portrait|m1t1|ua:ab' },
    image,
  );
  await approveCapture(store, 'd', Buffer.from('img2'), meta, image);
  const { baselines } = JSON.parse(
    await readFile(path.join(root, 'juxtapose.manifest.json'), 'utf8'),
  );
  expect(baselines.m.emulation).toBe('portrait|m1t1|ua:ab');
  expect('emulation' in baselines.d).toBe(false);
});
