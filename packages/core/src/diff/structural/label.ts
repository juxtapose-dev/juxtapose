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

export function label(el: StructureElement): string {
  if (el.tag === 'masked') return 'masked';
  if (el.role && el.name) return `${el.role}[name="${el.name.slice(0, 40)}"]`;
  if (el.id !== undefined) return `${el.tag}#${el.id}`;
  if (el.testId !== undefined) return `${el.tag}[data-testid="${el.testId}"]`;
  if (el.classes?.length) return `${el.tag}.${el.classes[0]}`;
  return el.path
    .replace(/^html:nth-of-type\(1\)>body:nth-of-type\(1\)>/, '')
    .replace(/:nth-of-type\(1\)/g, '');
}

/** Identity with the page-specific part removed, so the same change on two
 *  pages hashes to the same signature. */
export function abstractLabel(el: StructureElement): string {
  return el.role ?? el.tag;
}
