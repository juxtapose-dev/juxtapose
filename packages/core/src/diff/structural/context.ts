import { INHERITED_PROPS, elementAt } from '../../capture/structure.js';
import type { StructureElement, StructureSnapshot } from '../../types.js';

/** An analysis view, not a rewritten baseline. Keep the original hash: changes
 * to framework paint (for example its background) must remain unexplained
 * pixels, not be misclassified as render drift after dropping the container. */
export function componentStructure(
  snapshot: StructureSnapshot | undefined,
  contextIds: ReadonlySet<string>,
  prefixes = contextPrefixes(snapshot, contextIds),
): StructureSnapshot | undefined {
  if (!snapshot || contextIds.size === 0 || prefixes.length === 0) return snapshot;

  const elements: StructureElement[] = [];
  const indices: Array<number | null> = [];
  for (const [i, el] of snapshot.elements.entries()) {
    if (el.parent === null && el.id !== undefined && contextIds.has(el.id)) {
      indices[i] = null;
      continue;
    }
    const parent = el.parent === null ? null : elementAt(snapshot, el.parent);
    const mappedParent = el.parent === null ? null : indices[el.parent];
    if (mappedParent === undefined) throw new Error('invalid structure parent order');
    const prefix = prefixes.find((prefix) => el.path.startsWith(prefix));
    // Compact snapshots store inherited values on the wrapper. Promote them
    // to its immediate component children so a preview font/color change
    // still points at the affected component, and descendants stay compact.
    const inherited =
      parent && mappedParent === null
        ? Object.fromEntries(
            Object.entries(parent.styles).filter(([prop]) => INHERITED_PROPS.has(prop)),
          )
        : {};
    indices[i] = elements.length;
    elements.push({
      ...el,
      path: prefix && el.path.startsWith(prefix) ? el.path.slice(prefix.length) : el.path,
      parent: mappedParent,
      styles: { ...inherited, ...el.styles },
    });
  }
  return { ...snapshot, elements };
}

export function contextPrefixes(
  snapshot: StructureSnapshot | undefined,
  ids: ReadonlySet<string>,
): string[] {
  if (!snapshot || ids.size === 0) return [];
  return snapshot.elements
    .filter((el) => el.parent === null && el.id !== undefined && ids.has(el.id))
    .map((el) => `${el.path}>`);
}
