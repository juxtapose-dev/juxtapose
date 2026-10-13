// Two snaps on disk → pixels + verdict. The public seam for `jux diff`: it
// keeps diffImages and the structural internals unexported while giving the
// CLI the one call it needs. No browser is involved anywhere below this line.

import type { StructureSnapshot, StructuralVerdict } from '../types.js';
import { diffImages, type DiffOutput } from './diff.js';
import { structuralDiff } from './structural.js';

export interface SnapSide {
  image: Buffer;
  structure?: StructureSnapshot;
}

export interface SnapComparison {
  pixels: DiffOutput;
  verdict: StructuralVerdict;
}

export async function compareSnaps(
  a: SnapSide,
  b: SnapSide,
  escalate: { command: string },
): Promise<SnapComparison> {
  const pixels = await diffImages(a.image, b.image);
  const verdict = structuralDiff({
    baseline: a.structure,
    current: b.structure,
    // Byte equality, not mismatchPixels === 0: a sub-threshold colour change
    // has no mismatching pixels but is still a different image.
    imagesIdentical: a.image.equals(b.image),
    pixels,
    escalate,
  });
  return { pixels, verdict };
}
