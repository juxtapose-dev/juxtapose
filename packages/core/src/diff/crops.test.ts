import sharp from 'sharp';
import { expect, test } from 'vitest';
import { MAX_CROPS, MAX_CROP_SIDE, cropBox, renderCrops, scaleFor } from './crops.js';

// The images are made with sharp itself: crops do not interpret page
// content, so a solid frame with one painted rectangle exercises the real
// library end to end without a committed binary.
const rgba = (r: number, g: number, b: number) => ({ r, g, b, alpha: 1 });
async function frame(
  width: number,
  height: number,
  rect?: { x: number; y: number; w: number; h: number },
): Promise<Buffer> {
  let img = sharp({
    create: { width, height, channels: 4, background: rgba(255, 255, 255) },
  });
  if (rect) {
    const red = await sharp({
      create: {
        width: rect.w,
        height: rect.h,
        channels: 4,
        background: rgba(220, 38, 38),
      },
    })
      .png()
      .toBuffer();
    img = img.composite([{ input: red, left: rect.x, top: rect.y }]);
  }
  return img.webp({ lossless: true }).toBuffer();
}
const pixel = async (png: Buffer, x: number, y: number) => {
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  const i = (y * info.width + x) * info.channels;
  return [data[i], data[i + 1], data[i + 2]];
};

test('one region → one strip: 2× box, integer upscale, left baseline, right current', async () => {
  const a = await frame(200, 100);
  const b = await frame(200, 100, { x: 50, y: 20, w: 40, h: 10 });
  const [c] = await renderCrops(a, b, [{ x: 50, y: 20, width: 40, height: 10 }]);
  expect(c.box).toEqual({ x: 30, y: 15, width: 80, height: 20 });
  expect(c.scale).toBe(6); // floor(512 / 80)
  expect(c.width).toBe(80 * 6 * 2 + 4);
  expect(c.height).toBe(20 * 6);
  const meta = await sharp(c.png).metadata();
  expect([meta.width, meta.height, meta.format]).toEqual([c.width, c.height, 'png']);
  // centre of the region, on each side: white on the left, red on the right
  const cx = (50 + 20 - 30) * 6;
  const cy = (20 + 5 - 15) * 6;
  expect(await pixel(c.png, cx, cy)).toEqual([255, 255, 255]);
  expect(await pixel(c.png, 80 * 6 + 4 + cx, cy)).toEqual([220, 38, 38]);
  // nearest-neighbour: the red edge is a hard step, not a blend
  expect(await pixel(c.png, 80 * 6 + 4 + 20 * 6 - 1, cy)).toEqual([255, 255, 255]);
  expect(await pixel(c.png, 80 * 6 + 4 + 20 * 6, cy)).toEqual([220, 38, 38]);
});

test('a region at the edge is clamped to the frame', () => {
  // doubled about the centre: (5, 5) ± 10 → starts at −5, clamped to 0, 20 wide
  expect(
    cropBox({ x: 0, y: 0, width: 10, height: 10 }, { width: 200, height: 100 }),
  ).toEqual({
    x: 0,
    y: 0,
    width: 20,
    height: 20,
  });
  // (195, 97.5) ± (10, 8): x 185..205 → 185..200; y 89.5 → 89 .. 105 → 100
  expect(
    cropBox({ x: 190, y: 95, width: 10, height: 5 }, { width: 200, height: 100 }),
  ).toEqual({ x: 185, y: 89, width: 15, height: 11 });
});

// A region that starts exactly at the right or bottom edge covers no frame
// pixel; clamping it pulled in the last few columns, which did not change.
test('a region starting at x == frame.width or y == frame.height is outside', () => {
  const frame = { width: 200, height: 100 };
  const none = { x: 0, y: 0, width: 0, height: 0 };
  expect(cropBox({ x: 200, y: 10, width: 10, height: 10 }, frame)).toEqual(none);
  expect(cropBox({ x: 10, y: 100, width: 10, height: 10 }, frame)).toEqual(none);
  // and one ending exactly at the left edge
  expect(cropBox({ x: -10, y: 10, width: 10, height: 10 }, frame)).toEqual(none);
  // one px inside is still a box
  expect(cropBox({ x: 199, y: 10, width: 10, height: 10 }, frame).width).toBeGreaterThan(
    0,
  );
});

test('a tiny region gets at least a 16px box', () => {
  const box = cropBox(
    { x: 100, y: 50, width: 2, height: 1 },
    { width: 200, height: 100 },
  );
  expect(box.width).toBeGreaterThanOrEqual(16);
  expect(box.height).toBeGreaterThanOrEqual(16);
});

test('a box longer than 512px is scaled down so the longer side is 512', async () => {
  expect(scaleFor({ x: 0, y: 0, width: 1280, height: 800 })).toBeCloseTo(0.4);
  const a = await frame(1280, 800);
  const b = await frame(1280, 800, { x: 0, y: 0, w: 640, h: 400 });
  const [c] = await renderCrops(a, b, [{ x: 0, y: 0, width: 1280, height: 800 }]);
  const side = (c.width - 4) / 2;
  expect(side).toBe(MAX_CROP_SIDE);
  expect(c.height).toBe(320); // 800 × 0.4
  expect(c.width).toBe(MAX_CROP_SIDE * 2 + 4);
  // The red quadrant (640×400 page px) is 256×160 on the current side, and
  // the reduction keeps the split where it was: red inside, white outside,
  // and the baseline side all white.
  const right = side + 4;
  expect(await pixel(c.png, right + 100, 80)).toEqual([220, 38, 38]);
  expect(await pixel(c.png, right + 250, 155)).toEqual([220, 38, 38]);
  expect(await pixel(c.png, right + 262, 80)).toEqual([255, 255, 255]);
  expect(await pixel(c.png, right + 100, 166)).toEqual([255, 255, 255]);
  expect(await pixel(c.png, 100, 80)).toEqual([255, 255, 255]);
});

test('no regions → one strip of the whole frame', async () => {
  const a = await frame(200, 100);
  const crops = await renderCrops(a, a, []);
  expect(crops).toHaveLength(1);
  expect(crops[0].box).toEqual({ x: 0, y: 0, width: 200, height: 100 });
  expect(crops[0].region).toEqual({ x: 0, y: 0, width: 200, height: 100 });
});

test('at most MAX_CROPS strips, in the order given', async () => {
  const a = await frame(400, 400);
  const regions = Array.from({ length: 50 }, (_, k) => ({
    x: (k % 10) * 40,
    y: Math.floor(k / 10) * 40,
    width: 10,
    height: 10,
  }));
  const crops = await renderCrops(a, a, regions);
  expect(crops).toHaveLength(MAX_CROPS);
  expect(crops.map((c) => c.region)).toEqual(regions.slice(0, MAX_CROPS));
});

test('off-frame regions at the front do not starve valid ones of the cap', async () => {
  const a = await frame(100, 100);
  const off = Array.from({ length: MAX_CROPS }, (_, k) => ({
    x: 1000 + k,
    y: 1000,
    width: 5,
    height: 5,
  }));
  const valid = Array.from({ length: MAX_CROPS + 1 }, (_, k) => ({
    x: k * 10,
    y: 10,
    width: 5,
    height: 5,
  }));
  const crops = await renderCrops(a, a, [...off, ...valid]);
  expect(crops).toHaveLength(MAX_CROPS);
  expect(crops.map((c) => c.region)).toEqual(valid.slice(0, MAX_CROPS));
});

// Review Focus 2
test('images of different sizes crop the overlap and never throw', async () => {
  const a = await frame(200, 100);
  const b = await frame(390, 844, { x: 10, y: 10, w: 20, h: 20 });
  const crops = await renderCrops(a, b, []);
  expect(crops).toHaveLength(1);
  expect(crops[0].box).toEqual({ x: 0, y: 0, width: 200, height: 100 });
  // Both halves come from the overlap: the baseline is all white; the
  // current side shows b's red square (10..30) at scale 2, and white past it.
  const c = crops[0];
  expect(c.scale).toBe(2);
  const right = 200 * 2 + 4;
  expect(await pixel(c.png, 40, 40)).toEqual([255, 255, 255]);
  expect(await pixel(c.png, 399, 199)).toEqual([255, 255, 255]);
  expect(await pixel(c.png, right + 40, 40)).toEqual([220, 38, 38]);
  expect(await pixel(c.png, right + 399, 199)).toEqual([255, 255, 255]);
  // a region entirely outside the overlap is skipped, not an error
  const outside = await renderCrops(a, b, [{ x: 300, y: 500, width: 10, height: 10 }]);
  expect(outside).toEqual([]);
});

test('a zero-area or out-of-bounds region does not throw', async () => {
  const a = await frame(200, 100);
  const crops = await renderCrops(a, a, [
    { x: 50, y: 50, width: 0, height: 0 },
    { x: -500, y: -500, width: 10, height: 10 },
    { x: 1e6, y: 1e6, width: 10, height: 10 },
  ]);
  // the zero-area one still gets a minimum box; the two outside are skipped
  expect(crops).toHaveLength(1);
  expect(crops[0].box.width).toBeGreaterThanOrEqual(16);
});

test('a region touching the bottom-right edge renders a clamped strip', async () => {
  const a = await frame(200, 100);
  const b = await frame(200, 100, { x: 190, y: 90, w: 10, h: 10 });
  const [c] = await renderCrops(a, b, [{ x: 190, y: 90, width: 10, height: 10 }]);
  expect(c.box.x + c.box.width).toBeLessThanOrEqual(200);
  expect(c.box.y + c.box.height).toBeLessThanOrEqual(100);
  const meta = await sharp(c.png).metadata();
  expect([meta.width, meta.height]).toEqual([c.width, c.height]);
});

test('output is byte-stable across renders', async () => {
  const a = await frame(300, 200);
  const b = await frame(300, 200, { x: 40, y: 40, w: 30, h: 30 });
  const regions = [
    { x: 40, y: 40, width: 30, height: 30 },
    { x: 0, y: 0, width: 300, height: 200 },
  ];
  const one = await renderCrops(a, b, regions);
  const two = await renderCrops(a, b, regions);
  expect(one.map((c) => c.png.toString('base64'))).toEqual(
    two.map((c) => c.png.toString('base64')),
  );
});

test('explicit context shows a button below a thin changed band at native scale', async () => {
  const region = { x: 21, y: 206, width: 348, height: 18 };
  const a = await frame(390, 844, { x: 278, y: 258, w: 74, h: 30 });
  const b = await frame(390, 844, { x: 278, y: 264, w: 74, h: 30 });
  const [original] = await renderCrops(a, b, [region]);
  const [zero] = await renderCrops(a, b, [region], { padding: 0 });
  const [context] = await renderCrops(a, b, [region], { padding: 96 });
  expect(zero.png).toEqual(original.png);
  expect(original.box).toEqual({ x: 0, y: 197, width: 390, height: 36 });
  expect(context.box).toEqual({ x: 0, y: 110, width: 390, height: 210 });
  expect(context.scale).toBe(1);
  expect(await pixel(context.png, 283, 153)).toEqual([220, 38, 38]);
  expect(await pixel(context.png, 390 + 4 + 283, 159)).toEqual([220, 38, 38]);
  expect(context.region).toEqual(region);
});

test('large context clamps to the shared extent without unsafe arithmetic', async () => {
  const a = await frame(100, 80),
    b = await frame(70, 60);
  const [crop] = await renderCrops(a, b, [{ x: 1, y: 1, width: 2, height: 2 }], {
    padding: Number.MAX_SAFE_INTEGER,
  });
  expect(crop.box).toEqual({ x: 0, y: 0, width: 70, height: 60 });
});

test.each([
  -1,
  1.5,
  NaN,
  Infinity,
  Number.MAX_SAFE_INTEGER + 1,
  null as unknown as number,
])('invalid context padding %s is refused', (padding) => {
  expect(() =>
    cropBox({ x: 1, y: 1, width: 2, height: 2 }, { width: 100, height: 80 }, { padding }),
  ).toThrow('non-negative safe integer');
});
