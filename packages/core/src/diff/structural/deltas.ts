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
  elementAt,
  styleReader,
  round,
} from '../../capture/structure.js';
import type { Delta, StructureRect, StructureSnapshot } from '../../types.js';
import { abstractLabel, clip, label } from './label.js';
import type { ElementMatch } from './match.js';
import { compareCodeUnits } from '../../report/format.js';

export interface Fact {
  delta: Delta;
  /** Old and new rects of the element(s) this fact is about, for coverage. */
  rects: StructureRect[];
  /** `role|tag` of the element, for the signature. */
  abstract: string;
  /** Position in the current document; for `removed`, that of the preceding
   *  matched element. Keeps output order stable across runs. */
  order: number;
  /** The element this fact is about, as an index into one side's snapshot:
   *  the baseline for matched and removed elements (their label comes from
   *  it), the current side for added ones; a shift carries its anchor's.
   *  Labels are not identities — two `div.card`s are two elements — so
   *  anything that groups facts by element keys on this. */
  source: Source;
}

export interface Source {
  side: 'baseline' | 'current';
  index: number;
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

/** Longest `from`/`to` in a delta. A paragraph of copy or a data-URI src
 *  would otherwise make one delta larger than the whole tier-0 budget; 200
 *  keeps any realistic value (a font stack, a shadow, a URL) whole. With
 *  labels capped at MAX_LABEL, every delta has a fixed worst-case size. */
const MAX_VALUE = 200;
const BORDER_COLOR = /^border-(top|right|bottom|left)-color$/;
type StyleReader = ReturnType<typeof styleReader>;

export function computeFacts(
  a: StructureSnapshot,
  b: StructureSnapshot,
  match: ElementMatch,
  onSuppressedResize?: (baselineIndex: number, currentIndex: number) => void,
): Fact[] {
  const facts: Fact[] = [];
  const aToB = new Map(match.pairs);
  /** Baseline index → its facts; and children whose only change was
   *  following, so their rects can ride on an ancestor's fact. */
  const byElement = new Map<number, Fact[]>();
  const followers: Array<{ i: number; rects: StructureRect[] }> = [];
  const styleA = styleReader(a);
  const styleB = styleReader(b);

  // Indices in `match` come from matchElements over these same element
  // arrays, so they are in range by construction. Parent pointers are data
  // read from a sidecar and go through elementAt.
  for (const [i, j] of match.pairs) {
    const ea = a.elements[i]!;
    const eb = b.elements[j]!;
    const fact = (delta: Delta): Fact => {
      const f: Fact = {
        delta,
        rects: [ea.rect, eb.rect],
        abstract: abstractLabel(eb),
        order: j,
        source: { side: 'baseline', index: i },
      };
      byElement.set(i, [...(byElement.get(i) ?? []), f]);
      return f;
    };
    // Every fact about a matched element carries ONE label, the baseline
    // side's. A button's label is its name, and its name is usually its text,
    // so the current side would read `button[name="Save changes"] text
    // "Save"→"Save changes"`, and a text delta labelled from one side beside
    // a resize labelled from the other reads as two buttons.
    const el = label(ea);

    // Masked stand-ins carry no content by construction; anything that leaks
    // onto one must not surface as a delta either.
    if (ea.tag !== 'masked' && eb.tag !== 'masked') {
      const ta = ea.text ?? '';
      const tb = eb.text ?? '';
      if (ta !== tb)
        facts.push(
          fact({ kind: 'text', el, from: clip(ta, MAX_VALUE), to: clip(tb, MAX_VALUE) }),
        );

      for (const attr of ATTRS) {
        const from = ea[attr] ?? '';
        const to = eb[attr] ?? '';
        if (from === to) continue;
        // A name that is just the text restates the text delta.
        if (attr === 'name' && from === ta && to === tb) continue;
        facts.push(
          fact({
            kind: 'attr',
            el,
            attr,
            from: clip(from, MAX_VALUE),
            to: clip(to, MAX_VALUE),
          }),
        );
      }

      for (const prop of STRUCTURE_PROPS) {
        // A pre-v2 baseline never captured this value. Comparing its empty
        // default with a current grid would invent a change on every grid.
        if (
          prop === 'grid-template-columns' &&
          (a.styleCaptureVersion !== 2 || b.styleCaptureVersion !== 2)
        )
          continue;
        // An unstored border colour resolves to currentColor, so a plain
        // `color` change would also report four phantom border-colour deltas
        // on every borderless element. No border, no border-colour fact.
        if (
          BORDER_COLOR.test(prop) &&
          borderless(styleA, i, prop) &&
          borderless(styleB, j, prop)
        )
          continue;
        const from = styleA(i, prop);
        const to = styleB(j, prop);
        if (from === to) continue;
        if (
          INHERITED_PROPS.has(prop) &&
          !originatesHere(a, b, i, j, aToB, prop, styleA, styleB)
        )
          continue;
        facts.push(
          fact({
            kind: 'style',
            el,
            prop,
            from: clip(from, MAX_VALUE),
            to: clip(to, MAX_VALUE),
          }),
        );
      }
    }

    const dw = round(eb.rect.w - ea.rect.w);
    const dh = round(eb.rect.h - ea.rect.h);
    const dx = round(eb.rect.x - ea.rect.x);
    const dy = round(eb.rect.y - ea.rect.y);
    // A child whose box changed exactly as its parent's did only followed it.
    // On the 12-item reorder probe the item's `span.meta moved down 222px`
    // read as a second change beside the item's own move, and in the corpus
    // `nested-reorder` case the five spans doubled the shift count (6 for 3).
    // The ancestor that actually moved keeps its fact. Its rect usually
    // contains the child's, but an overflowing child's does not, so the
    // child's rects are handed to that fact below and coverage loses nothing.
    const p = parentChange(a, b, i, j, aToB);
    const resized = dw !== 0 || dh !== 0;
    const moved = dx !== 0 || dy !== 0;
    const followedSize = resized && p !== undefined && p.dw === dw && p.dh === dh;
    const followedPos = moved && p !== undefined && p.dx === dx && p.dy === dy;
    // Billing lost its useful input dimensions when parent and control shrank
    // together. Held-out padding/line-height repairs already had direct facts.
    // Expose only suppressed resizes without another own fact to an optional
    // evidence collector; leave facts, coverage and signatures unchanged.
    if (followedSize && !byElement.has(i)) onSuppressedResize?.(i, j);
    if (resized && !followedSize) facts.push(fact({ kind: 'resized', el, dw, dh }));
    if (moved && !followedPos) facts.push(fact({ kind: 'moved', el, dx, dy }));
    if ((followedSize || followedPos) && !byElement.has(i))
      followers.push({ i, rects: [ea.rect, eb.rect] });
  }

  // A uniformly moving n-deep chain walked n(n-1)/2 ancestors. Cache
  // resolved paths (including misses) so attachment visits O(n) ancestors,
  // while followers still append their rects in the original pair order.
  const nearestGeometry = new Map<number, Fact | undefined>();
  const geometryAtOrAbove = (start: number | null): Fact | undefined => {
    const path: number[] = [];
    let own: Fact | undefined;
    let k = start;
    while (k !== null) {
      if (nearestGeometry.has(k)) {
        own = nearestGeometry.get(k);
        break;
      }
      path.push(k);
      own = byElement
        .get(k)
        ?.find((f) => f.delta.kind === 'moved' || f.delta.kind === 'resized');
      if (own) break;
      k = elementAt(a, k).parent;
    }
    for (const index of path) nearestGeometry.set(index, own);
    return own;
  };
  for (const { i, rects } of followers) {
    geometryAtOrAbove(a.elements[i]!.parent)?.rects.push(...rects);
  }

  for (const j of match.added) {
    const e = b.elements[j]!;
    facts.push({
      delta: { kind: 'added', el: label(e), rect: e.rect },
      rects: [e.rect],
      abstract: abstractLabel(e),
      order: j,
      source: { side: 'current', index: j },
    });
  }

  // A removed element has no current position; order it after the last
  // matched element that precedes it on the baseline side. match.removed is
  // ascending, so one forward sweep finds each predecessor. A scan back from
  // each removed element was quadratic: a removed 4999-row list walked 12.5M
  // baseline indices, and its structural diff took 58-136 ms (11-26 ms now).
  let scanned = 0;
  let lastMatchedBefore = -0.5;
  for (const i of match.removed) {
    for (; scanned < i; scanned++) {
      const j = aToB.get(scanned);
      if (j !== undefined) lastMatchedBefore = j + 0.5;
    }
    const e = a.elements[i]!;
    facts.push({
      delta: { kind: 'removed', el: label(e), rect: e.rect },
      rects: [e.rect],
      abstract: abstractLabel(e),
      order: lastMatchedBefore,
      source: { side: 'baseline', index: i },
    });
  }

  return sortFacts(facts);
}

/** That side of `border-<side>-color` has zero width on this element. */
function borderless(style: StyleReader, i: number, colorProp: string): boolean {
  return style(i, colorProp.replace(/-color$/, '-width')) === '0px';
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
  styleA: StyleReader,
  styleB: StyleReader,
): boolean {
  const ea = a.elements[i]!; // i, j: a matched pair
  const eb = b.elements[j]!;
  if (ea.styles[prop] !== undefined || eb.styles[prop] !== undefined) return true;
  const pa = ea.parent;
  const pb = eb.parent;
  if (pa === null || pb === null) return true;
  // Parents unmatched: nothing above to blame, so report here.
  if (aToB.get(pa) !== pb) return true;
  return styleA(pa, prop) === styleB(pb, prop);
}

/** How the matched parent's box changed; undefined when the parent is the
 *  root or unmatched. Read off the rects, not off the facts, so a grandchild
 *  still reads as following when its parent's own move was itself
 *  suppressed. */
function parentChange(
  a: StructureSnapshot,
  b: StructureSnapshot,
  i: number,
  j: number,
  aToB: Map<number, number>,
): { dx: number; dy: number; dw: number; dh: number } | undefined {
  const pa = a.elements[i]!.parent; // i, j: a matched pair
  const pb = b.elements[j]!.parent;
  if (pa === null || pb === null || aToB.get(pa) !== pb) return undefined;
  const ra = elementAt(a, pa).rect;
  const rb = elementAt(b, pb).rect;
  return {
    dx: round(rb.x - ra.x),
    dy: round(rb.y - ra.y),
    dw: round(rb.w - ra.w),
    dh: round(rb.h - ra.h),
  };
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

// Defined with the browser-safe formatters so the addon shares it.
export { compareCodeUnits };
