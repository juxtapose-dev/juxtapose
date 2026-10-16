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

test('structure lives in a readable referenced file', async () => {
  await store.put('a', image, meta);
  await store.putStructure('a', Buffer.from(JSON.stringify(structure)));
  expect(existsSync(path.join(root, 'juxtapose'))).toBe(false);
  expect(existsSync(path.join(root, '.juxtapose', 'structure'))).toBe(false);
  const entry = (await store.readManifest()).baselines['a']!;
  expect(entry.structureHash).toBe(structure.structureHash);
  expect(entry.structure).toBeUndefined();
  expect(entry.structureFile).toBe('juxtapose.structures/a.json');
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

test('approveCapture writes one element per line in the separate structure file', async () => {
  const runDir = await mkdtemp(path.join(tmpdir(), 'jux-run-'));
  const img = path.join(runDir, 'a-current.webp');
  await writeFile(img, 'img');
  await writeFile(
    path.join(runDir, 'a-current.structure.json.gz'),
    encodeStructure(structure),
  );
  await approveCapture(store, 'a', Buffer.from('img'), meta, img);
  const text = await readFile(path.join(root, 'juxtapose.manifest.json'), 'utf8');
  const structureText = await readFile(
    path.join(root, JSON.parse(text).baselines.a.structureFile),
    'utf8',
  );
  expect(JSON.parse(structureText).elements).toHaveLength(2);
  // One element per line is what makes an approval's diff reviewable.
  expect(
    structureText.split('\n').filter((l) => /^\s*\{"(path|segment)"/.test(l)),
  ).toHaveLength(structure.elements.length);
  // Additive field, so the version stays 1: an older jux accepts only 1.
  expect(JSON.parse(text).version).toBe(1);
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

/** The previous release's manifest reader (git-store.ts at 1d50ed3), verbatim. */
function previousReleaseReads(text: string): Record<string, string> {
  const isRecord = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);
  try {
    const parsed: unknown = JSON.parse(text);
    if (!(isRecord(parsed) && parsed['version'] === 1 && isRecord(parsed['baselines'])))
      return {};
    return Object.fromEntries(
      Object.entries(parsed['baselines']).map(([id, e]) => [
        id,
        (e as { hash: string }).hash,
      ]),
    );
  } catch {
    return {};
  }
}

test('a manifest carrying structure is read by the previous release as the same hashes', async () => {
  const runDir = await mkdtemp(path.join(tmpdir(), 'jux-run-'));
  for (const id of ['a', 'b']) {
    const img = path.join(runDir, `${id}-current.webp`);
    await writeFile(img, `img-${id}`);
    await writeFile(
      path.join(runDir, `${id}-current.structure.json.gz`),
      encodeStructure(structure),
    );
    await approveCapture(store, id, Buffer.from(`img-${id}`), meta, img);
  }
  const text = await readFile(path.join(root, 'juxtapose.manifest.json'), 'utf8');
  expect(text).toContain('"structureFile"');
  expect(previousReleaseReads(text)).toEqual({
    a: hashImage(Buffer.from('img-a')),
    b: hashImage(Buffer.from('img-b')),
  });
});

/** An old-layout project: image and gzip sidecar in .juxtapose/baselines. */
async function legacyProject(
  id: string,
  img: Buffer,
  entry: Record<string, unknown>,
  sidecar: StructureSnapshot = structure,
) {
  const dir = path.join(root, '.juxtapose', 'baselines');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${id}.webp`), img);
  await writeFile(path.join(dir, `${id}.structure.json.gz`), encodeStructure(sidecar));
  const file = path.join(root, 'juxtapose.manifest.json');
  const manifest = existsSync(file)
    ? JSON.parse(await readFile(file, 'utf8'))
    : {
        version: 1,
        baselines: {},
      };
  manifest.baselines[id] = { ...meta, hash: hashImage(img), ...entry };
  await writeFile(file, JSON.stringify(manifest));
}

test('migrating legacy sidecars writes readable structure files, stays version 1, changes no hash', async () => {
  await legacyProject('a', image, { structureHash: structure.structureHash });
  const before = (await store.readManifest()).baselines['a']!;
  expect(await store.migrateLegacyStructures()).toEqual({ migrated: 1, skipped: [] });
  const text = await readFile(path.join(root, 'juxtapose.manifest.json'), 'utf8');
  expect(JSON.parse(text).version).toBe(1);
  const after = (await store.readManifest()).baselines['a']!;
  expect(after.structureFile).toBeDefined();
  expect(after.hash).toBe(before.hash);
  expect(previousReleaseReads(text)).toEqual({ a: hash });
  // Idempotent.
  expect(await store.migrateLegacyStructures()).toEqual({ migrated: 0, skipped: [] });
});

test('migration matches an entry with no structureHash by the legacy image hash', async () => {
  await legacyProject('a', image, {});
  await legacyProject('b', Buffer.from('other'), { hash: 'c'.repeat(64) });
  expect(await store.migrateLegacyStructures()).toEqual({
    migrated: 1,
    skipped: ['b'],
  });
  const m = await store.readManifest();
  expect(m.baselines['a']!.structureFile).toBeDefined();
  expect(m.baselines['b']!.structure).toBeUndefined();
});

test('migration skips a sidecar whose hash differs from the approved one', async () => {
  await legacyProject('a', image, { structureHash: 'x'.repeat(64) });
  expect(await store.migrateLegacyStructures()).toEqual({ migrated: 0, skipped: ['a'] });
});

test('a symlinked .juxtapose is refused before anything is created at its target', async () => {
  const outside = await mkdtemp(path.join(tmpdir(), 'jux-outside-'));
  await symlink(outside, path.join(root, '.juxtapose'));
  const warnings: string[] = [];
  const guarded = new CacheBaselineStore({
    projectRoot: root,
    onWarning: (m) => warnings.push(m),
  });
  await guarded.keepImage(image);
  expect(await readdir(outside)).toEqual([]);
  expect(warnings.length).toBeGreaterThan(0);
});

test('a symlinked .juxtapose/cache leaves no empty directories at its target', async () => {
  const outside = await mkdtemp(path.join(tmpdir(), 'jux-outside-'));
  await mkdir(path.join(root, '.juxtapose'), { recursive: true });
  await symlink(outside, path.join(root, '.juxtapose', 'cache'));
  const guarded = new CacheBaselineStore({ projectRoot: root, onWarning: () => {} });
  await guarded.keepImage(image);
  expect(await readdir(outside)).toEqual([]);
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
