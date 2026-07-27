import { describe, it, expect } from 'vitest';
import { computeChangedRegions } from './regions.js';

/** Build an RGBA diff buffer with the given pixels marked changed. */
function buf(width: number, height: number, pixels: [number, number][]): Buffer {
  const b = Buffer.alloc(width * height * 4);
  for (const [x, y] of pixels) b[(y * width + x) * 4 + 3] = 255;
  return b;
}

describe('computeChangedRegions', () => {
  it('returns nothing for an unchanged buffer', () => {
    expect(computeChangedRegions(buf(10, 10, []), 10, 10)).toEqual([]);
  });

  it('boxes a single changed pixel', () => {
    expect(computeChangedRegions(buf(10, 10, [[3, 4]]), 10, 10)).toEqual([
      { x: 3, y: 4, width: 1, height: 1 },
    ]);
  });

  it('merges a contiguous block into one region', () => {
    const pixels: [number, number][] = [];
    for (let y = 2; y < 6; y++) for (let x = 1; x < 5; x++) pixels.push([x, y]);
    expect(computeChangedRegions(buf(20, 20, pixels), 20, 20)).toEqual([
      { x: 1, y: 2, width: 4, height: 4 },
    ]);
  });

  it('keeps far-apart clusters separate', () => {
    const regions = computeChangedRegions(buf(100, 100, [[1, 1], [90, 90]]), 100, 100);
    expect(regions).toHaveLength(2);
  });

  it('merges clusters within the gap tolerance', () => {
    // 4px apart, default gap is 8 — one region.
    const regions = computeChangedRegions(buf(100, 100, [[10, 10], [14, 10]]), 100, 100);
    expect(regions).toEqual([{ x: 10, y: 10, width: 5, height: 1 }]);
  });

  it('joins two boxes bridged by a later span', () => {
    // The regression the original had: two separate columns established first,
    // then a row that touches both. A greedy first-match merge reports 2.
    const pixels: [number, number][] = [
      [0, 0], [0, 1], [0, 2],       // left column
      [40, 0], [40, 1], [40, 2],    // right column, beyond gap
    ];
    // Bridge row spanning both, added last.
    for (let x = 0; x <= 40; x++) pixels.push([x, 3]);

    const regions = computeChangedRegions(buf(60, 60, pixels), 60, 60);
    expect(regions).toEqual([{ x: 0, y: 0, width: 41, height: 4 }]);
  });
});
