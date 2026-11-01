/** Browser-only metadata. No attributes, wrappers, props or component state. */
export interface SvelteComponentNode {
  id: string;
  parent: string | null;
  name?: string;
  source?: { file: string; provenance: 'compiler' };
  elements: number[];
}
export interface SvelteComponentEvidence {
  framework: 'svelte';
  runtimeVersion?: string;
  relation: 'instrumented-context';
  elementRelation: 'declared-by';
  status: 'partial' | 'unavailable';
  reason: 'instrumented-components-only' | 'masked' | 'not-instrumented';
  truncated: boolean;
  nodes: SvelteComponentNode[];
}
export interface SvelteComponentRegistry {
  readonly marker: 'juxtapose.svelte-instrumentation/v1';
  readonly contextKey: symbol;
  register(name: string, source: string | null, parent: unknown): string | null;
  destroy(id: string | null): void;
  own(element: Element, id: string | null): { destroy(): void };
  collect(
    elements: readonly Element[],
    excludedRoots?: readonly Element[],
  ): SvelteComponentEvidence;
}
export const SVELTE_COMPONENT_REGISTRY = 'juxtapose.svelte.components/v1';

/** Self-contained so the build plugin can serialize this function into a virtual module. */
export function installSvelteComponentRegistry(
  version: string,
  maxNodes = 1024,
): SvelteComponentRegistry {
  const key = Symbol.for('juxtapose.svelte.components/v1');
  const previous: unknown = Reflect.get(globalThis, key);
  if (
    previous !== null &&
    typeof previous === 'object' &&
    Reflect.get(previous, 'marker') === 'juxtapose.svelte-instrumentation/v1' &&
    typeof Reflect.get(previous, 'contextKey') === 'symbol' &&
    ['register', 'destroy', 'own', 'collect'].every(
      (name) => typeof Reflect.get(previous, name) === 'function',
    )
  )
    return previous as SvelteComponentRegistry;
  const contextKey = Symbol('juxtapose.svelte.instance');
  const nodes = new Map<string, Omit<SvelteComponentNode, 'elements'>>();
  const owners = new WeakMap<Element, string>();
  const limit =
    Number.isSafeInteger(maxNodes) && maxNodes > 0 ? Math.min(maxNodes, 1024) : 1024;
  const runtimeVersion = /^5\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(version)
    ? version
    : undefined;
  let next = 0,
    truncated = false;
  const registry: SvelteComponentRegistry = {
    marker: 'juxtapose.svelte-instrumentation/v1',
    contextKey,
    register(name, file, parent) {
      if (nodes.size >= limit) {
        truncated = true;
        return null;
      }
      const id = `s${++next}`;
      const safeName =
        name.length > 0 &&
        name.length <= 120 &&
        ![...name].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
      const safeFile =
        file !== null &&
        file.length > 0 &&
        file.length <= 512 &&
        !/[\\:%?#]/.test(file) &&
        ![...file].some(
          (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
        ) &&
        !file.startsWith('/') &&
        !file.split('/').some((part) => part === '' || part === '.' || part === '..');
      nodes.set(id, {
        id,
        parent: typeof parent === 'string' && nodes.has(parent) ? parent : null,
        ...(safeName ? { name } : {}),
        ...(safeFile ? { source: { file, provenance: 'compiler' as const } } : {}),
      });
      return id;
    },
    destroy(id) {
      if (id !== null) nodes.delete(id);
    },
    own(element, id) {
      if (id !== null && nodes.has(id)) owners.set(element, id);
      return {
        destroy() {
          if (owners.get(element) === id) owners.delete(element);
        },
      };
    },
    collect(elements, excludedRoots = []) {
      const base = {
        framework: 'svelte' as const,
        ...(runtimeVersion ? { runtimeVersion } : {}),
        relation: 'instrumented-context' as const,
        elementRelation: 'declared-by' as const,
      };
      // Empty/text-only components cannot be located relative to a mask safely.
      if (excludedRoots.length)
        return {
          ...base,
          status: 'unavailable',
          reason: 'masked',
          truncated: false,
          nodes: [],
        };
      const indices = new Map<string, number[]>();
      for (let i = 0; i < Math.min(elements.length, 5000); i++) {
        const element = elements[i];
        if (!element) continue;
        const owner = owners.get(element);
        if (owner && nodes.has(owner)) {
          const list = indices.get(owner);
          if (list) list.push(i);
          else indices.set(owner, [i]);
        }
      }
      return {
        ...base,
        status: 'partial',
        reason: 'instrumented-components-only',
        truncated: truncated || elements.length > 5000,
        nodes: [...nodes.values()].map((node) => ({
          id: node.id,
          parent: node.parent !== null && nodes.has(node.parent) ? node.parent : null,
          ...(node.name ? { name: node.name } : {}),
          ...(node.source ? { source: { ...node.source } } : {}),
          elements: indices.get(node.id) ?? [],
        })),
      };
    },
  };
  Reflect.set(globalThis, key, registry);
  return registry;
}
