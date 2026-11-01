import { getReactWorkTagsForRenderer } from 'bippy';
import type { ReactComponentProvider, ReactFiberView } from './react.js';
export type ReactProviderFailure =
  | 'provider_missing'
  | 'unsupported_runtime'
  | 'provider_error'
  | 'renderer_limit'
  | 'root_limit';
export type ReactProviderResult =
  | { status: 'available'; provider: ReactComponentProvider }
  | {
      status: 'unavailable';
      runtimeVersion: string | null;
      reason: ReactProviderFailure;
    };

function own(target: object, key: string): unknown {
  const value: unknown = Object.getOwnPropertyDescriptor(target, key)?.value;
  return value;
}
const object = (value: unknown): value is object =>
  (typeof value === 'object' && value !== null) || typeof value === 'function';
/** Names are optional. Do not invoke getters or follow an arbitrarily deep memo/forwardRef chain. */
function componentName(type: unknown): string | undefined {
  const visited = new Set<object>();
  for (let i = 0; i < 8 && object(type) && !visited.has(type); i++) {
    visited.add(type);
    for (const key of ['displayName', 'name']) {
      const name = own(type, key);
      if (typeof name === 'string' && name.length > 0 && name.length <= 128) return name;
    }
    type = own(type, 'type') ?? own(type, 'render');
  }
  return undefined;
}

/** Snapshot discovery only. Hook installation belongs to the pre-React bundled entry. */
export function createReactComponentProvider(hook?: unknown): ReactProviderResult {
  let runtimeVersion: string | null = null;
  const fail = (reason: ReactProviderFailure): ReactProviderResult => ({
    status: 'unavailable',
    runtimeVersion,
    reason,
  });
  try {
    if (hook === undefined) hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
    if (!object(hook)) return fail('provider_missing');
    const renderers = own(hook, 'renderers'),
      getRoots = own(hook, 'getFiberRoots');
    if (!(renderers instanceof Map) || typeof getRoots !== 'function')
      return fail('provider_missing');
    if (renderers.size > 4) return fail('renderer_limit');
    const roots: object[] = [];
    let composite: ReadonlySet<number> | undefined,
      host: ReadonlySet<number> | undefined,
      unsupported: ReadonlySet<number> | undefined,
      offscreen: number | undefined,
      activity: number | undefined,
      known: ReadonlySet<number> | undefined,
      signature: string | undefined;
    let rendererCount = 0;
    for (const [id, renderer] of renderers as Map<unknown, unknown>) {
      if (++rendererCount > 4) return fail('renderer_limit');
      if (typeof id !== 'number' || !Number.isSafeInteger(id) || !object(renderer))
        return fail('provider_error');
      const version = own(renderer, 'version'),
        bundleType = own(renderer, 'bundleType'),
        rendererPackageName = own(renderer, 'rendererPackageName'),
        reconciler = own(renderer, 'reconcilerVersion');
      if (
        typeof version !== 'string' ||
        version.length > 64 ||
        !/^(?:18|19)\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version) ||
        (bundleType !== 0 && bundleType !== 1) ||
        rendererPackageName !== 'react-dom'
      )
        return fail('unsupported_runtime');
      if (runtimeVersion !== null && runtimeVersion !== version)
        return fail('unsupported_runtime');
      runtimeVersion = version;
      if (
        reconciler !== undefined &&
        (typeof reconciler !== 'string' ||
          reconciler.length > 64 ||
          !/^(?:18|19)\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(reconciler))
      )
        return fail('unsupported_runtime');
      const tags = getReactWorkTagsForRenderer({
        version,
        bundleType,
        rendererPackageName,
        ...(typeof reconciler === 'string' ? { reconcilerVersion: reconciler } : {}),
      });
      const valid = (numbers: number[]) =>
        numbers.filter((n) => Number.isSafeInteger(n) && n >= 0 && n <= 127);
      const componentTags = valid([
        tags.FunctionComponent,
        tags.ClassComponent,
        tags.ForwardRef,
        tags.MemoComponent,
        tags.SimpleMemoComponent,
      ]);
      const hostTags = valid([
        tags.HostComponent,
        tags.HostHoistable,
        tags.HostSingleton,
      ]);
      const unsupportedTags = valid([tags.LegacyHiddenComponent]);
      if (componentTags.length < 2 || hostTags.length === 0)
        return fail('unsupported_runtime');
      const knownTags = valid(Object.values(tags));
      const nextSignature = JSON.stringify([
        componentTags,
        hostTags,
        unsupportedTags,
        tags.OffscreenComponent,
        tags.ActivityComponent,
        knownTags,
      ]);
      if (signature !== undefined && signature !== nextSignature)
        return fail('unsupported_runtime');
      signature = nextSignature;
      composite = new Set(componentTags);
      host = new Set(hostTags);
      unsupported = new Set(unsupportedTags);
      known = new Set(knownTags);
      offscreen = tags.OffscreenComponent;
      activity = tags.ActivityComponent;
      const active: unknown = Reflect.apply(getRoots, hook, [id]);
      if (!(active instanceof Set)) return fail('provider_error');
      if (active.size > 16 || active.size + roots.length > 16) return fail('root_limit');
      for (const root of active as Set<unknown>) {
        if (roots.length >= 16) return fail('root_limit');
        if (!object(root)) return fail('provider_error');
        const current = own(root, 'current');
        if (!object(current) || typeof current === 'function')
          return fail('provider_error');
        roots.push(current);
      }
    }
    if (runtimeVersion === null || !composite || !host || !unsupported || !known)
      return fail('provider_missing');
    const componentTags = composite,
      hostTags = host,
      unsupportedTags = unsupported,
      knownTags = known,
      offscreenTag = offscreen,
      activityTag = activity,
      names = new WeakMap<object, string | undefined>();
    return {
      status: 'available',
      provider: {
        runtimeVersion,
        supported: true,
        roots,
        read(fiber): ReactFiberView {
          const tag = own(fiber, 'tag');
          if (
            typeof tag !== 'number' ||
            !Number.isSafeInteger(tag) ||
            tag < 0 ||
            tag > 127
          )
            throw new Error('Unsupported React fiber');
          if (!knownTags.has(tag) || unsupportedTags.has(tag))
            return { kind: 'unsupported', child: null, sibling: null };
          // React18/19 OffscreenState documents null=visible, object=hidden.
          // Read only this own internal marker, never its fields or component state.
          // https://github.com/facebook/react/blob/v19.2.6/packages/react-reconciler/src/ReactFiberOffscreenComponent.js
          const visibility = tag === offscreenTag ? own(fiber, 'memoizedState') : null;
          if (
            tag === offscreenTag &&
            visibility !== null &&
            typeof visibility !== 'object'
          )
            return { kind: 'unsupported', child: null, sibling: null };
          const hidden = tag === offscreenTag && visibility !== null;
          const child = hidden ? null : own(fiber, 'child'),
            sibling = own(fiber, 'sibling');
          if (
            !(child === null || (typeof child === 'object' && child !== null)) ||
            !(sibling === null || (typeof sibling === 'object' && sibling !== null))
          )
            throw new Error('Unsupported React fiber');
          if (hidden) return { kind: 'hidden', child: null, sibling };
          // Hydrated React19 Activity wraps exactly one Offscreen child. A non-null
          // marker is hydration metadata; decline rather than infer its visibility.
          if (
            tag === activityTag &&
            (own(fiber, 'memoizedState') !== null ||
              child === null ||
              own(child, 'tag') !== offscreenTag)
          )
            return { kind: 'unsupported', child: null, sibling: null };
          if (componentTags.has(tag)) {
            const type = own(fiber, 'type');
            let name: string | undefined;
            if (object(type)) {
              if (!names.has(type)) names.set(type, componentName(type));
              name = names.get(type);
            }
            return { kind: 'component', child, sibling, ...(name ? { name } : {}) };
          }
          if (hostTags.has(tag)) {
            const element = own(fiber, 'stateNode');
            if (!object(element)) throw new Error('Unsupported React host');
            // Identity is matched against actual caller Elements; no DOM or selector methods are used.
            return { kind: 'host', child, sibling, element: element as Element };
          }
          return { kind: 'transparent', child, sibling };
        },
      },
    };
  } catch {
    return fail('provider_error');
  }
}
