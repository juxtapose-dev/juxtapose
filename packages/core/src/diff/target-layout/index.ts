import type { StructureSnapshot } from '../../types.js';
import { hasCapturedStyle, styleReader } from '../../capture/structure.js';
import sharp from 'sharp';
import { fromPng } from './segment.js';
import { fromPngStreaming } from './stream.js';
import type { PaintComponentEvidence } from './paint-components.js';
export type { PaintComponentEvidence, SolidPaintComponent } from './paint-components.js';

export interface LayoutBox {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface StructureTextEvidence {
  /** Captured element text; descendant text is not necessarily included.
   * Parent/child blocks preserve mixed typography, not character offsets. */
  value: string;
  tag: string;
  /** Captured computed values, not target CSS declarations or inferred fonts. */
  styles: Record<string, string>;
}

export interface EvidenceBlock {
  id: string;
  box: LayoutBox;
  /** Exact opaque sRGB fill. No typography or CSS cause is inferred. */
  fill: [number, number, number] | null;
  solidArea: number | null;
  text?: StructureTextEvidence;
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

const TEXT_PROPERTIES = [
  'color',
  'font-family',
  'font-size',
  'font-style',
  'font-weight',
  'letter-spacing',
  'line-height',
  'text-decoration-line',
  'text-transform',
] as const;

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
        // The real-review typography diagnostic removed 98.4% of Pixelmatch
        // differences using mixed kbd/body styles that this converter discarded.
        // Keep source facts here; PNG producers must not infer equivalent text.
        ...(element.text !== undefined
          ? {
              text: {
                value: element.text,
                tag: element.tag,
                styles: Object.fromEntries(
                  TEXT_PROPERTIES.flatMap((property) => {
                    const value = hasCapturedStyle(snapshot, property)
                      ? style(index, property)
                      : undefined;
                    return value === undefined ? [] : [[property, value]];
                  }),
                ),
              },
            }
          : {}),
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
export async function extractTargetEvidence(
  image: Buffer,
  observePaint?: (
    image: RgbaImage,
    evidence: PaintComponentEvidence,
  ) => void | Promise<void>,
): Promise<TargetEvidence> {
  const { data, info } = await sharp(image)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const rgba = { data, width: info.width, height: info.height };
  if (!observePaint) return fromPng(rgba);
  let paint!: PaintComponentEvidence;
  const layout = fromPng(rgba, (evidence) => {
    paint = evidence;
  });
  // One decode and component scan serves both observations. Only bounded derived
  // values should escape this callback; the session must not retain full RGBA.
  await observePaint(rgba, paint);
  return layout;
}

/** Opt-in reference analysis for photo-heavy images. Never used by the default
 * matcher: recovery of paint components is not proof of DOM match precision. */
export async function extractTargetEvidenceStreaming(
  image: Buffer,
): Promise<TargetEvidence> {
  const { data, info } = await sharp(image)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return fromPngStreaming({ data, width: info.width, height: info.height });
}

export { fromPng };
export { matchLayout } from './match.js';
export type TargetLayoutResult = ReturnType<typeof import('./match.js').matchLayout>;
