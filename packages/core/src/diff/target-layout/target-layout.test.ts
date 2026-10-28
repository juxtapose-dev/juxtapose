import { expect, test } from 'vitest';
import { fromPng, fromStructure, matchLayout, type RgbaImage } from './index.js';
import type { StructureSnapshot } from '../../types.js';

const rects = (
  boxes: Array<[number, number, number, number]>,
  width = 100,
  height = 80,
): RgbaImage => {
  const data = new Uint8Array(width * height * 4).fill(255);
  for (const [x, y, w, h] of boxes)
    for (let yy = y; yy < y + h; yy++)
      for (let xx = x; xx < x + w; xx++) {
        const i = (yy * width + xx) * 4;
        data[i] = 37;
        data[i + 1] = 99;
        data[i + 2] = 235;
      }
  return { data, width, height };
};
const structure = (
  boxes: Array<[number, number, number, number]>,
): StructureSnapshot => ({
  schema: 'juxtapose.structure/v1',
  structureHash: 'test',
  viewport: { width: 100, height: 80 },
  contentHeight: 80,
  elements: boxes.map(([x, y, w, h], i) => ({
    path: `button#b${i}`,
    id: `b${i}`,
    tag: 'button',
    parent: null,
    rect: { x, y, w, h },
    paintOrder: i,
    styles: { 'background-color': 'rgb(37, 99, 235)' },
  })),
});

test('row components recover exact rectangular painted area and stable bytes', () => {
  const image = rects([
    [10, 10, 20, 10],
    [40, 40, 12, 20],
  ]);
  const first = fromPng(image);
  expect(first.blocks.map((b) => [b.box, b.solidArea])).toEqual([
    [{ x: 10, y: 10, width: 20, height: 10 }, 200],
    [{ x: 40, y: 40, width: 12, height: 20 }, 240],
  ]);
  expect(JSON.stringify(fromPng(image))).toBe(JSON.stringify(first));
  const dom = fromStructure(structure([[10, 10, 20, 10]]));
  expect(dom.blocks[0]).toMatchObject({
    provenance: 'structure',
    solidArea: null,
    children: [],
  });
});

test('reports a unique painted block resize with current DOM provenance and no CSS claim', () => {
  const result = matchLayout(
    fromPng(rects([[10, 10, 20, 10]])),
    fromPng(rects([[10, 10, 20, 16]])),
    structure([[10, 10, 20, 16]]),
  );
  expect(result.matches).toMatchObject([
    {
      dh: 6,
      dx: 0,
      dy: 0,
      dw: 0,
      element: { id: 'b0' },
      paintedFill: { rgb: [37, 99, 235], targetCurrentEqual: true },
      provenance: 'measured-from-pixels',
    },
  ]);
});

test('abstains from repeated lookalikes, two-pixel changes, colors and ambiguous DOM', () => {
  const target = fromPng(
    rects([
      [10, 10, 20, 10],
      [50, 10, 20, 10],
    ]),
  );
  const current = fromPng(
    rects([
      [10, 20, 20, 10],
      [50, 20, 20, 10],
    ]),
  );
  expect(
    matchLayout(
      target,
      current,
      structure([
        [10, 20, 20, 10],
        [50, 20, 20, 10],
      ]),
    ).matches,
  ).toEqual([]);
  const single = fromPng(rects([[10, 10, 20, 10]]));
  const shifted = fromPng(rects([[10, 12, 20, 10]]));
  expect(matchLayout(single, shifted, structure([[10, 12, 20, 10]])).matches).toEqual([]);
  const large = fromPng(rects([[10, 16, 20, 10]]));
  expect(
    matchLayout(
      single,
      large,
      structure([
        [10, 16, 20, 10],
        [10, 16, 20, 10],
      ]),
    ).matches,
  ).toEqual([]);
  large.blocks[0]!.fill = [38, 99, 235];
  expect(matchLayout(single, large, structure([[10, 16, 20, 10]])).matches).toEqual([]);
});

test('high-frequency images stop at a bounded component budget', () => {
  const width = 1000,
    height = 720;
  const image = rects([], width, height);
  for (let i = 0; i < width * height; i++) image.data[i * 4] = i % 2 ? 0 : 255;
  expect(fromPng(image)).toMatchObject({ blocks: [], abstained: { complexity: true } });
});

test('exact inner paint follows distinct controls through a reorder without OCR', () => {
  const targetBoxes: Array<[number, number, number, number]> = [
    [5, 10, 40, 30],
    [55, 10, 40, 30],
  ];
  const currentBoxes: Array<[number, number, number, number]> = [
    [55, 18, 40, 30],
    [5, 18, 40, 30],
  ];
  const paint = (boxes: typeof targetBoxes) => {
    const image = rects(boxes);
    boxes.forEach(([x, y], id) => {
      for (let yy = y + 12; yy < y + 16; yy++)
        for (let xx = x + 10; xx < x + 12 + id; xx++) {
          const offset = (yy * image.width + xx) * 4;
          image.data[offset] = image.data[offset + 1] = image.data[offset + 2] = 0;
        }
    });
    return image;
  };
  const result = matchLayout(
    fromPng(paint(targetBoxes)),
    fromPng(paint(currentBoxes)),
    structure(currentBoxes),
  );
  expect(result.matches).toMatchObject([
    { element: { id: 'b0' }, dx: 50, dy: 8 },
    { element: { id: 'b1' }, dx: -50, dy: 8 },
  ]);
});

test('structured evidence preserves mixed text styles without flattening descendants', () => {
  const snapshot = structure([
    [0, 0, 80, 16],
    [0, 0, 8, 14],
  ]);
  const parent = snapshot.elements[0]!;
  parent.tag = 'p';
  parent.text = '/ move';
  parent.styles = {
    'font-family': 'sans-serif',
    'font-size': '12px',
    'line-height': '16px',
  };
  const child = snapshot.elements[1]!;
  child.parent = 0;
  child.tag = 'kbd';
  child.text = 'j';
  child.styles = { 'font-family': 'monospace' };
  const evidence = fromStructure(snapshot);
  expect(evidence.blocks[0]).toMatchObject({
    children: ['dom:1'],
    text: { value: '/ move', tag: 'p', styles: { 'font-family': 'sans-serif' } },
  });
  expect(evidence.blocks[1]).toMatchObject({
    text: {
      value: 'j',
      tag: 'kbd',
      styles: { 'font-family': 'monospace', 'font-size': '12px', 'line-height': '16px' },
    },
  });
  const styles = evidence.blocks[1]!.text!.styles;
  expect(Object.keys(styles)).toEqual(Object.keys(styles).sort());
  expect(JSON.stringify(fromStructure(snapshot))).toBe(JSON.stringify(evidence));
  expect(parent.text).toBe('/ move');
});

test('pixel and textless structure blocks do not invent typography', () => {
  expect(fromStructure(structure([[0, 0, 10, 10]])).blocks[0]).not.toHaveProperty('text');
  for (const block of fromPng(rects([[0, 0, 10, 10]])).blocks)
    expect(block).not.toHaveProperty('text');
});
