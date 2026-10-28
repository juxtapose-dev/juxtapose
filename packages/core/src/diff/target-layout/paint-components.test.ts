import { expect, test } from 'vitest';
import sharp from 'sharp';
import { fromPng, extractTargetEvidence, type RgbaImage } from './index.js';
import type { PaintComponentEvidence } from './paint-components.js';

function canvas(width: number, height: number): RgbaImage {
  return { width, height, data: new Uint8Array(width * height * 4).fill(255) };
}
function fill(image: RgbaImage, x: number, y: number) {
  const i = (y * image.width + x) * 4;
  image.data.set([48, 95, 155, 255], i);
}
function pill(): RgbaImage {
  const image = canvas(100, 80);
  for (let y = 0; y < 24; y++)
    for (let x = 0; x < 40; x++)
      if (((x - 19.5) / 20) ** 2 + ((y - 11.5) / 12) ** 2 <= 1)
        fill(image, 10 + x, 10 + y);
  // A text-shaped hole reduces fill occupancy without changing its extent.
  for (let y = 18; y < 26; y++)
    for (let x = 24; x < 36; x++)
      image.data.set([255, 255, 255, 255], (y * image.width + x) * 4);
  return image;
}

test('rounded paint is observed separately without relaxing rectangular layout matching', () => {
  const image = pill();
  let paint!: PaintComponentEvidence;
  const original = fromPng(image);
  const observed = fromPng(image, (evidence) => {
    paint = evidence;
  });
  expect(observed).toEqual(original);
  expect(original.blocks.some((b) => b.fill?.[0] === 48)).toBe(false);
  const blue = paint.components.find((c) => c.fill[0] === 48)!;
  expect(blue.box).toEqual({ x: 10, y: 10, width: 40, height: 24 });
  const exactBluePixels = Array.from(
    { length: image.width * image.height },
    (_, i) => image.data[i * 4] === 48,
  ).filter(Boolean).length;
  expect(blue.solidArea).toBe(exactBluePixels);
  expect(blue.solidArea / (40 * 24)).toBeLessThan(0.8);
  expect(paint.complexity).toBe(false);
});

test('complexity exhaustion does not expose a partial paint inventory', () => {
  const image = canvas(256, 256);
  for (let y = 0; y < image.height; y++)
    for (let x = 0; x < image.width; x++) if ((x + y) % 2) fill(image, x, y);
  let paint!: PaintComponentEvidence;
  const result = fromPng(image, (evidence) => {
    paint = evidence;
  });
  expect(result.abstained.complexity).toBe(true);
  expect(paint).toEqual({
    width: 256,
    height: 256,
    components: [],
    omittedComponents: 0,
    complexity: true,
  });
});

test('complete component observations stay sorted and bounded with explicit omissions', () => {
  const image = canvas(443, 307);
  for (let row = 0; row < 17; row++)
    for (let col = 0; col < 17; col++)
      for (let y = 1 + row * 18; y < 17 + row * 18; y++)
        for (let x = 1 + col * 26; x < 25 + col * 26; x++) fill(image, x, y);
  let paint!: PaintComponentEvidence;
  fromPng(image, (evidence) => {
    paint = evidence;
  });
  expect(paint.complexity).toBe(false);
  expect(paint.components).toHaveLength(256);
  expect(paint.omittedComponents).toBe(33);
  expect(paint.components[0]?.box).toEqual({ x: 1, y: 1, width: 24, height: 16 });
  let again!: PaintComponentEvidence;
  fromPng(image, (evidence) => {
    again = evidence;
  });
  expect(again).toEqual(paint);
});

test('the optional observer receives the same decoded pixels and finishes before return', async () => {
  const image = pill();
  const png = await sharp(image.data, {
    raw: { width: image.width, height: image.height, channels: 4 },
  })
    .png()
    .toBuffer();
  let calls = 0;
  let finished = false;
  const layout = await extractTargetEvidence(png, async (rgba, paint) => {
    calls++;
    expect(Buffer.from(rgba.data)).toEqual(Buffer.from(image.data));
    expect(paint.components.some((c) => c.fill[0] === 48)).toBe(true);
    await Promise.resolve();
    finished = true;
  });
  expect(calls).toBe(1);
  expect(finished).toBe(true);
  expect(layout).toEqual(fromPng(image));
});

test('a member pixel disambiguates disconnected components with overlapping bounds', () => {
  const image = canvas(100, 80);
  // An L's bounding box also contains a separate same-color rectangle. The
  // first matching pixel inside the L's box belongs to the other component.
  for (let y = 10; y < 50; y++) fill(image, 49, y);
  for (let x = 10; x < 50; x++) fill(image, x, 49);
  for (let y = 10; y < 26; y++) for (let x = 12; x < 36; x++) fill(image, x, y);
  let paint!: PaintComponentEvidence;
  fromPng(image, (evidence) => {
    paint = evidence;
  });
  const ell = paint.components.find((c) => c.box.width === 40)!;
  expect(ell).toEqual({
    box: { x: 10, y: 10, width: 40, height: 40 },
    fill: [48, 95, 155],
    solidArea: 79,
    seed: { x: 49, y: 10 },
  });
  expect(paint.components.find((c) => c.box.width === 24)?.seed).toEqual({
    x: 12,
    y: 10,
  });
});
