// Where the lens samples from, and where it sits.
//
// Separate from the component because it is pure arithmetic that is easy to get
// subtly wrong -- a scaled-down capture magnified from unscaled coordinates
// shows the wrong region and looks plausible enough to ship -- and because a
// test for it should not need a DOM.

/** Diameter of the lens, px. */
export const SIZE = 176;
export const ZOOM = 4;

/**
 * Where to sample from, and where to put the lens.
 *
 * Split out from the drawing because it is the part that is easy to get subtly
 * wrong — a scaled-down capture magnified from unscaled coordinates shows the
 * wrong region, and it looks plausible enough to ship.
 */
export function loupeGeometry(opts: {
  /** Cursor, relative to the frame. */
  x: number;
  y: number;
  /** Rendered frame size. */
  width: number;
  height: number;
  /** The image's natural width, which is usually larger than `width`. */
  naturalWidth: number;
  size?: number;
  zoom?: number;
}): { sx: number; sy: number; sw: number; left: number; top: number } {
  const size = opts.size ?? SIZE;
  const zoom = opts.zoom ?? ZOOM;
  const scale = opts.naturalWidth / opts.width;
  const sw = size / zoom;
  const half = size / 2;

  return {
    sx: opts.x * scale - sw / 2,
    sy: opts.y * scale - sw / 2,
    sw,
    // Clamped so the lens never hangs off the frame and gets clipped.
    left: Math.min(Math.max(opts.x - half, 0), opts.width - size),
    top: Math.min(Math.max(opts.y - half, 0), opts.height - size),
  };
}
