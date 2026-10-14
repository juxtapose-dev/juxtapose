import sharp from 'sharp';
import { expect, test } from 'vitest';
import type { StructureElement, StructureSnapshot } from '../types.js';
import { analyzeFlake } from './analyze.js';

const VIEWPORT = { width: 40, height: 40 };

const el = (over: Partial<StructureElement>): StructureElement => ({
  path: 'html>body>div',
  parent: null,
  tag: 'div',
  rect: { x: 0, y: 0, w: 40, h: 40 },
  paintOrder: 0,
  styles: {},
  ...over,
});
const structure = (elements: StructureElement[], hash = 'h'): StructureSnapshot => ({
  schema: 'juxtapose.structure/v1',
  viewport: VIEWPORT,
  structureHash: hash,
  contentHeight: 40,
  elements,
});

/** A white frame with a black block at `at`, 4x4, 1% of the frame, under the render-drift cap. */
const frame = (at: { x: number; y: number } | null) =>
  sharp({
    create: { width: 40, height: 40, channels: 3, background: '#ffffff' },
  })
    .composite(
      at
        ? [
            {
              input: {
                create: { width: 4, height: 4, channels: 3, background: '#000000' },
              },
              left: at.x,
              top: at.y,
            },
          ]
        : [],
    )
    .webp({ lossless: true })
    .toBuffer();

test('an element in only the second capture is async, selected by its test id', async () => {
  const list = el({ path: 'html>body>ul', tag: 'ul', testId: 'results' });
  const row = el({
    path: 'html>body>ul>li:nth-of-type(1)',
    tag: 'li',
    parent: 0,
    testId: 'row-1',
    rect: { x: 0, y: 0, w: 40, h: 10 },
  });
  const flake = await analyzeFlake({
    storyId: 's',
    first: { image: await frame(null), structure: structure([list], 'a') },
    second: {
      image: await frame({ x: 0, y: 0 }),
      structure: structure([list, row], 'b'),
    },
  });
  expect(flake.cause).toBe('async-element');
  expect(flake.evidence).toEqual({
    selector: '[data-testid="row-1"]',
    presentIn: 'second',
  });
  expect(flake.fix).toEqual({
    stories: { s: { waitForSelector: '[data-testid="row-1"]' } },
  });
});

test('changed text is read from the matched element, and truncated structures are not compared for arrivals', async () => {
  const a = el({ tag: 'p', path: 'html>body>p', text: '10:41', classes: ['now'] });
  const b = { ...a, text: '10:42' };
  const flake = await analyzeFlake({
    storyId: 's',
    first: { image: await frame(null), structure: structure([a], 'a') },
    second: { image: await frame({ x: 2, y: 2 }), structure: structure([b], 'b') },
  });
  expect(flake.cause).toBe('clock');
  expect(flake.evidence).toEqual({ selector: 'p.now', before: '10:41', after: '10:42' });
});

test('a third-party image under the changed pixels is found; one elsewhere is not', async () => {
  const far = el({
    tag: 'img',
    path: 'html>body>img',
    rect: { x: 30, y: 30, w: 10, h: 10 },
    external: [{ kind: 'image', origin: 'https://cdn.example.com', path: '/a.png' }],
  });
  const s = structure([far], 'same');
  // The block changes at the top left; the image sits at the bottom right.
  const miss = await analyzeFlake({
    storyId: 's',
    first: { image: await frame(null), structure: s },
    second: { image: await frame({ x: 0, y: 0 }), structure: s },
  });
  expect(miss.cause).toBe('render-drift');

  const near = { ...far, rect: { x: 0, y: 0, w: 20, h: 20 } };
  const hit = await analyzeFlake({
    storyId: 's',
    first: { image: await frame(null), structure: structure([near], 'same') },
    second: { image: await frame({ x: 0, y: 0 }), structure: structure([near], 'same') },
  });
  expect(hit.cause).toBe('external-image');
  expect(hit.evidence.host).toBe('cdn.example.com');
});

test('a settle timeout in either capture is the cause, and the flags are kept', async () => {
  const flake = await analyzeFlake({
    storyId: 's',
    first: { image: await frame(null) },
    second: {
      image: await frame({ x: 1, y: 1 }),
      settle: {
        status: 'timeout',
        timeoutMs: 1500,
        pending: ['1 request to /api/feed in flight (Fetch)'],
      },
      flags: ['settle-timeout'],
    },
  });
  expect(flake.cause).toBe('settle-timeout');
  expect(flake.evidence.flags).toEqual(['settle-timeout']);
});

test('identical structure with a tiny pixel delta is render drift; a missing structure is unknown', async () => {
  const s = structure([el({})], 'same');
  const drift = await analyzeFlake({
    storyId: 's',
    first: { image: await frame(null), structure: s },
    second: { image: await frame({ x: 30, y: 30 }), structure: s },
  });
  expect(drift.cause).toBe('render-drift');
  expect(drift.fix).toBeNull();

  const unknown = await analyzeFlake({
    storyId: 's',
    first: { image: await frame(null) },
    second: { image: await frame({ x: 30, y: 30 }) },
  });
  expect(unknown.cause).toBe('unknown');
});

test('a capture that reused a renderer is order dependence unless freshRenderer is on', async () => {
  const s = structure([el({})], 'same');
  const input = {
    storyId: 's',
    first: { image: await frame(null), structure: s },
    second: {
      image: await frame({ x: 30, y: 30 }),
      structure: s,
      flags: ['renderer-reused' as const],
    },
  };
  const off = await analyzeFlake({ ...input, freshRenderer: false });
  expect(off.cause).toBe('order-dependence');
  expect(off.evidence.reusedIn).toEqual(['second']);
  expect(off.fix).toEqual({ freshRenderer: true });
  expect((await analyzeFlake({ ...input, freshRenderer: true })).cause).toBe(
    'render-drift',
  );
});
