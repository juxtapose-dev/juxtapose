import { STRUCTURE_PROPS, hasCapturedStyle, styleReader } from '../capture/structure.js';
import type { StructureElement, StructureSnapshot } from '../types.js';

export const ELEMENT_QUERY_FIELDS = [
  'id',
  'testId',
  'tag',
  'role',
  'name',
  'text',
] as const;
export type ElementQuery = Partial<Record<(typeof ELEMENT_QUERY_FIELDS)[number], string>>;
const DEFAULT_PROPERTIES = [
  'font-family',
  'font-size',
  'font-weight',
  'line-height',
  'letter-spacing',
  'margin-top',
  'margin-bottom',
];
const MAX_BYTES = 3072;
interface Base {
  schema: 'juxtapose.current-element/v1';
  structureHash: string;
  provenance: 'structure';
  meaning: string;
}
export type ElementInspection = Base &
  (
    | {
        status: 'measured';
        element: Pick<
          StructureElement,
          'tag' | 'id' | 'testId' | 'role' | 'name' | 'text' | 'rect'
        >;
        styles: Record<string, string>;
        omittedStyles: number;
        unavailableProperties?: string[];
      }
    | { status: 'unavailable'; reason: string }
    | { status: 'not-found' }
    | { status: 'ambiguous'; matchingElementsAtLeast: 2 }
  );
export function isElementQuery(value: unknown): value is ElementQuery {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length > 0 &&
    Object.entries(value).every(
      ([key, val]) =>
        (ELEMENT_QUERY_FIELDS as readonly string[]).includes(key) &&
        typeof val === 'string' &&
        val.trim().length > 0,
    )
  );
}
export function checkElementProperties(value: unknown): asserts value is string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > 12 ||
    value.some(
      (p) =>
        typeof p !== 'string' || p.length > 100 || !/^[-a-zA-Z][a-zA-Z0-9-]*$/.test(p),
    )
  )
    throw new Error(
      'properties must contain 1–12 CSS property names; uncaptured values are reported unavailable, and width/height are in rect',
    );
}
/** In a held-out typography choice, saved current styles identified the exact
 * edit 2/2 versus 1/2 for screenshots alone. Keep this requested, not default. */
export function inspectStructureElement(
  snapshot: StructureSnapshot,
  query: ElementQuery,
  properties: readonly string[] = DEFAULT_PROPERTIES,
): ElementInspection {
  if (!isElementQuery(query))
    throw new Error(
      'element must contain exact id, testId, tag, role, name or text fields',
    );
  checkElementProperties(properties);
  const base: Base = {
    schema: 'juxtapose.current-element/v1',
    structureHash: snapshot.structureHash,
    provenance: 'structure',
    meaning:
      'Captured computed values and border-box rect in this saved current structure; not target values, live state or winning CSS-rule locations.',
  };
  if (snapshot.truncated)
    return { ...base, status: 'unavailable', reason: 'truncated-structure' };
  let found: number | undefined;
  // A second match proves ambiguity; no full element index is needed for a
  // requested lookup, and unchanged duplicate elements count too.
  for (let i = 0; i < snapshot.elements.length; i++) {
    const e = snapshot.elements[i]!;
    if (
      !Object.entries(query).every(([key, value]) =>
        key === 'tag'
          ? e.tag.toLowerCase() === value.toLowerCase()
          : e[key as keyof ElementQuery] === value,
      )
    )
      continue;
    if (found !== undefined)
      return { ...base, status: 'ambiguous', matchingElementsAtLeast: 2 };
    found = i;
  }
  if (found === undefined) return { ...base, status: 'not-found' };
  const { tag, id, testId, role, name, text, rect } = snapshot.elements[found]!;
  const element = {
    tag,
    ...(id !== undefined ? { id } : {}),
    ...(testId !== undefined ? { testId } : {}),
    ...(role ? { role } : {}),
    ...(name ? { name } : {}),
    ...(text ? { text } : {}),
    rect: { ...rect },
  };
  const read = styleReader(snapshot);
  const available: Array<[string, string]> = [];
  const unavailableProperties: string[] = [];
  for (const property of [...new Set(properties)].sort()) {
    // A real agent asked for image-rendering with opacity/transform. Rejecting
    // the entire request discarded known facts and stopped its iteration.
    const value =
      STRUCTURE_PROPS.includes(property) && hasCapturedStyle(snapshot, property)
        ? read(found, property)
        : undefined;
    if (value === undefined) unavailableProperties.push(property);
    else available.push([property, value]);
  }
  const result = {
    ...base,
    status: 'measured' as const,
    element,
    styles: {} as Record<string, string>,
    omittedStyles: 0,
    ...(unavailableProperties.length ? { unavailableProperties } : {}),
  };
  if (Buffer.byteLength(JSON.stringify(result)) > MAX_BYTES)
    return { ...base, status: 'unavailable', reason: 'element-metadata-exceeds-budget' };
  for (const [property, value] of available) {
    const candidate = {
      ...result,
      styles: { ...result.styles, [property]: value },
      omittedStyles: result.omittedStyles + properties.length,
    };
    if (Buffer.byteLength(JSON.stringify(candidate)) > MAX_BYTES) result.omittedStyles++;
    else result.styles[property] = value;
  }
  return result;
}
