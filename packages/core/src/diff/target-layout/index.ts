import type { StructureSnapshot } from '../../types.js';
import { styleReader } from '../../capture/structure.js';
import sharp from 'sharp';
import { fromPng } from './segment.js';

export interface LayoutBox {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface EvidenceBlock {
  id: string;
  box: LayoutBox;
  /** Exact opaque sRGB fill. No typography or CSS cause is inferred. */
  fill: [number, number, number] | null;
  solidArea: number | null;
  /** Translation-invariant exact inner paint, not recognized text or a font. */
  content?: { width: number; height: number; sha256: string };
  children: string[];
  provenance: 'measured-from-pixels' | 'structure';
  confidenceRule: string;
}
export interface TargetEvidence {
  schema: 'juxtapose.target-evidence/v1';
  width: number;
  height: number;
  blocks: EvidenceBlock[];
  abstained: { complexity: boolean; nonRectangular: number; omitted: number };
}
export interface RgbaImage {
  data: Uint8Array;
  width: number;
  height: number;
}

export function fromStructure(snapshot: StructureSnapshot): TargetEvidence {
  const children: string[][] = snapshot.elements.map(() => []);
  snapshot.elements.forEach((element, index) => {
    if (element.parent !== null) children[element.parent]?.push(`dom:${index}`);
  });
  const style = styleReader(snapshot);
  return {
    schema: 'juxtapose.target-evidence/v1',
    ...snapshot.viewport,
    blocks: snapshot.elements.map((element, index) => {
      const value = style(index, 'background-color');
      const rgb = value
        ?.match(/^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/)
        ?.slice(1)
        .map(Number);
      return {
        id: `dom:${index}`,
        box: {
          x: element.rect.x,
          y: element.rect.y,
          width: element.rect.w,
          height: element.rect.h,
        },
        fill: rgb?.length === 3 ? (rgb as [number, number, number]) : null,
        solidArea: null,
        children: children[index]!,
        provenance: 'structure',
        confidenceRule: 'captured-dom-rectangle; visible fill area unknown',
      };
    }),
    abstained: { complexity: false, nonRectangular: 0, omitted: 0 },
  };
}

/** The caller caches this derived evidence by encoded image hash. Keeping
 * RGBA local avoids retaining 16 MB for every 4 MP target in an MCP session. */
export async function extractTargetEvidence(image: Buffer): Promise<TargetEvidence> {
  const { data, info } = await sharp(image)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return fromPng({ data, width: info.width, height: info.height });
}

export { fromPng };
export { matchLayout } from './match.js';
export type TargetLayoutResult = ReturnType<typeof import('./match.js').matchLayout>;
