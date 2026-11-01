import type { ComponentSnapshot } from './evidence.js';

/** Project validated capture metadata onto the DOM retained by hosted review. */
export function projectComponents(
  snapshot: ComponentSnapshot | undefined,
  retained: ReadonlySet<number>,
  limit: number,
  masked: boolean,
): ComponentSnapshot | undefined {
  if (!snapshot) return undefined;
  const budget = Math.max(0, Math.min(100, Math.floor(limit)));
  return {
    schema: snapshot.schema,
    trees: snapshot.trees.map((tree) => {
      if (masked)
        return {
          framework: tree.framework,
          parentRelation: tree.parentRelation,
          elementRelation: tree.elementRelation,
          coverage: tree.coverage,
          status: 'unavailable',
          reason: 'masked',
          truncated: false,
          nodes: [],
        };
      if (tree.status === 'unavailable') return tree;
      const included = new Set<number>();
      const priority = tree.nodes.filter((node) =>
        node.elements.some((index) => retained.has(index)),
      );
      for (const node of [...priority, ...tree.nodes]) {
        const needed: number[] = [];
        let id: number | null = node.id;
        while (id !== null && !included.has(id)) {
          needed.push(id);
          id = tree.nodes[id]!.parent;
        }
        if (included.size + needed.length <= budget)
          for (const ancestor of needed) included.add(ancestor);
      }
      const ids = [...included].sort((a, b) => a - b);
      const remap = new Map(ids.map((id, index) => [id, index]));
      let dropped = ids.length !== tree.nodes.length;
      const nodes = ids.map((oldId, id) => {
        const node = tree.nodes[oldId]!;
        const elements = node.elements.filter((index) => retained.has(index));
        if (elements.length !== node.elements.length) dropped = true;
        return {
          ...node,
          id,
          parent: node.parent === null ? null : remap.get(node.parent)!,
          elements,
        };
      });
      return {
        ...tree,
        ...(dropped
          ? {
              status: 'partial' as const,
              reason: 'budget-exceeded' as const,
              truncated: true,
            }
          : {}),
        nodes,
      };
    }),
  };
}
