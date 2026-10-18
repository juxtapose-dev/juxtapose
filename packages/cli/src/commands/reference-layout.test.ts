import { createHash } from 'node:crypto';
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import {
  encodeStructure,
  extractTargetEvidence,
  matchTargetLayout,
  type StructureSnapshot,
} from '@juxtapose/core';
import { ReferenceLayoutCache } from './reference-layout.js';
import { evaluateReferences } from './reference.js';
import { withDesignReferenceFeedback } from './mcp.js';

vi.mock('@juxtapose/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@juxtapose/core')>();
  return {
    ...actual,
    extractTargetEvidence: vi.fn(actual.extractTargetEvidence),
    matchTargetLayout: vi.fn(actual.matchTargetLayout),
  };
});
const roots: string[] = [];
afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
const hash = (buffer: Buffer) => createHash('sha256').update(buffer).digest('hex');
async function root() {
  const dir = await mkdtemp(path.join(tmpdir(), 'jux-layout-cache-'));
  roots.push(dir);
  return dir;
}
const svg = (y: number) =>
  Buffer.from(
    `<svg width="100" height="80"><rect width="100" height="80" fill="white"/><rect x="10" y="${y}" width="60" height="30" fill="#2563eb"/></svg>`,
  );
const snapshot = (id = 'save'): StructureSnapshot => ({
  schema: 'juxtapose.structure/v1',
  structureHash: id,
  contentHeight: 80,
  viewport: { width: 100, height: 80 },
  elements: [
    {
      path: `button#${id}`,
      id,
      parent: null,
      tag: 'button',
      paintOrder: 1,
      styles: {},
      rect: { x: 10, y: 18, w: 60, h: 30 },
    },
  ],
});
async function fixture() {
  const project = await root(),
    reference = svg(10),
    current = svg(18);
  return {
    project,
    reference,
    current,
    referenceHash: hash(reference),
    currentHash: hash(current),
    structure: encodeStructure(snapshot()),
  };
}
const cacheDir = (project: string) =>
  path.join(project, '.juxtapose/analysis/target-layout-v3');

test('reuses target/current segmentation, deduplicates concurrent requests and survives restart', async () => {
  const f = await fixture(),
    cache = new ReferenceLayoutCache();
  const [a, b] = await Promise.all([cache.evaluate(f), cache.evaluate(f)]);
  expect(a).toEqual(b);
  expect(a.matches).toMatchObject([
    {
      dy: 8,
      element: { id: 'save', provenance: 'structure' },
      paintedFill: { rgb: [37, 99, 235], targetCurrentEqual: true },
    },
  ]);
  expect(extractTargetEvidence).toHaveBeenCalledTimes(2);
  expect(matchTargetLayout).toHaveBeenCalledTimes(1);
  expect(await new ReferenceLayoutCache().evaluate(f)).toEqual(a);
  expect(extractTargetEvidence).toHaveBeenCalledTimes(2);
  expect(matchTargetLayout).toHaveBeenCalledTimes(1);
  const updated = await cache.evaluate({
    ...f,
    structure: encodeStructure(snapshot('renamed')),
  });
  expect(updated.matches[0]?.element.id).toBe('renamed');
  expect(extractTargetEvidence).toHaveBeenCalledTimes(2);
  expect(matchTargetLayout).toHaveBeenCalledTimes(2);
  await expect(cache.evaluate({ ...f, reference: svg(11) })).rejects.toThrow(
    'changed during analysis',
  );
});

test('corrupt pair analysis is rebuilt from cached image evidence without decoding again', async () => {
  const f = await fixture(),
    expected = await new ReferenceLayoutCache().evaluate(f);
  const pair = (await readdir(cacheDir(f.project))).find((file) =>
    file.startsWith('pair-'),
  )!;
  const file = path.join(cacheDir(f.project), pair);
  const entry = JSON.parse(await readFile(file, 'utf8'));
  entry.data.matches[0].dy = 999;
  await writeFile(file, JSON.stringify(entry));
  expect(await new ReferenceLayoutCache().evaluate(f)).toEqual(expected);
  expect(extractTargetEvidence).toHaveBeenCalledTimes(2);
  expect(matchTargetLayout).toHaveBeenCalledTimes(2);
});

test('a symlinked analysis parent is neither read nor written', async () => {
  const f = await fixture(),
    outside = await root();
  await mkdir(path.join(f.project, '.juxtapose'));
  await symlink(outside, path.join(f.project, '.juxtapose/analysis'), 'dir');
  const actual = await new ReferenceLayoutCache().evaluate(f);
  expect(actual.matches[0]?.dy).toBe(8);
  expect(await readdir(outside)).toEqual([]);
});

test('requested detail retains every accepted geometry match in the cached comparison', async () => {
  const project = await root(),
    width = 400,
    height = 100;
  const boxes = Array.from({ length: 20 }, (_, i) => ({
    x: 5 + (i % 10) * 38,
    y: 5 + Math.floor(i / 10) * 45,
    color: `#${(0x202030 + i * 101).toString(16)}`,
  }));
  const image = (offset: number) =>
    Buffer.from(
      `<svg width="${width}" height="${height}"><rect width="100%" height="100%" fill="white"/>${boxes.map((b) => `<rect x="${b.x}" y="${b.y + offset}" width="30" height="30" fill="${b.color}"/>`).join('')}</svg>`,
    );
  const reference = image(0),
    current = image(4);
  const structure: StructureSnapshot = {
    schema: 'juxtapose.structure/v1',
    structureHash: 'many',
    viewport: { width, height },
    contentHeight: height,
    elements: boxes.map((b, i) => ({
      path: `button#b${i}`,
      id: `b${i}`,
      parent: null,
      tag: 'button',
      paintOrder: i,
      styles: {},
      rect: { x: b.x, y: b.y + 4, w: 30, h: 30 },
    })),
  };
  const result = await new ReferenceLayoutCache().evaluate({
    project,
    reference,
    current,
    referenceHash: hash(reference),
    currentHash: hash(current),
    structure: encodeStructure(structure),
  });
  expect(result.matches).toHaveLength(20);
  expect(result.omittedMatches).toBe(0);
});

const white = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAwAAAAICAYAAADN5B7xAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAE0lEQVQYlWP4TyJgGNVABCA5lADspH6QblB3gwAAAABJRU5ErkJggg==',
  'base64',
);
const black = Buffer.from('UklGRhoAAABXRUJQVlA4TA4AAAAvC8ABAAcQEf0PRET/Aw==', 'base64');
const whiteWebp = Buffer.from(
  'UklGRh4AAABXRUJQVlA4TBEAAAAvC8ABAAfQ//73v/+BiOh/AAA=',
  'base64',
);
async function savedFixture(image: Buffer) {
  const project = await root(),
    run = path.join(project, '.juxtapose/runs/r1');
  await mkdir(path.join(run, 'images'), { recursive: true });
  await writeFile(path.join(project, 'target.png'), white);
  await writeFile(
    path.join(project, 'juxtapose.config.json'),
    JSON.stringify({
      designReferences: {
        desktop: {
          storyId: 'card',
          image: 'target.png',
          viewport: { width: 12, height: 8 },
        },
      },
    }),
  );
  await writeFile(
    path.join(run, 'report.json'),
    JSON.stringify({
      runId: 'r1',
      capturedCount: 1,
      results: [{ storyId: 'card', status: 'fail', viewport: { width: 12, height: 8 } }],
    }),
  );
  await writeFile(path.join(run, 'images/card-current.webp'), image);
  await writeFile(
    path.join(run, 'images/card-current.structure.json.gz'),
    encodeStructure({
      schema: 'juxtapose.structure/v1',
      structureHash: 'empty',
      viewport: { width: 12, height: 8 },
      contentHeight: 8,
      elements: [],
    }),
  );
  return project;
}

test('layout is on demand, cannot change the verdict and never analyzes a passing target', async () => {
  const project = await savedFixture(black);
  const tool = {
    content: [
      { type: 'text' as const, text: JSON.stringify({ runId: 'r1', capturedCount: 1 }) },
    ],
    isError: false,
  };
  await withDesignReferenceFeedback(tool, project);
  expect(extractTargetEvidence).not.toHaveBeenCalled();
  const result = await evaluateReferences({ project, includeLayout: true });
  expect(result.outcome).toBe('fail');
  expect(result.states[0]).toMatchObject({
    mismatchPixels: 96,
    layout: { status: 'measured', matches: [] },
  });
  const pass = await evaluateReferences({
    project: await savedFixture(whiteWebp),
    includeLayout: true,
  });
  expect(pass.outcome).toBe('pass');
  expect(pass.states[0]).not.toHaveProperty('layout');
  expect(extractTargetEvidence).toHaveBeenCalledTimes(2);
});

test.each([
  undefined,
  { rgb: [256, 99, 235], targetCurrentEqual: true },
  { rgb: [37, 99], targetCurrentEqual: true },
  { rgb: [37, 99, 235], targetCurrentEqual: false },
])(
  'rebuilds cached matches with missing or invalid painted fill: %j',
  async (paintedFill) => {
    const f = await fixture();
    const expected = await new ReferenceLayoutCache().evaluate(f);
    const pair = (await readdir(cacheDir(f.project))).find((file) =>
      file.startsWith('pair-'),
    )!;
    const file = path.join(cacheDir(f.project), pair);
    const entry = JSON.parse(await readFile(file, 'utf8'));
    if (paintedFill === undefined) delete entry.data.matches[0].paintedFill;
    else entry.data.matches[0].paintedFill = paintedFill;
    entry.checksum = hash(Buffer.from(JSON.stringify(entry.data)));
    await writeFile(file, JSON.stringify(entry));
    expect(await new ReferenceLayoutCache().evaluate(f)).toEqual(expected);
    expect(extractTargetEvidence).toHaveBeenCalledTimes(2);
    expect(matchTargetLayout).toHaveBeenCalledTimes(2);
  },
);

test('ignores a previous layout cache version and recomputes the pixel measurements', async () => {
  const f = await fixture();
  const expected = await new ReferenceLayoutCache().evaluate(f);
  const old = path.join(f.project, '.juxtapose/analysis/target-layout-v2');
  await mkdir(old);
  for (const name of await readdir(cacheDir(f.project))) {
    await writeFile(
      path.join(old, name),
      await readFile(path.join(cacheDir(f.project), name)),
    );
  }
  await rm(cacheDir(f.project), { recursive: true });
  expect(await new ReferenceLayoutCache().evaluate(f)).toEqual(expected);
  expect(extractTargetEvidence).toHaveBeenCalledTimes(4);
  expect(matchTargetLayout).toHaveBeenCalledTimes(2);
});
