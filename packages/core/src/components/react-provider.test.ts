import { expect, it } from 'vitest';
import { getReactWorkTagsForRenderer } from 'bippy';
import { createReactComponentProvider } from './react-provider.js';
const renderer = (version = '18.3.1') => ({
  version,
  bundleType: 0,
  rendererPackageName: 'react-dom',
});
const fiber = (tag: number, rest: Record<string, unknown> = {}) => ({
  tag,
  child: null,
  sibling: null,
  ...rest,
});
it('uses committed root.current and version-resolved tags without searching DOM fibers', () => {
  const r = renderer(),
    tags = getReactWorkTagsForRenderer(r),
    current = fiber(tags.HostRoot),
    stale = {};
  const result = createReactComponentProvider({
    renderers: new Map([[1, r]]),
    getFiberRoots: () => new Set([{ current, alternate: stale }]),
  });
  expect(result.status).toBe('available');
  if (result.status !== 'available') throw new Error('provider missing');
  expect(result.provider.roots).toEqual([current]);
  function Row() {}
  expect(result.provider.read(fiber(tags.FunctionComponent, { type: Row }))).toEqual({
    kind: 'component',
    child: null,
    sibling: null,
    name: 'Row',
  });
});
it('bounds renderer discovery even when an iterator disagrees with its size', () => {
  class ExtraRenderers extends Map<number, ReturnType<typeof renderer>> {
    get size() {
      return 0;
    }
  }
  const result = createReactComponentProvider({
    renderers: new ExtraRenderers(
      Array.from({ length: 5 }, (_, i) => [i + 1, renderer()]),
    ),
    getFiberRoots: () => new Set(),
  });
  expect(result).toMatchObject({ status: 'unavailable', reason: 'renderer_limit' });
});
it('bounds committed root discovery even when an iterator disagrees with its size', () => {
  class ExtraRoots extends Set<object> {
    get size() {
      return 0;
    }
  }
  const result = createReactComponentProvider({
    renderers: new Map([[1, renderer()]]),
    getFiberRoots: () =>
      new ExtraRoots(Array.from({ length: 17 }, () => ({ current: {} }))),
  });
  expect(result).toMatchObject({ status: 'unavailable', reason: 'root_limit' });
});
it.each(['18.3.1', '19.2.6'])(
  'classifies known React%s composites, portals and DOM hosts from library tags',
  (version) => {
    const r = renderer(version),
      tags = getReactWorkTagsForRenderer(r),
      current = fiber(tags.HostRoot);
    const result = createReactComponentProvider({
      renderers: new Map([[1, r]]),
      getFiberRoots: () => new Set([{ current }]),
    });
    if (result.status !== 'available') throw new Error('provider unavailable');
    const el = {} as Element;
    function Button() {}
    expect(
      result.provider.read(fiber(tags.ForwardRef, { type: { render: Button } })),
    ).toMatchObject({ kind: 'component', name: 'Button' });
    expect(
      result.provider.read(fiber(tags.MemoComponent, { type: { type: Button } })),
    ).toMatchObject({ kind: 'component', name: 'Button' });
    expect(
      result.provider.read(fiber(tags.HostComponent, { stateNode: el })),
    ).toMatchObject({ kind: 'host', element: el });
    expect(result.provider.read(fiber(tags.Fragment))).toMatchObject({
      kind: 'transparent',
    });
    expect(result.provider.read(fiber(tags.HostPortal))).toMatchObject({
      kind: 'transparent',
    });
  },
);
it('never invokes component bodies, getters, props, state or source helpers', () => {
  const r = renderer(),
    tags = getReactWorkTagsForRenderer(r),
    current = fiber(tags.HostRoot);
  let invoked = 0;
  function Button() {
    invoked++;
  }
  Object.defineProperty(Button, 'displayName', {
    get() {
      throw new Error('private getter');
    },
  });
  const child = fiber(tags.FunctionComponent, { type: Button });
  for (const name of [
    'memoizedProps',
    'memoizedState',
    '_debugSource',
    '_debugOwner',
    '_debugStack',
  ])
    Object.defineProperty(child, name, {
      get() {
        throw new Error('private');
      },
    });
  const result = createReactComponentProvider({
    renderers: new Map([[1, r]]),
    getFiberRoots: () => new Set([{ current }]),
  });
  if (result.status !== 'available') throw new Error('provider unavailable');
  expect(result.provider.read(child)).toMatchObject({
    kind: 'component',
    name: 'Button',
  });
  expect(invoked).toBe(0);
});
it.each(['18.3.1', '19.2.6'])(
  'reads only the internal Offscreen visibility marker for React%s',
  (version) => {
    const r = renderer(version),
      tags = getReactWorkTagsForRenderer(r);
    const result = createReactComponentProvider({
      renderers: new Map([[1, r]]),
      getFiberRoots: () => new Set([{ current: fiber(tags.HostRoot) }]),
    });
    if (result.status !== 'available') throw new Error('provider unavailable');
    const child = fiber(tags.FunctionComponent),
      sibling = fiber(tags.Fragment);
    expect(
      result.provider.read(
        fiber(tags.OffscreenComponent, { memoizedState: null, child, sibling }),
      ),
    ).toEqual({ kind: 'transparent', child, sibling });
    const hidden = new Proxy(
      {},
      {
        get() {
          throw new Error('internal data must not be read');
        },
      },
    );
    expect(
      result.provider.read(
        fiber(tags.OffscreenComponent, { memoizedState: hidden, child, sibling }),
      ),
    ).toEqual({ kind: 'hidden', child: null, sibling });
    for (const metadata of [{}, { memoizedState: 0 }])
      expect(
        result.provider.read(fiber(tags.OffscreenComponent, metadata)),
      ).toMatchObject({ kind: 'unsupported' });
    const getter = fiber(tags.OffscreenComponent);
    Object.defineProperty(getter, 'memoizedState', {
      get() {
        throw new Error('must not invoke getters');
      },
    });
    expect(result.provider.read(getter)).toMatchObject({ kind: 'unsupported' });
  },
);
it('accepts only hydrated Activity wrappers with a known Offscreen child', () => {
  const r = renderer('19.2.6'),
    tags = getReactWorkTagsForRenderer(r);
  const result = createReactComponentProvider({
    renderers: new Map([[1, r]]),
    getFiberRoots: () => new Set([{ current: fiber(tags.HostRoot) }]),
  });
  if (result.status !== 'available') throw new Error('provider unavailable');
  const child = fiber(tags.OffscreenComponent, { memoizedState: null });
  expect(
    result.provider.read(fiber(tags.ActivityComponent, { memoizedState: null, child })),
  ).toEqual({ kind: 'transparent', child, sibling: null });
  for (const rest of [
    { memoizedState: {} },
    { memoizedState: null, child: fiber(tags.Fragment) },
    {},
  ])
    expect(result.provider.read(fiber(tags.ActivityComponent, rest))).toMatchObject({
      kind: 'unsupported',
    });
  for (const tag of [tags.LegacyHiddenComponent, 126])
    expect(result.provider.read(fiber(tag))).toMatchObject({ kind: 'unsupported' });
});
it('does not recurse through cyclic or excessively nested display-name wrappers', () => {
  const r = renderer(),
    tags = getReactWorkTagsForRenderer(r),
    current = fiber(tags.HostRoot),
    type: Record<string, unknown> = {};
  type['type'] = type;
  const result = createReactComponentProvider({
    renderers: new Map([[1, r]]),
    getFiberRoots: () => new Set([{ current }]),
  });
  if (result.status !== 'available') throw new Error('provider unavailable');
  expect(result.provider.read(fiber(tags.MemoComponent, { type }))).not.toHaveProperty(
    'name',
  );
});
it('rejects mixed renderer versions and non-DOM renderers', () => {
  expect(
    createReactComponentProvider({
      renderers: new Map([
        [1, renderer()],
        [2, renderer('19.2.6')],
      ]),
      getFiberRoots: () => new Set(),
    }),
  ).toMatchObject({ status: 'unavailable', reason: 'unsupported_runtime' });
  expect(
    createReactComponentProvider({
      renderers: new Map([[1, { ...renderer(), rendererPackageName: 'react-native' }]]),
      getFiberRoots: () => new Set(),
    }),
  ).toMatchObject({ status: 'unavailable', reason: 'unsupported_runtime' });
});
it.each([null, {}, { renderers: new Map() }])(
  'reports missing hook capabilities without fallback scanning',
  (hook) => {
    expect(createReactComponentProvider(hook)).toMatchObject({
      status: 'unavailable',
      reason: 'provider_missing',
    });
  },
);
it('maps provider failures to a fixed reason without retaining raw error text', () => {
  const result = createReactComponentProvider({
    renderers: new Map([[1, renderer()]]),
    getFiberRoots() {
      throw new Error('secret/path');
    },
  });
  expect(result).toMatchObject({ status: 'unavailable', reason: 'provider_error' });
  expect(JSON.stringify(result)).not.toContain('secret');
});
