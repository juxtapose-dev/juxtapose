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
  expect(Math.max(side, c.height)).toBeLessThanOrEqual(MAX_CROP_SIDE);
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

// Review Focus 2
test('images of different sizes crop the overlap and never throw', async () => {
  const a = await frame(200, 100);
  const b = await frame(390, 844, { x: 10, y: 10, w: 20, h: 20 });
  const crops = await renderCrops(a, b, []);
  expect(crops).toHaveLength(1);
  expect(crops[0].box).toEqual({ x: 0, y: 0, width: 200, height: 100 });
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
