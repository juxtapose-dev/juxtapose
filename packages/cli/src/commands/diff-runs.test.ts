import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { deflateSync } from 'node:zlib';
import {
  encodeStoryId,
  encodeStructure,
  hashImage,
  type StructureSnapshot,
} from '@juxtapose/core';
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

// A 40x40 white PNG with an optional 4x4 black block: the cli has no image
// library of its own, and the diff reads any format.
const frame = (left: number | null): Buffer => {
  const rows = Buffer.alloc(40 * (1 + 40 * 3), 255);
  for (let y = 0; y < 40; y++) {
    rows[y * 121] = 0; // filter: none
    if (left !== null && y < 4)
      rows.fill(0, y * 121 + 1 + left * 3, y * 121 + 1 + (left + 4) * 3);
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let r = 0xffffffff;
    for (const x of b) r = crcTable[(r ^ x) & 255]! ^ (r >>> 8);
    return (r ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(40, 0);
  ihdr.writeUInt32BE(40, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
};
const structure: StructureSnapshot = {
  schema: 'juxtapose.structure/v1',
  viewport: { width: 40, height: 40 },
  structureHash: 'h',
  contentHeight: 40,
  elements: [
    {
      path: 'html>body>img',
      parent: null,
      tag: 'img',
      classes: ['cover'],
      rect: { x: 0, y: 0, w: 20, h: 20 },
      paintOrder: 0,
      styles: {},
      external: [{ kind: 'image', origin: 'https://picsum.photos', path: '/200' }],
    },
  ],
};
/** Two runs of the same stories whose captures differ under a third-party image. */
async function writeFlakyRuns(ids: string[]) {
  for (const [runId, image] of [
    ['r1', frame(null)],
    ['r2', frame(0)],
  ] as const) {
    await writeRun(
      runId,
      ids.map((storyId) => ({
        storyId,
        hash: hashImage(image),
        image: image as unknown as string,
      })),
    );
    for (const storyId of ids)
      await writeFile(
        path.join(
          root,
          '.juxtapose',
          'runs',
          runId,
          'images',
          `${encodeStoryId(storyId)}-current.structure.json.gz`,
        ),
        encodeStructure(structure),
      );
  }
}

test('a story that differs is explained: the cause and the exact fix, in JSON and text', async () => {
  await writeFlakyRuns(['card--basic']);
  const json = JSON.parse((await diffRuns('r1', 'r2')).out);
  expect(json.flake['card--basic']).toMatchObject({
    cause: 'external-image',
    evidence: { host: 'picsum.photos', selector: 'img.cover' },
    fix: {
      stories: { 'card--basic': { network: { external: { images: 'placeholder' } } } },
    },
  });
  const text = (await diffRuns('r1', 'r2', false)).out;
  expect(text).toContain(
    'Unstable: external image from picsum.photos in img.cover; fix: stories["card--basic"].network.external.images = "placeholder"',
  );
});

test('with no flake to report the JSON has no flake key', async () => {
  await writeRun('r1', [{ storyId: 'a', hash: 'h1' }]);
  await writeRun('r2', [{ storyId: 'a', hash: 'h2' }]);
  expect(JSON.parse((await diffRuns('r1', 'r2')).out)).not.toHaveProperty('flake');
});

test('three stories under one host are one group: one project fix, one line', async () => {
  await writeFlakyRuns(['c--1', 'a--1', 'b--1']);
  const json = JSON.parse((await diffRuns('r1', 'r2')).out);
  expect(json.flakeGroups).toEqual([
    {
      cause: 'external-image',
      host: 'picsum.photos',
      storyIds: ['a--1', 'b--1', 'c--1'],
      fix: {
        network: {
          rules: [{ match: 'https://picsum.photos/**', action: 'placeholder' }],
        },
      },
    },
  ]);
  // Per-story flake stays.
  expect(Object.keys(json.flake)).toEqual(['a--1', 'b--1', 'c--1']);
  const text = (await diffRuns('r1', 'r2', false)).out;
  expect(text).toContain(
    '3 stories: external images from picsum.photos; fix: network.rules += {"match":"https://picsum.photos/**","action":"placeholder"}',
  );
  expect(text).toContain('a--1, b--1, c--1');
  // The group stands in for the three per-story lines.
  expect(text).not.toContain('Unstable:');
});
