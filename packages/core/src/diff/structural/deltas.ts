// One typed fact per changed thing between two matched snapshots.
//
// Style deltas are reported where they originate. Compact storage (see
// capture/structure.ts) stores an inherited property only where it differs
// from the parent, but a change on `main` still changes every descendant's
// effective colour — reporting it 40 times would bury the one fact that
// matters. So an inherited delta is emitted only where the element's own
// stored value changed, or where the parents' effective values already agree.

import {
  INHERITED_PROPS,
  STRUCTURE_PROPS,
  effectiveStyle,
  round,
} from '../../capture/structure.js';
import type { Delta, StructureRect, StructureSnapshot } from '../../types.js';
import { abstractLabel, label } from './label.js';
import type { ElementMatch } from './match.js';

export interface Fact {
  delta: Delta;
  /** Old and new rects of the element(s) this fact is about, for coverage. */
  rects: StructureRect[];
  /** `role|tag` of the element, for the signature. */
  abstract: string;
  /** Position in the current document; for `removed`, that of the preceding
   *  matched element. Keeps output order stable across runs. */
  order: number;
}

/** Within one position, which fact reads first. */
export const KIND_RANK: Record<Delta['kind'], number> = {
  removed: 0,
  added: 1,
  text: 2,
  attr: 3,
  style: 4,
  resized: 5,
  moved: 6,
  shift: 7,
};

const ATTRS = ['src', 'role', 'name'] as const;
const BORDER_COLOR = /^border-(top|right|bottom|left)-color$/;

export function computeFacts(
  a: StructureSnapshot,
  b: StructureSnapshot,
  match: ElementMatch,
): Fact[] {
  const facts: Fact[] = [];
  const aToB = new Map(match.pairs);

  for (const [i, j] of match.pairs) {
    const ea = a.elements[i];
    const eb = b.elements[j];
    const fact = (delta: Delta): Fact => ({
      delta,
      rects: [ea.rect, eb.rect],
      abstract: abstractLabel(eb),
      order: j,
    });
    // Text and attr deltas are labelled from the BASELINE side: a button's
    // label is its name, and its name is usually its text, so labelling from
    // the current side would read `button[name="Save changes"] text "Save"→
    // "Save changes"` — the label would spoil the delta. Everything else is
    // labelled from the current side, which is what the agent is looking at.
    const elA = label(ea);
    const el = label(eb);

    // Masked stand-ins carry no content by construction; anything that leaks
    // onto one must not surface as a delta either.
    if (ea.tag !== 'masked' && eb.tag !== 'masked') {
      const ta = ea.text ?? '';
      const tb = eb.text ?? '';
      if (ta !== tb) facts.push(fact({ kind: 'text', el: elA, from: ta, to: tb }));

      for (const attr of ATTRS) {
        const from = ea[attr] ?? '';
        const to = eb[attr] ?? '';
        if (from === to) continue;
        // A name that is just the text restates the text delta.
        if (attr === 'name' && from === ta && to === tb) continue;
        facts.push(fact({ kind: 'attr', el: elA, attr, from, to }));
      }

      for (const prop of STRUCTURE_PROPS) {
        // An unstored border colour resolves to currentColor, so a plain
        // `color` change would also report four phantom border-colour deltas
        // on every borderless element. No border, no border-colour fact.
        if (BORDER_COLOR.test(prop) && borderless(a, i, prop) && borderless(b, j, prop))
          continue;
        const from = effectiveStyle(a, i, prop);
        const to = effectiveStyle(b, j, prop);
        if (from === to) continue;
        if (INHERITED_PROPS.has(prop) && !originatesHere(a, b, i, j, aToB, prop))
          continue;
        facts.push(fact({ kind: 'style', el, prop, from, to }));
      }
    }

    const dw = round(eb.rect.w - ea.rect.w);
    const dh = round(eb.rect.h - ea.rect.h);
    if (dw !== 0 || dh !== 0) facts.push(fact({ kind: 'resized', el, dw, dh }));
    const dx = round(eb.rect.x - ea.rect.x);
    const dy = round(eb.rect.y - ea.rect.y);
    if (dx !== 0 || dy !== 0) facts.push(fact({ kind: 'moved', el, dx, dy }));
  }

  for (const j of match.added) {
    const e = b.elements[j];
    facts.push({
      delta: { kind: 'added', el: label(e), rect: e.rect },
      rects: [e.rect],
      abstract: abstractLabel(e),
      order: j,
    });
  }

  // A removed element has no current position; order it after the last
  // matched element that precedes it on the baseline side.
  const lastMatchedBefore = (i: number): number => {
    for (let k = i - 1; k >= 0; k--) {
      const j = aToB.get(k);
      if (j !== undefined) return j + 0.5;
    }
    return -0.5;
  };
  for (const i of match.removed) {
    const e = a.elements[i];
    facts.push({
      delta: { kind: 'removed', el: label(e), rect: e.rect },
      rects: [e.rect],
      abstract: abstractLabel(e),
      order: lastMatchedBefore(i),
    });
  }

  return sortFacts(facts);
}

/** That side of `border-<side>-color` has zero width on this element. */
function borderless(s: StructureSnapshot, i: number, colorProp: string): boolean {
  return effectiveStyle(s, i, colorProp.replace(/-color$/, '-width')) === '0px';
}

/** An inherited property changed on this element, not merely on an ancestor:
 *  either it stores its own value on a side, or its parents' effective values
 *  agree (so the difference starts here). */
function originatesHere(
  a: StructureSnapshot,
  b: StructureSnapshot,
  i: number,
  j: number,
  aToB: Map<number, number>,
  prop: string,
): boolean {
  const ea = a.elements[i];
  const eb = b.elements[j];
  if (ea.styles[prop] !== undefined || eb.styles[prop] !== undefined) return true;
  const pa = ea.parent;
  const pb = eb.parent;
  if (pa === null || pb === null) return true;
  // Parents unmatched: nothing above to blame, so report here.
  if (aToB.get(pa) !== pb) return true;
  return effectiveStyle(a, pa, prop) === effectiveStyle(b, pb, prop);
}

export function sortFacts(facts: Fact[]): Fact[] {
  return facts.sort(
    (x, y) =>
      x.order - y.order ||
      KIND_RANK[x.delta.kind] - KIND_RANK[y.delta.kind] ||
      compareCodeUnits(factKey(x.delta), factKey(y.delta)),
  );
}

function factKey(d: Delta): string {
  return d.kind === 'style' ? d.prop : d.kind === 'attr' ? d.attr : '';
}

/** Byte-identical output across machines needs a locale-free order;
 *  `localeCompare` is not one. */
export const compareCodeUnits = (a: string, b: string): number =>
  a < b ? -1 : a > b ? 1 : 0;
