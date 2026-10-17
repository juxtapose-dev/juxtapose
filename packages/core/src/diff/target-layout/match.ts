import type { StructureSnapshot } from '../../types.js';
import { styleReader } from '../../capture/structure.js';
import type { EvidenceBlock, LayoutBox, TargetEvidence } from './index.js';

export interface LayoutMatch {
  targetBlock: string;
  currentBlock: string;
  targetBox: LayoutBox;
  currentBox: LayoutBox;
  dx: number;
  dy: number;
  dw: number;
  dh: number;
  /** Current element only, when its visible rectangle bounds uniquely agree. */
  element: { path: string; id?: string; provenance: 'structure' };
  provenance: 'measured-from-pixels';
  confidenceRule: string;
}

const color = (a: EvidenceBlock, b: EvidenceBlock) =>
  a.fill !== null && b.fill !== null && a.fill.every((v, i) => v === b.fill![i]);
const content = (a: EvidenceBlock, b: EvidenceBlock) =>
  a.content && b.content
    ? a.content.sha256 === b.content.sha256 &&
      a.content.width === b.content.width &&
      a.content.height === b.content.height
    : !a.content && !b.content;
const area = (b: LayoutBox) => b.width * b.height;
const edges = (a: LayoutBox, b: LayoutBox) =>
  Math.max(
    Math.abs(a.x - b.x),
    Math.abs(a.y - b.y),
    Math.abs(a.x + a.width - b.x - b.width),
    Math.abs(a.y + a.height - b.y - b.height),
  );
const usable = (b: EvidenceBlock) =>
  b.provenance === 'measured-from-pixels' && (b.solidArea ?? 0) >= 16;

/** Start stricter than DeltaE <=3: exact fill equality (DeltaE 0), mutually
 * unique assignments, and repeated lookalikes excluded even if position
 * makes one cheaper. Identical reordered controls have no pixel identity. */
export function matchLayout(
  target: TargetEvidence,
  current: TargetEvidence,
  structure: StructureSnapshot,
) {
  const matches: LayoutMatch[] = [];
  const style = styleReader(structure);
  if (
    structure.viewport.width !== current.width ||
    structure.viewport.height !== current.height ||
    target.width !== current.width ||
    target.height !== current.height
  )
    return {
      matches,
      abstained: target.blocks.length + current.blocks.length,
      status: 'abstained' as const,
      reason: 'incompatible-geometry' as const,
    };
  if (target.abstained.complexity || current.abstained.complexity)
    return {
      matches,
      abstained: target.blocks.length + current.blocks.length,
      status: 'abstained' as const,
      reason: 'component-budget' as const,
    };
  const duplicate = (blocks: EvidenceBlock[]) =>
    new Set(
      blocks
        .filter((a) =>
          blocks.some(
            (b) =>
              a !== b &&
              color(a, b) &&
              content(a, b) &&
              Math.abs(a.box.width - b.box.width) <= 2 &&
              Math.abs(a.box.height - b.box.height) <= 2,
          ),
        )
        .map((b) => b.id),
    );
  const targetDuplicates = duplicate(target.blocks),
    currentDuplicates = duplicate(current.blocks);
  const left = target.blocks.filter((b) => usable(b) && !targetDuplicates.has(b.id));
  const right = current.blocks.filter((b) => usable(b) && !currentDuplicates.has(b.id));
  const candidates: Array<{ a: EvidenceBlock; b: EvidenceBlock; cost: number }> = [];
  for (const a of left)
    for (const b of right) {
      if (!color(a, b) || !content(a, b)) continue;
      const ratio = area(a.box) / area(b.box);
      if (ratio < 0.5 || ratio > 2) continue;
      const dx = a.box.x - b.box.x,
        dy = a.box.y - b.box.y;
      const scale = Math.max(target.width, target.height);
      const cost =
        (Math.abs(dx) + Math.abs(dy)) / scale +
        Math.abs(Math.log(a.box.width / b.box.width)) +
        Math.abs(Math.log(a.box.height / b.box.height));
      candidates.push({ a, b, cost });
    }
  const byTarget = new Map<string, typeof candidates>(),
    byCurrent = new Map<string, typeof candidates>();
  for (const c of candidates) {
    const a = byTarget.get(c.a.id) ?? [];
    a.push(c);
    byTarget.set(c.a.id, a);
    const b = byCurrent.get(c.b.id) ?? [];
    b.push(c);
    byCurrent.set(c.b.id, b);
  }
  for (const list of [...byTarget.values(), ...byCurrent.values()])
    list.sort((a, b) => a.cost - b.cost);
  const unique = (list: typeof candidates) =>
    !list[1] || (list[1].cost > list[0]!.cost && list[1].cost >= 2 * list[0]!.cost);
  for (const a of left) {
    const list = byTarget.get(a.id);
    const best = list?.[0];
    if (
      !best ||
      !unique(list) ||
      byCurrent.get(best.b.id)?.[0] !== best ||
      !unique(byCurrent.get(best.b.id)!)
    )
      continue;
    const b = best.b;
    const delta = {
      dx: b.box.x - a.box.x,
      dy: b.box.y - a.box.y,
      dw: b.box.width - a.box.width,
      dh: b.box.height - a.box.height,
    };
    if (Math.max(...Object.values(delta).map(Math.abs)) <= 2) continue;
    const elements = structure.elements.filter((el, i) => {
      const outer = { x: el.rect.x, y: el.rect.y, width: el.rect.w, height: el.rect.h };
      if (edges(b.box, outer) <= 1) return true;
      if (
        b.box.x < outer.x - 1 ||
        b.box.y < outer.y - 1 ||
        b.box.x + b.box.width > outer.x + outer.width + 1 ||
        b.box.y + b.box.height > outer.y + outer.height + 1
      )
        return false;
      const border = (side: string) =>
        Number.parseFloat(style(i, `border-${side}-width`)) || 0;
      const left = border('left'),
        right = border('right'),
        top = border('top'),
        bottom = border('bottom');
      // A real 65.38px button yielded a 61px fill: comparing only its outer
      // box missed a correct 8px translation (2.38px edge error). Measured
      // current borders define the fill box; allow only 1px raster rounding.
      return (
        edges(b.box, {
          x: outer.x + left,
          y: outer.y + top,
          width: outer.width - left - right,
          height: outer.height - top - bottom,
        }) <= 1
      );
    });
    if (elements.length !== 1) continue;
    const element = elements[0]!;
    matches.push({
      targetBlock: a.id,
      currentBlock: b.id,
      targetBox: a.box,
      currentBox: b.box,
      ...delta,
      element: {
        path: element.path,
        ...(element.id ? { id: element.id } : {}),
        provenance: 'structure',
      },
      provenance: 'measured-from-pixels',
      confidenceRule:
        'exact-fill; exact inner paint when present; >=16 solid pixels; mutual best with >=2x second-best cost; repeated lookalikes excluded; geometry delta >2px; boxes measure painted regions, not CSS border boxes',
    });
  }
  return {
    matches,
    abstained: target.blocks.length - matches.length,
    status: 'measured' as const,
  };
}
