import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import {
  encodeStructure,
  extractTargetEvidence,
  type StructureSnapshot,
} from '@juxtapose/core';
import { ReferenceLayoutCache } from './reference-layout.js';
import { focusedLayoutFeedback } from './reference-layout-feedback.js';
import { McpServer } from './mcp.js';
import type { ReferenceResult } from './reference.js';
import {
  appendFocusedPaint,
  isPaint,
  type TargetTextProvider,
} from './reference-paint.js';
vi.mock('@juxtapose/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@juxtapose/core')>();
  return { ...actual, extractTargetEvidence: vi.fn(actual.extractTargetEvidence) };
});
const roots: string[] = [];
afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
const hash = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const svg = (y: number, many = false) =>
  Buffer.from(
    `<svg width="500" height="200"><rect width="500" height="200" fill="white"/>${Array.from({ length: many ? 8 : 1 }, (_, i) => `<rect x="${10 + i * 50}" y="${y}" width="30" height="20" fill="rgb(${37 + i},99,235)"/>`).join('')}</svg>`,
  );
const snapshot: StructureSnapshot = {
  schema: 'juxtapose.structure/v1',
  structureHash: 'test',
  viewport: { width: 500, height: 200 },
  contentHeight: 200,
  elements: [
    {
      path: 'button#save',
      id: 'save',
      tag: 'button',
      text: 'Save',
      parent: null,
      rect: { x: 10, y: 18, w: 30, h: 20 },
      paintOrder: 1,
      styles: {},
    },
  ],
};
async function fixture(many = false) {
  const project = await mkdtemp(path.join(tmpdir(), 'jux-paint-cache-'));
  roots.push(project);
  const reference = svg(10, many),
    current = svg(18, many);
  return {
    project,
    reference,
    current,
    referenceHash: hash(reference),
    currentHash: hash(current),
    structure: encodeStructure(snapshot),
  };
}
const provider = (text = 'Save', version = 'test-engine/data/preprocessing-v1') => ({
  cacheKey: version,
  recognize: vi.fn(async () => ({ text, score: 96 })),
});
const dir = (p: string) => path.join(p, '.juxtapose/analysis/target-layout-v3');

test('shares one decode/scan per image and full OCR across concurrent reads, restart and provider versions', async () => {
  const f = await fixture(),
    p = provider('Full cached text\n' + 'x'.repeat(90)),
    cache = new ReferenceLayoutCache(p);
  const [a, b] = await Promise.all([cache.evaluate(f), cache.evaluate(f)]);
  expect(a).toEqual(b);
  expect(extractTargetEvidence).toHaveBeenCalledTimes(2);
  expect(p.recognize).toHaveBeenCalledTimes(1);
  expect(a.paint?.target).toMatchObject({
    status: 'measured',
    regions: [{ text: { full: 'Full cached text\n' + 'x'.repeat(90) } }],
  });
  expect(a.paint?.current).toMatchObject({
    status: 'measured',
    regions: [{ elementText: 'Save' }],
  });
  const restarted = await new ReferenceLayoutCache(p).evaluate(f);
  expect(restarted).toEqual(a);
  expect(extractTargetEvidence).toHaveBeenCalledTimes(2);
  expect(p.recognize).toHaveBeenCalledTimes(1);
  const p2 = provider('Changed', 'test-engine/data/preprocessing-v2');
  const changed = await new ReferenceLayoutCache(p2).evaluate(f);
  expect(p2.recognize).toHaveBeenCalledTimes(1);
  expect(extractTargetEvidence).toHaveBeenCalledTimes(3);
  expect(changed.paint?.target).toMatchObject({
    regions: [{ text: { full: 'Changed' } }],
  });
});

test('failed or malformed provider records preserve geometry and are retried rather than cached', async () => {
  const f = await fixture(),
    p = provider();
  p.recognize.mockRejectedValueOnce(new Error('worker failed'));
  const cache = new ReferenceLayoutCache(p),
    first = await cache.evaluate(f);
  expect(first.matches).toMatchObject([{ dy: 8 }]);
  expect(first.paint?.target).toMatchObject({
    providerFailures: 1,
    regions: [{ textStatus: 'provider-error' }],
  });
  const second = await cache.evaluate(f);
  expect(second.matches).toEqual(first.matches);
  expect(p.recognize).toHaveBeenCalledTimes(2);
  expect(second.paint?.target).toMatchObject({ providerFailures: 0 });
  const bad: TargetTextProvider = {
    cacheKey: 'invalid-output-v1',
    recognize: vi.fn(async () => ({ text: 'wrong shape', score: '96' })),
  };
  const malformed = await new ReferenceLayoutCache(bad).evaluate(f);
  expect(malformed.matches).toEqual(first.matches);
  expect(malformed.paint?.target).toMatchObject({ providerFailures: 1 });
});

test('typed-invalid disk records are rejected even with a matching envelope checksum', async () => {
  const f = await fixture(),
    p = provider();
  await new ReferenceLayoutCache(p).evaluate(f);
  for (const name of await readdir(dir(f.project))) {
    const file = path.join(dir(f.project), name);
    if (name.startsWith('paint-image-')) await rm(file);
    if (name.startsWith('paint-text-')) {
      const entry = JSON.parse(await readFile(file, 'utf8'));
      entry.data = { full: 123, score: 96 };
      entry.checksum = hash(JSON.stringify(entry.data));
      await writeFile(file, JSON.stringify(entry));
    }
  }
  const result = await new ReferenceLayoutCache(p).evaluate(f);
  expect(p.recognize).toHaveBeenCalledTimes(2);
  expect(result.paint?.target).toMatchObject({ regions: [{ text: { full: 'Save' } }] });
});

test('provider concurrency stays at two for distinct component crops', async () => {
  const f = await fixture(true);
  let active = 0,
    max = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const p: TargetTextProvider = {
    cacheKey: 'concurrency-v1',
    recognize: vi.fn(async () => {
      active++;
      max = Math.max(active, max);
      await gate;
      active--;
      return { text: 'Observed', score: 96 };
    }),
  };
  const pending = new ReferenceLayoutCache(p).evaluate(f);
  await vi.waitFor(() => expect(p.recognize).toHaveBeenCalledTimes(2));
  expect(max).toBe(2);
  release();
  const result = await pending;
  expect(p.recognize).toHaveBeenCalledTimes(8);
  expect(max).toBe(2);
  expect(result.paint?.target).toMatchObject({ providerFailures: 0 });
});

test('stalled recognition returns geometry and retains real worker slots across retries', async () => {
  const f = await fixture(true);
  const releases: Array<() => void> = [];
  const p: TargetTextProvider = {
    cacheKey: 'stalled-provider-v1',
    recognize: vi.fn(
      () =>
        new Promise((resolve) => {
          releases.push(() => resolve({ text: 'Save', score: 96 }));
        }),
    ),
  };
  const cache = new ReferenceLayoutCache(p);
  try {
    const first = await cache.evaluate(f);
    expect(first.paint?.target).toMatchObject({ providerFailures: 8 });
    expect(first.matches.length).toBeGreaterThan(0);
    expect(p.recognize).toHaveBeenCalledTimes(2);
    const retry = await cache.evaluate(f);
    expect(retry.paint?.target).toMatchObject({ providerFailures: 8 });
    expect(p.recognize).toHaveBeenCalledTimes(2);
  } finally {
    releases.forEach((release) => release());
  }
}, 7000);

test.each([
  ['DOM annotation', { elementText: 123 }],
  ['observed low score', { text: { full: 'wrong', score: 1 } }],
  ['observed missing text', { text: undefined }],
  ['observed blank text', { text: { full: '  ', score: 96 } }],
  ['inconsistent low score status', { textStatus: 'low-score' }],
  ['unreported provider error', { text: undefined, textStatus: 'provider-error' }],
])('image validation independently rejects %s', async (_name, patch) => {
  const f = await fixture();
  const layout = await new ReferenceLayoutCache(provider()).evaluate(f);
  const entry = JSON.parse(JSON.stringify(layout.paint?.target));
  expect(isPaint(entry)).toBe(true);
  Object.assign(entry.regions[0], patch);
  expect(isPaint(entry)).toBe(false);
});

test('image cache rejects injected DOM text and inconsistent recognition states', async () => {
  const f = await fixture(),
    p = provider();
  await new ReferenceLayoutCache(p).evaluate(f);
  for (const name of await readdir(dir(f.project))) {
    if (!name.startsWith('paint-image-')) continue;
    const file = path.join(dir(f.project), name);
    const entry = JSON.parse(await readFile(file, 'utf8'));
    entry.data.paint.regions[0].elementText = 123;
    entry.data.paint.regions[0].textStatus = 'observed';
    entry.data.paint.regions[0].text = { full: 'wrong', score: 1 };
    entry.checksum = hash(JSON.stringify(entry.data));
    await writeFile(file, JSON.stringify(entry));
  }
  const result = await new ReferenceLayoutCache(p).evaluate(f);
  expect(extractTargetEvidence).toHaveBeenCalledTimes(4);
  expect(result.paint?.target).toMatchObject({
    regions: [{ text: { full: 'Save', score: 96 } }],
  });
  expect(result.paint?.current).toMatchObject({ regions: [{ elementText: 'Save' }] });
  expect(p.recognize).toHaveBeenCalledTimes(1);
});

test('focused projection omits whole long text while full JSON retains it, without changing geometry', async () => {
  const f = await fixture(),
    p = provider('A complete long label ' + 'x'.repeat(80)),
    layout = await new ReferenceLayoutCache(p).evaluate(f);
  const evidence = {
    runId: 'r1',
    states: [{ name: 'desktop', storyId: 'card', status: 'fail', layout, regions: [] }],
  } as unknown as ReferenceResult;
  const focused = focusedLayoutFeedback(evidence);
  const { paint: _, ...withoutPaint } = layout;
  void _;
  expect(focused.layout).toEqual(withoutPaint);
  expect(focused.paint).toBeUndefined();
  expect(JSON.stringify(focused)).not.toContain('x'.repeat(20));
  expect(Buffer.byteLength(JSON.stringify(focused))).toBeLessThanOrEqual(4096);
  expect(layout.paint?.target).toMatchObject({
    regions: [{ text: { full: 'A complete long label ' + 'x'.repeat(80) } }],
  });
});

test('unchanged translated pixels do not repeat color evidence already covered by geometry', async () => {
  const f = await fixture(),
    p = provider();
  const layout = await new ReferenceLayoutCache(p).evaluate(f);
  const focused = focusedLayoutFeedback({
    runId: 'r1',
    states: [{ name: 'desktop', storyId: 'card', status: 'fail', layout, regions: [] }],
  } as unknown as ReferenceResult);
  expect(layout.matches).toMatchObject([{ dy: 8 }]);
  expect(focused.layout?.matches).toEqual(layout.matches);
  expect(focused.paint).toBeUndefined();
  expect(layout.paint?.target).toMatchObject({ regions: [{ text: { full: 'Save' } }] });
});

test('translated equal-count components remain available when no geometry explains them', async () => {
  const f = await fixture(),
    p = provider();
  const layout = await new ReferenceLayoutCache(p).evaluate(f);
  const packet = appendFocusedPaint(
    { next: 'Inspect unresolved geometry.' },
    layout.paint,
  );
  expect(packet.paint?.target).toMatchObject([
    { box: [10, 10, 30, 20], textInside: 'Save' },
  ]);
  expect(packet.paint?.current).toMatchObject([
    { box: [10, 18, 30, 20], elementText: 'Save' },
  ]);
});

test('an unchanged copy does not suppress different multiplicities of repeated paint', async () => {
  const f = await fixture(),
    p = provider();
  const layout = await new ReferenceLayoutCache(p).evaluate(f);
  const paint = layout.paint!;
  if (paint.target.status !== 'measured') throw Error('expected target');
  const original = paint.target.regions[0]!;
  paint.target.regions.push({ ...original, box: { ...original.box, x: 60 } });
  const packet = appendFocusedPaint({ next: 'Edit using measured facts.' }, paint);
  expect(packet.paint?.target).toMatchObject([{ textInside: 'Save', count: 2 }]);
  expect(packet.paint?.current).toMatchObject([{ elementText: 'Save', count: 1 }]);
});

test('real MCP compact and full requests reuse cached text and keep the default response unchanged', async () => {
  const f = await fixture(),
    p = provider();
  const require = createRequire(import.meta.url),
    sharp = createRequire(require.resolve('@juxtapose/core/package.json'))('sharp');
  const reference: Buffer = await sharp(f.reference).png().toBuffer(),
    current: Buffer = await sharp(
      Buffer.from(f.current.toString().replace('rgb(37,99,235)', 'rgb(239,68,68)')),
    )
      .webp({ lossless: true })
      .toBuffer();
  const run = path.join(f.project, '.juxtapose/runs/r1');
  await mkdir(path.join(run, 'images'), { recursive: true });
  await mkdir(path.join(f.project, 'design'));
  await writeFile(path.join(f.project, 'design/target.png'), reference);
  await writeFile(path.join(run, 'images/card-current.webp'), current);
  await writeFile(path.join(run, 'images/card-current.structure.json.gz'), f.structure);
  await writeFile(
    path.join(run, 'report.json'),
    JSON.stringify({
      runId: 'r1',
      results: [
        { storyId: 'card', status: 'new', viewport: { width: 500, height: 200 } },
      ],
    }),
  );
  await writeFile(
    path.join(f.project, 'juxtapose.config.json'),
    JSON.stringify({
      designReferences: {
        desktop: {
          storyId: 'card',
          image: 'design/target.png',
          viewport: { width: 500, height: 200 },
        },
      },
    }),
  );
  const server = new McpServer(
      { project: f.project, chrome: '/nonexistent/chrome' },
      { experimentalTargetTextProvider: p },
    ),
    control = new McpServer({ project: f.project, chrome: '/nonexistent/chrome' });
  try {
    const first = await server.call('reference', { name: 'desktop' });
    expect(first).toEqual(await control.call('reference', { name: 'desktop' }));
    expect(p.recognize).not.toHaveBeenCalled();
    const compact = await server.call('reference', { name: 'desktop', detail: 'layout' });
    expect(compact.isError).toBe(false);
    const text = compact.content[0];
    if (text?.type !== 'text') throw Error('expected text');
    expect(JSON.parse(text.text).paint.target[0]).toMatchObject({
      rgb: '#2563eb',
      textInside: 'Save',
    });
    const full = await server.call('reference', { name: 'desktop', detail: 'json' });
    const block = full.content[0];
    if (block?.type !== 'text') throw Error('expected JSON');
    expect(
      JSON.parse(block.text).states[0].layout.paint.target.regions[0].text.full,
    ).toBe('Save');
    expect(p.recognize).toHaveBeenCalledTimes(1);
    expect(await server.call('reference', { name: 'desktop' })).toEqual(first);
  } finally {
    await server.close();
    await control.close();
  }
});

test('paint budget fallback permits verified hypotheses without promising all omitted facts', async () => {
  const f = await fixture(),
    p = provider();
  const layout = await new ReferenceLayoutCache(p).evaluate(f);
  const packet = appendFocusedPaint({ next: 'x'.repeat(3000) }, layout.paint);
  expect(packet.paint?.target).not.toHaveLength(0);
  expect(packet.next).toContain('source-grounded edits');
  expect(packet.next).toContain('verify affected states');
  expect(packet.next).toContain('CSS causes are hypotheses');
  expect(packet.next).toContain('omissions can remain');
  expect(packet.next).toContain('No PNG target DOM or abstained matches');
  expect(Buffer.byteLength(JSON.stringify(packet))).toBeLessThanOrEqual(4096);
});

test('soft paint packing keeps both inventories across the target and omits the next block accurately', async () => {
  const f = await fixture(),
    p = provider();
  const layout = await new ReferenceLayoutCache(p).evaluate(f);
  const paint = structuredClone(layout.paint!);
  for (const role of ['target', 'current'] as const) {
    const image = paint[role];
    if (image.status !== 'measured') throw Error('expected measured fixture');
    const first = image.regions[0]!;
    image.regions.push({
      ...first,
      id: `${role}-other`,
      box: { ...first.box, x: first.box.x + 40 },
      fill: [90, 20, 30],
      cropHash: `${role}-different-paint`,
      ...(role === 'target'
        ? { text: { full: 'Other', score: 95 }, textStatus: 'observed' as const }
        : { elementText: 'Other' }),
    });
  }
  const saved = JSON.stringify(paint);
  let checked = false;
  for (let padding = 2000; padding < 3072; padding += 20) {
    const packet = appendFocusedPaint(
      { next: 'Use saved facts.', padding: 'x'.repeat(padding) },
      paint,
    );
    const bytes = Buffer.byteLength(JSON.stringify(packet));
    if (
      bytes <= 3072 ||
      packet.paint?.target.length !== 1 ||
      packet.paint.current.length !== 1
    )
      continue;
    expect(bytes).toBeLessThanOrEqual(4096);
    expect(packet.paint.omitted).toEqual([1, 1]);
    expect(packet.paint.target[0]?.count).toBe(1);
    expect(packet.paint.current[0]?.count).toBe(1);
    checked = true;
    break;
  }
  expect(checked).toBe(true);
  expect(JSON.stringify(paint)).toBe(saved);
});
