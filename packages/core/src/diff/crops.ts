// Tier-3: the pixels, but only where they changed and only as much as an
// agent needs. One PNG per changed region — baseline | current, side by
// side — with the region's bounding box doubled about its centre for
// context and scaled so the longer side is at most 512px. Nearest-neighbour
// when scaling up, so a 1px border reads as a hard 6px step and not a blur.
// No browser; sharp only, which `diffImages` already loads.

import sharp from 'sharp';
import type { ChangedRegion } from '../types.js';

export const MAX_CROPS = 8;
export const MAX_CROP_SIDE = 512;
const GUTTER = 4;
/** A 1×1 region still needs enough around it to recognise. */
const MIN_BOX = 16;
/** Pinned so the same input is the same bytes: sharp strips metadata by
 *  default; the level and filter fix the zlib stream. */
const PNG = { compressionLevel: 9, adaptiveFiltering: false } as const;
/** The gutter colour: magenta is in no UI palette, so it never reads as content. */
const GUTTER_RGBA = { r: 255, g: 0, b: 255, alpha: 1 };

export interface Crop {
  /** The changed region this strip shows, page px. */
  region: ChangedRegion;
  /** What was cropped: the region doubled about its centre, clamped to both frames. */
  box: ChangedRegion;
  /** Output px per page px: an integer above 1 when enlarged, under 1 when reduced. */
  scale: number;
  /** The whole strip: left side, gutter, right side. */
  width: number;
  height: number;
  png: Buffer;
}

export async function renderCrops(
  a: Buffer,
  b: Buffer,
  regions: ChangedRegion[],
): Promise<Crop[]> {
  const [ma, mb] = await Promise.all([sharp(a).metadata(), sharp(b).metadata()]);
  // Only the overlap exists on both sides; after a size change that is the
  // smaller frame's extent.
  const frame = {
    width: Math.min(ma.width ?? 0, mb.width ?? 0),
    height: Math.min(ma.height ?? 0, mb.height ?? 0),
  };
  // Nothing marked (sub-threshold, or a size change): the whole frame is
  // the one thing worth looking at.
  const wanted = regions.length > 0 ? regions : [{ x: 0, y: 0, ...frame }];
  const out: Crop[] = [];
  for (const region of wanted) {
    // The cap counts rendered crops, not candidates: off-frame regions at the
    // front must not starve a valid later one.
    if (out.length >= MAX_CROPS) break;
    const box = cropBox(region, frame);
    if (box.width === 0 || box.height === 0) continue;
    const scale = scaleFor(box);
    const sw = Math.max(1, Math.round(box.width * scale));
    const sh = Math.max(1, Math.round(box.height * scale));
    const side = (img: Buffer) =>
      sharp(img)
        .extract({ left: box.x, top: box.y, width: box.width, height: box.height })
        .resize(sw, sh, { kernel: scale >= 1 ? 'nearest' : 'lanczos3', fit: 'fill' })
        .ensureAlpha()
        .png(PNG)
        .toBuffer();
    const [left, right] = await Promise.all([side(a), side(b)]);
    const width = sw * 2 + GUTTER;
    const png = await sharp({
      create: { width, height: sh, channels: 4, background: GUTTER_RGBA },
    })
      .composite([
        { input: left, left: 0, top: 0 },
        { input: right, left: sw + GUTTER, top: 0 },
      ])
      .png(PNG)
      .toBuffer();
    out.push({ region, box, scale, width, height: sh, png });
  }
  return out;
}

/** The region doubled about its centre, at least MIN_BOX a side, clamped to
 *  the frame, integer px. A zero-size box means the region lies outside the
 *  frame. */
export function cropBox(
  r: ChangedRegion,
  frame: { width: number; height: number },
): ChangedRegion {
  // Clamping alone would drag a region left of / above the frame back to the
  // origin and crop something unrelated, so outside means no box.
  if (
    r.x + r.width < 0 ||
    r.y + r.height < 0 ||
    r.x > frame.width ||
    r.y > frame.height
  ) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }
  const w = Math.max(MIN_BOX, r.width * 2);
  const h = Math.max(MIN_BOX, r.height * 2);
  const x0 = Math.min(frame.width, Math.max(0, Math.floor(r.x + r.width / 2 - w / 2)));
  const y0 = Math.min(frame.height, Math.max(0, Math.floor(r.y + r.height / 2 - h / 2)));
  const x1 = Math.min(frame.width, Math.ceil(x0 + w));
  const y1 = Math.min(frame.height, Math.ceil(y0 + h));
  return { x: x0, y: y0, width: Math.max(0, x1 - x0), height: Math.max(0, y1 - y0) };
}

/** An integer enlargement that keeps the longer side within MAX_CROP_SIDE,
 *  or a fractional reduction once the box itself is past it. */
export function scaleFor(box: ChangedRegion): number {
  const longer = Math.max(box.width, box.height);
  return longer <= MAX_CROP_SIDE
    ? Math.max(1, Math.floor(MAX_CROP_SIDE / longer))
    : MAX_CROP_SIDE / longer;
}
