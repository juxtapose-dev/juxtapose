import { expect, test } from 'vitest';
import { loupeGeometry } from './loupe-geometry.js';

// A 1280px capture rendered into a 640px panel: every source coordinate is
// twice the display one. Getting this wrong magnifies the wrong region and
// still looks plausible, which is why it is the first test.
const scaled = { width: 640, height: 400, naturalWidth: 1280, size: 100, zoom: 4 };

test('samples from source pixels, not display pixels', () => {
  const g = loupeGeometry({ x: 320, y: 100, ...scaled });
  // 320 display -> 640 source, centred on a 25px window.
  expect(g.sw).toBe(25);
  expect(g.sx).toBe(640 - 12.5);
  expect(g.sy).toBe(200 - 12.5);
});

test('an unscaled image samples where the cursor is', () => {
  const g = loupeGeometry({
    x: 300,
    y: 200,
    width: 800,
    height: 600,
    naturalWidth: 800,
    size: 100,
    zoom: 4,
  });
  expect(g.sx).toBe(300 - 12.5);
  expect(g.sy).toBe(200 - 12.5);
});

// At an edge the lens would hang off the frame and be clipped by the frame's
// `overflow: hidden`, hiding the very pixels being inspected.
test('the lens stays inside the frame at every corner', () => {
  const topLeft = loupeGeometry({ x: 0, y: 0, ...scaled });
  expect(topLeft.left).toBe(0);
  expect(topLeft.top).toBe(0);

  const bottomRight = loupeGeometry({ x: 640, y: 400, ...scaled });
  expect(bottomRight.left).toBe(640 - 100);
  expect(bottomRight.top).toBe(400 - 100);
});

test('the lens centres on the cursor away from the edges', () => {
  const g = loupeGeometry({ x: 320, y: 200, ...scaled });
  expect(g.left).toBe(320 - 50);
  expect(g.top).toBe(200 - 50);
});
