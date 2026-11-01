import { afterEach, expect, it, vi } from 'vitest';
afterEach(() => vi.restoreAllMocks());
import {
  collectReactComponents,
  type ReactComponentProvider,
  type ReactFiberView,
} from './react.js';
const element = () => ({}) as Element;
function provider(
  root: object,
  views: Map<object, ReactFiberView>,
): ReactComponentProvider {
  return {
    runtimeVersion: '18.3.1',
    supported: true,
    roots: [root],
    read(f) {
      const value = views.get(f);
      if (!value) throw new Error('unknown fiber');
      return value;
    },
  };
}
it('preserves repeated instances and empty components while mapping supplied element identity', () => {
  const root = {},
    a = {},
    b = {},
    hostA = {},
    hostB = {},
    empty = {};
  const first = element(),
    second = element();
  const p = provider(
    root,
    new Map([
      [root, { kind: 'transparent', child: a, sibling: null }],
      [a, { kind: 'component', name: 'Row', child: hostA, sibling: b }],
      [hostA, { kind: 'host', element: first, child: null, sibling: null }],
      [b, { kind: 'component', name: 'Row', child: hostB, sibling: empty }],
      [hostB, { kind: 'host', element: second, child: null, sibling: null }],
      [empty, { kind: 'component', name: 'Empty', child: null, sibling: null }],
    ]),
  );
  expect(collectReactComponents([second, first], p)).toMatchObject({
    status: 'available',
    reason: null,
    truncated: false,
    nodes: [
      { id: 0, parent: null, name: 'Row', elements: [1] },
      { id: 1, parent: null, name: 'Row', elements: [0] },
      { id: 2, parent: null, name: 'Empty', elements: [] },
    ],
  });
});

it('keeps transparent fragments, nearest host associations and framework portal ancestry', () => {
  const root = {},
    app = {},
    fragment = {},
    row = {},
    host = {},
    portal = {},
    aside = {};
  const target = element(),
    portalTarget = element();
  const p = provider(
    root,
    new Map([
      [root, { kind: 'transparent', child: app, sibling: null }],
      [app, { kind: 'component', name: 'App', child: fragment, sibling: null }],
      [fragment, { kind: 'transparent', child: row, sibling: portal }],
      [row, { kind: 'component', name: 'Row', child: host, sibling: null }],
      [host, { kind: 'host', element: target, child: null, sibling: null }],
      [portal, { kind: 'component', name: 'Portal', child: aside, sibling: null }],
      [aside, { kind: 'host', element: portalTarget, child: null, sibling: null }],
    ]),
  );
  expect(collectReactComponents([portalTarget, target], p).nodes).toEqual([
    { id: 0, parent: null, name: 'App', elements: [] },
    { id: 1, parent: 0, name: 'Row', elements: [1] },
    { id: 2, parent: 0, name: 'Portal', elements: [0] },
  ]);
});
it('returns masked before reading any provider field or fiber', () => {
  const read = vi.fn();
  const p: ReactComponentProvider = {
    get runtimeVersion() {
      throw new Error('must not inspect');
    },
    supported: true,
    roots: [],
    read,
  };
  expect(collectReactComponents([], p, { excludedRoots: [element()] })).toMatchObject({
    status: 'unavailable',
    reason: 'masked',
    runtimeVersion: null,
    nodes: [],
  });
  expect(read).not.toHaveBeenCalled();
});
it('skips hidden trees without inspecting their names or descendants', () => {
  const root = {},
    visible = {},
    hidden = {},
    secret = {};
  const p = provider(
    root,
    new Map([
      [root, { kind: 'transparent', child: visible, sibling: null }],
      [visible, { kind: 'component', name: 'Visible', child: null, sibling: hidden }],
      [hidden, { kind: 'hidden', child: secret, sibling: null }],
    ]),
  );
  expect(collectReactComponents([], p).nodes).toEqual([
    { id: 0, parent: null, name: 'Visible', elements: [] },
  ]);
});
it('reports no roots and never substitutes DOM ancestry or a fabricated framework', () => {
  expect(collectReactComponents([])).toMatchObject({
    status: 'unavailable',
    reason: 'provider_missing',
    nodes: [],
  });
  expect(
    collectReactComponents([], { ...provider({}, new Map()), roots: [] }),
  ).toMatchObject({ status: 'unavailable', reason: 'no_roots', nodes: [] });
});
it.each(['17.0.2', '20.0.0', 'unknown', '19.1.0\nsecret'])(
  'refuses unsupported runtime %s before traversal',
  (runtimeVersion) => {
    const read = vi.fn();
    expect(
      collectReactComponents([], { runtimeVersion, supported: true, roots: [{}], read }),
    ).toMatchObject({ status: 'unavailable', reason: 'unsupported_runtime', nodes: [] });
    expect(read).not.toHaveBeenCalled();
  },
);
it('requires provider compatibility, not merely a major version string', () => {
  const read = vi.fn();
  expect(
    collectReactComponents([], {
      runtimeVersion: '19.1.0',
      supported: false,
      roots: [{}],
      read,
    }),
  ).toMatchObject({ status: 'unavailable', reason: 'unsupported_runtime' });
  expect(read).not.toHaveBeenCalled();
});
it('rejects a cycle rather than returning an authoritative partial tree', () => {
  const root = {};
  const p = provider(
    root,
    new Map([[root, { kind: 'component', name: 'Cycle', child: root, sibling: null }]]),
  );
  expect(collectReactComponents([], p)).toMatchObject({
    status: 'unavailable',
    reason: 'invalid_tree',
    truncated: false,
    nodes: [],
  });
});
it('rejects the same fiber borrowed by two roots', () => {
  const root = {};
  const p = provider(
    root,
    new Map([[root, { kind: 'component', name: 'One', child: null, sibling: null }]]),
  );
  p.roots = [root, root];
  expect(collectReactComponents([], p)).toMatchObject({
    status: 'unavailable',
    reason: 'invalid_tree',
    nodes: [],
  });
});
it('discards a provider error without exposing its raw details', () => {
  const p = provider({}, new Map());
  expect(collectReactComponents([], p)).toMatchObject({
    status: 'unavailable',
    reason: 'provider_error',
    nodes: [],
  });
  expect(JSON.stringify(collectReactComponents([], p))).not.toContain('unknown fiber');
});
function chain(length: number) {
  const fibers = Array.from({ length }, () => ({}));
  return provider(
    fibers[0]!,
    new Map(
      fibers.map((f, i) => [
        f,
        { kind: 'component', name: 'Layer', child: fibers[i + 1] ?? null, sibling: null },
      ]),
    ),
  );
}
it('counts every visited fiber, including transparent nodes, against the hard work bound', () => {
  const p = chain(8),
    original = p.read;
  p.read = vi.fn((f) => ({ ...original(f), kind: 'transparent' }));
  expect(collectReactComponents([], p, { maxFibers: 2 })).toMatchObject({
    status: 'available',
    reason: 'fiber_limit',
    truncated: true,
    nodes: [],
  });
  expect(p.read).toHaveBeenCalledTimes(2);
});
it('caps component nodes without manufacturing parents outside the returned tree', () => {
  expect(collectReactComponents([], chain(8), { maxNodes: 2 })).toMatchObject({
    status: 'available',
    reason: 'node_limit',
    truncated: true,
    nodes: [
      { id: 0, parent: null },
      { id: 1, parent: 0 },
    ],
  });
});
it('caps depth, retaining explicit incomplete evidence', () => {
  const p = chain(8);
  p.read = vi.fn(p.read);
  expect(collectReactComponents([], p, { maxDepth: 1 })).toMatchObject({
    reason: 'depth_limit',
    truncated: true,
    nodes: [
      { id: 0, parent: null },
      { id: 1, parent: 0 },
    ],
  });
  expect(p.read).toHaveBeenCalledTimes(2);
});
it('caps roots before visiting additional trees', () => {
  const p = chain(1);
  p.roots = [...p.roots, {}];
  p.read = vi.fn(p.read);
  expect(collectReactComponents([], p, { maxRoots: 1 })).toMatchObject({
    reason: 'root_limit',
    truncated: true,
    nodes: [{ id: 0, parent: null }],
  });
  expect(p.read).toHaveBeenCalledTimes(1);
});
it('maps only supplied Element identity, caps input and preserves repeated input indices', () => {
  const root = {},
    first = element(),
    absent = element();
  const p = provider(
    root,
    new Map([
      [root, { kind: 'component', name: 'App', child: absent, sibling: null }],
      [absent, { kind: 'host', element: first, child: null, sibling: null }],
    ]),
  );
  expect(
    collectReactComponents([first, first, element()], p, { maxElements: 2 }),
  ).toMatchObject({
    reason: 'element_limit',
    truncated: true,
    nodes: [{ id: 0, elements: [0, 1] }],
  });
  expect(collectReactComponents([element()], p).nodes[0]?.elements).toEqual([]);
});
it('stops before a provider read when the time budget is exhausted', () => {
  vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValue(26);
  const p = chain(1);
  p.read = vi.fn(p.read);
  expect(collectReactComponents([], p)).toMatchObject({
    reason: 'time_limit',
    truncated: true,
    nodes: [],
  });
  expect(p.read).not.toHaveBeenCalled();
});
it('does not serialize props, source, state or unsafe names', () => {
  const root = {};
  const view: ReactFiberView = {
    kind: 'component',
    name: 'x'.repeat(129),
    child: null,
    sibling: null,
  };
  for (const key of ['props', 'source', 'state'])
    Object.defineProperty(view, key, {
      get() {
        throw new Error('private');
      },
    });
  const result = collectReactComponents([], provider(root, new Map([[root, view]])));
  expect(result).toMatchObject({
    status: 'available',
    reason: null,
    nodes: [{ id: 0, parent: null, elements: [] }],
  });
  expect(Object.keys(result.nodes[0]!)).toEqual(['id', 'parent', 'elements']);
  expect(JSON.stringify(result)).not.toContain('private');
});
it('is serializable as a self-contained browser function', () => {
  const copy = new Function(
    `return (${collectReactComponents.toString()})`,
  )() as typeof collectReactComponents;
  expect(copy([], chain(1))).toEqual(collectReactComponents([], chain(1)));
});
