/* global MutationObserver */
export interface RetainedDomElement {
  path: string;
  tag: string;
  rect: { x: number; y: number; w: number; h: number };
}
export interface DomMappingGeometry {
  scale: number;
  origin: { x: number; y: number };
  /** Optional scroll offsets from the same CDP snapshot. */
  scroll?: { x: number; y: number };
}
export type DomMappingStatus = {
  status: 'available' | 'unavailable';
  reason?: 'masked' | 'dom-changed' | 'budget-exceeded';
};
export interface RetainedDomMapping extends DomMappingStatus {
  /** Actual browser elements; consume in this task, never JSON-serialize them. */
  elements: Element[];
  /** Compact collector input index -> retained structure element index. */
  indices: number[];
}

/**
 * One synchronous browser task. Literal paths match normalizeStructure rather
 * than CSS: IDs/test IDs may contain selector syntax. Uniqueness and geometry
 * are required, but cannot alone detect a same-shape replacement. Capture must
 * also install/finish the mutation guard around its CDP snapshot and this task.
 */
export function mapRetainedElements(
  document: Document,
  retained: readonly RetainedDomElement[],
  geometry: DomMappingGeometry,
  excludedRoots: readonly Element[] = [],
): RetainedDomMapping {
  const fail = (
    reason: 'masked' | 'dom-changed' | 'budget-exceeded',
  ): RetainedDomMapping => ({ status: 'unavailable', reason, elements: [], indices: [] });
  if (excludedRoots.length) return fail('masked');
  if (retained.length > 5000) return fail('budget-exceeded');
  const view = document.defaultView;
  if (!view || !document.documentElement) return fail('dom-changed');
  const { scale, origin, scroll } = geometry;
  const scrollX = view.scrollX,
    scrollY = view.scrollY;
  if (
    ![scale, origin.x, origin.y, scrollX, scrollY].every(Number.isFinite) ||
    scale <= 0 ||
    scale > 100 ||
    (scroll && (scroll.x !== scrollX || scroll.y !== scrollY))
  )
    return fail('dom-changed');
  const wanted = new Set(
    retained.filter((e) => !e.tag.startsWith('::')).map((e) => `${e.tag}\0${e.path}`),
  );
  const matches = new Map<string, Element | null>();
  const queue: { element: Element; path: string; depth: number }[] = [];
  const enqueue = (children: Element[], parent: string, depth: number): boolean => {
    const counts = new Map<string, number>();
    for (const element of children) {
      if (queue.length >= 20000) return false;
      const tag = element.nodeName.toLowerCase();
      const nth = (counts.get(tag) ?? 0) + 1;
      counts.set(tag, nth);
      if (tag === 'head' || tag === 'script' || tag === 'style') continue;
      const id = element.getAttribute('id'),
        testId = element.getAttribute('data-testid');
      if ((id?.length ?? 0) > 512 || (testId?.length ?? 0) > 512 || depth > 128)
        return false;
      const step =
        id !== null
          ? `${tag}#${id}`
          : testId !== null
            ? `${tag}[data-testid="${testId}"]`
            : `${tag}:nth-of-type(${nth})`;
      const path = parent ? `${parent}>${step}` : step;
      if (path.length > 8192) return false;
      queue.push({ element, path, depth });
    }
    return true;
  };
  if (!enqueue(Array.from(document.children), '', 0)) return fail('budget-exceeded');
  const visited = new Set<Element>();
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const { element, path, depth } = queue[cursor]!;
    if (visited.has(element)) return fail('dom-changed');
    visited.add(element);
    const key = `${element.nodeName.toLowerCase()}\0${path}`;
    if (wanted.has(key)) matches.set(key, matches.has(key) ? null : element);
    // CDP's flat snapshot lists shadow children under the host, before light
    // children. Keep their shared nth-of-type counts, without crossing frames.
    if (
      queue.length +
        element.children.length +
        (element.shadowRoot?.children.length ?? 0) >
      20000
    )
      return fail('budget-exceeded');
    const children = [
      ...(element.shadowRoot ? Array.from(element.shadowRoot.children) : []),
      ...Array.from(element.children),
    ];
    if (!enqueue(children, path, depth + 1)) return fail('budget-exceeded');
  }
  const elements: Element[] = [],
    indices: number[] = [];
  const used = new Set<Element>();
  const round = (n: number) => Math.round(n * 100) / 100;
  for (let index = 0; index < retained.length; index++) {
    const expected = retained[index]!;
    if (expected.tag.startsWith('::')) continue;
    const element = matches.get(`${expected.tag}\0${expected.path}`);
    if (!element || used.has(element) || !element.isConnected) return fail('dom-changed');
    const rect = element.getBoundingClientRect();
    const actual =
      scale === 1
        ? {
            x: round(rect.x),
            y: round(rect.y),
            w: round(rect.width),
            h: round(rect.height),
          }
        : {
            x: round((rect.x + scrollX - origin.x) * scale),
            y: round((rect.y + scrollY - origin.y) * scale),
            w: round(rect.width * scale),
            h: round(rect.height * scale),
          };
    if (
      Object.entries(actual).some(
        ([key, value]) =>
          !Number.isFinite(value) || value !== expected.rect[key as keyof typeof actual],
      )
    )
      return fail('dom-changed');
    used.add(element);
    elements.push(element);
    indices.push(index);
  }
  if (view.scrollX !== scrollX || view.scrollY !== scrollY) return fail('dom-changed');
  return { status: 'available', elements, indices };
}

/** Install AFTER mask marking and BEFORE DOMSnapshot; key is random per capture. */
export function installDomMappingGuard(
  document: Document,
  key: string,
  excludedRoots: readonly Element[] = [],
): DomMappingStatus {
  if (excludedRoots.length) return { status: 'unavailable', reason: 'masked' };
  const view = document.defaultView;
  if (!view || !/^[A-Za-z0-9_-]{16,128}$/.test(key) || Object.hasOwn(view, key))
    return { status: 'unavailable', reason: 'dom-changed' };
  const roots: (Document | ShadowRoot)[] = [document];
  const queue = Array.from(document.children);
  for (let cursor = 0; cursor < queue.length; cursor++) {
    if (queue.length > 20000 || roots.length > 128)
      return { status: 'unavailable', reason: 'budget-exceeded' };
    const element = queue[cursor]!;
    if (
      queue.length +
        element.children.length +
        (element.shadowRoot?.children.length ?? 0) >
        20000 ||
      (element.shadowRoot && roots.length >= 128)
    )
      return { status: 'unavailable', reason: 'budget-exceeded' };
    if (element.shadowRoot) {
      roots.push(element.shadowRoot);
      queue.push(...Array.from(element.shadowRoot.children));
    }
    queue.push(...Array.from(element.children));
  }
  const state: {
    document: Document;
    observer: MutationObserver;
    roots: (Document | ShadowRoot)[];
    changed: boolean;
  } = {
    document,
    roots,
    changed: false,
    observer: new MutationObserver(() => {
      state.changed = true;
    }),
  };
  const { observer } = state;
  try {
    for (const root of roots)
      observer.observe(root, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true,
      });
    Object.defineProperty(view, key, {
      configurable: true,
      value: state,
    });
    return { status: 'available' };
  } catch {
    observer.disconnect();
    return { status: 'unavailable', reason: 'dom-changed' };
  }
}

/**
 * Call in the SAME synchronous task after mapping/collecting, including on
 * failure. Disconnects and deletes state. Newly attached open roots fail closed.
 * A closed root attached after installation is not observable without patching
 * attachShadow; closed-shadow coverage is not promised by this guard.
 */
export function finishDomMappingGuard(document: Document, key: string): DomMappingStatus {
  const view = document.defaultView;
  if (!view || !/^[A-Za-z0-9_-]{16,128}$/.test(key))
    return { status: 'unavailable', reason: 'dom-changed' };
  const value: unknown = Object.getOwnPropertyDescriptor(view, key)?.value;
  if (
    !value ||
    typeof value !== 'object' ||
    !('document' in value) ||
    value.document !== document ||
    !('observer' in value) ||
    !(value.observer instanceof MutationObserver) ||
    !('roots' in value) ||
    !Array.isArray(value.roots) ||
    !('changed' in value) ||
    typeof value.changed !== 'boolean'
  )
    return { status: 'unavailable', reason: 'dom-changed' };
  const { observer } = value;
  try {
    if (observer.takeRecords().length || value.changed)
      return { status: 'unavailable', reason: 'dom-changed' };
    const roots = new Set<Document | ShadowRoot>([document]);
    const queue = Array.from(document.children);
    for (let cursor = 0; cursor < queue.length; cursor++) {
      if (queue.length > 20000 || roots.size > 128)
        return { status: 'unavailable', reason: 'budget-exceeded' };
      const element = queue[cursor]!;
      if (
        queue.length +
          element.children.length +
          (element.shadowRoot?.children.length ?? 0) >
          20000 ||
        (element.shadowRoot && roots.size >= 128)
      )
        return { status: 'unavailable', reason: 'budget-exceeded' };
      if (element.shadowRoot) {
        roots.add(element.shadowRoot);
        queue.push(...Array.from(element.shadowRoot.children));
      }
      queue.push(...Array.from(element.children));
    }
    if (
      roots.size !== value.roots.length ||
      value.roots.some((root: unknown) => !roots.has(root as Document | ShadowRoot))
    )
      return { status: 'unavailable', reason: 'dom-changed' };
    if (observer.takeRecords().length || value.changed)
      return { status: 'unavailable', reason: 'dom-changed' };
    return { status: 'available' };
  } finally {
    observer.disconnect();
    Reflect.deleteProperty(view, key);
  }
}
