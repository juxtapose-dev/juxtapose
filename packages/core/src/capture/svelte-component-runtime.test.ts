import { afterEach, expect, it } from 'vitest';
import {
  installSvelteComponentRegistry,
  SVELTE_COMPONENT_REGISTRY,
} from './svelte-component-runtime.js';
afterEach(() => {
  Reflect.deleteProperty(globalThis, Symbol.for(SVELTE_COMPONENT_REGISTRY));
});
it('keeps separate instances for repeated and zero-element components with explicit context/declaration relations', () => {
  const registry = installSvelteComponentRegistry('5.55.7');
  const root = registry.register('App', 'src/App.svelte', null);
  const first = registry.register('Fragment', 'src/Fragment.svelte', root);
  const second = registry.register('Fragment', 'src/Fragment.svelte', root);
  const empty = registry.register('Empty', 'src/Empty.svelte', root);
  const one = {} as Element,
    two = {} as Element;
  registry.own(one, first);
  registry.own(two, second);
  const result = registry.collect([one, two]);
  expect(first).not.toBe(second);
  expect(result).toMatchObject({
    runtimeVersion: '5.55.7',
    relation: 'instrumented-context',
    elementRelation: 'declared-by',
    status: 'partial',
    reason: 'instrumented-components-only',
  });
  expect(result.nodes).toEqual([
    {
      id: root,
      parent: null,
      name: 'App',
      source: { file: 'src/App.svelte', provenance: 'compiler' },
      elements: [],
    },
    {
      id: first,
      parent: root,
      name: 'Fragment',
      source: { file: 'src/Fragment.svelte', provenance: 'compiler' },
      elements: [0],
    },
    {
      id: second,
      parent: root,
      name: 'Fragment',
      source: { file: 'src/Fragment.svelte', provenance: 'compiler' },
      elements: [1],
    },
    {
      id: empty,
      parent: root,
      name: 'Empty',
      source: { file: 'src/Empty.svelte', provenance: 'compiler' },
      elements: [],
    },
  ]);
});
it('returns no names or source evidence for any active mask', () => {
  const registry = installSvelteComponentRegistry('5.55.7');
  registry.register('PrivateComponent', 'src/PrivateComponent.svelte', null);
  expect(registry.collect([], [{} as Element])).toMatchObject({
    status: 'unavailable',
    reason: 'masked',
    nodes: [],
  });
  expect(JSON.stringify(registry.collect([], [{} as Element]))).not.toContain('Private');
});
it('tears down ownership without a late cleanup removing a newer owner', () => {
  const registry = installSvelteComponentRegistry('5.55.7');
  const a = registry.register('A', null, null),
    b = registry.register('B', null, null),
    element = {} as Element;
  const old = registry.own(element, a);
  const current = registry.own(element, b);
  old.destroy();
  expect(registry.collect([element]).nodes.find((n) => n.id === b)?.elements).toEqual([
    0,
  ]);
  current.destroy();
  registry.destroy(a);
  registry.destroy(b);
  expect(registry.collect([element]).nodes).toEqual([]);
});
it('bounds component retention and refuses absolute/unsafe source metadata', () => {
  const registry = installSvelteComponentRegistry('5.55.7', 2);
  registry.register('A', '/Users/private/A.svelte', null);
  registry.register('B', '../secret/B.svelte', null);
  expect(registry.register('Overflow', null, null)).toBeNull();
  expect(registry.collect([])).toMatchObject({
    truncated: true,
    nodes: [{ name: 'A' }, { name: 'B' }],
  });
  expect(registry.collect([]).nodes.every((n) => n.source === undefined)).toBe(true);
});
it('reuses one registry and a unique context symbol per browser realm', () => {
  const first = installSvelteComponentRegistry('5.55.7');
  expect(installSvelteComponentRegistry('5.55.7')).toBe(first);
  expect(Symbol.keyFor(first.contextKey)).toBeUndefined();
});

it('clamps schema bounds and marks dropped component/element evidence truncated', () => {
  const registry = installSvelteComponentRegistry('5.55.7', 5000);
  const first = registry.register('A', null, null);
  for (let i = 1; i < 1024; i++) registry.register('A', null, first);
  expect(registry.register('Overflow', null, first)).toBeNull();
  const element = {} as Element;
  registry.own(element, first);
  const evidence = registry.collect(Array.from({ length: 5001 }, () => element));
  expect(evidence.truncated).toBe(true);
  expect(evidence.nodes).toHaveLength(1024);
  expect(evidence.nodes[0]?.elements).toHaveLength(5000);
  expect(evidence.nodes[0]?.elements.at(-1)).toBe(4999);
});
it('omits overlong names and URL-delimited source paths', () => {
  const registry = installSvelteComponentRegistry('5.55.7');
  for (const file of ['src/A%20.svelte', 'src/A?part.svelte', 'src/A#part.svelte'])
    registry.register('A'.repeat(121), file, null);
  expect(
    registry
      .collect([])
      .nodes.every((node) => node.name === undefined && node.source === undefined),
  ).toBe(true);
});
