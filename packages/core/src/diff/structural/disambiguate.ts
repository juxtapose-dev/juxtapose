// A label is a description, not an identity: a page with two cards has two
// `div.card`s, and when both change, every reader of the verdict — the JSON,
// the summary, `describeDeltas` — sees one element. Measured on a dark-mode
// probe: the two cards' facts merged into one clause that stated
// `background-color` twice; on a 12-item reorder, seven `span.meta` moves
// read as one line and six deltas vanished from the human output.
//
// So within one verdict, distinct elements get distinct labels. Only labels
// that actually collide change, and they take the shortest stable
// distinguisher: the nearest ancestor with a name, id or test id
// (`span.meta in listitem[name="Item 4"]`), or, when that does not separate
// them, the element's ordinal among same-labelled elements on its side of the
// diff (`div.card (2nd)`). Both are properties of the page, not of the diff,
// so the same change labels the same way on every run.

import { elementAt } from '../../capture/structure.js';
import type { StructureSnapshot } from '../../types.js';
import type { Fact, Source } from './deltas.js';
import { MAX_LABEL, clip, label } from './label.js';

export function disambiguate(
  facts: Fact[],
  baseline: StructureSnapshot,
  current: StructureSnapshot,
): Fact[] {
  const snap = (s: Source) => (s.side === 'baseline' ? baseline : current);
  const nth: { baseline?: number[]; current?: number[] } = {};
  // ordinals has one entry per element, and a source indexes an element.
  const nthOf = (s: Source) => (nth[s.side] ??= ordinals(snap(s)))[s.index]!;
  const key = (s: Source) => `${s.side}:${s.index}`;
  const labelOf = (f: Fact) => ('el' in f.delta ? f.delta.el : f.delta.after);

  // label → the distinct elements wearing it, in first-seen (fact) order
  const byLabel = new Map<string, Map<string, Source>>();
  for (const f of facts) {
    const l = labelOf(f);
    let ids = byLabel.get(l);
    if (!ids) byLabel.set(l, (ids = new Map<string, Source>()));
    ids.set(key(f.source), f.source);
  }

  const rename = new Map<string, string>();
  for (const [l, ids] of byLabel) {
    if (ids.size < 2) continue;
    const sources = [...ids.values()];
    const scoped = sources.map((s) => {
      const a = labelledAncestor(snap(s), s.index);
      return a === undefined ? undefined : clip(`${l} in ${a}`, MAX_LABEL);
    });
    const distinct =
      scoped.every((x) => x !== undefined) && new Set(scoped).size === scoped.length;
    for (const [k, s] of sources.entries()) {
      const suffix = ` (${ordinal(nthOf(s))})`;
      rename.set(
        key(s),
        // distinct implies every scoped label is defined.
        distinct ? scoped[k]! : clip(l, MAX_LABEL - suffix.length) + suffix,
      );
    }
  }
  if (rename.size === 0) return facts;

  return facts.map((f) => {
    const to = rename.get(key(f.source));
    if (to === undefined) return f;
    const d = f.delta;
    return { ...f, delta: 'el' in d ? { ...d, el: to } : { ...d, after: to } };
  });
}

/** Label of the nearest ancestor that names itself (role+name, id, test id);
 *  a class or a path does not tell two siblings' parents apart. */
function labelledAncestor(s: StructureSnapshot, index: number): string | undefined {
  for (let p = elementAt(s, index).parent; p !== null; p = elementAt(s, p).parent) {
    const e = elementAt(s, p);
    if (e.tag === 'masked') continue;
    if ((e.role && e.name) || e.id !== undefined || e.testId !== undefined)
      return label(e);
  }
  return undefined;
}

/** Each element's 1-based position among its side's elements that carry the
 *  same label, in document order. One pass per side, not one per element: a
 *  list of 5,000 identical rows that all changed would otherwise be 25M
 *  label calls. */
function ordinals(s: StructureSnapshot): number[] {
  const seen = new Map<string, number>();
  return s.elements.map((e) => {
    const l = label(e);
    const n = (seen.get(l) ?? 0) + 1;
    seen.set(l, n);
    return n;
  });
}

function ordinal(n: number): string {
  const teen = n % 100 >= 11 && n % 100 <= 13;
  const suffix = teen ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th');
  return `${n}${suffix}`;
}
