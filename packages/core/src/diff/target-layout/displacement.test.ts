import { expect, test } from 'vitest';
import { findExactDisplacements } from './displacement.js';
import type { RgbaImage } from './index.js';

function noise(width = 384, height = 384): RgbaImage {
  const data = Buffer.alloc(width * height * 4, 255);
  let state = 123;
  for (let i = 0; i < data.length; i += 4) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    data[i] = state >>> 24;
    data[i + 1] = (state >>> 16) & 255;
    data[i + 2] = (state >>> 8) & 255;
  }
  return { data, width, height };
}
function shifted(image: RgbaImage, dx: number, dy: number): RgbaImage {
  const data = Buffer.alloc(image.data.length, 255);
  for (let y = 0; y < image.height; y++)
    for (let x = 0; x < image.width; x++) {
      const sx = x - dx,
        sy = y - dy;
      if (sx < 0 || sy < 0 || sx >= image.width || sy >= image.height) continue;
      const a = (y * image.width + x) * 4,
        b = (sy * image.width + sx) * 4;
      for (let c = 0; c < 4; c++) data[a + c] = image.data[b + c]!;
    }
  return { ...image, data };
}
function verifyAll(reference: RgbaImage, current: RgbaImage) {
  const result = findExactDisplacements(reference, current);
  for (const observation of result.observations) {
    const a = observation.currentBox,
      b = observation.referenceBox;
    expect(observation.dx).toBe(a.x - b.x);
    expect(observation.dy).toBe(a.y - b.y);
    for (let y = 0; y < a.height; y++) {
      const left = current.data.subarray(
        ((a.y + y) * current.width + a.x) * 4,
        ((a.y + y) * current.width + a.x + a.width) * 4,
      );
      const right = reference.data.subarray(
        ((b.y + y) * reference.width + b.x) * 4,
        ((b.y + y) * reference.width + b.x + b.width) * 4,
      );
      expect(Buffer.from(left).equals(Buffer.from(right))).toBe(true);
    }
  }
  expect(result.observations.length).toBeLessThanOrEqual(3);
  for (const [i, a] of result.observations.entries())
    expect(
      result.observations.some(
        (b, j) =>
          j !== i &&
          a.dx === b.dx &&
          a.dy === b.dy &&
          a.currentBox.x >= b.currentBox.x &&
          a.currentBox.y >= b.currentBox.y &&
          a.currentBox.x + a.currentBox.width <= b.currentBox.x + b.currentBox.width &&
          a.currentBox.y + a.currentBox.height <= b.currentBox.y + b.currentBox.height,
      ),
    ).toBe(false);
  expect(result.stats.searched).toBeLessThanOrEqual(12);
  expect(result.stats.verificationPixelBudgetUsed).toBeLessThanOrEqual(4_000_000);
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(3072);
  return result;
}

test('automatically finds positive/negative and one-pixel translations with full-region verification', () => {
  const reference = noise();
  for (const [dx, dy] of [
    [0, 1],
    [3, -4],
    [-8, 8],
  ]) {
    const current = shifted(reference, dx!, dy!),
      result = verifyAll(reference, current);
    expect(result.status).toBe('measured');
    expect(result.observations.length).toBeGreaterThan(0);
    expect(result.observations.every((o) => o.dx === dx && o.dy === dy)).toBe(true);
    expect(findExactDisplacements(reference, current)).toEqual(result);
  }
});

test('sample matches do not pass when unsampled bytes changed', () => {
  const reference = noise(),
    current = shifted(reference, 0, 1);
  for (let y = 1; y < current.height; y += 2)
    for (let x = 1; x < current.width; x += 2)
      current.data[(y * current.width + x) * 4] =
        255 - current.data[(y * current.width + x) * 4]!;
  const result = verifyAll(reference, current);
  expect(result.observations).toEqual([]);
  expect(result.stats.verificationRejected).toBeGreaterThan(0);
});

test('flat, unchanged, repeated-pattern and out-of-window evidence abstains', () => {
  const reference = noise();
  expect(findExactDisplacements(reference, reference).observations).toEqual([]);
  expect(
    findExactDisplacements(reference, shifted(reference, 0, 9)).observations,
  ).toEqual([]);
  expect(
    findExactDisplacements(reference, shifted(reference, 0, 9), { radius: 16 })
      .observations.length,
  ).toBeGreaterThan(0);
  const flat = { data: Buffer.alloc(384 * 384 * 4, 255), width: 384, height: 384 };
  expect(findExactDisplacements(flat, flat).observations).toEqual([]);
  const pattern = noise();
  for (let y = 0; y < pattern.height; y++)
    for (let x = 0; x < pattern.width; x++) {
      const i = (y * pattern.width + x) * 4;
      pattern.data[i] = (x % 6) * 40;
      pattern.data[i + 1] = (y % 6) * 40;
      pattern.data[i + 2] = ((x + y) % 6) * 40;
    }
  const repeated = verifyAll(pattern, shifted(pattern, 0, 1));
  expect(repeated.observations).toEqual([]);
  expect(repeated.stats.ambiguous).toBeGreaterThan(0);
});

test('changed content may not be covered by an accepted exact region', () => {
  const reference = noise(),
    current = shifted(reference, 2, 1);
  const x = 200,
    y = 200;
  current.data[(y * current.width + x) * 4] ^= 255;
  const result = verifyAll(reference, current);
  expect(result.observations.length).toBeGreaterThan(0);
  expect(
    result.observations.every(
      ({ currentBox: b }) =>
        !(x >= b.x && y >= b.y && x < b.x + b.width && y < b.y + b.height),
    ),
  ).toBe(true);
});

test('invalid geometry and radius are rejected; tiny extents explicitly abstain', () => {
  const reference = noise();
  expect(() => findExactDisplacements(reference, { ...reference, height: 1 })).toThrow(
    'RGBA extent',
  );
  expect(() => findExactDisplacements(reference, noise(320, 384))).toThrow(
    'equal image extents',
  );
  for (const radius of [0, 65, 1.5])
    expect(() => findExactDisplacements(reference, reference, { radius })).toThrow(
      'radius',
    );
  expect(findExactDisplacements(noise(32, 32), noise(32, 32))).toMatchObject({
    status: 'abstained',
    reason: 'small-extent',
    observations: [],
  });
});

test('fully transparent RGB patterns cannot produce visible displacement evidence', () => {
  const reference = noise();
  for (let i = 3; i < reference.data.length; i += 4) reference.data[i] = 0;
  const current = shifted(reference, 0, 1);
  expect(findExactDisplacements(reference, current)).toMatchObject({
    status: 'abstained',
    observations: [],
  });
});
