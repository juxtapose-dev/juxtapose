// What rendered the pixels. Two baselines from different environments are not
// comparable byte-for-byte even when nothing about the code changed, so an
// all-red suite after a toolchain bump is indistinguishable from 700
// regressions unless the environment is on record.
//
// Measured before choosing the fields: across Chromium 149 -> 151, 16 of 18
// example stories were byte-identical, while re-encoding the same images
// through a different libvips changed all 17 baseline hashes with zero changed
// pixels. The encoder moves bytes far more readily than the browser does, so it
// earns a field of its own rather than being folded into the browser version.

import sharp from 'sharp';
import type { Browser } from '../browser/browser.js';
import type { CaptureEnv } from '../types.js';

export type { CaptureEnv };

export function captureEnv(browser: Browser): CaptureEnv {
  return {
    browser: browser.version(),
    os: `${process.platform}-${process.arch}`,
    encoder: sharp.versions.vips,
  };
}

export function sameEnv(a: CaptureEnv | undefined, b: CaptureEnv | undefined): boolean {
  if (!a || !b) return false;
  return a.browser === b.browser && a.os === b.os && a.encoder === b.encoder;
}

/** One line naming only what moved, for explaining an all-red run. Empty when
 *  the environments match or either is unknown. */
export function describeEnvChange(from: CaptureEnv | undefined, to: CaptureEnv): string {
  if (!from) return '';
  const parts: string[] = [];
  if (from.browser !== to.browser) parts.push(`browser ${from.browser} -> ${to.browser}`);
  if (from.os !== to.os) parts.push(`os ${from.os} -> ${to.os}`);
  if (from.encoder !== to.encoder)
    parts.push(`encoder libvips ${from.encoder} -> ${to.encoder}`);
  return parts.join(', ');
}
