// The mutation corpus: one page, and one scripted mutation per operator from
// the spec's Verification §2 list, each with the classification and delta it
// must produce. Shared by the fixture generator, the unit tests (through the
// generated fixture) and the end-to-end corpus script, so an expectation is
// written once.

/**
 * @typedef {{ css?: string; saveText?: string; banner?: string; logo?: string;
 *   removeRow?: boolean; canvasFill?: string; rowOrder?: number[]; meta?: boolean }} PageOptions
 */

const ROW_WORDS = ['one', 'two', 'three', 'four', 'five'];

/** @param {PageOptions} o */
export function render(o) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  body { margin: 16px; font: 16px/1.5 sans-serif; color: rgb(17, 24, 39); background: rgb(255, 255, 255); }
  h1 { font-size: 24px; margin: 0 0 12px; }
  .save { display: inline-block; padding: 8px 12px; margin: 0 0 12px;
    background: rgb(37, 99, 235); color: rgb(255, 255, 255);
    border: 2px solid rgb(29, 78, 216); border-radius: 6px; font-weight: 600;
    line-height: 24px; font-size: 16px; letter-spacing: normal; }
  .row { padding: 6px 0; border-top: 1px solid rgb(229, 231, 235); }
  canvas { display: block; margin-top: 12px; }
  ${o.css ?? ''}
</style></head><body>
<main>
  <h1 id="title">Settings</h1>
  <button class="save" data-testid="save">${o.saveText ?? 'Save'}</button>
  ${o.banner ?? ''}
  <img id="logo" src="${o.logo ?? '/logo-a.svg'}" width="32" height="32" alt="Logo">
  ${(o.rowOrder ?? [1, 2, 3, 4, 5])
    // byte-for-byte the markup the fixture was captured from: a removed row
    // leaves its (blank) line behind
    .map((n) =>
      o.removeRow && n === 1
        ? ''
        : // The span follows its text with no whitespace between, so the row's
          // own text node is byte-identical with and without `meta`.
          `<div class="row" id="row-${n}">Row ${ROW_WORDS[n - 1]}${o.meta ? `<span class="meta"> #${n}</span>` : ''}</div>`,
    )
    .join('\n  ')}
  <canvas id="chart" width="200" height="60"></canvas>
</main>
<script>
  const c = document.getElementById('chart').getContext('2d');
  c.fillStyle = '${o.canvasFill ?? 'rgb(16, 185, 129)'}';
  c.fillRect(10, 10, 120, 40);
</script></body></html>`;
}

const SAVE = 'button[name="Save"]';
const style = (prop, tag) => ({
  classification: 'style-only',
  styleTags: [tag],
  delta: { kind: 'style', el: SAVE, prop },
});

/** Order matters only for reporting. `noop` is the baseline every operator
 *  is diffed against unless it names another with `against`. An
 *  expectation's `absent` is a RegExp no delta's `el`/`after` may match. */
export const OPERATORS = [
  { name: 'noop', page: {}, expect: { classification: 'identical', noDeltas: true } },
  {
    name: 'color',
    page: { css: '.save { color: rgb(254, 240, 138); }' },
    expect: style('color', 'color'),
  },
  {
    name: 'background',
    page: { css: '.save { background: rgb(29, 78, 216); }' },
    // The bytes differ but pixelmatch marks 0 pixels: the realistic
    // sub-threshold change, where structure is the only explanation.
    expect: { ...style('background-color', 'color'), flags: ['sub-threshold'] },
  },
  {
    name: 'padding',
    page: { css: '.save { padding: 12px 16px; }' },
    expect: style('padding-top', 'spacing'),
  },
  {
    name: 'margin',
    page: { css: '.save { margin-bottom: 32px; }' },
    expect: { ...style('margin-bottom', 'spacing'), shift: true },
  },
  {
    name: 'font-size',
    page: { css: '.save { font-size: 20px; }' },
    expect: style('font-size', 'typography'),
  },
  {
    name: 'font-weight',
    page: { css: '.save { font-weight: 400; }' },
    expect: style('font-weight', 'typography'),
  },
  {
    name: 'line-height',
    page: { css: '.save { line-height: 40px; }' },
    expect: style('line-height', 'typography'),
  },
  {
    name: 'letter-spacing',
    page: { css: '.save { letter-spacing: 2px; }' },
    expect: style('letter-spacing', 'typography'),
  },
  {
    name: 'border-radius',
    page: { css: '.save { border-radius: 16px; }' },
    expect: style('border-top-left-radius', 'border'),
  },
  {
    name: 'border-color',
    page: { css: '.save { border-color: rgb(220, 38, 38); }' },
    expect: style('border-top-color', 'border'),
  },
  {
    name: 'box-shadow',
    page: { css: '.save { box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4); }' },
    expect: style('box-shadow', 'effects'),
  },
  {
    name: 'opacity',
    page: { css: '.save { opacity: 0.5; }' },
    expect: style('opacity', 'effects'),
  },
  {
    name: 'text',
    page: { saveText: 'Save changes' },
    expect: {
      classification: 'text-only',
      delta: { kind: 'text', from: 'Save', to: 'Save changes' },
      flags: ['text-changed'],
    },
  },
  {
    name: 'removed',
    page: { removeRow: true },
    expect: {
      classification: 'element-removed',
      delta: { kind: 'removed', el: 'div#row-1' },
      flags: ['element-removed'],
      shift: true,
    },
  },
  {
    name: 'inserted',
    page: {
      banner:
        '<div id="banner" style="height:40px;background:rgb(254,243,199)">Unsaved changes</div>',
    },
    expect: {
      classification: 'element-added',
      delta: { kind: 'added', el: 'div#banner' },
      shift: true,
    },
  },
  {
    name: 'img-src',
    page: { logo: '/logo-b.svg' },
    expect: {
      classification: 'attr-only',
      delta: {
        kind: 'attr',
        el: 'img[name="Logo"]',
        attr: 'src',
        from: 'logo-a.svg',
        to: 'logo-b.svg',
      },
    },
  },
  {
    // Row one moved below row four: rows two to four each move up one row
    // (37px), and row one — the only thing the author touched — moves down
    // three. The verdict must lead with row one, then the shift it caused.
    name: 'reorder',
    page: { rowOrder: [2, 3, 4, 1, 5] },
    expect: {
      classification: 'reflow',
      delta: { kind: 'moved', el: 'div#row-1', dx: 0, dy: 111 },
      shift: true,
      lead: 'reflow: div#row-1 moved down 111px; 3 elements after div#row-1 moved up 37px',
    },
  },
  {
    // Every row gains an inline span. Five `span.meta` are added, and since
    // the label collides, each is scoped to its row (`span.meta in div#row-1`).
    name: 'nested',
    page: { meta: true },
    expect: {
      classification: 'element-added',
      delta: { kind: 'added', el: 'span.meta in div#row-1' },
    },
  },
  {
    // The `reorder` operator on rows that each contain a span. The spans
    // move because their rows do; they must not be listed, and the shift
    // must count rows (3), not rows plus spans (6). Diffed against `nested`,
    // not `noop`, so the spans exist on both sides.
    name: 'nested-reorder',
    against: 'nested',
    page: { meta: true, rowOrder: [2, 3, 4, 1, 5] },
    expect: {
      classification: 'reflow',
      delta: { kind: 'moved', el: 'div#row-1', dx: 0, dy: 111 },
      shift: true,
      absent: /^span\.meta/,
      lead: 'reflow: div#row-1 moved down 111px; 3 elements after div#row-1 moved up 37px',
    },
  },
  {
    name: 'canvas',
    page: { canvasFill: 'rgb(239, 68, 68)' },
    expect: { classification: 'unknown', flags: ['unexplained-pixels'], noDeltas: true },
  },
];

export function pageHtml(name) {
  const op = OPERATORS.find((o) => o.name === name);
  if (!op) throw new Error(`unknown corpus operator '${name}'`);
  return render(op.page);
}

const sameFields = (delta, want) =>
  Object.entries(want).every(([k, v]) => delta[k] === v);

/**
 * Every way a verdict can disagree with an operator's expectation, as
 * human-readable strings; empty means pass. The ONE checker: the unit test
 * (Task 3) and the end-to-end script (Task 7) both call it, so they cannot
 * drift apart.
 * @param {typeof OPERATORS[number]} op
 * @param {{ classification: string; styleTags: string[]; summary: string; deltas: Array<Record<string, unknown>>; flags: string[]; explained: string }} v
 * @returns {string[]}
 */
export function checkVerdict(op, v) {
  const e = op.expect;
  const problems = [];
  if (v.classification !== e.classification)
    problems.push(`classification ${v.classification} ≠ ${e.classification}`);
  if (e.styleTags && JSON.stringify(v.styleTags) !== JSON.stringify(e.styleTags)) {
    problems.push(
      `styleTags ${JSON.stringify(v.styleTags)} ≠ ${JSON.stringify(e.styleTags)}`,
    );
  }
  if (e.delta && !v.deltas.some((d) => sameFields(d, e.delta)))
    problems.push(`missing delta ${JSON.stringify(e.delta)}`);
  for (const f of e.flags ?? [])
    if (!v.flags.includes(f)) problems.push(`missing flag ${f}`);
  if (e.noDeltas && v.deltas.length)
    problems.push(`expected no deltas, got ${v.deltas.length}`);
  if (e.shift && !v.deltas.some((d) => d.kind === 'shift'))
    problems.push('expected a shift delta');
  if (e.lead && !v.summary.startsWith(e.lead))
    problems.push(`summary does not lead with '${e.lead}': '${v.summary}'`);
  if (e.absent) {
    const hit = v.deltas.find((d) => e.absent.test(String('el' in d ? d.el : d.after)));
    if (hit) problems.push(`unexpected delta ${JSON.stringify(hit)}`);
  }
  if (op.name !== 'noop' && op.name !== 'canvas' && v.explained !== 'full')
    problems.push(`explained ${v.explained}`);
  return problems;
}

export const LOGO = (fill) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" rx="6" fill="${fill}"/></svg>`;
