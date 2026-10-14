import { existsSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { beforeEach, expect, test } from 'vitest';
import { encodeStructure } from '../capture/structure.js';
import type { StructureSnapshot } from '../types.js';
import { approveCapture } from './approve.js';
import { CacheBaselineStore } from './cache-store.js';
import { hashImage } from './status.js';

const meta = { commit: 'abc', approvedBy: 't', approvedAt: '2026-10-14T00:00:00Z' };
const image = Buffer.from('webp-bytes-one');
const hash = hashImage(image);

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

let root: string;
let store: CacheBaselineStore;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'jux-cache-store-'));
  store = new CacheBaselineStore({ projectRoot: root });
});

const cacheDir = () => path.join(root, '.juxtapose', 'cache', 'baselines');

test('put stores the image under its hash and get reads it back', async () => {
  await store.put('a--b', image, meta);
  expect(existsSync(path.join(cacheDir(), `${hash}.webp`))).toBe(true);
  expect(await store.get('a--b')).toEqual(image);
  const manifest = JSON.parse(
    await readFile(path.join(root, 'juxtapose.manifest.json'), 'utf8'),
  );
  expect(manifest.baselines['a--b'].hash).toBe(hash);
});

test('put never writes an image into the old git layout', async () => {
  await store.put('a--b', image, meta);
  expect(existsSync(path.join(root, '.juxtapose', 'baselines'))).toBe(false);
});

test('two stories with identical pixels share one cache file', async () => {
  await store.put('a', image, meta);
  await store.put('b', image, meta);
  expect(await readdir(cacheDir())).toEqual([`${hash}.webp`]);
});

test('a missing image is a structured result carrying the manifest hash, not a throw', async () => {
  await store.put('a', image, meta);
  await rm(cacheDir(), { recursive: true });
  expect(await store.lookup('a')).toEqual({
    kind: 'unavailable',
    reason: 'not-in-cache',
    hash,
  });
  expect(await store.get('a')).toBeNull();
});

test('a story with no manifest entry is unavailable for a different reason', async () => {
  expect(await store.lookup('nope')).toEqual({
    kind: 'unavailable',
    reason: 'no-manifest-entry',
  });
});

test('a cache file whose bytes do not match its name is not trusted', async () => {
  await store.put('a', image, meta);
  await writeFile(path.join(cacheDir(), `${hash}.webp`), 'tampered');
  expect((await store.lookup('a')).kind).toBe('unavailable');
});

test('legacy layout: reads the old per-story image when it matches the manifest', async () => {
  await store.put('a', image, meta);
  await rm(cacheDir(), { recursive: true });
  const legacy = path.join(root, '.juxtapose', 'baselines');
  await mkdir(legacy, { recursive: true });
  await writeFile(path.join(legacy, 'a.webp'), image);
  expect(await store.get('a')).toEqual(image);
  // The read copied it into the cache, which locate prefers.
  expect(store.locate('a')).toBe(path.join(cacheDir(), `${hash}.webp`));
});

test('legacy layout: an old image that is not the approved one is ignored', async () => {
  await store.put('a', image, meta);
  await rm(cacheDir(), { recursive: true });
  const legacy = path.join(root, '.juxtapose', 'baselines');
  await mkdir(legacy, { recursive: true });
  await writeFile(path.join(legacy, 'a.webp'), 'some other revision');
  expect((await store.lookup('a')).kind).toBe('unavailable');
});

test('structure lives in the manifest entry, not in a file of its own', async () => {
  await store.put('a', image, meta);
  await store.putStructure('a', Buffer.from(JSON.stringify(structure)));
  expect(existsSync(path.join(root, 'juxtapose'))).toBe(false);
  expect(existsSync(path.join(root, '.juxtapose', 'structure'))).toBe(false);
  const entry = (await store.readManifest()).baselines['a']!;
  expect(entry.structureHash).toBe(structure.structureHash);
  expect(entry.structure?.elements).toHaveLength(2);
  expect(JSON.parse((await store.getStructure('a'))!.toString())).toEqual(structure);
});

test('structure falls back to the legacy gzip sidecar beside old images', async () => {
  const legacy = path.join(root, '.juxtapose', 'baselines');
  await mkdir(legacy, { recursive: true });
  const gz = gzipSync(Buffer.from('{}'));
  await writeFile(path.join(legacy, 'a.structure.json.gz'), gz);
  expect(await store.getStructure('a')).toEqual(gz);
  expect(await store.getStructure('missing')).toBeNull();
});

test('put drops the previous structure so it cannot outlive its pixels', async () => {
  await store.put('a', image, meta);
  await store.putStructure('a', Buffer.from(JSON.stringify(structure)));
  await store.put('a', Buffer.from('new pixels'), meta);
  expect(await store.getStructure('a')).toBeNull();
});

test('remove clears manifest and structure but leaves shared cache images', async () => {
  await store.put('a', image, meta);
  await store.put('b', image, meta);
  await store.putStructure('a', Buffer.from(JSON.stringify(structure)));
  await store.remove('a');
  expect(await store.getStructure('a')).toBeNull();
  expect((await store.readManifest()).baselines['a']).toBeUndefined();
  expect(await store.get('b')).toEqual(image);
});

test('cache dir is configurable', async () => {
  const custom = new CacheBaselineStore({ projectRoot: root, dir: 'tmp/imgs' });
  await custom.put('a', image, meta);
  expect(existsSync(path.join(root, 'tmp', 'imgs', `${hash}.webp`))).toBe(true);
});

test('approveCapture puts the structure in the manifest, one element per line', async () => {
  const runDir = await mkdtemp(path.join(tmpdir(), 'jux-run-'));
  const img = path.join(runDir, 'a-current.webp');
  await writeFile(img, 'img');
  await writeFile(
    path.join(runDir, 'a-current.structure.json.gz'),
    encodeStructure(structure),
  );
  await approveCapture(store, 'a', Buffer.from('img'), meta, img);
  const text = await readFile(path.join(root, 'juxtapose.manifest.json'), 'utf8');
  expect(JSON.parse(text).baselines.a.structure.elements).toHaveLength(2);
  // One element per line is what makes an approval's diff reviewable.
  expect(
    text.split('\n').filter((l) => l.trimStart().startsWith('{"path"')),
  ).toHaveLength(structure.elements.length);
  expect(JSON.parse(text).version).toBe(2);
});

test('keepImage caches a passing capture without touching the manifest', async () => {
  await store.keepImage(image);
  expect(existsSync(path.join(cacheDir(), `${hash}.webp`))).toBe(true);
  expect(existsSync(path.join(root, 'juxtapose.manifest.json'))).toBe(false);
  await store.keepImage(image); // idempotent
  expect(await readdir(cacheDir())).toEqual([`${hash}.webp`]);
});

test('a truncated cache entry is repaired by keepImage and by put', async () => {
  await store.put('a', image, meta);
  const file = path.join(cacheDir(), `${hash}.webp`);
  await writeFile(file, image.subarray(0, 3));
  expect((await store.lookup('a')).kind).toBe('unavailable');
  await store.keepImage(image);
  expect((await store.lookup('a')).kind).toBe('found');
  await writeFile(file, 'junk');
  await store.put('a', image, meta);
  expect((await store.lookup('a')).kind).toBe('found');
});

test('concurrent keepImage calls for one image all succeed and leave no temp files', async () => {
  await Promise.all(Array.from({ length: 12 }, () => store.keepImage(image)));
  expect(await readdir(cacheDir())).toEqual([`${hash}.webp`]);
});

test('an image found in the legacy layout is copied into the cache', async () => {
  await store.put('a', image, meta);
  await rm(cacheDir(), { recursive: true });
  const legacy = path.join(root, '.juxtapose', 'baselines');
  await mkdir(legacy, { recursive: true });
  await writeFile(path.join(legacy, 'a.webp'), image);
  await store.lookup('a');
  await rm(legacy, { recursive: true }); // the migration commit deletes it on pull
  expect(await store.get('a')).toEqual(image);
});

test('a manifest hash that is not 64 hex characters never reaches a path', async () => {
  await store.put('a', image, meta);
  const manifest = await store.readManifest();
  manifest.baselines['a']!.hash = '../../etc/passwd';
  await store.writeManifest(manifest);
  expect((await store.lookup('a')).kind).toBe('unavailable');
  expect(store.locate('a')).toBeUndefined();
});

test('temp files live outside the cache, so a CI cache save never sees debris', async () => {
  await store.keepImage(image);
  expect(await readdir(cacheDir())).toEqual([`${hash}.webp`]);
  expect(existsSync(path.join(root, '.juxtapose', 'tmp'))).toBe(true);
});

test('stale temp files from a killed process are swept, fresh ones are kept', async () => {
  const tmp = path.join(root, '.juxtapose', 'tmp');
  await mkdir(tmp, { recursive: true });
  await mkdir(cacheDir(), { recursive: true });
  const stale = path.join(tmp, 'a.tmp');
  const fresh = path.join(tmp, 'b.tmp');
  const legacyDebris = path.join(cacheDir(), `${hash}.webp.dead.tmp`);
  for (const f of [stale, fresh, legacyDebris]) await writeFile(f, 'half');
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
  await utimes(stale, old, old);
  await utimes(legacyDebris, old, old);
  await store.sweepStaleTmp();
  expect(existsSync(stale)).toBe(false);
  expect(existsSync(legacyDebris)).toBe(false);
  expect(existsSync(fresh)).toBe(true);
});

test('the first write sweeps without being asked', async () => {
  const tmp = path.join(root, '.juxtapose', 'tmp');
  await mkdir(tmp, { recursive: true });
  const stale = path.join(tmp, 'dead.tmp');
  await writeFile(stale, 'half');
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
  await utimes(stale, old, old);
  await store.keepImage(image);
  expect(existsSync(stale)).toBe(false);
});

test('rewriting unchanged stories reproduces their bytes; one approve touches only its lines', async () => {
  for (const id of ['b', 'a', 'c']) {
    await store.put(id, Buffer.from(`img-${id}`), meta);
    await store.putStructure(id, Buffer.from(JSON.stringify(structure)));
  }
  const file = path.join(root, 'juxtapose.manifest.json');
  const before = await readFile(file, 'utf8');
  // Sorted by id, whatever order they were approved in.
  expect(Object.keys(JSON.parse(before).baselines)).toEqual(['a', 'b', 'c']);
  await store.writeManifest(await store.readManifest());
  expect(await readFile(file, 'utf8')).toBe(before);

  await store.put('b', Buffer.from('img-b2'), { ...meta, commit: 'def' });
  const after = await readFile(file, 'utf8');
  const changed = after.split('\n').filter((l, i) => l !== before.split('\n')[i]);
  expect(changed.length).toBeGreaterThan(0);
  expect(after.split('\n').length).toBeLessThan(before.split('\n').length);
  // The a and c entries are byte-identical blocks.
  const block = (text: string, id: string) =>
    text.slice(text.indexOf(`"${id}": {`)).split('\n    "')[0];
  expect(block(after, 'a')).toBe(block(before, 'a'));
  expect(block(after, 'c')).toBe(block(before, 'c'));
});

test('a version 1 manifest (hashes only) still reads and gains structure on adoption', async () => {
  await writeFile(
    path.join(root, 'juxtapose.manifest.json'),
    JSON.stringify({
      version: 1,
      baselines: { a: { ...meta, hash, structureHash: structure.structureHash } },
    }),
  );
  expect((await store.readManifest()).baselines['a']!.hash).toBe(hash);
  expect(await store.adoptStructures(new Map([['a', structure]]))).toBe(1);
  expect((await store.readManifest()).baselines['a']!.structure).toBeDefined();
  expect(
    JSON.parse(await readFile(path.join(root, 'juxtapose.manifest.json'), 'utf8'))
      .version,
  ).toBe(2);
  // Already has it: nothing to do, and a different hash is never adopted.
  expect(await store.adoptStructures(new Map([['a', structure]]))).toBe(0);
});

test('adoption refuses a structure whose hash differs from the approved one', async () => {
  await store.put('a', image, { ...meta, structureHash: 'x'.repeat(64) });
  expect(await store.adoptStructures(new Map([['a', structure]]))).toBe(0);
});

test('conflict markers in the manifest are a lockfile error, not an empty manifest', async () => {
  await writeFile(
    path.join(root, 'juxtapose.manifest.json'),
    '{\n<<<<<<< HEAD\n  "version": 1,\n=======\n  "version": 1,\n>>>>>>> main\n}\n',
  );
  await expect(store.readManifest()).rejects.toThrow(/Don't hand-merge/);
  await expect(store.readManifest()).rejects.toThrow(/jux approve --story/);
});

test('a symlinked tmp dir is not swept or written through; caching is skipped with a warning', async () => {
  const outside = await mkdtemp(path.join(tmpdir(), 'jux-outside-'));
  const victim = path.join(outside, 'precious.tmp');
  await writeFile(victim, 'keep me');
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
  await utimes(victim, old, old);
  await mkdir(path.join(root, '.juxtapose'), { recursive: true });
  await symlink(outside, path.join(root, '.juxtapose', 'tmp'));

  const warnings: string[] = [];
  const guarded = new CacheBaselineStore({
    projectRoot: root,
    onWarning: (m) => warnings.push(m),
  });
  await guarded.sweepStaleTmp();
  await guarded.keepImage(image);
  await guarded.keepImage(image);

  expect(existsSync(victim)).toBe(true);
  expect(await readdir(outside)).toEqual(['precious.tmp']);
  expect(existsSync(path.join(cacheDir(), `${hash}.webp`))).toBe(false);
  expect(warnings).toHaveLength(1); // once, not per image
  expect(warnings[0]).toMatch(/\.juxtapose\/tmp.*link/);
});

test('a symlinked cache dir is refused the same way', async () => {
  const outside = await mkdtemp(path.join(tmpdir(), 'jux-outside-'));
  await mkdir(path.dirname(cacheDir()), { recursive: true });
  await symlink(outside, cacheDir());
  const warnings: string[] = [];
  const guarded = new CacheBaselineStore({
    projectRoot: root,
    onWarning: (m) => warnings.push(m),
  });
  await guarded.keepImage(image);
  expect(await readdir(outside)).toEqual([]);
  expect(warnings).toHaveLength(1);
});

test('the sweep deletes regular files only, never a link inside the tmp dir', async () => {
  const outside = await mkdtemp(path.join(tmpdir(), 'jux-outside-'));
  const target = path.join(outside, 'target');
  await writeFile(target, 'keep me');
  const tmp = path.join(root, '.juxtapose', 'tmp');
  await mkdir(tmp, { recursive: true });
  await symlink(target, path.join(tmp, 'link.tmp'));
  await store.sweepStaleTmp(Date.now() + 10 * 60 * 60 * 1000);
  expect(existsSync(target)).toBe(true);
});
