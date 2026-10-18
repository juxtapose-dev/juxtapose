import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, test, vi } from 'vitest';
import { encodeStructure, encodeStoryId, type StructureSnapshot } from '@juxtapose/core';
import { SavedElementCache } from './saved-element.js';
import { McpServer } from './mcp.js';
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});
const corpus = JSON.parse(
  readFileSync(
    new URL(
      '../../../core/src/diff/__fixtures__/structural-corpus.json',
      import.meta.url,
    ),
    'utf8',
  ),
);
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
async function fixture() {
  const project = await mkdtemp(path.join(tmpdir(), 'jux-element-'));
  roots.push(project);
  const dir = path.join(project, '.juxtapose/runs/r1');
  await mkdir(path.join(dir, 'images'), { recursive: true });
  const s = structuredClone(corpus.cases.noop.structure) as StructureSnapshot;
  const file = path.join(
    dir,
    'images',
    encodeStoryId('card--default') + '-current.structure.json.gz',
  );
  await writeFile(file, encodeStructure(s));
  await writeFile(
    path.join(dir, 'report.json'),
    JSON.stringify({
      runId: 'r1',
      capturedCount: 1,
      totalCount: 1,
      durationMs: 0,
      summary: { pass: 0, fail: 1, new: 0, skip: 0, stale: 0 },
      results: [
        {
          storyId: 'card--default',
          status: 'fail',
          durationMs: 0,
          mismatchPixels: 1,
          mismatchPercent: 1,
          changedRegions: [],
        },
      ],
    }),
  );
  return { project, dir, file, s };
}
test('real MCP returns current styles without Chrome or changing normal report results', async () => {
  const f = await fixture(),
    server = new McpServer({ project: f.project, chrome: '/not-a-browser' });
  try {
    const response = await server.call('report', {
      runId: 'r1',
      story: 'card--default',
      element: { tag: 'h1' },
      properties: ['font-size', 'margin-bottom'],
    });
    expect(response.isError).toBe(false);
    const first = response.content[0];
    const data = JSON.parse(first?.type === 'text' ? first.text : '{}');
    expect(data).toMatchObject({
      schema: 'juxtapose.current-element/v1',
      runId: 'r1',
      storyId: 'card--default',
      status: 'measured',
      styles: { 'font-size': '24px', 'margin-bottom': '12px' },
    });
    const ordinary = await server.call('report', { runId: 'r1', story: 'card--default' });
    expect(JSON.stringify(ordinary)).not.toContain('current-element');
    expect((await server.call('report', { element: { tag: 'h1' } })).isError).toBe(true);
    expect(
      (await server.call('report', { story: 'card--default', properties: ['font-size'] }))
        .isError,
    ).toBe(true);
    expect(
      (
        await server.call('report', {
          story: 'card--default',
          element: { selector: 'h1' },
        })
      ).isError,
    ).toBe(true);
  } finally {
    await server.close();
  }
});
test('concurrent/repeated lookups reuse decoded snapshots and in-place edits invalidate', async () => {
  const f = await fixture(),
    cache = new SavedElementCache();
  const canonical = await realpath(f.file);
  const reads = () =>
    vi.mocked(readFile).mock.calls.filter(([p]) => p === canonical).length;
  const before = reads();
  await Promise.all(
    Array.from({ length: 3 }, () =>
      cache.lookup(f.project, 'r1', 'card--default', { tag: 'h1' }),
    ),
  );
  await cache.lookup(f.project, 'r1', 'card--default', { tag: 'h1' });
  expect(reads() - before).toBe(1);
  f.s.elements.find((e) => e.tag === 'h1')!.styles['font-size'] = '29px';
  await writeFile(f.file, encodeStructure(f.s));
  expect(
    await cache.lookup(f.project, 'r1', 'card--default', { tag: 'h1' }),
  ).toMatchObject({ status: 'measured', styles: { 'font-size': '29px' } });
  expect(reads() - before).toBe(2);
});
test('missing snapshots are explicit and symlink escapes are rejected', async () => {
  const f = await fixture(),
    cache = new SavedElementCache();
  await rm(f.file);
  expect(
    await cache.lookup(f.project, 'r1', 'card--default', { tag: 'h1' }),
  ).toMatchObject({ status: 'unavailable', reason: 'missing-current-structure' });
  const outside = await mkdtemp(path.join(tmpdir(), 'jux-element-outside-'));
  roots.push(outside);
  const external = path.join(outside, 'outside.gz');
  await writeFile(external, encodeStructure(f.s));
  await symlink(external, f.file);
  await expect(
    cache.lookup(f.project, 'r1', 'card--default', { tag: 'h1' }),
  ).rejects.toThrow('escapes');
});

test('concurrent MCP element queries share the initial report read too', async () => {
  const f = await fixture(),
    server = new McpServer({ project: f.project, chrome: '/not-a-browser' });
  const reportFile = await realpath(path.join(f.dir, 'report.json'));
  const reads = () =>
    vi.mocked(readFile).mock.calls.filter(([p]) => p === reportFile).length;
  const before = reads();
  try {
    const results = await Promise.all(
      Array.from({ length: 3 }, () =>
        server.call('report', {
          runId: 'r1',
          story: 'card--default',
          element: { tag: 'h1' },
        }),
      ),
    );
    expect(results.every((r) => !r.isError)).toBe(true);
    expect(reads() - before).toBe(1);
  } finally {
    await server.close();
  }
});
