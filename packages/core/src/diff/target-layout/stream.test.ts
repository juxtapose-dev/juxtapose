import { expect, test } from 'vitest';
import sharp from 'sharp';
import { fromPng } from './segment.js';
import { fromPngStreaming } from './stream.js';
import { extractTargetEvidence, extractTargetEvidenceStreaming } from './index.js';

test('streaming preserves exact geometry, fill, abstentions and fingerprints across joins and splits', () => {
  for (let seed = 1; seed <= 80; seed++) {
    let state = seed;
    const next = () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state;
    };
    const width = 48,
      height = 48,
      data = Buffer.alloc(width * height * 4, 255);
    for (let n = 0; n < 20; n++) {
      const x = next() % 40,
        y = next() % 40,
        w = 1 + (next() % 8),
        h = 1 + (next() % 8),
        color = next() % 4;
      for (let yy = y; yy < y + h; yy++)
        for (let xx = x; xx < x + w; xx++) {
          const i = (yy * width + xx) * 4;
          data[i] = color * 50;
          data[i + 1] = color * 30;
          data[i + 2] = color * 10;
          data[i + 3] = color === 3 ? 0 : 255;
        }
    }
    const image = { data, width, height };
    expect(fromPngStreaming(image)).toEqual(fromPng(image));
  }
});

test('excluded non-rectangular canvas background does not inflate abstentions', () => {
  const width = 40,
    height = 40,
    data = Buffer.alloc(width * height * 4, 255);
  for (let y = 2; y < 38; y++)
    for (let x = 2; x < 38; x++) {
      const i = (y * width + x) * 4;
      data[i] = 10;
      data[i + 1] = 20;
      data[i + 2] = 30;
    }
  expect(fromPngStreaming({ data, width, height })).toEqual(
    fromPng({ data, width, height }),
  );
});

test('equal-area background uses first pixel order rather than component completion order', () => {
  const width = 8,
    height = 8,
    data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const first = x < 2 || y >= 6;
      const second = x >= 2 && (y < 4 || (y === 4 && x >= 4));
      if (!first && !second) continue;
      const i = (y * width + x) * 4;
      data[i] = first ? 20 : 100;
      data[i + 1] = first ? 30 : 110;
      data[i + 2] = first ? 40 : 120;
      data[i + 3] = 255;
    }
  const image = { data, width, height };
  expect(fromPngStreaming(image)).toEqual(fromPng(image));
  expect(fromPngStreaming(image).blocks).toHaveLength(1);
});

test('opt-in PNG extraction recovers a flat region after more than 40000 exact-color runs', async () => {
  const width = 512,
    height = 128,
    data = Buffer.alloc(width * height * 4, 255);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = i >> 16;
    data[i * 4 + 1] = (i >> 8) & 255;
    data[i * 4 + 2] = i & 255;
  }
  for (let y = 20; y < 60; y++)
    for (let x = 20; x < 120; x++) {
      const i = (y * width + x) * 4;
      data[i] = 10;
      data[i + 1] = 20;
      data[i + 2] = 30;
    }
  const png = await sharp(data, { raw: { width, height, channels: 4 } })
    .png()
    .toBuffer();
  expect((await extractTargetEvidence(png)).abstained.complexity).toBe(true);
  const result = await extractTargetEvidenceStreaming(png);
  expect(result.abstained.complexity).toBe(false);
  expect(result.blocks).toEqual([
    expect.objectContaining({
      box: { x: 20, y: 20, width: 100, height: 40 },
      fill: [10, 20, 30],
      solidArea: 4000,
    }),
  ]);
  expect(await extractTargetEvidenceStreaming(png)).toEqual(result);
});

test('streaming retains inner paint fingerprints and bounded failure behavior', () => {
  const width = 64,
    height = 64,
    data = Buffer.alloc(width * height * 4, 255);
  for (let y = 10; y < 50; y++)
    for (let x = 10; x < 50; x++) {
      const i = (y * width + x) * 4;
      data[i] = 10;
      data[i + 1] = 20;
      data[i + 2] = 30;
    }
  for (let y = 25; y < 28; y++)
    for (let x = 25; x < 29; x++)
      data.fill(0, (y * width + x) * 4, (y * width + x) * 4 + 3);
  const result = fromPngStreaming({ data, width, height });
  expect(result).toEqual(fromPng({ data, width, height }));
  expect(result.blocks.some((block) => block.content)).toBe(true);
  const hugeRow = Buffer.alloc(40001 * 4, 255);
  for (let i = 0; i < 40001; i++) {
    hugeRow[i * 4] = i >> 8;
    hugeRow[i * 4 + 1] = i & 255;
  }
  expect(fromPngStreaming({ data: hugeRow, width: 40001, height: 1 })).toMatchObject({
    blocks: [],
    abstained: { complexity: true },
  });
  expect(() => fromPngStreaming({ data: Buffer.alloc(3), width: 1, height: 1 })).toThrow(
    'exact RGBA',
  );
});
