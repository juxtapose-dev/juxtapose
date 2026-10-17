import { expect, test } from 'vitest';
import sharp from 'sharp';
import type { StructureSnapshot } from '../types.js';
import { observeReferenceOutlines } from './reference-outlines.js';

const viewport = { width: 390, height: 600 };
const structure = (border = 'rgb(154, 165, 177)'): StructureSnapshot => ({
  schema: 'juxtapose.structure/v1',
  viewport,
  structureHash: 'fixture',
  contentHeight: viewport.height,
  elements: [
    {
      path: 'html>body>input#city',
      parent: null,
      tag: 'input',
      role: 'textbox',
      rect: { x: 62, y: 400, w: 125, h: 44 },
      paintOrder: 1,
      styles: { 'border-top-color': border },
    },
  ],
});

async function image(boxes: Array<[number, number, number, number]>) {
  const rects = boxes
    .map(
      ([x, y, width, height]) =>
        `<rect x="${x + 0.5}" y="${y + 0.5}" width="${width - 1}" height="${height - 1}" rx="4" fill="white" stroke="#9aa5b1" stroke-width="1"/>`,
    )
    .join('');
  return sharp(
    Buffer.from(
      `<svg width="390" height="600"><rect width="390" height="600" fill="white"/>${rects}</svg>`,
    ),
  )
    .png()
    .toBuffer();
}

const region = { x: 45, y: 390, width: 300, height: 140 };

test('observes stacked target outlines versus side-by-side current outlines', async () => {
  const reference = await image([
    [62, 409, 266, 44],
    [62, 497, 266, 44],
  ]);
  const current = await image([
    [62, 409, 125, 44],
    [203, 409, 125, 44],
  ]);
  const result = await observeReferenceOutlines({
    reference,
    current,
    structure: structure(),
    region,
  });
  expect(result?.kind).toBe('border-outline-geometry/v1');
  expect(result?.targetBoxes).toHaveLength(2);
  expect(result?.currentBoxes).toHaveLength(2);
  expect(result?.targetBoxes[0]?.x).toBe(result?.targetBoxes[1]?.x);
  expect(result?.currentBoxes[0]?.x).toBeLessThan(result?.currentBoxes[1]?.x ?? 0);
});

test('abstains for equal geometry or missing border evidence', async () => {
  const reference = await image([[62, 409, 266, 44]]);
  const shiftedOnePixel = await image([[62, 410, 266, 44]]);
  expect(
    await observeReferenceOutlines({
      reference,
      current: shiftedOnePixel,
      structure: structure(),
      region,
    }),
  ).toBeNull();
  expect(
    await observeReferenceOutlines({
      reference,
      current: shiftedOnePixel,
      structure: structure('rgb(1, 2, 3)'),
      region,
    }),
  ).toBeNull();
});
