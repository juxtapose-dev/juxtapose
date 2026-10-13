// packages/core/src/browser/selectors.ts
//
// Masks, structure.ts's mask marking and waitForSelector resolve selectors
// in the page. Playwright's locator engine also accepted `text=`, `>>`,
// `:has-text()` and friends; those are refused up front so a baseline is
// never captured unmasked because a selector silently matched nothing
// (spec §Decisions 5; a documented breaking change in the changeset).
//
// Open shadow roots are pierced: each root's own matches first, then its
// shadow trees. Mask boxes are all the same opaque colour, so their order
// cannot change a pixel; closed roots are invisible to Playwright too.

const PLAYWRIGHT_ONLY = [
  /^[a-zA-Z-]+=/, // text=, css=, xpath=, id=, nth=, internal:…= (engine prefix)
  /^internal:/,
  />>/,
  /:(has-text|text|text-is|text-matches|visible|nth-match|light|above|below|left-of|right-of|near)\(/,
  /:visible\b/,
];

export function isCssSelector(selector: string): boolean {
  return !PLAYWRIGHT_ONLY.some((re) => re.test(selector));
}

export function assertCssSelector(selector: string): void {
  if (!isCssSelector(selector)) {
    throw new Error(`jux: selector '${selector}' is not a CSS selector`);
  }
}

/** In-page: every match of `selector` in the document and its open shadow roots. */
export const QUERY_ALL_SOURCE = `function (selector) {
  const out = [];
  const walk = (root) => {
    for (const el of root.querySelectorAll(selector)) out.push(el);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let node = walker.currentNode;
    while (node) {
      if (node.shadowRoot) walk(node.shadowRoot);
      node = walker.nextNode();
    }
  };
  walk(document);
  return out;
}`;

/**
 * `(function (els, a0, a1…) { body })((queryAll)(selector), arg0, arg1…)`
 * — one builder for every "do X to all matches" evaluate, so the selector
 * and arguments are JSON-escaped in exactly one place.
 */
export function queryAllExpression(
  selector: string,
  body: string,
  ...args: unknown[]
): string {
  const names = args.map((_, i) => `a${i}`);
  const params = ['els', ...names].join(', ');
  const values = [
    `(${QUERY_ALL_SOURCE})(${JSON.stringify(selector)})`,
    ...args.map((a) => JSON.stringify(a)),
  ].join(', ');
  return `(function (${params}) { ${body} })(${values})`;
}
