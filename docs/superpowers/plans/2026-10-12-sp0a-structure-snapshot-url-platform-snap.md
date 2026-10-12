# SP0 PR (a): Structure Snapshot, URL Platform and `jux snap` — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture a deterministic structure snapshot (visible elements + ~30 computed styles + rects) in the same frame as every screenshot, persist it beside the WebP, add a workbench-free URL platform, and ship `jux snap <url>` — the foundation PR (b)'s structural diff reads.

**Architecture:** One CDP `DOMSnapshot.captureSnapshot` call inside `captureStory`, after `waitForPaint` and before the screenshot, normalized by a pure function into `StructureSnapshot`. Storage is a gzipped JSON sidecar next to each run image and baseline. The URL platform is the null `Platform` in core. `jux snap` drives `captureStory` through a new public `snapPage()` helper so the settle pipeline stays unexported.

**Tech Stack:** TypeScript (ESM, Node 22), Playwright Chromium + raw CDP, `node:zlib`, `node:crypto`, vitest, pnpm workspaces.

**Spec:** `docs/specs/2026-10-12-sp0-structural-diff-agent-surface-design.md` (§1 structure snapshot, §2 URL platform, §6 `jux snap`, Verification §3–4). Read it with this plan.

## Global Constraints

- Pass/fail stays the pixel hash. Nothing in this PR may change a story's status.
- A structure-capture failure must never fail a story: the snapshot still returns, `structure` is absent.
- Structure is captured after `waitForPaint` and immediately before `page.screenshot` — same frame. Do not reorder anything else in `captureStory` (CLAUDE.md: ordering there is load-bearing).
- Element cap: 5,000 elements; record `truncated` when hit.
- Rects rounded to 0.01px.
- Schema string: `'juxtapose.structure/v1'`.
- Sidecar filenames: run `images/<safe>-current.structure.json.gz`; baseline `.juxtapose/baselines/<safe>.structure.json.gz`; snaps `.juxtapose/snaps/<name>.structure.json.gz`.
- The settle pipeline, pool and `captureStory` stay unexported from `@juxtapose/core` (see `packages/core/src/index.ts` header); expose only `snapPage`.
- CLI exit codes: 0 success, 1 failure, 2 usage error (`index.ts:93`).
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Run `pnpm format` before each commit (CI runs `prettier --check` on md/json/ts).

**Spec refinements made here (call out in the PR):**

- `display` and `visibility` are not stored as styles. `visibility` is read only to filter hidden elements; `display:none` elements get no layout entry from CDP at all (verified on Chromium 151), and display changes surface as added/removed/resized geometry.
- Styles are stored compactly: an inherited property only when it differs from the nearest kept ancestor's effective value; a non-inherited property only when it differs from its initial value. `effectiveStyle()` reconstructs the full value, so nothing is lost.
- `src` is the URL basename only; the content hash in spec §1 moves to PR (b) with the diff that uses it.
- Added beyond the spec's list, found by probing real CDP output before execution: `fill`/`stroke`/`stroke-width` (SVG paint is computed style, and inherited); `content`, stored only on pseudo-elements, whose visible text it is; pseudo-elements (`::before`/`::after`) kept as elements; an `<input>`'s typed value as its text. Without these, an icon recolour, a CSS icon swap, or changed form contents would have shown as unexplained pixels.

## Review Focus

1. **Pages with iframes or shadow DOM** — CDP returns one document per frame and shadow content inside the host document. Expect: only the top document is snapshotted, iframes appear as one element with their rect, open shadow content is included, nothing throws. Test: Task 1 fixture includes both.
2. **Very large DOMs** — over 5,000 visible elements. Expect: first 5,000 in document order kept, `truncated: {kept, total}`, no crash, still deterministic. Test: Task 1.
3. **CDP unavailable or throwing** (non-Chromium browser, closed session). Expect: `captureStory` returns the snapshot with `structure` undefined. Test: Task 2.
4. **`mask` selectors that match nothing or are invalid CSS** — Expect: no throw; nothing masked. Test: Task 2.
5. **`jux snap` against an unreachable URL or a non-2xx response** — Expect: exit 1, a one-line message naming the URL and status, no files written. Test: Task 5.

---

### Task 1: `StructureSnapshot` types and the pure normalizer

**Files:**

- Modify: `packages/core/src/types.ts` (append after `Snapshot`, and add `structure?` to `Snapshot`)
- Create: `packages/core/src/capture/structure.ts`
- Create: `scripts/capture-structure-fixture.mjs`
- Create: `packages/core/src/capture/__fixtures__/structure-basic.cdp.json` (generated, committed)
- Test: `packages/core/src/capture/structure.test.ts`

**Interfaces:**

- Produces (types.ts):
  ```ts
  export interface StructureRect {
    x: number;
    y: number;
    w: number;
    h: number;
  }
  export interface StructureElement {
    path: string;
    parent: number | null;
    tag: string;
    id?: string;
    testId?: string;
    classes?: string[];
    role?: string;
    name?: string;
    text?: string;
    src?: string;
    rect: StructureRect;
    paintOrder: number;
    styles: Record<string, string>;
  }
  export interface StructureSnapshot {
    schema: 'juxtapose.structure/v1';
    viewport: Viewport;
    structureHash: string;
    elements: StructureElement[];
    truncated?: { kept: number; total: number };
  }
  // Snapshot gains:  structure?: StructureSnapshot;
  ```
- Produces (structure.ts): `STRUCTURE_PROPS: readonly string[]`, `INHERITED_PROPS: ReadonlySet<string>`, `INITIAL_VALUES: Readonly<Record<string,string>>`, `MASK_ATTR = 'data-jux-masked'`, `MAX_ELEMENTS = 5000`,
  `normalizeStructure(raw: CdpSnapshot, viewport: Viewport): StructureSnapshot`,
  `effectiveStyle(s: StructureSnapshot, index: number, prop: string): string`,
  `encodeStructure(s: StructureSnapshot): Buffer` (gzip), `decodeStructure(b: Buffer): StructureSnapshot`,
  type `CdpSnapshot` (the subset of the CDP response read).

- [ ] **Step 1: Add the types**

Append to `packages/core/src/types.ts` after the `Snapshot` interface, and add the field to `Snapshot`:

```ts
export interface Snapshot {
  storyId: string;
  /** WebP-encoded. PNG is an intermediate, never stored. */
  image: Buffer;
  viewport: Viewport;
  capturedAt: string;
  /** Wall time for this story's capture, ms. */
  durationMs: number;
  /** Visible elements and their styles, from the same frame as `image`.
   *  Absent when structure capture failed or was disabled — it explains a
   *  failure, it never decides one. */
  structure?: StructureSnapshot;
}

export interface StructureRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface StructureElement {
  /** tag + (#id | [data-testid] | :nth-of-type) chain from <html>. */
  path: string;
  /** Index of the nearest kept ancestor in `elements`, null at the root. */
  parent: number | null;
  tag: string;
  id?: string;
  testId?: string;
  classes?: string[];
  role?: string;
  name?: string;
  text?: string;
  src?: string;
  rect: StructureRect;
  paintOrder: number;
  /** Compact: see effectiveStyle() in capture/structure.ts. */
  styles: Record<string, string>;
}

export interface StructureSnapshot {
  schema: 'juxtapose.structure/v1';
  viewport: Viewport;
  /** sha256 of the canonical JSON of `elements`. Equal ⇒ identical structure
   *  and styles, so a pixel difference is render drift. */
  structureHash: string;
  elements: StructureElement[];
  truncated?: { kept: number; total: number };
}
```

- [ ] **Step 2: Write the fixture generator**

`scripts/capture-structure-fixture.mjs` — captures REAL CDP output (CLAUDE.md: fixtures must come from the real library, not be hand-written). Re-run it whenever `STRUCTURE_PROPS` changes.

```js
// Generates packages/core/src/capture/__fixtures__/structure-basic.cdp.json
// from real Chromium. Run: node scripts/capture-structure-fixture.mjs
// Re-run whenever STRUCTURE_PROPS changes; commit the result.
import { createRequire } from 'node:module';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(path.join(root, 'packages/core/package.json'));
const { chromium } = require('playwright');
const { STRUCTURE_PROPS } = await import(
  path.join(root, 'packages/core/dist/capture/structure.js')
);

const HTML = `<!doctype html><html><head><style>
  body { margin: 8px; font: 16px/1.5 sans-serif; color: rgb(17, 24, 39); }
  .btn { padding: 8px 12px; background: rgb(37, 99, 235); color: white; border-radius: 6px; border: 0; }
  .card { padding: 16px; margin-top: 12px; box-shadow: 0 1px 2px rgba(0,0,0,.2); }
  .hidden { visibility: hidden; }
  .star::before { content: "★"; color: rgb(220, 38, 38); }
</style></head><body>
  <main>
    <h1 id="title">Settings</h1>
    <p>Hello <b>there</b> world</p>
    <button class="btn primary" data-testid="save">Save</button>
    <button class="btn" aria-label="Close">×</button>
    <a href="/help">Help</a>
    <img src="/static/logo.png" alt="Logo" width="20" height="20">
    <div class="card"><p>One</p><p>Two</p></div>
    <div style="display:none"><p>gone</p></div>
    <div class="hidden"><p>invisible</p></div>
    <div style="position:absolute; left:-5000px">offscreen</div>
    <div id="masked-area" data-jux-masked="1"><p>secret</p><p>more</p></div>
    <span style="display:inline-block;width:0;height:0"></span>
    <iframe srcdoc="<p>inside</p>" width="80" height="40"></iframe>
    <div id="host"></div>
    <span class="star">Starred</span>
    <svg width="20" height="20"><circle cx="10" cy="10" r="8" fill="#f00"/></svg>
    <input value="typed text" placeholder="Name">
  </main>
  <script>
    document.getElementById('host').attachShadow({ mode: 'open' }).innerHTML =
      '<span class="shadow">in shadow</span>';
  </script>
</body></html>`;

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 400, height: 600 },
  deviceScaleFactor: 1,
});
await page.setContent(HTML, { waitUntil: 'load' });
const cdp = await page.context().newCDPSession(page);
const raw = await cdp.send('DOMSnapshot.captureSnapshot', {
  computedStyles: [...STRUCTURE_PROPS, 'visibility'],
  includeDOMRects: true,
  includePaintOrder: true,
});
await browser.close();

const out = path.join(
  root,
  'packages/core/src/capture/__fixtures__/structure-basic.cdp.json',
);
await writeFile(
  out,
  JSON.stringify({ viewport: { width: 400, height: 600 }, raw }) + '\n',
);
console.log(`wrote ${out}`);
```

- [ ] **Step 3: Write `structure.ts` (constants, normalizer, helpers)**

Create `packages/core/src/capture/structure.ts`:

```ts
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

import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import type {
  StructureElement,
  StructureRect,
  StructureSnapshot,
  Viewport,
} from '../types.js';

/** Styles recorded per element. `display`/`visibility` are deliberately absent:
 *  display:none elements have no layout entry at all, and visibility is read
 *  only to filter (see VISIBILITY below). */
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

/** Requested alongside STRUCTURE_PROPS, used only to drop hidden elements. */
const VISIBILITY = 'visibility';

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

const BORDER_SIDES = ['top', 'right', 'bottom', 'left'] as const;

export const MASK_ATTR = 'data-jux-masked';
export const MAX_ELEMENTS = 5000;

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

/** The subset of a CDP DOMSnapshot.captureSnapshot response we read. */
export interface CdpSnapshot {
  documents: Array<{
    nodes: {
      parentIndex: number[];
      nodeType: number[];
      nodeName: number[];
      nodeValue: number[];
      attributes: number[][];
      /** Rare-string data: parallel arrays of node index → string index.
       *  Verified on Chromium 151: pseudo-elements appear as element nodes
       *  named `::before`/`::after` with pseudoType set; an <input>'s typed
       *  value is in inputValue, not in an attribute. */
      pseudoType?: { index: number[]; value: number[] };
      inputValue?: { index: number[]; value: number[] };
    };
    layout: {
      nodeIndex: number[];
      styles: number[][];
      bounds: number[][];
      paintOrders?: number[];
    };
  }>;
  strings: string[];
}

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

const round = (n: number) => Math.round(n * 100) / 100;

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
  const str = (i: number | undefined) =>
    i === undefined || i < 0 ? undefined : raw.strings[i];
  const { nodes, layout } = doc;
  const styleIdx = STRUCTURE_PROPS.map((_, i) => i);
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

  // children lists and own text, in document order
  const children = new Map<number, number[]>();
  const ownText = new Map<number, string>();
  for (let i = 0; i < nodes.nodeType.length; i++) {
    const p = nodes.parentIndex[i];
    if (p < 0) continue;
    if (nodes.nodeType[i] === TEXT_NODE) {
      const t = str(nodes.nodeValue[i]) ?? '';
      ownText.set(p, (ownText.get(p) ?? '') + t);
    } else if (nodes.nodeType[i] === ELEMENT_NODE) {
      const list = children.get(p) ?? [];
      list.push(i);
      children.set(p, list);
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
    const siblings = children.get(nodes.parentIndex[i]) ?? [];
    const sameTag = siblings.filter(
      (s) => (str(nodes.nodeName[s]) ?? '').toLowerCase() === tag,
    );
    const step =
      a.id !== undefined
        ? `${tag}#${a.id}`
        : a['data-testid'] !== undefined
          ? `${tag}[data-testid="${a['data-testid']}"]`
          : `${tag}:nth-of-type(${sameTag.indexOf(i) + 1})`;
    const path = parentPath ? `${parentPath}>${step}` : step;

    const row = layoutOf.get(i);
    if (row === undefined) return; // display:none (or no box): drop the subtree
    const values = layout.styles[row].map((s) => str(s) ?? '');
    if (values[visibilityIdx] === 'hidden' || values[visibilityIdx] === 'collapse') {
      // hidden boxes can still contain visible descendants (visibility: visible)
      for (const c of children.get(i) ?? []) visit(c, path, keptParent);
      return;
    }

    const [x, y, w, h] = layout.bounds[row];
    const rect: StructureRect = { x: round(x), y: round(y), w: round(w), h: round(h) };
    const offscreen =
      rect.x + rect.w <= 0 ||
      rect.y + rect.h <= 0 ||
      rect.x >= viewport.width ||
      rect.y >= viewport.height;
    const empty = rect.w <= 0 || rect.h <= 0;

    if (a[MASK_ATTR] !== undefined) {
      total++;
      if (elements.length < MAX_ELEMENTS) {
        elements.push({
          path,
          parent: keptParent,
          tag: 'masked',
          rect,
          paintOrder: layout.paintOrders?.[row] ?? 0,
          styles: {},
        });
        effective.push(
          keptParent === null ? { ...ROOT_INHERITED } : effective[keptParent],
        );
      }
      return; // never descend into a masked subtree
    }

    const keep = !offscreen && !empty && tag !== 'html' && tag !== 'body';
    let me = keptParent;
    if (keep) {
      total++;
      if (elements.length < MAX_ELEMENTS) {
        const inherited = keptParent === null ? ROOT_INHERITED : effective[keptParent];
        const styles: Record<string, string> = {};
        const eff: Record<string, string> = { ...inherited };
        for (const k of styleIdx) {
          const prop = STRUCTURE_PROPS[k];
          const v = values[k];
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
        const typed = inputValue.get(i);
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
        if (a.src !== undefined) el.src = a.src.split(/[?#]/)[0].split('/').pop();
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
    elements,
  };
  if (total > elements.length) snapshot.truncated = { kept: elements.length, total };
  return snapshot;
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

const collapse = (s: string) => s.replace(/\s+/g, ' ').trim();

/** Computed `content` is a CSS string like `"★"` (quoted), `none`, `normal`,
 *  or something like `counter(x)`. Return the visible literal text when there
 *  is one; otherwise the raw value, so a change is still detected. */
function parseContent(v: string | undefined): string {
  if (!v || v === 'none' || v === 'normal') return '';
  const m = /^"(.*)"$/.exec(v);
  return m ? m[1] : v;
}

/** The full value of `prop` for element `index`, reconstructing what the
 *  compact storage omitted. */
export function effectiveStyle(
  s: StructureSnapshot,
  index: number,
  prop: string,
): string {
  const el = s.elements[index];
  if (el.styles[prop] !== undefined) return el.styles[prop];
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
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .filter((k) => o[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

function hashElements(elements: StructureElement[]): string {
  return createHash('sha256').update(canonical(elements)).digest('hex');
}

export function encodeStructure(s: StructureSnapshot): Buffer {
  return gzipSync(Buffer.from(JSON.stringify(s)));
}

export function decodeStructure(b: Buffer): StructureSnapshot {
  return JSON.parse(gunzipSync(b).toString('utf8')) as StructureSnapshot;
}
```

Note `ROOT_INHERITED` lacks `font-family`, `font-size`, `line-height`: those have no universal root default, so the root element always stores them (the first kept element differs from `undefined`). That is intended.

- [ ] **Step 4: Build and generate the real fixture**

Run: `pnpm --filter @juxtapose/core build && node scripts/capture-structure-fixture.mjs && pnpm format`
Expected: `wrote …/structure-basic.cdp.json`; file is committed alongside the test.

- [ ] **Step 5: Write the failing tests**

Create `packages/core/src/capture/structure.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import {
  decodeStructure,
  effectiveStyle,
  encodeStructure,
  MAX_ELEMENTS,
  normalizeStructure,
  type CdpSnapshot,
} from './structure.js';

// Real Chromium output — regenerate with scripts/capture-structure-fixture.mjs.
const fixture = JSON.parse(
  readFileSync(
    path.join(import.meta.dirname, '__fixtures__/structure-basic.cdp.json'),
    'utf8',
  ),
) as { viewport: { width: number; height: number }; raw: CdpSnapshot };
const snap = () => normalizeStructure(fixture.raw, fixture.viewport);
const find = (pred: (e: ReturnType<typeof snap>['elements'][number]) => boolean) =>
  snap().elements.find(pred);

test('keeps visible elements with identity, role and name', () => {
  const save = find((e) => e.testId === 'save');
  expect(save).toMatchObject({
    tag: 'button',
    role: 'button',
    name: 'Save',
    text: 'Save',
  });
  expect(save!.classes).toEqual(['btn', 'primary']);
  expect(save!.path).toBe(
    'html:nth-of-type(1)>body:nth-of-type(1)>main:nth-of-type(1)>button[data-testid="save"]',
  );
  expect(find((e) => e.id === 'title')).toMatchObject({
    tag: 'h1',
    role: 'heading',
    text: 'Settings',
  });
  expect(find((e) => e.tag === 'a')).toMatchObject({ role: 'link', name: 'Help' });
  expect(find((e) => e.tag === 'img')).toMatchObject({
    role: 'img',
    name: 'Logo',
    src: 'logo.png',
  });
  expect(find((e) => e.name === 'Close')).toBeDefined();
});

test('own text excludes child element text', () => {
  const p = find((e) => e.tag === 'p' && (e.text ?? '').startsWith('Hello'));
  expect(p!.text).toBe('Hello world');
  expect(find((e) => e.tag === 'b')!.text).toBe('there');
});

test('drops display:none, visibility:hidden, offscreen, zero-area, html, body', () => {
  const texts = snap().elements.map((e) => e.text);
  expect(texts).not.toContain('gone');
  expect(texts).not.toContain('invisible');
  expect(texts).not.toContain('offscreen');
  expect(snap().elements.some((e) => e.tag === 'html' || e.tag === 'body')).toBe(false);
  expect(snap().elements.some((e) => e.tag === 'span' && e.rect.w === 0)).toBe(false);
});

test('a masked subtree becomes one opaque element', () => {
  const masked = snap().elements.filter((e) => e.tag === 'masked');
  expect(masked).toHaveLength(1);
  expect(snap().elements.map((e) => e.text)).not.toContain('secret');
});

test('iframe is one element; open shadow content is included', () => {
  expect(find((e) => e.tag === 'iframe')).toMatchObject({ role: 'document' });
  expect(snap().elements.map((e) => e.text)).not.toContain('inside');
  expect(find((e) => e.text === 'in shadow')).toBeDefined();
});

test('styles are compact but effectiveStyle reconstructs them', () => {
  const s = snap();
  const i = s.elements.findIndex((e) => e.testId === 'save');
  const save = s.elements[i];
  expect(save.styles['background-color']).toBe('rgb(37, 99, 235)');
  expect(save.styles['padding-top']).toBe('8px');
  expect(save.styles['margin-top']).toBeUndefined(); // initial value, not stored
  expect(effectiveStyle(s, i, 'margin-top')).toBe('0px');
  // inherited: body color is set on body, which is not kept; main stores it
  const main = s.elements.findIndex((e) => e.tag === 'main');
  expect(effectiveStyle(s, main, 'color')).toBe('rgb(17, 24, 39)');
  const p = s.elements.findIndex((e) => e.text === 'One');
  expect(s.elements[p].styles.color).toBeUndefined(); // same as ancestor
  expect(effectiveStyle(s, p, 'color')).toBe('rgb(17, 24, 39)');
});

test('a pseudo-element is an element whose text is its CSS content', () => {
  const before = find((e) => e.tag === '::before');
  expect(before).toMatchObject({ text: '★' });
  expect(before!.styles.color).toBe('rgb(220, 38, 38)');
  expect(before!.styles.content).toBe('"★"');
  // `content` is never stored on a normal element
  expect(
    snap().elements.filter((e) => !e.tag.startsWith('::') && e.styles.content),
  ).toEqual([]);
});

test('SVG paint is captured, inherited-compact like color', () => {
  const s = snap();
  const i = s.elements.findIndex((e) => e.tag === 'circle');
  expect(s.elements[i].styles.fill).toBe('rgb(255, 0, 0)');
  expect(effectiveStyle(s, i, 'stroke')).toBe('none');
});

test("an input's typed value is its text", () => {
  expect(find((e) => e.tag === 'input')).toMatchObject({
    text: 'typed text',
    role: 'textbox',
  });
});

test('rects are rounded to 0.01px', () => {
  for (const e of snap().elements) {
    for (const v of Object.values(e.rect)) expect(Math.round(v * 100)).toBe(v * 100);
  }
});

test('hash is stable and changes with content', () => {
  expect(snap().structureHash).toBe(snap().structureHash);
  const raw = structuredClone(fixture.raw);
  const i = raw.strings.indexOf('Settings');
  raw.strings[i] = 'Preferences';
  expect(normalizeStructure(raw, fixture.viewport).structureHash).not.toBe(
    snap().structureHash,
  );
});

test('gzip round-trips', () => {
  const s = snap();
  expect(decodeStructure(encodeStructure(s))).toEqual(s);
});

test('caps at MAX_ELEMENTS and records the truncation', () => {
  const raw = structuredClone(fixture.raw);
  const doc = raw.documents[0];
  const mainNode = doc.nodes.nodeName.findIndex((n) => raw.strings[n] === 'MAIN');
  const mainRow = doc.layout.nodeIndex.indexOf(mainNode);
  const divName = raw.strings.indexOf('DIV');
  for (let k = 0; k < MAX_ELEMENTS + 10; k++) {
    const idx = doc.nodes.nodeType.length;
    doc.nodes.parentIndex.push(mainNode);
    doc.nodes.nodeType.push(1);
    doc.nodes.nodeName.push(divName);
    doc.nodes.nodeValue.push(-1);
    doc.nodes.attributes.push([]);
    doc.layout.nodeIndex.push(idx);
    doc.layout.styles.push([...doc.layout.styles[mainRow]]);
    doc.layout.bounds.push([10, 10, 5, 5]);
    doc.layout.paintOrders?.push(1);
  }
  const s = normalizeStructure(raw, fixture.viewport);
  expect(s.elements).toHaveLength(MAX_ELEMENTS);
  expect(s.truncated!.kept).toBe(MAX_ELEMENTS);
  expect(s.truncated!.total).toBeGreaterThan(MAX_ELEMENTS);
});
```

- [ ] **Step 6: Run the tests**

Run: `pnpm vitest run packages/core/src/capture/structure.test.ts`
Expected: all pass. If an assertion about a specific real-Chromium value fails (e.g. a rounded rect, a color string), inspect the fixture and correct the **test's expectation** only when the fixture shows the real value is right and the expectation was a guess; correct the **code** when the behavior is wrong. Record which in the commit message.

- [ ] **Step 7: Commit**

```bash
pnpm format
git add packages/core/src/types.ts packages/core/src/capture/structure.ts packages/core/src/capture/structure.test.ts packages/core/src/capture/__fixtures__ scripts/capture-structure-fixture.mjs
git commit -m "feat(core): structure snapshot normalizer from real CDP output

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Capture structure in the same frame as the screenshot

**Files:**

- Modify: `packages/core/src/capture/structure.ts` (add `captureStructure`)
- Modify: `packages/core/src/capture/capture.ts:19-46` (`CaptureDeps`), `:160-196` (call site + return)
- Test: `packages/core/src/capture/structure-capture.test.ts`

**Interfaces:**

- Consumes: `normalizeStructure`, `STRUCTURE_PROPS`, `MASK_ATTR` (Task 1).
- Produces: `captureStructure(page: Page, viewport: Viewport, mask: readonly string[]): Promise<StructureSnapshot | undefined>`; `CaptureDeps.structure?: boolean` (default true); `Snapshot.structure` populated by `captureStory`.

- [ ] **Step 1: Write the failing tests**

Create `packages/core/src/capture/structure-capture.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Page } from 'playwright';
import { expect, test, vi } from 'vitest';
import { captureStructure } from './structure.js';

const fixture = JSON.parse(
  readFileSync(
    path.join(import.meta.dirname, '__fixtures__/structure-basic.cdp.json'),
    'utf8',
  ),
);
const viewport = fixture.viewport;

function fakePage(opts: {
  send?: () => Promise<unknown>;
  evaluate?: () => Promise<unknown>;
}) {
  const detach = vi.fn(async () => {});
  const evaluate = vi.fn(opts.evaluate ?? (async () => 0));
  const page = {
    evaluate,
    context: () => ({
      newCDPSession: async () => ({
        send: opts.send ?? (async () => fixture.raw),
        detach,
      }),
    }),
  } as unknown as Page;
  return { page, detach, evaluate };
}

test('returns a normalized snapshot and detaches the session', async () => {
  const { page, detach } = fakePage({});
  const s = await captureStructure(page, viewport, []);
  expect(s?.schema).toBe('juxtapose.structure/v1');
  expect(detach).toHaveBeenCalled();
});

test('a CDP failure yields undefined, never a throw', async () => {
  const { page } = fakePage({
    send: async () => {
      throw new Error('Target closed');
    },
  });
  await expect(captureStructure(page, viewport, [])).resolves.toBeUndefined();
});

test('mask selectors are marked before and cleared after', async () => {
  const { page, evaluate } = fakePage({});
  await captureStructure(page, viewport, ['.clock']);
  // two evaluates: mark, then clear
  expect(evaluate).toHaveBeenCalledTimes(2);
});

test('an invalid mask selector does not throw', async () => {
  const { page } = fakePage({
    evaluate: async () => {
      throw new DOMException('not a valid selector');
    },
  });
  await expect(captureStructure(page, viewport, ['[[bad'])).resolves.toBeDefined();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run packages/core/src/capture/structure-capture.test.ts`
Expected: FAIL — `captureStructure is not exported`.

- [ ] **Step 3: Implement `captureStructure`**

Append to `packages/core/src/capture/structure.ts` (add `import type { Page } from 'playwright';` to its imports):

```ts
/**
 * Snapshot the page's structure. Never throws: a missing structure costs the
 * agent some explanation, a thrown error would cost the story its capture.
 *
 * Mask selectors are marked with MASK_ATTR so the normalizer collapses their
 * subtree, then unmarked. Setting an attribute does not affect paint unless a
 * stylesheet targets it, which nothing ships with.
 */
export async function captureStructure(
  page: Page,
  viewport: Viewport,
  mask: readonly string[],
): Promise<StructureSnapshot | undefined> {
  const mark = (on: boolean) =>
    page
      .evaluate(
        ({ selectors, attr, on }) => {
          for (const sel of selectors) {
            try {
              for (const el of document.querySelectorAll(sel)) {
                if (on) el.setAttribute(attr, '1');
                else el.removeAttribute(attr);
              }
            } catch {
              // invalid selector: same as matching nothing
            }
          }
        },
        { selectors: [...mask], attr: MASK_ATTR, on },
      )
      .catch(() => {});

  try {
    if (mask.length) await mark(true);
    const cdp = await page.context().newCDPSession(page);
    try {
      const raw = (await cdp.send('DOMSnapshot.captureSnapshot', {
        computedStyles: [...STRUCTURE_PROPS, 'visibility'],
        includeDOMRects: true,
        includePaintOrder: true,
      })) as unknown as CdpSnapshot;
      return normalizeStructure(raw, viewport);
    } finally {
      await cdp.detach().catch(() => {});
    }
  } catch {
    return undefined;
  } finally {
    if (mask.length) await mark(false);
  }
}
```

- [ ] **Step 4: Hook it into `captureStory`**

In `packages/core/src/capture/capture.ts`:

Add to imports: `import { captureStructure } from './structure.js';`

Add to `CaptureDeps` (after `warmSwitch`):

```ts
  /**
   * Capture the structure snapshot beside the pixels. Default true. It costs
   * one CDP call per story (budget: < 30 ms) and explains failures; it never
   * decides one. `JUXTAPOSE_NO_STRUCTURE=1` turns it off for A/B timing.
   */
  structure?: boolean;
```

Replace the block from `await waitForPaint(page);` through the `page.screenshot(...)` call so it reads:

```ts
await waitForPaint(page);

// Structure from the same frame the screenshot is about to take: after the
// paint barrier, before the shutter, with nothing in between that could
// mutate the page.
const effective = params.viewport ?? effectiveViewport;
const structure =
  deps.structure !== false && process.env.JUXTAPOSE_NO_STRUCTURE !== '1'
    ? await captureStructure(page, effective, params.mask ?? [])
    : undefined;

// A selector matching nothing is not an error — a story that conditionally
// renders the element shouldn't fail on the branch where it's absent.
const png = await page.screenshot({
  type: 'png',
  ...(params.mask?.length
    ? { mask: params.mask.map((selector) => page.locator(selector)) }
    : {}),
});
```

And in the returned object replace `viewport: params.viewport ?? effectiveViewport,` with `viewport: effective,` and add `...(structure ? { structure } : {}),` after `durationMs`.

- [ ] **Step 5: Run unit tests and the determinism check**

Run: `pnpm vitest run packages/core/src/capture && pnpm build && pnpm --filter example-storybook build-storybook && pnpm check:determinism`
Expected: unit tests PASS; `check:determinism` still reports byte-identical pixels (structure capture must not perturb pixels — if it does, that is a blocker; stop and report).

- [ ] **Step 6: Commit**

```bash
pnpm format
git add packages/core/src/capture
git commit -m "feat(core): capture structure in the same frame as the screenshot

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Persist structure beside run images and baselines

**Files:**

- Modify: `packages/core/src/run/run.ts:50-55` (`RunArtifact`), `:164`, `:171`, `:185-190` (the three `onArtifact` calls)
- Modify: `packages/core/src/types.ts` (`ApprovalMeta.structureHash?`, `BaselineStore` optional methods)
- Modify: `packages/core/src/baseline/git-store.ts` (`putStructure`, `getStructure`)
- Modify: `packages/cli/src/commands/run.ts:221-226` (`writeArtifact`)
- Modify: `packages/cli/src/commands/approve.ts:53-66`
- Modify: `packages/core/src/index.ts` (export `encodeStructure`, `decodeStructure`, structure types)
- Test: `packages/core/src/baseline/git-store.test.ts` (create)

**Interfaces:**

- Consumes: `encodeStructure`, `decodeStructure`, `StructureSnapshot` (Task 1); `Snapshot.structure` (Task 2).
- Produces: `RunArtifact.structure?: StructureSnapshot`; `ApprovalMeta.structureHash?: string` (so `BaselineEntry.structureHash` exists via the spread in `put`); `BaselineStore.putStructure?(storyId: string, gz: Buffer): Promise<void>`; `BaselineStore.getStructure?(storyId: string): Promise<Buffer | null>`; run file `images/<safe>-current.structure.json.gz`; baseline file `<baselineDir>/<safe>.structure.json.gz`.

- [ ] **Step 1: Write the failing store test**

Create `packages/core/src/baseline/git-store.test.ts`:

```ts
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { GitBaselineStore } from './git-store.js';

const meta = { commit: 'abc', approvedBy: 't', approvedAt: '2026-10-12T00:00:00Z' };

test('structure sidecar is written beside the image and read back', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'jux-store-'));
  const store = new GitBaselineStore({ projectRoot: root });
  await store.put('Components/Button--primary', Buffer.from('img'), {
    ...meta,
    structureHash: 'h1',
  });
  await store.putStructure('Components/Button--primary', Buffer.from('gz'));
  expect(await store.getStructure('Components/Button--primary')).toEqual(
    Buffer.from('gz'),
  );
  const manifest = JSON.parse(
    await readFile(path.join(root, 'juxtapose.manifest.json'), 'utf8'),
  );
  expect(manifest.baselines['Components/Button--primary'].structureHash).toBe('h1');
});

test('a missing sidecar reads as null', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'jux-store-'));
  const store = new GitBaselineStore({ projectRoot: root });
  expect(await store.getStructure('nope')).toBeNull();
});

test('remove deletes the sidecar too', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'jux-store-'));
  const store = new GitBaselineStore({ projectRoot: root });
  await store.put('a', Buffer.from('img'), meta);
  await store.putStructure('a', Buffer.from('gz'));
  await store.remove('a');
  expect(await store.getStructure('a')).toBeNull();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run packages/core/src/baseline/git-store.test.ts`
Expected: FAIL — `putStructure is not a function`.

- [ ] **Step 3: Implement types and store methods**

In `packages/core/src/types.ts`, add to `ApprovalMeta`:

```ts
  /** structureHash of the approved capture's sidecar. Absent when the capture
   *  had no structure, or was approved before sidecars existed. */
  structureHash?: string;
```

and to `BaselineStore`:

```ts
  /** Optional: stores that can hold the gzipped structure sidecar. */
  putStructure?(storyId: string, gz: Buffer): Promise<void>;
  getStructure?(storyId: string): Promise<Buffer | null>;
```

In `packages/core/src/baseline/git-store.ts`, add to the class:

```ts
  private structurePath(storyId: string): string {
    return path.join(this.imageDir, `${encodeStoryId(storyId)}.structure.json.gz`);
  }

  async putStructure(storyId: string, gz: Buffer): Promise<void> {
    await mkdir(this.imageDir, { recursive: true });
    await writeFile(this.structurePath(storyId), gz);
  }

  async getStructure(storyId: string): Promise<Buffer | null> {
    try {
      return await readFile(this.structurePath(storyId));
    } catch {
      return null;
    }
  }
```

and in `remove`, after the image `rm`: `await rm(this.structurePath(storyId), { force: true });`

- [ ] **Step 4: Carry structure through the run and write it**

In `packages/core/src/run/run.ts`, add to `RunArtifact`: `structure?: StructureSnapshot;` (import the type), and at each of the three `opts.onArtifact?.({ ... current: snapshot.image ... })` calls add `structure: snapshot.structure,`.

In `packages/cli/src/commands/run.ts`, replace `writeArtifact` with:

```ts
async function writeArtifact(runDir: string, a: RunArtifact): Promise<void> {
  const safe = encodeStoryId(a.storyId);
  const images = path.join(runDir, 'images');
  await writeFile(path.join(images, `${safe}-current.webp`), a.current);
  if (a.diff) await writeFile(path.join(images, `${safe}-diff.webp`), a.diff);
  if (a.structure) {
    await writeFile(
      path.join(images, `${safe}-current.structure.json.gz`),
      encodeStructure(a.structure),
    );
  }
}
```

(import `encodeStructure` from `@juxtapose/core`.)

In `packages/cli/src/commands/approve.ts`, replace the `try { … }` body inside the candidates loop with:

```ts
    try {
      const image = await readFile(imagePath);
      const structurePath = imagePath.replace(/-current\.webp$/, '-current.structure.json.gz');
      const gz = await readFile(structurePath).catch(() => null);
      const structureHash = gz ? decodeStructure(gz).structureHash : undefined;
      await ctx.store.put(result.storyId, image, {
        commit,
        approvedBy,
        approvedAt,
        env,
        ...(structureHash ? { structureHash } : {}),
      });
      if (gz) await ctx.store.putStructure?.(result.storyId, gz);
      approved.push(result.storyId);
    } catch {
```

(import `decodeStructure` from `@juxtapose/core`.)

In `packages/core/src/index.ts` add, in the types export block, `StructureSnapshot, StructureElement, StructureRect,` and below the baseline-store exports:

```ts
// Structure sidecars: read and write the gzipped snapshot beside an image.
export { encodeStructure, decodeStructure } from './capture/structure.js';
```

- [ ] **Step 5: Run tests, then an end-to-end check on the example**

Run: `pnpm vitest run packages/core && pnpm build && (cd examples/storybook && node ../../packages/cli/dist/index.js run --all --json > /dev/null; ls .juxtapose/runs/*/images | grep -c structure.json.gz)`
Expected: tests PASS; the count equals the number of captured stories in the example.

- [ ] **Step 6: Commit**

```bash
pnpm format
git add packages/core packages/cli
git commit -m "feat: persist structure sidecars for runs and baselines

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: The URL platform (closes #11)

**Files:**

- Create: `packages/core/src/platforms/urls.ts`
- Modify: `packages/core/src/types.ts` (`ProjectConfig.platform`, `ProjectConfig.urls`, `UrlEntry`)
- Modify: `packages/core/src/index.ts` (export `createUrlPlatform`, `UrlEntry`)
- Modify: `packages/cli/src/context.ts` (`resolvePlatform`)
- Modify: `packages/cli/src/commands/run.ts:76-77` (no static server for `urls`)
- Modify: `packages/cli/src/index.ts` (USAGE: `--platform storybook | ladle | urls`)
- Test: `packages/core/src/platforms/urls.test.ts`

**Interfaces:**

- Produces: `interface UrlEntry { id: string; url: string; params?: StoryParams }`; `ProjectConfig.platform?: 'storybook' | 'ladle' | 'urls'`; `ProjectConfig.urls?: UrlEntry[]`; `createUrlPlatform(urls: UrlEntry[]): Platform` with `name === 'urls'`.

- [ ] **Step 1: Write the failing tests**

Create `packages/core/src/platforms/urls.test.ts`:

```ts
import type { Page } from 'playwright';
import { expect, test, vi } from 'vitest';
import { createUrlPlatform } from './urls.js';

const p = createUrlPlatform([
  { id: 'home', url: 'http://localhost:3000/' },
  { id: 'settings', url: '/settings', params: { delay: 50 } },
]);
const target = { projectRoot: '/x' };

test('enumerates entries as stories with no componentPath', async () => {
  const stories = await p.enumerate(target);
  expect(stories.map((s) => s.storyId)).toEqual(['home', 'settings']);
  expect(stories[0]).toMatchObject({ title: 'home', name: 'home', componentPath: '' });
  expect(stories[1].params).toEqual({ delay: 50 });
});

test('is never autodetected', async () => {
  expect(await p.detect(target)).toBe(false);
});

test('absolute URLs ignore baseUrl; relative URLs resolve against it', async () => {
  const goto = vi.fn(async () => null);
  const page = { goto } as unknown as Page;
  await p.showStory(page, 'home', 'about:blank');
  await p.showStory(page, 'settings', 'http://localhost:5173');
  expect(goto.mock.calls.map((c) => c[0])).toEqual([
    'http://localhost:3000/',
    'http://localhost:5173/settings',
  ]);
});

test('a relative URL with no origin is a clear error', async () => {
  const page = { goto: vi.fn() } as unknown as Page;
  await expect(p.showStory(page, 'settings', 'about:blank')).rejects.toThrow(
    /relative url '\/settings' needs --origin/,
  );
});

test('an unknown id is a clear error', async () => {
  const page = { goto: vi.fn() } as unknown as Page;
  await expect(p.showStory(page, 'nope', 'about:blank')).rejects.toThrow(
    /no url with id 'nope'/,
  );
});

test('settle resolves immediately; core does the generic settling', async () => {
  await expect(p.settle({} as Page, {} as never)).resolves.toBeUndefined();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run packages/core/src/platforms/urls.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Add to `packages/core/src/types.ts`:

```ts
/** One page for the `urls` platform. */
export interface UrlEntry {
  /** Stable id; used as the story id and for file names. */
  id: string;
  /** Absolute, or relative to --origin. */
  url: string;
  params?: StoryParams;
}
```

and in `ProjectConfig` change `platform?: 'storybook' | 'ladle';` to `platform?: 'storybook' | 'ladle' | 'urls';` and add:

```ts
  /** Pages to capture when `platform` is 'urls'. */
  urls?: UrlEntry[];
```

Create `packages/core/src/platforms/urls.ts`:

```ts
// The null platform: an explicit list of URLs, no workbench (issue #11).
//
// Everything a workbench adapter contributes — enumeration, a render signal,
// componentPath — is absent here, which is exactly what the Platform seam was
// designed to allow: settling falls entirely to core's generic pipeline (DOM
// quiescence, fonts, images, animation freeze, paint barrier), and affected
// analysis sees an empty componentPath and falls back to capturing everything.
//
// Lives in core rather than its own adapter package because it has no
// knowledge of any workbench and `jux snap` must always have it.

import type { Page } from 'playwright';
import type { Platform } from '../platform.js';
import type { StoryManifest, UrlEntry } from '../types.js';

export function createUrlPlatform(urls: UrlEntry[]): Platform {
  const byId = new Map(urls.map((u) => [u.id, u]));

  const resolve = (id: string, baseUrl: string): string => {
    const entry = byId.get(id);
    if (!entry) throw new Error(`jux: no url with id '${id}'`);
    if (/^[a-z][a-z0-9+.-]*:/i.test(entry.url)) return entry.url;
    if (!/^https?:/i.test(baseUrl)) {
      throw new Error(`jux: relative url '${entry.url}' needs --origin`);
    }
    return new URL(entry.url, baseUrl).toString();
  };

  return {
    name: 'urls',
    async detect() {
      return false;
    },
    async enumerate(): Promise<StoryManifest[]> {
      return urls.map((u) => ({
        storyId: u.id,
        title: u.id,
        name: u.id,
        componentPath: '',
        params: u.params ?? {},
      }));
    },
    async showStory(page: Page, storyId: string, baseUrl: string) {
      await page.goto(resolve(storyId, baseUrl), { waitUntil: 'load' });
    },
    previewUrl() {
      return 'about:blank';
    },
    storyUrl(baseUrl: string, storyId: string) {
      return resolve(storyId, baseUrl);
    },
    async settle() {
      // No platform render signal. Core's generic settle runs after this.
    },
    configDirs: [],
    storyFileGlobs: [],
  };
}
```

Export from `packages/core/src/index.ts` (in the "Implementing a platform adapter" block):

```ts
export { createUrlPlatform } from './platforms/urls.js';
```

and add `UrlEntry` to the type export list.

In `packages/cli/src/context.ts`, at the top of `resolvePlatform` add a `config` parameter and the urls branch. Change the call in `resolveContext` to `resolvePlatform(flags.platform ?? config.platform, target, config)` and the function to:

```ts
async function resolvePlatform(
  name: string | undefined,
  target: { projectRoot: string; buildDir?: string; origin?: string },
  config: ProjectConfig,
): Promise<Platform> {
  if (name === 'urls') {
    if (!config.urls?.length) {
      throw new Error("platform 'urls' needs a non-empty `urls` list in juxtapose config");
    }
    return createUrlPlatform(config.urls);
  }
  const platforms: Platform[] = [new StorybookPlatform(), new LadlePlatform()];
  // …unchanged below…
```

(import `createUrlPlatform` from `@juxtapose/core`; update the unknown-platform message to list `storybook, ladle, urls`.)

In `packages/cli/src/commands/run.ts` replace:

```ts
const server = ctx.origin ? null : await serveStatic(ctx.buildDir!);
const baseUrl = ctx.origin ?? server!.url;
```

with:

```ts
// The urls platform addresses pages directly; there is nothing to serve.
const needsServer = !ctx.origin && ctx.platform.name !== 'urls';
const server = needsServer ? await serveStatic(ctx.buildDir!) : null;
const baseUrl = ctx.origin ?? server?.url ?? 'about:blank';
```

In `packages/cli/src/index.ts` USAGE, change `storybook | ladle` to `storybook | ladle | urls`.

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run packages/core/src/platforms && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
pnpm format
git add packages/core packages/cli
git commit -m "feat: URL-list platform in core (closes #11)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: `snapPage` and `jux snap`

**Files:**

- Create: `packages/core/src/capture/snap.ts`
- Modify: `packages/core/src/index.ts` (export `snapPage`, `SnapOptions`, `SnapResult`)
- Create: `packages/cli/src/commands/snap.ts`
- Create: `packages/cli/src/snap-name.ts`
- Modify: `packages/cli/src/index.ts` (USAGE, options `as`, `viewport`, `wait-for`, `mask`; `case 'snap'`)
- Test: `packages/cli/src/snap-name.test.ts`
- Test (integration, script): `scripts/check-snap.mjs`

**Interfaces:**

- Consumes: `captureStory` (internal), `createUrlPlatform` (Task 4), `deterministicLaunchOptions`, `captureEnv`, `encodeStructure` (Task 1).
- Produces:

  ```ts
  export interface SnapOptions {
    url: string;
    viewport?: Viewport;
    params?: StoryParams;
  }
  export interface SnapResult {
    snapshot: Snapshot;
    env: CaptureEnv;
    status: number | null;
  }
  export function snapPage(opts: SnapOptions): Promise<SnapResult>;
  ```

  `snapName(url: string, as?: string): string`. CLI stdout (`--json`): `{ name, image, structure, viewport, env, structureHash, elements, durationMs }`.

- [ ] **Step 1: Write the failing name test**

Create `packages/cli/src/snap-name.test.ts`:

```ts
import { expect, test } from 'vitest';
import { snapName } from './snap-name.js';

test('slugs the url', () => {
  expect(snapName('http://localhost:5173/settings/profile?tab=1')).toBe(
    'localhost-5173-settings-profile',
  );
});

test('an explicit name wins but is sanitized', () => {
  expect(snapName('http://x/', 'before')).toBe('before');
  expect(snapName('http://x/', '../../etc/passwd')).toBe('etc-passwd');
});

test('never empty, never longer than 60', () => {
  expect(snapName('about:blank', '///')).toBe('snap');
  expect(snapName(`http://x/${'a'.repeat(200)}`).length).toBeLessThanOrEqual(60);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run packages/cli/src/snap-name.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the name helper**

Create `packages/cli/src/snap-name.ts`:

```ts
// File-safe snap names. A name becomes a path under .juxtapose/snaps/, so it
// must not be able to traverse out of it.
export function snapName(url: string, as?: string): string {
  const source = as ?? url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/[?#].*$/, '');
  const slug = source
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return slug || 'snap';
}
```

Run: `pnpm vitest run packages/cli/src/snap-name.test.ts` — Expected: PASS.

- [ ] **Step 4: Implement `snapPage` in core**

Create `packages/core/src/capture/snap.ts`:

```ts
// Capture one URL through the full settle pipeline, outside any run.
//
// The public entry point for `jux snap` and for anything else that needs a
// single deterministic capture. It exists so captureStory and the settle
// pipeline can stay unexported (see index.ts): callers get the result of the
// load-bearing ordering without being able to reorder it.

import { chromium } from 'playwright';
import type { CaptureEnv, Snapshot, StoryParams, Viewport } from '../types.js';
import { createUrlPlatform } from '../platforms/urls.js';
import { captureStory } from './capture.js';
import { captureEnv } from './env.js';
import { deterministicLaunchOptions } from './launch.js';

export interface SnapOptions {
  url: string;
  viewport?: Viewport;
  params?: StoryParams;
}

export interface SnapResult {
  snapshot: Snapshot;
  env: CaptureEnv;
  /** HTTP status of the main document, null for non-HTTP URLs. */
  status: number | null;
}

const DEFAULT_SNAP_VIEWPORT: Viewport = { width: 1280, height: 800 };

export async function snapPage(opts: SnapOptions): Promise<SnapResult> {
  const viewport = opts.viewport ?? DEFAULT_SNAP_VIEWPORT;
  const browser = await chromium.launch(deterministicLaunchOptions());
  try {
    const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
    const page = await context.newPage();
    let status: number | null = null;
    page.on('response', (r) => {
      if (r.request().isNavigationRequest() && r.frame() === page.mainFrame()) {
        status = r.status();
      }
    });
    const platform = createUrlPlatform([
      { id: 'snap', url: opts.url, params: opts.params },
    ]);
    const [story] = await platform.enumerate({ projectRoot: process.cwd() });
    const snapshot = await captureStory(
      page,
      story,
      { platform, baseUrl: opts.url },
      viewport,
    );
    if (!snapshot) throw new Error('jux: page declared skip');
    return { snapshot, env: captureEnv(browser), status };
  } finally {
    await browser.close().catch(() => {});
  }
}
```

Export from `packages/core/src/index.ts` in the "Driving a run" block:

```ts
export { snapPage, type SnapOptions, type SnapResult } from './capture/snap.js';
```

Add `CaptureEnv` to the type exports if not already exported (it is defined in `types.ts`).

- [ ] **Step 5: Implement `jux snap`**

Create `packages/cli/src/commands/snap.ts`:

```ts
// `jux snap <url>` — one deterministic capture, pixels plus structure, no
// workbench. The first half of the agent loop: snap before an edit, snap
// after, then `jux diff` (PR b).

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { encodeStructure, snapPage, type Viewport } from '@juxtapose/core';
import { snapName } from '../snap-name.js';

export interface SnapFlags {
  json?: boolean;
  project?: string;
  as?: string;
  viewport?: string;
  'wait-for'?: string;
  mask?: string[];
}

export async function snapCommand(
  url: string | undefined,
  flags: SnapFlags,
): Promise<number> {
  if (!url) {
    process.stderr.write('jux snap: missing <url>\n');
    return 2;
  }
  let viewport: Viewport | undefined;
  if (flags.viewport) {
    const m = /^(\d+)x(\d+)$/.exec(flags.viewport);
    if (!m) {
      process.stderr.write(`jux snap: --viewport must be WxH, got '${flags.viewport}'\n`);
      return 2;
    }
    viewport = { width: Number(m[1]), height: Number(m[2]) };
  }

  const name = snapName(url, flags.as);
  let result;
  try {
    result = await snapPage({
      url,
      viewport,
      params: {
        ...(flags['wait-for'] ? { waitForSelector: flags['wait-for'] } : {}),
        ...(flags.mask?.length ? { mask: flags.mask } : {}),
      },
    });
  } catch (err) {
    process.stderr.write(
      `jux snap: could not capture ${url}: ${(err as Error).message}\n`,
    );
    return 1;
  }
  if (result.status !== null && (result.status < 200 || result.status >= 300)) {
    process.stderr.write(
      `jux snap: ${url} returned HTTP ${result.status}; nothing written\n`,
    );
    return 1;
  }

  const dir = path.join(
    path.resolve(flags.project ?? process.cwd()),
    '.juxtapose',
    'snaps',
  );
  await mkdir(dir, { recursive: true });
  // Self-ignoring: snaps are scratch, never baselines.
  await writeFile(path.join(dir, '.gitignore'), '*\n');
  const image = path.join(dir, `${name}.webp`);
  await writeFile(image, result.snapshot.image);
  const s = result.snapshot.structure;
  const structure = s ? path.join(dir, `${name}.structure.json.gz`) : null;
  if (s && structure) await writeFile(structure, encodeStructure(s));

  const out = {
    name,
    image,
    structure,
    viewport: result.snapshot.viewport,
    env: result.env,
    structureHash: s?.structureHash ?? null,
    elements: s?.elements.length ?? 0,
    durationMs: result.snapshot.durationMs,
  };
  process.stdout.write(
    flags.json
      ? JSON.stringify(out) + '\n'
      : `jux: snapped ${url} → ${name} (${out.elements} elements, ${out.durationMs} ms)\n`,
  );
  return 0;
}
```

In `packages/cli/src/index.ts`:

- import: `import { snapCommand } from './commands/snap.js';`
- USAGE, after the `handoff` line: `  jux snap <url> [options]       capture one page: pixels + structure, no workbench`
  and a section:
  ```
  snap
    --as <name>                    name for this snap (default: from the url)
    --viewport <WxH>               default 1280x800
    --wait-for <selector>          wait for this selector before capture
    --mask <selector>              cover before capture (repeatable)
  ```
- parseArgs options: `as: { type: 'string' }, viewport: { type: 'string' }, 'wait-for': { type: 'string' }, mask: { type: 'string', multiple: true },`
- switch: `case 'snap': return snapCommand(positionals[0], values as never);`

- [ ] **Step 6: Write the integration check (covers Review Focus 5)**

Create `scripts/check-snap.mjs`:

```js
// End-to-end check for `jux snap`: a good page writes files and a structure;
// a 404 and an unreachable host exit 1 and write nothing.
// Run after `pnpm build`: node scripts/check-snap.mjs
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const cli = path.resolve(import.meta.dirname, '../packages/cli/dist/index.js');
const server = createServer((req, res) => {
  if (req.url === '/ok') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<main><h1>Hello</h1><button>Save</button></main>');
  } else {
    res.writeHead(404);
    res.end('nope');
  }
}).listen(0);
const port = server.address().port;
const project = mkdtempSync(path.join(tmpdir(), 'jux-snap-'));
const run = (args) => {
  try {
    return {
      code: 0,
      out: execFileSync('node', [cli, 'snap', ...args, '--project', project, '--json'], {
        encoding: 'utf8',
      }),
    };
  } catch (e) {
    return { code: e.status, out: e.stdout + e.stderr };
  }
};
let failed = 0;
const check = (ok, msg) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`);
  if (!ok) failed++;
};

const good = run([`http://127.0.0.1:${port}/ok`, '--as', 'good']);
check(good.code === 0, 'good page exits 0');
const j = JSON.parse(good.out);
check(existsSync(j.image) && existsSync(j.structure), 'writes image and structure');
check(
  j.elements >= 3 && /^[0-9a-f]{64}$/.test(j.structureHash),
  'structure has elements and a hash',
);

const missing = run([`http://127.0.0.1:${port}/missing`, '--as', 'missing']);
check(
  missing.code === 1 && /HTTP 404/.test(missing.out),
  '404 exits 1 naming the status',
);
check(
  !readdirSync(path.join(project, '.juxtapose/snaps')).some((f) =>
    f.startsWith('missing'),
  ),
  '404 writes nothing',
);

const down = run(['http://127.0.0.1:1/', '--as', 'down']);
check(down.code === 1 && /could not capture/.test(down.out), 'unreachable host exits 1');

server.close();
process.exit(failed ? 1 : 0);
```

- [ ] **Step 7: Build and run**

Run: `pnpm build && pnpm vitest run packages/cli && node scripts/check-snap.mjs`
Expected: unit tests PASS; every `check-snap` line prints `ok`.

- [ ] **Step 8: Commit**

```bash
pnpm format
git add packages/core packages/cli scripts/check-snap.mjs
git commit -m "feat: jux snap — one capture, pixels plus structure, no workbench

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Determinism and budget verification, in CI

**Files:**

- Create: `scripts/check-structure-determinism.mjs`
- Create: `scripts/structure-budget.mjs`
- Modify: `.github/workflows/ci.yml` (determinism job, after the Ladle step at line ~93)

**Interfaces:**

- Consumes: `jux run --all --json` run directories (Task 3), `JUXTAPOSE_NO_STRUCTURE` (Task 2), `decodeStructure` (Task 1, via `packages/core/dist`).

- [ ] **Step 1: Write the determinism script**

Create `scripts/check-structure-determinism.mjs`:

```js
// Capture an example N times and assert every story's structureHash is
// identical across runs. The structure counterpart of check-determinism.mjs:
// an unstable sidecar would make the structural diff report phantom changes.
// Usage: node scripts/check-structure-determinism.mjs <exampleDir> <runs>
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const [dir, n = '3'] = process.argv.slice(2);
const example = path.resolve(dir);
const cli = path.join(root, 'packages/cli/dist/index.js');
const { decodeStructure } = await import(path.join(root, 'packages/core/dist/index.js'));

const seen = new Map(); // storyFile -> Set(hash)
for (let i = 0; i < Number(n); i++) {
  try {
    execFileSync('node', [cli, 'run', '--all', '--json'], {
      cwd: example,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    // exit 1 is expected when nothing is approved; we only read the files
  }
  const runs = path.join(example, '.juxtapose/runs');
  const latest = readdirSync(runs).sort().at(-1);
  const images = path.join(runs, latest, 'images');
  for (const f of readdirSync(images).filter((f) => f.endsWith('.structure.json.gz'))) {
    const hash = decodeStructure(readFileSync(path.join(images, f))).structureHash;
    if (!seen.has(f)) seen.set(f, new Set());
    seen.get(f).add(hash);
  }
}
const unstable = [...seen].filter(([, s]) => s.size > 1).map(([f]) => f);
if (seen.size === 0) {
  console.error('FAIL — no structure sidecars found');
  process.exit(1);
}
if (unstable.length) {
  console.error(
    `FAIL — ${unstable.length}/${seen.size} stories unstable:\n  ${unstable.join('\n  ')}`,
  );
  process.exit(1);
}
console.log(`OK — ${seen.size} structure snapshots identical across ${n} runs`);
```

- [ ] **Step 2: Write the budget script**

Create `scripts/structure-budget.mjs`:

```js
// Report the cost of structure capture on an example: sidecar size, element
// count, and per-story capture overhead (structure on vs off). Targets from the
// spec — median sidecar < 20 KB gz, overhead < 30 ms — are reported, not
// enforced: a miss goes in the PR, it does not fail CI.
// Usage: node scripts/structure-budget.mjs <exampleDir>
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const example = path.resolve(process.argv[2]);
const cli = path.join(root, 'packages/cli/dist/index.js');
const { decodeStructure } = await import(path.join(root, 'packages/core/dist/index.js'));

const runOnce = (env) => {
  let out = '';
  try {
    out = execFileSync('node', [cli, 'run', '--all', '--json', '--concurrency', '1'], {
      cwd: example,
      env: { ...process.env, ...env },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (e) {
    out = e.stdout;
  }
  const report = JSON.parse(out.trim().split('\n').at(-1));
  return { report, dir: path.join(example, '.juxtapose/runs', report.runId, 'images') };
};
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

const off = runOnce({ JUXTAPOSE_NO_STRUCTURE: '1' });
const on = runOnce({});
const ms = (r) => new Map(r.report.results.map((x) => [x.storyId, x.durationMs]));
const offMs = ms(off),
  onMs = ms(on);
const overhead = [...onMs].map(([id, t]) => t - (offMs.get(id) ?? t));

const files = readdirSync(on.dir).filter((f) => f.endsWith('.structure.json.gz'));
const sizes = files.map((f) => statSync(path.join(on.dir, f)).size);
const counts = files.map(
  (f) => decodeStructure(readFileSync(path.join(on.dir, f))).elements.length,
);

console.log(`stories: ${files.length}`);
console.log(
  `sidecar gz bytes  median ${median(sizes)}  max ${Math.max(...sizes)}  (target median < 20480)`,
);
console.log(`elements          median ${median(counts)}  max ${Math.max(...counts)}`);
console.log(
  `overhead ms       median ${median(overhead)}  max ${Math.max(...overhead)}  (target median < 30)`,
);
```

- [ ] **Step 3: Run both locally on all three examples**

Run:

```bash
pnpm build
for ex in examples/storybook examples/storybook-vue examples/ladle; do
  node scripts/check-structure-determinism.mjs $ex 3
  node scripts/structure-budget.mjs $ex
done
```

Expected: three `OK — … identical across 3 runs`; budget lines printed. If any example is unstable, it is a normalization bug — find which field differs between two sidecars (decode both, diff the JSON), fix it in `normalizeStructure`, regenerate the Task 1 fixture, re-run. Do not loosen the check.

- [ ] **Step 4: Add the determinism check to CI**

In `.github/workflows/ci.yml`, in the `determinism` job after `Determinism (Ladle)`, add:

```yaml
# Structure sidecars must be as stable as the pixels they explain, or the
# structural diff reports phantom changes.
- name: Structure determinism (Storybook, React)
  run: node scripts/check-structure-determinism.mjs examples/storybook 3

- name: Structure determinism (Ladle)
  run: node scripts/check-structure-determinism.mjs examples/ladle 3

- name: jux snap end to end
  run: node scripts/check-snap.mjs
```

- [ ] **Step 5: Full gate and commit**

Run: `pnpm build && pnpm typecheck && pnpm lint && pnpm format:check && pnpm test && pnpm check:determinism`
Expected: all green.

```bash
git add scripts/check-structure-determinism.mjs scripts/structure-budget.mjs .github/workflows/ci.yml
git commit -m "ci: structure determinism and jux snap checks; budget script

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 6: Open the PR**

PR body must include: the budget output for all three examples (verbatim), the determinism output, the three spec refinements listed under Global Constraints, `Closes #11`, and `🤖 Generated with [Claude Code](https://claude.com/claude-code)` as the last line. Add a changeset (`pnpm changeset`): minor for `@juxtapose/core` and `@juxtapose/cli`.
