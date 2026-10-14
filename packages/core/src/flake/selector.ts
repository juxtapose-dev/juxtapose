// A CSS selector for one element of a structure snapshot, short enough to read
// in a message and valid in `mask` and `waitForSelector` (plain CSS, no
// Playwright syntax). Most specific stable handle first: test id, id, tag plus
// classes, and only then the full path from <html>.
//
// Every identifier is escaped. The snapshot's `path` is built from raw ids
// (`div#collapsible:_r_0_:content` for a React/Zag useId), which is not a
// selector the browser parses: it is rebuilt here from the path's own steps
// rather than changed in the snapshot, because `path` is hashed into
// `structureHash` and committed in sidecars.

import type { StructureElement, StructureSnapshot } from '../types.js';

/** `CSS.escape`, for Node: https://drafts.csswg.org/cssom/#serialize-an-identifier */
export function cssEscape(value: string): string {
  let out = '';
  const first = value.charCodeAt(0);
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    const ch = value[i]!;
    if (c === 0) out += '�';
    else if (
      (c >= 0x1 && c <= 0x1f) ||
      c === 0x7f ||
      (i === 0 && c >= 0x30 && c <= 0x39) ||
      (i === 1 && c >= 0x30 && c <= 0x39 && first === 0x2d)
    )
      out += `\\${c.toString(16)} `;
    else if (i === 0 && value.length === 1 && c === 0x2d) out += `\\${ch}`;
    else if (
      c >= 0x80 ||
      c === 0x2d ||
      c === 0x5f ||
      (c >= 0x30 && c <= 0x39) ||
      (c >= 0x41 && c <= 0x5a) ||
      (c >= 0x61 && c <= 0x7a)
    )
      out += ch;
    else out += `\\${ch}`;
  }
  return out;
}

const attrValue = (v: string) =>
  `"${v.replace(/[\\"]/g, '\\$&').replace(/\n/g, '\\a ')}"`;

/** An id a framework generated per render (React `useId`: `:r0:`, `_r_0_`;
 *  Zag/Ark/Radix prefixes), so a selector built on it is only as stable as
 *  the render order. */
function isGeneratedId(id: string): boolean {
  return (
    /[:]/.test(id) ||
    /^_?r_?\d+_?$/.test(id) ||
    /^(?:radix|react-aria|headlessui)[-_]/i.test(id)
  );
}

/** A class a build generated (emotion `css-1odw0y2`, styled-components,
 *  CSS-module hashes `_abc123` / `Button_root__x7Yz2`): it changes with the
 *  styles, not with the component. */
function isGeneratedClass(c: string): boolean {
  return (
    (/^(?:css|sc|emotion|jsx|svelte|chakra)-[a-z0-9]{5,}$/i.test(c) && /\d/.test(c)) ||
    /^_[A-Za-z0-9]{5,}$/.test(c) ||
    (/__[A-Za-z0-9_-]{4,}$/.test(c) && /\d/.test(c.slice(c.lastIndexOf('__'))))
  );
}

/** Split a snapshot path on the `>` between steps, not one inside an id or an
 *  attribute value. */
function pathSteps(path: string): string[] {
  const steps: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < path.length; i++) {
    const ch = path[i]!;
    if (ch === '"' && path[i - 1] !== '\\') quoted = !quoted;
    if (ch === '>' && !quoted) {
      steps.push(cur);
      cur = '';
    } else cur += ch;
  }
  steps.push(cur);
  return steps;
}

/** The snapshot's path with every step escaped. */
function escapedPath(path: string): string {
  return pathSteps(path)
    .map((step) => {
      const m =
        /^([^#[:]+)(?:#([\s\S]*)|\[data-testid="([\s\S]*)"\]|:nth-of-type\((\d+)\))$/.exec(
          step,
        );
      if (!m) return step;
      const tag = cssEscape(m[1]!);
      if (m[2] !== undefined) return `${tag}#${cssEscape(m[2])}`;
      if (m[3] !== undefined) return `${tag}[data-testid=${attrValue(m[3])}]`;
      return `${tag}:nth-of-type(${m[4]})`;
    })
    .join('>');
}

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

export interface ElementSelector {
  selector: string;
  /** Built on a test id, id or class rather than the element's position:
   *  it survives an unrelated element appearing before it. */
  stable: boolean;
}

export function describeSelector(s: StructureSnapshot, index: number): ElementSelector {
  const i = selectable(s, index);
  const el = s.elements[i];
  if (!el) return { selector: '*', stable: false };
  const count = (match: (e: StructureElement) => boolean) =>
    s.elements.filter(match).length;

  if (el.testId !== undefined && count((e) => e.testId === el.testId) === 1)
    return { selector: `[data-testid=${attrValue(el.testId)}]`, stable: true };
  if (el.id !== undefined && !isGeneratedId(el.id) && count((e) => e.id === el.id) === 1)
    return { selector: `#${cssEscape(el.id)}`, stable: true };
  const classes = (el.classes ?? []).filter((c) => !isGeneratedClass(c));
  if (classes.length > 0) {
    const same = count(
      (e) => e.tag === el.tag && classes.every((c) => e.classes?.includes(c)),
    );
    if (same === 1)
      return {
        selector: `${cssEscape(el.tag)}.${classes.map(cssEscape).join('.')}`,
        stable: true,
      };
  }
  return { selector: escapedPath(el.path), stable: false };
}

export function selectorFor(s: StructureSnapshot, index: number): string {
  return describeSelector(s, index).selector;
}
