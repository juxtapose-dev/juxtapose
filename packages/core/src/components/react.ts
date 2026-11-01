export interface ReactFiberView {
  kind: 'component' | 'host' | 'transparent' | 'hidden' | 'unsupported';
  child: object | null;
  sibling: object | null;
  name?: string;
  element?: Element;
}
/** Compatibility reads must be O(1), without props, source helpers or component invocation. */
export interface ReactComponentProvider {
  runtimeVersion: string;
  supported: boolean;
  /** Already committed root.current fibers, never their work-in-progress alternates. */
  roots: readonly object[];
  read(fiber: object): ReactFiberView;
}
export interface ReactComponentNode {
  id: number;
  parent: number | null;
  name?: string;
  elements: number[];
}
export type ReactSnapshotReason =
  | 'masked'
  | 'provider_missing'
  | 'unsupported_runtime'
  | 'unsupported_tree'
  | 'renderer_limit'
  | 'no_roots'
  | 'provider_error'
  | 'invalid_tree'
  | 'fiber_limit'
  | 'node_limit'
  | 'element_limit'
  | 'root_limit'
  | 'depth_limit'
  | 'time_limit';
export interface ReactComponentSnapshot {
  framework: 'react';
  runtimeVersion: string | null;
  relation: 'rendered-parent';
  status: 'available' | 'unavailable';
  reason: ReactSnapshotReason | null;
  truncated: boolean;
  nodes: ReactComponentNode[];
}
export interface ReactSnapshotOptions {
  excludedRoots?: readonly Element[];
  maxFibers?: number;
  maxNodes?: number;
  maxElements?: number;
  maxRoots?: number;
  maxDepth?: number;
  maxMs?: number;
}
/** Self-contained for in-page bundling. Call after settle, with retained unmasked DOM elements.
 * Empty element lists do not prove empty components: hosts may be offscreen or unretained. */
export function collectReactComponents(
  elements: readonly Element[],
  provider?: ReactComponentProvider,
  options: ReactSnapshotOptions = {},
): ReactComponentSnapshot {
  let runtimeVersion: string | null = null;
  const unavailable = (reason: ReactSnapshotReason): ReactComponentSnapshot => ({
    framework: 'react',
    runtimeVersion,
    relation: 'rendered-parent',
    status: 'unavailable',
    reason,
    truncated: false,
    nodes: [],
  });
  // A framework tree includes names that DOM masks removed. Do not inspect it at all.
  if (options.excludedRoots?.length) return unavailable('masked');
  if (!provider) return unavailable('provider_missing');
  const limit = (value: number | undefined, cap: number) =>
    typeof value === 'number' && Number.isSafeInteger(value) && value > 0
      ? Math.min(value, cap)
      : cap;
  const maxFibers = limit(options.maxFibers, 10000),
    maxNodes = limit(options.maxNodes, 1000),
    maxElements = limit(options.maxElements, 5000),
    maxRoots = limit(options.maxRoots, 16),
    maxDepth = limit(options.maxDepth, 64),
    maxMs = limit(options.maxMs, 25);
  const nodes: ReactComponentNode[] = [];
  let reason: ReactSnapshotReason | null = null;
  const truncate = (why: ReactSnapshotReason) => {
    reason ??= why;
  };
  const began = performance.now();
  try {
    const version = provider.runtimeVersion;
    if (
      typeof version !== 'string' ||
      version.length > 64 ||
      !/^(?:18|19)\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)
    )
      return unavailable('unsupported_runtime');
    runtimeVersion = version;
    if (provider.supported !== true) return unavailable('unsupported_runtime');
    if (!Array.isArray(provider.roots) || typeof provider.read !== 'function')
      return unavailable('provider_error');
    if (provider.roots.length === 0) return unavailable('no_roots');
    const byElement = new Map<Element, number[]>();
    if (elements.length > maxElements) truncate('element_limit');
    for (let i = 0; i < Math.min(elements.length, maxElements); i++) {
      const element = elements[i];
      if (!element || typeof element !== 'object') return unavailable('invalid_tree');
      const indices = byElement.get(element) ?? [];
      indices.push(i);
      byElement.set(element, indices);
    }
    if (provider.roots.length > maxRoots) truncate('root_limit');
    const stack: { fiber: object; parent: number | null; depth: number }[] = [];
    for (let i = Math.min(provider.roots.length, maxRoots) - 1; i >= 0; i--) {
      const fiber: unknown = provider.roots[i];
      if (!fiber || typeof fiber !== 'object') return unavailable('invalid_tree');
      stack.push({ fiber, parent: null, depth: 0 });
    }
    const visited = new Set<object>(),
      associated = new Set<number>();
    let fiberCount = 0;
    while (stack.length) {
      if (performance.now() - began >= maxMs) {
        truncate('time_limit');
        break;
      }
      if (fiberCount >= maxFibers) {
        truncate('fiber_limit');
        break;
      }
      const item = stack.pop()!;
      if (visited.has(item.fiber)) return unavailable('invalid_tree');
      visited.add(item.fiber);
      fiberCount++;
      const view = provider.read(item.fiber);
      if (performance.now() - began >= maxMs) {
        truncate('time_limit');
        break;
      }
      if (
        !view ||
        !['component', 'host', 'transparent', 'hidden', 'unsupported'].includes(
          view.kind,
        ) ||
        !(view.child === null || typeof view.child === 'object') ||
        !(view.sibling === null || typeof view.sibling === 'object')
      )
        return unavailable('invalid_tree');
      if (view.kind === 'unsupported') return unavailable('unsupported_tree');
      if (view.sibling)
        stack.push({ fiber: view.sibling, parent: item.parent, depth: item.depth });
      if (view.kind === 'hidden') continue;
      let parent = item.parent;
      if (view.kind === 'component') {
        if (nodes.length >= maxNodes) {
          truncate('node_limit');
          break;
        }
        const name = view.name;
        const safeName =
          typeof name === 'string' &&
          name.length > 0 &&
          name.length <= 128 &&
          ![...name].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
            ? name
            : undefined;
        parent = nodes.length;
        nodes.push({
          id: parent,
          parent: item.parent,
          ...(safeName ? { name: safeName } : {}),
          elements: [],
        });
      }
      if (view.kind === 'host' && parent !== null && view.element) {
        for (const index of byElement.get(view.element) ?? []) {
          if (associated.has(index)) return unavailable('invalid_tree');
          associated.add(index);
          nodes[parent]!.elements.push(index);
        }
      }
      if (view.child) {
        if (item.depth >= maxDepth) truncate('depth_limit');
        else stack.push({ fiber: view.child, parent, depth: item.depth + 1 });
      }
    }
    for (const node of nodes) node.elements.sort((a, b) => a - b);
    return {
      framework: 'react',
      runtimeVersion,
      relation: 'rendered-parent',
      status: 'available',
      reason,
      truncated: reason !== null,
      nodes,
    };
  } catch {
    return unavailable('provider_error');
  }
}
