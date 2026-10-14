// A CSS selector for one element of a structure snapshot, short enough to read
// in a message and valid in `mask` and `waitForSelector` (plain CSS, no
// Playwright syntax). Most specific stable handle first: test id, id, tag plus
// classes, and only then the full path from <html>.

import type { StructureElement, StructureSnapshot } from '../types.js';

const IDENT = /^-?[A-Za-z_][\w-]*$/;

const attrValue = (v: string) => `"${v.replace(/["\\]/g, '\\$&')}"`;

/** The nearest element that is a real node: a pseudo-element or a mask
 *  stand-in cannot be selected, so its owner stands for it. */
function selectable(s: StructureSnapshot, index: number): number {
  let i = index;
  for (;;) {
    const el = s.elements[i];
    if (!el) return index;
    if (!el.tag.startsWith('::') && el.tag !== 'masked') return i;
    if (el.parent === null) return index;
    i = el.parent;
  }
}

export function selectorFor(s: StructureSnapshot, index: number): string {
  const i = selectable(s, index);
  const el = s.elements[i];
  if (!el) return '*';
  const count = (match: (e: StructureElement) => boolean) =>
    s.elements.filter(match).length;

  if (el.testId !== undefined && count((e) => e.testId === el.testId) === 1)
    return `[data-testid=${attrValue(el.testId)}]`;
  if (el.id !== undefined && IDENT.test(el.id) && count((e) => e.id === el.id) === 1)
    return `#${el.id}`;
  const classes = (el.classes ?? []).filter((c) => IDENT.test(c));
  if (classes.length > 0) {
    const same = count(
      (e) => e.tag === el.tag && classes.every((c) => e.classes?.includes(c)),
    );
    if (same === 1) return `${el.tag}.${classes.join('.')}`;
  }
  return el.path;
}
