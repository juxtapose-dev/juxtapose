import type { EvidenceBlock, RgbaImage, TargetEvidence } from './index.js';
import { contentFingerprint } from './segment.js';

interface Component {
  id: number;
  parent: Component | null;
  color: number;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  area: number;
}
interface Run {
  start: number;
  end: number;
  color: number;
  node: Component;
}
const MAX_ROW_RUNS = 40_000;
const MAX_CANDIDATES = 40_000;
const MAX_BLOCKS = 256;

/** The website reference has 234780 row runs but only 797 simultaneously live
 * components. Finalize components after their last row instead of exhausting
 * the cumulative 40000-run budget. No pixel or short-run filtering is applied. */
export function fromPngStreaming(image: RgbaImage): TargetEvidence {
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
  const candidates: Component[] = [];
  let background: Component | undefined;
  let previous: Run[] = [];
  let active = new Set<Component>();
  let sequence = 0;
  const root = (node: Component): Component => {
    let found = node;
    while (found.parent) found = found.parent;
    while (node.parent) {
      const next = node.parent;
      node.parent = found;
      node = next;
    }
    return found;
  };
  const union = (left: Component, right: Component) => {
    left = root(left);
    right = root(right);
    if (left === right) return;
    if (left.id > right.id) [left, right] = [right, left];
    right.parent = left;
    left.x0 = Math.min(left.x0, right.x0);
    left.x1 = Math.max(left.x1, right.x1);
    left.y0 = Math.min(left.y0, right.y0);
    left.y1 = Math.max(left.y1, right.y1);
    left.area += right.area;
  };
  const rectangular = (c: Component) => {
    const w = c.x1 - c.x0,
      h = c.y1 - c.y0;
    return w >= 4 && h >= 4 && c.area / (w * h) >= 0.8;
  };
  const finish = (c: Component) => {
    const edges =
      Number(c.x0 === 0) +
      Number(c.y0 === 0) +
      Number(c.x1 === width) +
      Number(c.y1 === height);
    if (
      edges >= 2 &&
      (!background ||
        c.area > background.area ||
        (c.area === background.area && c.id < background.id))
    )
      background = c;
    if (c.area < 16) return;
    if (!rectangular(c)) {
      result.abstained.nonRectangular++;
      return;
    }
    if (candidates.length === MAX_CANDIDATES) {
      result.abstained.complexity = true;
      return;
    }
    candidates.push(c);
  };
  const colorAt = (offset: number) =>
    data[offset + 3] === 255
      ? (data[offset]! << 16) | (data[offset + 1]! << 8) | data[offset + 2]!
      : -1;
  for (let y = 0; y < height; y++) {
    const row: Run[] = [];
    let cursor = 0;
    for (let x = 0; x < width;) {
      const start = x,
        color = colorAt((y * width + x) * 4);
      while (++x < width && colorAt((y * width + x) * 4) === color) {
        /* exact row run */
      }
      if (color < 0) continue;
      if (row.length === MAX_ROW_RUNS) {
        result.abstained.complexity = true;
        return result;
      }
      const node: Component = {
        id: sequence++,
        parent: null,
        color,
        x0: start,
        x1: x,
        y0: y,
        y1: y + 1,
        area: x - start,
      };
      while (cursor < previous.length && previous[cursor]!.end <= start) cursor++;
      for (let i = cursor; i < previous.length && previous[i]!.start < x; i++)
        if (previous[i]!.color === color) union(node, previous[i]!.node);
      row.push({ start, end: x, color, node });
    }
    const next = new Set<Component>();
    for (const run of row) {
      run.node = root(run.node);
      next.add(run.node);
    }
    const ended = new Set<Component>();
    for (const node of active) {
      const found = root(node);
      if (!next.has(found)) ended.add(found);
    }
    for (const node of ended) finish(node);
    previous = row;
    active = next;
    if (result.abstained.complexity) return result;
  }
  for (const node of active) finish(node);
  if (result.abstained.complexity) return result;
  // Canvas background is excluded before this count in the original producer.
  if (background && background.area >= 16 && !rectangular(background))
    result.abstained.nonRectangular--;
  const ordered = candidates
    .filter((c) => c !== background)
    .sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0 || b.area - a.area);
  result.abstained.omitted = Math.max(0, ordered.length - MAX_BLOCKS);
  result.blocks = ordered.slice(0, MAX_BLOCKS).map((c, i): EvidenceBlock => {
    const content = contentFingerprint(image, c);
    return {
      id: `pixel:${i}`,
      box: { x: c.x0, y: c.y0, width: c.x1 - c.x0, height: c.y1 - c.y0 },
      fill: [c.color >> 16, (c.color >> 8) & 255, c.color & 255],
      solidArea: c.area,
      ...(content ? { content } : {}),
      children: [],
      provenance: 'measured-from-pixels',
      confidenceRule:
        'opaque-exact-color-component; >=16 solid pixels; >=80% rectangular occupancy; not canvas background',
    };
  });
  return result;
}
