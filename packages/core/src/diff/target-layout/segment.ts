import type { EvidenceBlock, RgbaImage, TargetEvidence } from './index.js';
import { createHash } from 'node:crypto';

interface Run {
  start: number;
  end: number;
  color: number;
  node: number;
}
interface Component {
  parent: number;
  color: number;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  area: number;
}
const MAX_RUNS = 40_000;
const MAX_BLOCKS = 256;

/** Exact-color row components are a conservative first producer. A bounded
 * run count makes photographs abstain rather than allocate a pixel index;
 * corpus timings, not large-DOM synthetic tests, decide whether to keep it. */
export function fromPng(image: RgbaImage): TargetEvidence {
  const { data, width, height } = image;
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    data.length !== width * height * 4
  )
    throw new Error('target layout requires exact RGBA extent');
  const result: TargetEvidence = {
    schema: 'juxtapose.target-evidence/v1',
    width,
    height,
    blocks: [],
    abstained: { complexity: false, nonRectangular: 0, omitted: 0 },
  };
  const nodes: Component[] = [];
  const root = (id: number): number => {
    while (nodes[id]!.parent !== id) {
      nodes[id]!.parent = nodes[nodes[id]!.parent]!.parent;
      id = nodes[id]!.parent;
    }
    return id;
  };
  const union = (a: number, b: number) => {
    a = root(a);
    b = root(b);
    if (a === b) return;
    if (a > b) [a, b] = [b, a];
    const left = nodes[a]!,
      right = nodes[b]!;
    right.parent = a;
    left.x0 = Math.min(left.x0, right.x0);
    left.x1 = Math.max(left.x1, right.x1);
    left.y0 = Math.min(left.y0, right.y0);
    left.y1 = Math.max(left.y1, right.y1);
    left.area += right.area;
  };
  const colorAt = (offset: number) =>
    data[offset + 3] === 255
      ? (data[offset]! << 16) | (data[offset + 1]! << 8) | data[offset + 2]!
      : -1;
  let previous: Run[] = [];
  for (let y = 0; y < height; y++) {
    const row: Run[] = [];
    let cursor = 0;
    for (let x = 0; x < width;) {
      const start = x,
        color = colorAt((y * width + x) * 4);
      while (++x < width && colorAt((y * width + x) * 4) === color) {
        /* contiguous pixels */
      }
      if (color < 0) continue;
      if (nodes.length === MAX_RUNS) {
        result.abstained.complexity = true;
        return result;
      }
      const node = nodes.length;
      nodes.push({
        parent: node,
        color,
        x0: start,
        x1: x,
        y0: y,
        y1: y + 1,
        area: x - start,
      });
      while (cursor < previous.length && previous[cursor]!.end <= start) cursor++;
      for (let i = cursor; i < previous.length && previous[i]!.start < x; i++)
        if (previous[i]!.color === color) union(node, previous[i]!.node);
      row.push({ start, end: x, color, node });
    }
    previous = row;
  }
  const components = nodes.filter((_node, i) => root(i) === i);
  let background: Component | undefined;
  for (const c of components) {
    const edges =
      Number(c.x0 === 0) +
      Number(c.y0 === 0) +
      Number(c.x1 === width) +
      Number(c.y1 === height);
    if (edges >= 2 && (!background || c.area > background.area)) background = c;
  }
  const blocks: EvidenceBlock[] = [];
  for (const c of components) {
    if (c === background || c.area < 16) continue;
    const w = c.x1 - c.x0,
      h = c.y1 - c.y0;
    if (w < 4 || h < 4 || c.area / (w * h) < 0.8) {
      result.abstained.nonRectangular++;
      continue;
    }
    const content = contentFingerprint(image, c);
    blocks.push({
      id: '',
      box: { x: c.x0, y: c.y0, width: w, height: h },
      fill: [c.color >> 16, (c.color >> 8) & 255, c.color & 255],
      solidArea: c.area,
      ...(content ? { content } : {}),
      children: [],
      provenance: 'measured-from-pixels',
      confidenceRule:
        'opaque-exact-color-component; >=16 solid pixels; >=80% rectangular occupancy; not canvas background',
    });
  }
  blocks.sort(
    (a, b) =>
      a.box.y - b.box.y || a.box.x - b.box.x || (b.solidArea ?? 0) - (a.solidArea ?? 0),
  );
  result.abstained.omitted = Math.max(0, blocks.length - MAX_BLOCKS);
  result.blocks = blocks
    .slice(0, MAX_BLOCKS)
    .map((block, i) => ({ ...block, id: `pixel:${i}` }));
  return result;
}

/** The first 30 real pairs yielded only 12 geometry facts: blank repeated
 * controls correctly abstained. Unchanged inner paint can distinguish some
 * repeated fills without OCR. Exact bytes deliberately reject font/AA drift. */
export function contentFingerprint(
  image: RgbaImage,
  c: Pick<Component, 'x0' | 'x1' | 'y0' | 'y1' | 'color'>,
): EvidenceBlock['content'] {
  const w = c.x1 - c.x0,
    h = c.y1 - c.y0;
  if (w < 24 || h < 24) return undefined;
  const inset = 6;
  let x0 = c.x1,
    x1 = c.x0,
    y0 = c.y1,
    y1 = c.y0,
    pixels = 0;
  for (let y = c.y0 + inset; y < c.y1 - inset; y++) {
    for (let x = c.x0 + inset; x < c.x1 - inset; x++) {
      const i = (y * image.width + x) * 4;
      const rgb = (image.data[i]! << 16) | (image.data[i + 1]! << 8) | image.data[i + 2]!;
      if (image.data[i + 3] === 255 && rgb === c.color) continue;
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x + 1);
      y0 = Math.min(y0, y);
      y1 = Math.max(y1, y + 1);
      pixels++;
    }
  }
  if (pixels < 8) return undefined;
  const hash = createHash('sha256');
  for (let y = y0; y < y1; y++)
    hash.update(
      image.data.subarray((y * image.width + x0) * 4, (y * image.width + x1) * 4),
    );
  return { width: x1 - x0, height: y1 - y0, sha256: hash.digest('hex') };
}
