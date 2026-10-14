// Structure snapshot: the visible DOM and its computed styles, captured in the
// same frame as the screenshot.
//
// Why: pixels say WHERE something changed; this says WHAT — which element,
// which property, old → new — so an agent can decide without reading an image
// (spec: docs/specs/2026-10-12-sp0-structural-diff-agent-surface-design.md).
// It explains a failure; it never decides one. The pixel hash still does.
//
// Everything here is a pure function of the CDP response so it can be tested
// against real Chromium output committed as a fixture.

import type { Protocol } from 'devtools-protocol';
import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { Page } from '../browser/page.js';
import { isRecord } from '../browser/guards.js';
import { queryAllExpression } from '../browser/selectors.js';
import type {
  ExternalRef,
  StructureElement,
  StructureRect,
  StructureSnapshot,
  Viewport,
} from '../types.js';

/** Styles recorded per element. `display`/`visibility` are deliberately absent:
 *  display:none elements have no layout entry at all, and visibility is read
 *  only to filter (see `visibilityIdx` in normalizeStructure). */
export const STRUCTURE_PROPS: readonly string[] = [
  'color',
  'background-color',
  'background-image',
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'line-height',
  'letter-spacing',
  'text-align',
  'text-decoration-line',
  'text-transform',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  'margin-top',
  'margin-right',
  'margin-bottom',
  'margin-left',
  'border-top-width',
  'border-right-width',
  'border-bottom-width',
  'border-left-width',
  'border-top-color',
  'border-right-color',
  'border-bottom-color',
  'border-left-color',
  'border-top-left-radius',
  'border-top-right-radius',
  'border-bottom-right-radius',
  'border-bottom-left-radius',
  'opacity',
  'transform',
  'box-shadow',
  'gap',
  'z-index',
  // SVG paint is computed style, not an attribute: without these an icon
  // recolour is unexplained pixels.
  'fill',
  'stroke',
  'stroke-width',
  // A pseudo-element's visible text lives here, not in a text node: without it
  // a CSS icon swap (`content: "★"` → `"☆"`) is unexplained pixels.
  'content',
];

/** Inherited properties are stored only where they differ from the parent. */
export const INHERITED_PROPS: ReadonlySet<string> = new Set([
  'color',
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'line-height',
  'letter-spacing',
  'text-align',
  'text-transform',
  'fill',
  'stroke',
  'stroke-width',
]);

/** Computed-style initial values for non-inherited properties. A value equal
 *  to its initial value is not stored. Border colors are special-cased: they
 *  default to currentColor, so they are stored only when that side's width is
 *  non-zero. */
export const INITIAL_VALUES: Readonly<Record<string, string>> = {
  'background-color': 'rgba(0, 0, 0, 0)',
  'background-image': 'none',
  'text-decoration-line': 'none',
  'padding-top': '0px',
  'padding-right': '0px',
  'padding-bottom': '0px',
  'padding-left': '0px',
  'margin-top': '0px',
  'margin-right': '0px',
  'margin-bottom': '0px',
  'margin-left': '0px',
  'border-top-width': '0px',
  'border-right-width': '0px',
  'border-bottom-width': '0px',
  'border-left-width': '0px',
  'border-top-left-radius': '0px',
  'border-top-right-radius': '0px',
  'border-bottom-right-radius': '0px',
  'border-bottom-left-radius': '0px',
  opacity: '1',
  transform: 'none',
  'box-shadow': 'none',
  gap: 'normal',
  'z-index': 'auto',
  content: 'normal',
};

/** Root defaults for inherited props when no kept ancestor exists. */
const ROOT_INHERITED: Readonly<Record<string, string>> = {
  color: 'rgb(0, 0, 0)',
  'font-style': 'normal',
  'font-weight': '400',
  'letter-spacing': 'normal',
  'text-align': 'start',
  'text-transform': 'none',
  // SVG paint defaults (CSS initial values, as Chromium computes them)
  fill: 'rgb(0, 0, 0)',
  stroke: 'none',
  'stroke-width': '1px',
};

export const MASK_ATTR = 'data-jux-masked';
export const MAX_ELEMENTS = 5000;

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

/**
 * A DOMSnapshot.captureSnapshot response. Verified on Chromium 151:
 * pseudo-elements appear as element nodes named `::before`/`::after` with
 * pseudoType set; an <input>'s typed value is in inputValue, not in an
 * attribute.
 */
export type CdpSnapshot = Protocol.DOMSnapshot.CaptureSnapshotResponse;

const IMPLICIT_ROLES: Record<string, string> = {
  button: 'button',
  h1: 'heading',
  h2: 'heading',
  h3: 'heading',
  h4: 'heading',
  h5: 'heading',
  h6: 'heading',
  img: 'img',
  select: 'combobox',
  textarea: 'textbox',
  nav: 'navigation',
  main: 'main',
  header: 'banner',
  footer: 'contentinfo',
  ul: 'list',
  ol: 'list',
  li: 'listitem',
  table: 'table',
  dialog: 'dialog',
  iframe: 'document',
};

export const round = (n: number) => Math.round(n * 100) / 100;

/**
 * Turn a raw CDP snapshot into a StructureSnapshot.
 *
 * Only the top document is read: iframe content is a separate document and is
 * represented by the <iframe> element's own rect. Open shadow content is part
 * of the host document's node list and is included.
 */
export function normalizeStructure(
  raw: CdpSnapshot,
  viewport: Viewport,
): StructureSnapshot {
  const doc = raw.documents[0];
  // captureStructure's catch turns this into "no structure", as it did the
  // TypeError this used to be.
  if (!doc) throw new Error('DOMSnapshot.captureSnapshot returned no documents');
  const str = (i: number | undefined) =>
    i === undefined || i < 0 ? undefined : raw.strings[i];
  // DOMSnapshot's arrays are parallel by protocol: nodes.* has one entry per
  // node, layout.* one per layout row, and each styles row one value per
  // requested property. The indexed reads marked `!` below rely on that.
  const { layout } = doc;
  // Optional in the protocol, always sent by Chromium. A missing one is a
  // broken snapshot: say which, rather than fail on a later read (or, for
  // nodeValue on a page without text, not at all).
  const need = <T>(v: T | undefined, name: string): T => {
    if (v === undefined)
      throw new Error(`DOMSnapshot.captureSnapshot returned no nodes.${name}`);
    return v;
  };
  const nodes = {
    parentIndex: need(doc.nodes.parentIndex, 'parentIndex'),
    nodeType: need(doc.nodes.nodeType, 'nodeType'),
    nodeName: need(doc.nodes.nodeName, 'nodeName'),
    nodeValue: need(doc.nodes.nodeValue, 'nodeValue'),
    attributes: need(doc.nodes.attributes, 'attributes'),
    inputValue: doc.nodes.inputValue,
  };
  // `visibility` is requested after STRUCTURE_PROPS and used only to filter.
  const visibilityIdx = STRUCTURE_PROPS.length;

  // node index -> layout row. A node can have several rows (a pseudo-element
  // gets one for its box and one per text fragment); the FIRST is the box.
  const layoutOf = new Map<number, number>();
  layout.nodeIndex.forEach((n, row) => {
    if (!layoutOf.has(n)) layoutOf.set(n, row);
  });
  const contentIdx = STRUCTURE_PROPS.indexOf('content');

  const rare = (r: { index: number[]; value: number[] } | undefined) => {
    const m = new Map<number, string>();
    r?.index.forEach((n, k) => m.set(n, str(r.value[k]) ?? ''));
    return m;
  };
  const inputValue = rare(nodes.inputValue);
  // Which third-party resource each element paints or embeds, read from this
  // same response: the browser's resolved <img> source and the computed
  // background. Nothing here touches the page, so it cannot move a pixel.
  const currentSource = rare(doc.nodes.currentSourceURL);
  const documentUrl = str(doc.baseURL) ?? str(doc.documentURL) ?? '';
  const pageOrigin = httpOrigin(documentUrl);
  const backgroundIdx = STRUCTURE_PROPS.indexOf('background-image');

  // children lists, own text and each element's nth-of-type, in document order.
  // nth-of-type is counted here, once, rather than by filtering the sibling
  // list per child: that was quadratic in sibling count, and Primer's TreeView
  // contain-intrinsic-size story has ~100 lists of 1000 siblings, so it cost
  // ~100M name reads and most of a 470-1070 ms normalize.
  const children = new Map<number, number[]>();
  const ownText = new Map<number, string>();
  const nthOfType = new Map<number, number>();
  // per parent: lowercased tag -> elements of that tag seen so far
  const tagCounts = new Map<number, Map<string, number>>();
  for (let i = 0; i < nodes.nodeType.length; i++) {
    const p = nodes.parentIndex[i]!;
    if (p < 0) continue;
    if (nodes.nodeType[i] === TEXT_NODE) {
      const t = str(nodes.nodeValue[i]) ?? '';
      ownText.set(p, (ownText.get(p) ?? '') + t);
    } else if (nodes.nodeType[i] === ELEMENT_NODE) {
      const list = children.get(p) ?? [];
      list.push(i);
      children.set(p, list);
      const counts = tagCounts.get(p) ?? new Map<string, number>();
      tagCounts.set(p, counts);
      const tag = (str(nodes.nodeName[i]) ?? '').toLowerCase();
      const n = (counts.get(tag) ?? 0) + 1;
      counts.set(tag, n);
      nthOfType.set(i, n);
    }
  }

  const attrs = (i: number): Record<string, string> => {
    const out: Record<string, string> = {};
    const a = nodes.attributes[i] ?? [];
    for (let k = 0; k + 1 < a.length; k += 2) out[str(a[k])!] = str(a[k + 1]) ?? '';
    return out;
  };

  const elements: StructureElement[] = [];
  let total = 0;
  // effective inherited values per kept element, for compact storage
  const effective: Array<Record<string, string>> = [];

  const visit = (i: number, parentPath: string, keptParent: number | null): void => {
    const tag = (str(nodes.nodeName[i]) ?? '').toLowerCase();
    if (tag === 'head' || tag === 'script' || tag === 'style') return;
    const a = attrs(i);
    const step =
      a.id !== undefined
        ? `${tag}#${a.id}`
        : a['data-testid'] !== undefined
          ? `${tag}[data-testid="${a['data-testid']}"]`
          : `${tag}:nth-of-type(${nthOfType.get(i)!})`; // set for every element child
    const path = parentPath ? `${parentPath}>${step}` : step;

    const row = layoutOf.get(i);

    // Mask first, before any check that can descend: a visibility:hidden mask
    // target with a visibility:visible child used to take the hidden branch
    // below and record the child's text, while the screenshot mask covered it.
    if (a[MASK_ATTR] !== undefined) {
      if (row === undefined) return; // no box: nothing to stand in for
      total++;
      if (elements.length < MAX_ELEMENTS) {
        // DOM.Rectangle is [x, y, width, height]; a short one reads NaN, as it
        // always has (round(undefined)).
        const [x = NaN, y = NaN, w = NaN, h = NaN] = layout.bounds[row]!;
        elements.push({
          path,
          parent: keptParent,
          tag: 'masked',
          rect: { x: round(x), y: round(y), w: round(w), h: round(h) },
          paintOrder: layout.paintOrders?.[row] ?? 0,
          styles: {},
        });
        effective.push(
          // effective is pushed in lockstep with elements, so a kept parent's
          // index is always in it.
          keptParent === null ? { ...ROOT_INHERITED } : effective[keptParent]!,
        );
      }
      return; // never descend into a masked subtree
    }

    if (row === undefined) return; // display:none (or no box): drop the subtree
    // Only `visibility` is read for every row; the other 41 values are decoded
    // below, for kept elements only. Decoding all of them for all 130k rows of
    // Primer's TreeView story (284 kept) was ~5.5M string reads and url()
    // scans for values nothing looked at.
    const rowStyles = layout.styles[row]!;
    const visibility = urlsToFileNames(str(rowStyles[visibilityIdx]) ?? '');
    if (visibility === 'hidden' || visibility === 'collapse') {
      // hidden boxes can still contain visible descendants (visibility: visible)
      for (const c of children.get(i) ?? []) visit(c, path, keptParent);
      return;
    }

    const [x = NaN, y = NaN, w = NaN, h = NaN] = layout.bounds[row]!;
    const rect: StructureRect = { x: round(x), y: round(y), w: round(w), h: round(h) };
    const offscreen =
      rect.x + rect.w <= 0 ||
      rect.y + rect.h <= 0 ||
      rect.x >= viewport.width ||
      rect.y >= viewport.height;
    const empty = rect.w <= 0 || rect.h <= 0;

    const keep = !offscreen && !empty && tag !== 'html' && tag !== 'body';
    let me = keptParent;
    if (keep) {
      total++;
      if (elements.length < MAX_ELEMENTS) {
        const rawValues = rowStyles.map((s) => str(s) ?? '');
        const values = rawValues.map(urlsToFileNames);
        const inherited = keptParent === null ? ROOT_INHERITED : effective[keptParent]!;
        const styles: Record<string, string> = {};
        const eff: Record<string, string> = { ...inherited };
        for (const [k, prop] of STRUCTURE_PROPS.entries()) {
          const v = values[k]!;
          if (INHERITED_PROPS.has(prop)) {
            eff[prop] = v;
            if (inherited[prop] !== v) styles[prop] = v;
          } else if (prop.startsWith('border-') && prop.endsWith('-color')) {
            const side = prop.split('-')[1];
            const width = values[STRUCTURE_PROPS.indexOf(`border-${side}-width`)];
            if (width !== '0px') styles[prop] = v;
          } else if (INITIAL_VALUES[prop] !== v) {
            styles[prop] = v;
          }
        }
        // `content` is meaningful only on a pseudo-element, where it IS the
        // text; on a normal element it is always `normal`, so drop it there.
        const isPseudo = tag.startsWith('::');
        if (!isPseudo) delete styles.content;
        const pseudoText = isPseudo ? parseContent(values[contentIdx]) : '';
        // Sidecars are committed to git: never record a secret field's value.
        const secret = tag === 'input' && isSecretInput(a);
        const typed = secret ? undefined : inputValue.get(i);
        const text = collapse(pseudoText || typed || ownText.get(i) || '');
        const role = a.role ?? implicitRole(tag, a);
        const name = (a['aria-label'] ?? a.alt ?? a.title ?? text) || undefined;
        const el: StructureElement = {
          path,
          parent: keptParent,
          tag,
          rect,
          paintOrder: layout.paintOrders?.[row] ?? 0,
          styles,
        };
        if (a.id !== undefined) el.id = a.id;
        if (a['data-testid'] !== undefined) el.testId = a['data-testid'];
        const classes = (a.class ?? '').split(/\s+/).filter(Boolean);
        if (classes.length) el.classes = classes;
        if (role) el.role = role;
        if (name) el.name = name.slice(0, 80);
        if (text) el.text = text.slice(0, 200);
        if (a.src !== undefined) el.src = fileName(a.src);
        const external = pageOrigin
          ? externalRefs({
              pageOrigin,
              baseUrl: documentUrl,
              tag,
              src: tag === 'img' ? (currentSource.get(i) ?? a.src) : a.src,
              background: rawValues[backgroundIdx] ?? '',
            })
          : [];
        if (external.length) el.external = external;
        elements.push(el);
        effective.push(eff);
        me = elements.length - 1;
      }
    }
    for (const c of children.get(i) ?? []) visit(c, path, me);
  };

  // node 0 is #document; start from its element children (<html>)
  for (const c of children.get(0) ?? []) visit(c, '', null);

  const snapshot: StructureSnapshot = {
    schema: 'juxtapose.structure/v1',
    viewport,
    structureHash: hashElements(elements),
    contentHeight: round(doc.contentHeight ?? viewport.height),
    elements,
  };
  if (total > elements.length) snapshot.truncated = { kept: elements.length, total };
  return snapshot;
}

/** Autofill tokens that name a secret: a typed OTP, password or card number
 *  in a `type=text` field is as sensitive as one in `type=password`. */
const SECRET_AUTOCOMPLETE = new Set([
  'one-time-code',
  'current-password',
  'new-password',
]);

function isSecretInput(a: Record<string, string>): boolean {
  if (['password', 'hidden'].includes((a.type ?? '').toLowerCase())) return true;
  return (a.autocomplete ?? '')
    .toLowerCase()
    .split(/\s+/)
    .some((t) => SECRET_AUTOCOMPLETE.has(t) || t.startsWith('cc-'));
}

function implicitRole(tag: string, a: Record<string, string>): string | undefined {
  if (tag === 'a') return a.href !== undefined ? 'link' : undefined;
  if (tag === 'input') {
    const t = (a.type ?? 'text').toLowerCase();
    return t === 'checkbox' || t === 'radio'
      ? t
      : t === 'button' || t === 'submit'
        ? 'button'
        : 'textbox';
  }
  return IMPLICIT_ROLES[tag];
}

/** The filename of a URL: no origin, path, query or hash. The origin changes
 *  every run (`jux run` serves on port 0) and between machines, so recording
 *  it would make the same page hash differently each time. */
function fileName(u: string): string {
  // A data: URI's "filename" is a slice of its payload: opaque, and as long as
  // the payload happens to be between slashes.
  if (/^data:/i.test(u.trim())) return 'data:';
  return u.split(/[?#]/)[0]!.split('/').pop() ?? ''; // split returns >= 1 part
}

/** Computed values serialize url() tokens absolute: probe2 recorded
 *  `url("http://127.0.0.1:41001/bg.png")` vs `...:41002/bg.png` for one page
 *  on two ports, and two different structureHashes. Keep only the filename. */
function urlsToFileNames(v: string): string {
  if (!v.includes('url(')) return v;
  return v.replace(
    /url\((?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^)]*))\)/g,
    (_m, dq?: string, sq?: string, bare?: string) =>
      `url(${JSON.stringify(fileName((dq ?? sq ?? bare ?? '').trim()))})`,
  );
}

/** Most third-party references kept per element. */
const MAX_EXTERNAL_PER_ELEMENT = 5;

const httpOrigin = (u: string): string | undefined => {
  try {
    const parsed = new URL(u);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
      ? parsed.origin
      : undefined;
  } catch {
    return undefined;
  }
};

/**
 * The third-party URLs an element loads: its <img> source, an <iframe>'s
 * `src`, and any `url()` in its computed background. A URL on the page's own
 * origin, a data: or blob: URL, or one that does not parse is not third-party.
 * The query and hash are dropped (sidecars are committed; a signed URL's query
 * is a credential).
 */
function externalRefs(e: {
  pageOrigin: string;
  baseUrl: string;
  tag: string;
  src: string | undefined;
  background: string;
}): ExternalRef[] {
  const out: ExternalRef[] = [];
  const add = (kind: ExternalRef['kind'], raw: string | undefined): void => {
    if (!raw) return;
    let u: URL;
    try {
      u = new URL(raw, e.baseUrl);
    } catch {
      return;
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return;
    if (u.origin === e.pageOrigin) return;
    if (
      out.some((r) => r.kind === kind && r.origin === u.origin && r.path === u.pathname)
    )
      return;
    out.push({ kind, origin: u.origin, path: u.pathname });
  };
  if (e.tag === 'img') add('image', e.src);
  else if (e.tag === 'iframe') add('frame', e.src);
  if (e.background.includes('url(')) {
    for (const m of e.background.matchAll(
      /url\((?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^)]*))\)/g,
    ))
      add('background', (m[1] ?? m[2] ?? m[3] ?? '').trim());
  }
  return out.slice(0, MAX_EXTERNAL_PER_ELEMENT);
}

const collapse = (s: string) => s.replace(/\s+/g, ' ').trim();

/** Computed `content` is a CSS string like `"★"` (quoted), `none`, `normal`,
 *  or something like `counter(x)`. Return the visible literal text when there
 *  is one; otherwise the raw value, so a change is still detected. */
function parseContent(v: string | undefined): string {
  if (!v || v === 'none' || v === 'normal') return '';
  const m = /^"(.*)"$/.exec(v);
  return m ? m[1]! : v; // the group is not optional
}

/** Element `index`, following a reference stored in the snapshot (a parent
 *  pointer). Snapshots are read back from sidecars on disk, so a malformed one
 *  says what is wrong instead of failing on a property of undefined; callers
 *  already treat any throw as "no structural verdict". */
export function elementAt(s: StructureSnapshot, index: number): StructureElement {
  const el = s.elements[index];
  if (!el) throw new Error(`structure snapshot has no element ${index}`);
  return el;
}

/** The full value of `prop` for element `index`, reconstructing what the
 *  compact storage omitted. */
export function effectiveStyle(
  s: StructureSnapshot,
  index: number,
  prop: string,
): string {
  const el = elementAt(s, index);
  const own = el.styles[prop];
  if (own !== undefined) return own;
  if (INHERITED_PROPS.has(prop)) {
    return el.parent === null
      ? (ROOT_INHERITED[prop] ?? '')
      : effectiveStyle(s, el.parent, prop);
  }
  if (prop.startsWith('border-') && prop.endsWith('-color')) {
    return effectiveStyle(s, index, 'color'); // currentColor
  }
  return INITIAL_VALUES[prop] ?? '';
}

/** Canonical JSON: object keys sorted at every level, so hashing is stable. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (isRecord(v)) {
    const o = v;
    return `{${Object.keys(o)
      .sort()
      .filter((k) => o[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

function hashElements(elements: StructureElement[]): string {
  // `external` is evidence for the flake classifier, not structure. Leaving it
  // out keeps every structureHash (and so every committed sidecar's) what it
  // was before the field existed.
  const structural = elements.map((el) =>
    Object.fromEntries(Object.entries(el).filter(([k]) => k !== 'external')),
  );
  return createHash('sha256').update(canonical(structural)).digest('hex');
}

export function encodeStructure(s: StructureSnapshot): Buffer {
  return gzipSync(Buffer.from(JSON.stringify(s)));
}

/**
 * The envelope encodeStructure always writes. Elements are not checked one by
 * one: every reader already treats a bad sidecar as no structure.
 */
function isStructureSnapshot(v: unknown): v is StructureSnapshot {
  return (
    isRecord(v) &&
    v['schema'] === 'juxtapose.structure/v1' &&
    typeof v['structureHash'] === 'string' &&
    typeof v['contentHeight'] === 'number' &&
    isRecord(v['viewport']) &&
    typeof v['viewport']['width'] === 'number' &&
    typeof v['viewport']['height'] === 'number' &&
    Array.isArray(v['elements'])
  );
}

/** gzip's two-byte magic. JSON never starts with 0x1f, so it tells the two
 *  sidecar formats apart without a file extension. */
export function isGzip(b: Buffer): boolean {
  return b.length >= 2 && b[0] === 0x1f && b[1] === 0x8b;
}

/**
 * The committed form of a structure sidecar: plain JSON, one element per line,
 * keys in capture order. Committed sidecars are the only way CI (which has no
 * baseline image) can say which element changed, and an approval's sidecar
 * diff is how a reviewer sees it. gzip would make that diff opaque and
 * one-line JSON would make it one unreadable line; this keeps `git diff`
 * showing exactly the elements that moved. Still `JSON.parse`-able as is.
 */
export function formatStructure(s: StructureSnapshot): Buffer {
  const { elements, ...head } = s;
  const lines = Object.entries(head).map(
    ([k, v]) => `${JSON.stringify(k)}:${JSON.stringify(v)}`,
  );
  const body = elements.map((e) => JSON.stringify(e)).join(',\n');
  return Buffer.from(
    `{\n${lines.join(',\n')},\n"elements":[${elements.length ? '\n' + body + '\n' : ''}]\n}\n`,
  );
}

/** Throws on a sidecar that is not one encodeStructure or formatStructure
 *  wrote; every caller catches. */
export function decodeStructure(b: Buffer): StructureSnapshot {
  const parsed: unknown = JSON.parse((isGzip(b) ? gunzipSync(b) : b).toString('utf8'));
  if (!isStructureSnapshot(parsed))
    throw new Error('not a juxtapose.structure/v1 sidecar');
  return parsed;
}

/**
 * Snapshot the page's structure. Never throws: a missing structure costs the
 * agent some explanation, a thrown error would cost the story its capture.
 *
 * Mask selectors are resolved with the same CSS-over-open-shadow-roots query
 * the screenshot masks with; Playwright-only syntax is rejected in
 * captureStory before anything runs. Matches get MASK_ATTR so the normalizer
 * collapses their subtree. A plain document.querySelectorAll would miss
 * matches inside shadow roots and leak masked content into the sidecar.
 *
 * Fail closed: if marking fails, or any match lost its mark by the time the
 * snapshot returns (the page mutated in between), return undefined. Setting an
 * attribute does not affect paint unless a stylesheet targets it, which
 * nothing ships with.
 */
export async function captureStructure(
  page: Page,
  viewport: Viewport,
  mask: readonly string[],
): Promise<StructureSnapshot | undefined> {
  const mark = (sel: string) =>
    page.evaluate<number>(
      queryAllExpression(
        sel,
        "for (const el of els) el.setAttribute(a0, '1'); return els.length;",
        MASK_ATTR,
      ),
    );
  const verify = (sel: string) =>
    // unknown: checked below rather than assumed; the page's globals are the
    // story's to replace.
    page.evaluate<unknown>(
      queryAllExpression(
        sel,
        'return { total: els.length, marked: els.filter((e) => e.hasAttribute(a0)).length };',
        MASK_ATTR,
      ),
    );
  const unmark = () =>
    page
      .evaluate(
        queryAllExpression(
          `[${MASK_ATTR}]`,
          'for (const el of els) el.removeAttribute(a0);',
          MASK_ATTR,
        ),
      )
      .catch(() => {});

  // How many elements each selector marked. Verification re-resolves the
  // selector, so an element that lost both its mark and its match would drop
  // out of the re-resolved list and `every` would pass on the survivors
  // (probe c: SECRET-C recorded). Comparing counts closes that.
  const markedCounts: number[] = [];
  try {
    for (const sel of mask) {
      const n = await mark(sel);
      markedCounts.push(typeof n === 'number' ? n : 0);
    }
  } catch {
    if (mask.length) await unmark();
    return undefined;
  }

  try {
    // No includeDOMRects. It adds offset/scroll/client rects, which nothing
    // reads (rects come from layout.bounds, always sent), and reading an
    // element's offset rect makes Chrome lay out any content-visibility
    // subtree it sits in. On Primer's TreeView contain-intrinsic-size story
    // (130k layout rows, ~320,000 px tall) the call took 2.6-4.9 s with it and
    // 0.8-1.2 s without; the response shrank from 34 MB to 28 MB. What remains
    // is Chrome computing 42 styles for every row (0.33 s with `visibility`
    // alone). It also stops a closed <details>'s never-painted menu being laid
    // out and recorded as visible (3 of Primer's 1102 stories).
    const raw = await page.send('DOMSnapshot.captureSnapshot', {
      computedStyles: [...STRUCTURE_PROPS, 'visibility'],
      includePaintOrder: true,
    });
    for (const [k, sel] of mask.entries()) {
      const v = await verify(sel);
      // Every current match still marked, and none of the marked ones gone.
      const intact =
        isRecord(v) &&
        v['marked'] === v['total'] &&
        typeof v['marked'] === 'number' &&
        v['marked'] >= markedCounts[k]!; // one count was pushed per mask selector
      if (!intact) return undefined;
    }
    return normalizeStructure(raw, viewport);
  } catch {
    return undefined;
  } finally {
    if (mask.length) await unmark();
  }
}
