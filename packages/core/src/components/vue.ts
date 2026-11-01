export interface VueComponentNode {
  /** Capture-local instance identity; never a durable cross-render identifier. */
  id: string;
  parent: string | null;
  name?: string;
  elements: number[];
}

export interface VueComponentSnapshot {
  framework: 'vue';
  runtimeVersion?: string;
  relation: 'rendered-parent';
  status: 'ok' | 'partial' | 'unavailable';
  reason?: 'runtime_hooks_unavailable' | 'unsupported_runtime' | 'limit' | 'masked';
  truncated: boolean;
  nodes: VueComponentNode[];
}

/**
 * Browser-only, self-contained so capture can serialize the function without a
 * Vue dependency. Vue 3's devtools element hooks require a development build or
 * __VUE_PROD_DEVTOOLS__. Never enable that flag or modify the page here.
 * Logical rendered parents come from raw instances, never DOM ancestry. The
 * vnode walk retains empty components and Teleport/fragment siblings which an
 * element-to-source stack cannot represent.
 */
export function collectVueComponents(
  elements: Element[],
  excludedRoots: Element[] = [],
): VueComponentSnapshot {
  // Without a full physical-root proof, a fragment/Teleport/zero-DOM child
  // could disclose names behind a mask. Suppress the graph conservatively.
  if (excludedRoots.length)
    return {
      framework: 'vue',
      relation: 'rendered-parent',
      status: 'unavailable',
      reason: 'masked',
      truncated: false,
      nodes: [],
    };
  const MAX_ELEMENTS = 4096;
  const MAX_NODES = 1024;
  const MAX_VISITS = 16384;
  const MAX_DEPTH = 128;
  type Raw = Record<string, unknown>;
  const object = (value: unknown): value is Raw =>
    value !== null && (typeof value === 'object' || typeof value === 'function');
  // Structural instance fields are own data properties. Do not invoke user
  // getters, inspect props/setup state, call render functions or read slots.
  const data = (value: unknown, key: string): unknown => {
    if (!object(value)) return undefined;
    try {
      const field = Object.getOwnPropertyDescriptor(value, key);
      return field && 'value' in field ? field.value : undefined;
    } catch {
      return undefined;
    }
  };
  let truncated = elements.length > MAX_ELEMENTS;
  const owners = new Map<Raw, number[]>();
  const roots = new Set<Raw>();
  const memberships = new Map<Element, number[]>();
  for (let index = 0; index < Math.min(elements.length, MAX_ELEMENTS); index++) {
    const element = elements[index];
    if (!element) continue;
    const indices = memberships.get(element);
    if (indices) indices.push(index);
    else memberships.set(element, [index]);
  }
  for (const [input, inputIndices] of memberships) {
    let element: Element | null = input;
    let owner: unknown;
    const ancestors = new Set<Element>();
    for (let depth = 0; element && depth < MAX_DEPTH; depth++) {
      if (ancestors.has(element)) break;
      ancestors.add(element);
      owner = data(element, '__vueParentComponent');
      if (object(owner)) break;
      element = element.parentElement;
      if (depth === MAX_DEPTH - 1 && element) truncated = true;
    }
    if (!object(owner)) continue;
    const indices = owners.get(owner);
    if (indices) indices.push(...inputIndices);
    else owners.set(owner, [...inputIndices]);
    const seen = new Set<Raw>();
    let root = owner;
    for (let depth = 0; depth < MAX_DEPTH; depth++) {
      if (seen.has(root)) {
        truncated = true;
        break;
      }
      seen.add(root);
      const parent = data(root, 'parent');
      if (!object(parent)) break;
      root = parent;
      if (depth === MAX_DEPTH - 1) truncated = true;
    }
    roots.add(root);
  }

  const result: VueComponentSnapshot = {
    framework: 'vue',
    relation: 'rendered-parent',
    status: 'unavailable',
    reason: 'runtime_hooks_unavailable',
    truncated,
    nodes: [],
  };
  const instances = new Map<Raw, VueComponentNode>();
  const visited = new Set<Raw>();
  const queue: { value: Raw; instance: boolean }[] = [];
  let unsupported = false;
  for (const root of roots) {
    const version = data(data(data(root, 'appContext'), 'app'), 'version');
    if (
      typeof version !== 'string' ||
      version.length > 64 ||
      !/^3\.\d+\.\d+(?:[-+].*)?$/.test(version)
    ) {
      unsupported = true;
      continue;
    }
    result.runtimeVersion ??= version;
    queue.push({ value: root, instance: true });
  }
  let cursor = 0;
  while (cursor < queue.length && cursor < MAX_VISITS) {
    const { value, instance } = queue[cursor++]!;
    if (visited.has(value)) continue;
    visited.add(value);
    if (instance) {
      if (data(value, 'isUnmounted') === true) continue;
      if (instances.size >= MAX_NODES) {
        truncated = true;
        continue;
      }
      const type = data(value, 'type');
      const name = data(type, 'name') ?? data(type, '__name');
      instances.set(value, {
        id: `vue:${instances.size}`,
        parent: null,
        ...(typeof name === 'string' && name.length <= 120 ? { name } : {}),
        elements: (owners.get(value) ?? []).sort((a, b) => a - b),
      });
      const subTree = data(value, 'subTree');
      if (object(subTree)) queue.push({ value: subTree, instance: false });
    } else {
      const component = data(value, 'component');
      if (object(component)) queue.push({ value: component, instance: true });
      const suspense = data(value, 'suspense');
      const active = data(suspense, 'activeBranch');
      if (object(active)) queue.push({ value: active, instance: false });
      const children = data(value, 'children');
      if (Array.isArray(children)) {
        for (let i = 0; i < children.length; i++) {
          if (queue.length >= MAX_VISITS) {
            truncated = true;
            break;
          }
          const child = data(children, String(i));
          if (object(child)) queue.push({ value: child, instance: false });
        }
      }
    }
  }
  if (cursor < queue.length) truncated = true;
  for (const [instance, node] of instances) {
    const parent = data(instance, 'parent');
    if (object(parent)) {
      const chain = new Set<Raw>([instance]);
      let ancestor: unknown = parent;
      let valid = true;
      for (let depth = 0; object(ancestor); depth++) {
        if (chain.has(ancestor) || depth >= MAX_DEPTH) {
          valid = false;
          truncated = true;
          break;
        }
        chain.add(ancestor);
        ancestor = data(ancestor, 'parent');
      }
      if (valid) node.parent = instances.get(parent)?.id ?? null;
    }
  }
  result.nodes = [...instances.values()];
  result.truncated = truncated;
  if (result.nodes.length) {
    result.status = truncated || unsupported ? 'partial' : 'ok';
    if (truncated) result.reason = 'limit';
    else if (unsupported) result.reason = 'unsupported_runtime';
    else delete result.reason;
  } else if (unsupported) result.reason = 'unsupported_runtime';
  return result;
}
