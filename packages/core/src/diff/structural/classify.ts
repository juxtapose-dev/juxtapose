// Classification and risk flags. First match wins, in an order that puts
// causes before consequences: a padding change that reflows the page is a
// spacing change with a shift in its deltas, not a "reflow" — the spec's own
// summary example says so.

import type {
  ChangedRegion,
  Classification,
  Delta,
  Flag,
  StructureElement,
  StructureSnapshot,
  StyleTag,
} from '../../types.js';
import type { Fact } from './deltas.js';
import { SELF_PAINTING } from './label.js';
import { intersects } from './coverage.js';

export interface ClassifyContext {
  baseline?: StructureSnapshot;
  current?: StructureSnapshot;
  facts: Fact[];
  explained: 'full' | 'partial' | 'none';
  unexplainedRegions: ChangedRegion[];
  pixels: {
    /** Byte-identical images: the only pixel evidence of "no change". */
    imagesIdentical: boolean;
    dimensionMismatch: boolean;
    /** The pixel diff marked at least one region with area. */
    hasRegions: boolean;
    /** The images differ but the pixel diff marked no region. */
    subThreshold: boolean;
  };
}

const comparableStyles = (a?: StructureSnapshot, b?: StructureSnapshot) =>
  !a || !b || a.styleCaptureVersion === b.styleCaptureVersion;

const TAG_ORDER: StyleTag[] = [
  'color',
  'typography',
  'spacing',
  'layout',
  'border',
  'effects',
];

export function styleTagOf(prop: string): StyleTag {
  if (prop === 'grid-template-columns') return 'layout';
  if (/^(padding|margin)-|^gap$/.test(prop)) return 'spacing';
  if (/^border-.*-(width|radius)$/.test(prop) || /^border-.*-color$/.test(prop))
    return 'border';
  if (/^(font-|line-height|letter-spacing|text-|content$)/.test(prop))
    return 'typography';
  if (/^(opacity|transform|box-shadow|z-index|stroke-width)$/.test(prop))
    return 'effects';
  return 'color'; // color, background-*, fill, stroke
}

export function classify(ctx: ClassifyContext): {
  classification: Classification;
  styleTags: StyleTag[];
} {
  const none: StyleTag[] = [];
  const { pixels, baseline, current, facts } = ctx;
  // Never "0 mismatch pixels": pixelmatch's tolerance hides real changes
  // (the corpus `background` case changes the bytes and marks 0 pixels).
  if (
    pixels.imagesIdentical &&
    !pixels.dimensionMismatch &&
    !pixels.hasRegions &&
    facts.length === 0
  )
    return { classification: 'identical', styleTags: none };
  // Before the structure checks: a size change is a size change whether or
  // not either side captured structure.
  if (pixels.dimensionMismatch)
    return { classification: 'dimension-change', styleTags: none };
  if (!baseline || !current) return { classification: 'unknown', styleTags: none };
  if (
    baseline.viewport.width !== current.viewport.width ||
    baseline.viewport.height !== current.viewport.height
  ) {
    return { classification: 'dimension-change', styleTags: none };
  }
  // Equal hashes and no facts: the DOM and styles did not change, so the
  // pixels are drift or self-painted content. The facts come from the
  // elements themselves, so they outrank a hash that disagrees with them.
  if (
    facts.length === 0 &&
    comparableStyles(baseline, current) &&
    baseline.structureHash === current.structureHash
  ) {
    const selfPainted = selfPaintingAt(current, ctx.unexplainedRegions) !== undefined;
    return { classification: selfPainted ? 'unknown' : 'render-drift', styleTags: none };
  }

  const kinds = new Set(facts.map((f) => f.delta.kind));
  if (kinds.has('removed')) return { classification: 'element-removed', styleTags: none };
  if (kinds.has('added')) return { classification: 'element-added', styleTags: none };

  const primary = (['text', 'style', 'attr'] as const).filter((k) => kinds.has(k));
  const styleTags = kinds.has('style')
    ? TAG_ORDER.filter((t) =>
        facts.some((f) => f.delta.kind === 'style' && styleTagOf(f.delta.prop) === t),
      )
    : none;
  if (primary.length > 1) return { classification: 'mixed', styleTags };
  if (primary[0] === 'text') return { classification: 'text-only', styleTags: none };
  if (primary[0] === 'style') return { classification: 'style-only', styleTags };
  if (primary[0] === 'attr') return { classification: 'attr-only', styleTags: none };
  if (kinds.has('shift')) return { classification: 'reflow', styleTags: none };
  if (kinds.has('moved') || kinds.has('resized'))
    return { classification: 'geometry', styleTags: none };
  // Bytes differ, nothing marked, nothing structural: antialiasing-scale drift.
  if (pixels.subThreshold) return { classification: 'render-drift', styleTags: none };
  return { classification: 'unknown', styleTags: none };
}

/** The first self-painting element (canvas, video, img…) on the current side
 *  under an unexplained region: its content changes without the DOM or styles
 *  changing, so the pixels there are content, not drift. */
export function selfPaintingAt(
  current: StructureSnapshot,
  unexplained: ChangedRegion[],
): StructureElement | undefined {
  for (const r of unexplained) {
    const e = current.elements.find(
      (e) => SELF_PAINTING.has(e.tag) && intersects(r, e.rect),
    );
    if (e) return e;
  }
  return undefined;
}

const LARGE_SHIFT_COUNT = 10;
const LARGE_SHIFT_PX = 50;

/** In a fixed order, so the flag list serializes identically every run. */
export function computeFlags(ctx: ClassifyContext): Flag[] {
  const flags: Flag[] = [];
  const { baseline, current, facts } = ctx;
  const has = (k: Delta['kind']) => facts.some((f) => f.delta.kind === k);
  if (has('removed')) flags.push('element-removed');
  if (has('text')) flags.push('text-changed');
  if (
    facts.some(
      (f) =>
        f.delta.kind === 'shift' &&
        (f.delta.count >= LARGE_SHIFT_COUNT || Math.abs(f.delta.dy) >= LARGE_SHIFT_PX),
    )
  ) {
    flags.push('large-reflow');
  }
  if (ctx.explained !== 'full') flags.push('unexplained-pixels');
  if (ctx.pixels.subThreshold) flags.push('sub-threshold');
  if (baseline?.truncated || current?.truncated) flags.push('structure-truncated');
  if (!comparableStyles(baseline, current)) flags.push('incomplete-style-comparison');
  if (!baseline) flags.push('no-baseline-structure');
  if (!current) flags.push('no-current-structure');
  const belowFold = (s: StructureSnapshot | undefined) =>
    s !== undefined && s.contentHeight > s.viewport.height;
  if (belowFold(baseline) || belowFold(current)) flags.push('below-fold');
  return flags;
}
