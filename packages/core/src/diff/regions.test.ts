import { describe, it, expect } from 'vitest';
import pixelmatch from 'pixelmatch';
import { computeChangedRegions } from './regions.js';

/**
 * Build a diff buffer shaped the way pixelmatch actually emits one: the whole
 * frame filled with faded-original pixels at full alpha, and only the changed
 * pixels painted red.
 *
 * The fixture must mimic this, not just set alpha on changed pixels — an
 * earlier version did the latter and happily passed while the production code
 * was reporting every diff as a full-viewport region.
 */
function buf(width: number, height: number, pixels: [number, number][]): Buffer {
  const b = Buffer.alloc(width * height * 4);
  // Unchanged background: opaque, non-red.
  for (let i = 0; i < width * height; i++) {
    b[i * 4] = 255;
    b[i * 4 + 1] = 255;
    b[i * 4 + 2] = 255;
    b[i * 4 + 3] = 255;
  }
  // Changed pixels: pixelmatch's red.
  for (const [x, y] of pixels) {
    const o = (y * width + x) * 4;
    b[o] = 255;
    b[o + 1] = 0;
    b[o + 2] = 0;
    b[o + 3] = 255;
  }
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

  it('does not merge vertically distant clusters that share an x-range', () => {
    // The real-world failure this guards: a button changes at the top of the
    // page and a stray antialiased pixel appears near the bottom. Both sit in
    // the same columns, so a merge that checks x-overlap and y-overlap
    // independently swallows the entire viewport into one region and destroys
    // the localization the report exists to provide.
    const pixels: [number, number][] = [];
    for (let y = 20; y < 40; y++) for (let x = 20; x < 100; x++) pixels.push([x, y]);
    pixels.push([50, 700]);

    const regions = computeChangedRegions(buf(1280, 800, pixels), 1280, 800);
    expect(regions).toHaveLength(2);
    // The button-sized cluster must stay button-sized.
    const big = regions.find((r) => r.width > 10)!;
    expect(big.height).toBeLessThan(50);
  });

  it('localizes a real pixelmatch diff instead of returning the whole frame', () => {
    // End-to-end against pixelmatch's actual output format rather than a
    // hand-rolled fixture. This is the test that matters: the hand-rolled
    // fixtures above all passed while production reported every diff as
    // 1280x800, because they encoded the wrong convention for "changed".
    const w = 200;
    const h = 150;
    const a = Buffer.alloc(w * h * 4);
    const b = Buffer.alloc(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      a[i * 4] = a[i * 4 + 1] = a[i * 4 + 2] = 255;
      a[i * 4 + 3] = 255;
      b[i * 4] = b[i * 4 + 1] = b[i * 4 + 2] = 255;
      b[i * 4 + 3] = 255;
    }
    // Recolour a small block, like a button changing colour.
    for (let y = 20; y < 40; y++) {
      for (let x = 10; x < 60; x++) {
        const o = (y * w + x) * 4;
        b[o] = 37;
        b[o + 1] = 99;
        b[o + 2] = 235;
      }
    }

    const diff = Buffer.alloc(w * h * 4);
    const changed = pixelmatch(a, b, diff, w, h, { threshold: 0.1, includeAA: false });
    expect(changed).toBeGreaterThan(0);

    const regions = computeChangedRegions(diff, w, h);
    expect(regions).toHaveLength(1);
    // Must be the block, not the frame.
    expect(regions[0].width).toBeLessThan(w / 2);
    expect(regions[0].height).toBeLessThan(h / 2);
    expect(regions[0].x).toBeGreaterThanOrEqual(9);
    expect(regions[0].y).toBeGreaterThanOrEqual(19);
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
