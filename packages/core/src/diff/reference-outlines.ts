import sharp from 'sharp';
import type { ChangedRegion, StructureSnapshot } from '../types.js';

export interface OutlineBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ReferenceOutlineObservation {
  kind: 'border-outline-geometry/v1';
  targetBoxes: OutlineBox[];
  currentBoxes: OutlineBox[];
  note: 'Matched-color border outlines in target and current pixels; element identity and CSS cause are unknown.';
}

interface RawImage {
  data: Buffer;
  width: number;
  height: number;
}

const NOTE =
  'Matched-color border outlines in target and current pixels; element identity and CSS cause are unknown.' as const;

function textboxBorderColor(
  structure: StructureSnapshot,
): [number, number, number] | null {
  const counts = new Map<string, number>();
  for (const element of structure.elements) {
    if (element.role !== 'textbox') continue;
    const color = element.styles['border-top-color'];
    if (color && /^rgb\(\d+, \d+, \d+\)$/.test(color))
      counts.set(color, (counts.get(color) ?? 0) + 1);
  }
  const selected = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (!selected) return null;
  const values = selected.match(/\d+/g)?.map(Number);
  return values?.length === 3 ? [values[0]!, values[1]!, values[2]!] : null;
}

async function pixels(image: Buffer): Promise<RawImage> {
  const { data, info } = await sharp(image)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.channels !== 4) throw new Error('outline probe expected RGBA pixels');
  return { data, width: info.width, height: info.height };
}

function matches(
  image: RawImage,
  x: number,
  y: number,
  color: readonly [number, number, number],
): boolean {
  const offset = (y * image.width + x) * 4;
  return (
    image.data[offset + 3]! >= 250 &&
    Math.abs(image.data[offset]! - color[0]) <= 8 &&
    Math.abs(image.data[offset + 1]! - color[1]) <= 8 &&
    Math.abs(image.data[offset + 2]! - color[2]) <= 8
  );
}

function hasSide(
  image: RawImage,
  from: number,
  to: number,
  y: number,
  color: readonly [number, number, number],
): boolean {
  for (let x = Math.max(0, from); x < Math.min(image.width, to); x++)
    if (matches(image, x, y, color)) return true;
  return false;
}

function sideRatio(
  image: RawImage,
  from: number,
  to: number,
  startY: number,
  endY: number,
  color: readonly [number, number, number],
): number {
  let present = 0;
  for (let y = startY; y < endY; y++) if (hasSide(image, from, to, y, color)) present++;
  return present / Math.max(1, endY - startY);
}

function findOutlines(
  image: RawImage,
  color: readonly [number, number, number],
  region: ChangedRegion,
): OutlineBox[] | null {
  const x0 = Math.max(0, region.x - 100);
  const x1 = Math.min(image.width, region.x + region.width + 100);
  const y0 = Math.max(0, region.y - 100);
  const y1 = Math.min(image.height, region.y + region.height + 100);
  // A diagnostic must not make a huge screenshot significantly slower.
  if (image.width * (y1 - y0) > 2_000_000) return null;
  const rows: Array<{ x: number; y: number; end: number }> = [];
  for (let y = y0; y < y1; y++) {
    let start = -1;
    for (let x = 0; x <= image.width; x++) {
      const match = x < image.width && matches(image, x, y, color);
      if (match && start === -1) start = x;
      if (!match && start !== -1) {
        if (x - start >= 40 && start < x1 && x > x0) rows.push({ x: start, y, end: x });
        start = -1;
      }
    }
    if (rows.length > 256) return null;
  }
  const boxes: OutlineBox[] = [];
  for (let i = 0; i < rows.length; i++) {
    const top = rows[i]!;
    for (let j = i + 1; j < rows.length; j++) {
      const bottom = rows[j]!;
      const gap = bottom.y - top.y;
      if (gap > 100) break;
      if (
        gap < 20 ||
        Math.abs(top.x - bottom.x) > 2 ||
        Math.abs(top.end - bottom.end) > 2
      )
        continue;
      const sideStart = top.y + 2;
      const sideEnd = bottom.y - 1;
      if (
        sideRatio(image, top.x - 10, top.x - 1, sideStart, sideEnd, color) < 0.7 ||
        sideRatio(image, top.end, top.end + 10, sideStart, sideEnd, color) < 0.7
      )
        continue;
      boxes.push({
        x: top.x,
        y: top.y,
        width: top.end - top.x,
        height: gap + 1,
      });
      break;
    }
    if (boxes.length > 8) return null;
  }
  return boxes.sort((a, b) => a.y - b.y || a.x - b.x);
}

/** A deliberately narrow image observation. Missing strokes, mismatched
 * border colors and crowded regions abstain instead of implying an element
 * was added or removed. It never changes the design-reference verdict. */
export async function observeReferenceOutlines(input: {
  reference: Buffer;
  current: Buffer;
  structure: StructureSnapshot;
  region: ChangedRegion;
}): Promise<ReferenceOutlineObservation | null> {
  const color = textboxBorderColor(input.structure);
  if (!color) return null;
  const [target, current] = await Promise.all([
    pixels(input.reference),
    pixels(input.current),
  ]);
  if (target.width !== current.width || target.height !== current.height) return null;
  const targetBoxes = findOutlines(target, color, input.region);
  const currentBoxes = findOutlines(current, color, input.region);
  if (!targetBoxes?.length || !currentBoxes?.length) return null;
  if (
    targetBoxes.length === currentBoxes.length &&
    targetBoxes.every((box, index) => {
      const other = currentBoxes[index]!;
      return (
        Math.abs(box.x - other.x) <= 2 &&
        Math.abs(box.y - other.y) <= 2 &&
        Math.abs(box.width - other.width) <= 2 &&
        Math.abs(box.height - other.height) <= 2
      );
    })
  )
    return null;
  return { kind: 'border-outline-geometry/v1', targetBoxes, currentBoxes, note: NOTE };
}
