// Short human labels for elements in deltas and summaries. The budget is
// ~1,500 chars for a whole verdict, so a label is the shortest thing that
// still tells an agent which element to look at.

import type { StructureElement } from '../../types.js';

/** Elements that paint their own pixels: a change inside them leaves the DOM
 *  and computed styles untouched, so unexplained pixels on one of these mean
 *  "content", not "drift". */
export const SELF_PAINTING: ReadonlySet<string> = new Set([
  'canvas',
  'video',
  'img',
  'iframe',
  'object',
  'embed',
]);

/** Longest label in a delta or summary. A deep path or a generated id or
 *  class must not be able to spend the verdict's 1,500-char budget. */
export const MAX_LABEL = 60;

export function label(el: StructureElement): string {
  if (el.tag === 'masked') return 'masked';
  if (el.role && el.name)
    return clip(`${el.role}[name="${clip(el.name, 40)}"]`, MAX_LABEL);
  if (el.id !== undefined) return clip(`${el.tag}#${el.id}`, MAX_LABEL);
  if (el.testId !== undefined)
    return clip(`${el.tag}[data-testid="${el.testId}"]`, MAX_LABEL);
  if (el.classes?.length) return clip(`${el.tag}.${el.classes[0]}`, MAX_LABEL);
  return clipPath(
    el.path
      .replace(/^html:nth-of-type\(1\)>body:nth-of-type\(1\)>/, '')
      .replace(/:nth-of-type\(1\)/g, ''),
  );
}

/** A path keeps its tail — the element itself and its nearest ancestors —
 *  cut at a `>` boundary, so what remains is still a valid selector suffix. */
function clipPath(path: string): string {
  if (path.length <= MAX_LABEL) return path;
  const parts = path.split('>');
  let out = parts[parts.length - 1];
  for (let k = parts.length - 2; k >= 0; k--) {
    const next = `${parts[k]}>${out}`;
    if (next.length + 2 > MAX_LABEL) break;
    out = next;
  }
  return `…>${clip(out, MAX_LABEL - 2)}`;
}

/** At most `max` UTF-16 units, ending in `…` when cut, never splitting a
 *  surrogate pair (half an emoji is invalid UTF-16 in the JSON). */
export function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  let end = max - 1;
  const c = s.charCodeAt(end - 1);
  if (c >= 0xd800 && c <= 0xdbff) end--;
  return s.slice(0, end) + '…';
}

/** Identity with the page-specific part removed, so the same change on two
 *  pages hashes to the same signature. */
export function abstractLabel(el: StructureElement): string {
  return el.role ?? el.tag;
}
