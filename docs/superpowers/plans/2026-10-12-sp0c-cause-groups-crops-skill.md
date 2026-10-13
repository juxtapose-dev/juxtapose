# SP0 PR (c): Cause, Groups, Crops and the Claude Code Skill — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish sub-project 0: a failing story says _why_ (`cause`: which changed files its import closure reaches), a run says _how many stories share one change_ (`groups`), `jux diff --crops` becomes the real tier-3 escalation (side-by-side strips per region, no browser), a child's move that only follows its parent is no longer a delta, and a Claude Code plugin teaches an agent the snap → edit → snap → diff loop — then run that loop once for real and record the token cost as one labelled anecdote.

**Architecture:** Four small additions to `@juxtapose/core`, all pure and all on the cold path: `analysis/cause.ts` inverts `affected.ts`'s manifest walk (forward BFS from the story's `componentPath`, intersected with `git diff --name-only`), lazily, so a green run reads neither git nor the manifest; `run/groups.ts` buckets failing results by the verdict's existing `signature`; `diff/crops.ts` turns two images plus regions into PNG strips with sharp; `diff/structural/deltas.ts` learns that a child whose box changed exactly as its parent's box did only followed it. The verdict gains an optional `cause` (fitted to the 1,500-char budget like everything else), `RunReport` gains `groups`, and the CLI only formats what core returns — human output leads with the cause, `--crops` writes files under `.juxtapose/crops/` and lists forward-slash relative paths, `jux handoff` ends with the crops command before the image paths. The plugin is two files under `plugins/claude-code/`. Fixtures stay real Chromium captures from the committed generator; two nested corpus operators are added for the child-follows-parent rule.

**Tech Stack:** TypeScript (ESM, Node 22), vitest, sharp (already a core dependency), Playwright Chromium for fixture generation and the end-to-end scripts only, pnpm workspaces, Claude Code plugin format (verified against the docs on 2026-10-12, see Task 6).

**Spec:** `docs/specs/2026-10-12-sp0-structural-diff-agent-surface-design.md` — §4 (cause), §5 (`groups`), §6 (`--crops`, `jux handoff` footer), §7 (skill), Verification 5 (green path) and 6 (the loop, once). The toolchain spec `docs/specs/2026-10-12-agent-toolchain-design.md` sets the production bar: exit codes 0/1/2/3, versioned byte-stable JSON, errors that name the next command, no telemetry. PR (a) and (b) are merged; this branch (`feat/sp0c-cause-groups-crops-skill`) is off main `68c7ceb`. **The current code, not PR (b)'s plan, is the contract**: names and signatures below are copied from `packages/core/src` and `packages/cli/src` as they are on main.

## Global Constraints

- Pass/fail stays the pixel hash. Nothing here changes a story's `status`; `cause`, `groups` and crops explain, never decide.
- Green path unchanged and shown: a passing run reads no sidecar, no manifest and no git output. `prepareCause` loads its inputs on the first `causeFor` call, which happens only inside the `status === 'fail'` branch of `judge()` in `packages/core/src/run/run.ts`. The `cause` phase is timed through `Phases.time('cause', …)` so `jux run` prints it, and Task 7 records before/after timings on the examples.
- Never fail a story or abort a run: every new read (manifest, git, images, a store's `locate`) is guarded with `try/catch` and degrades to `cause.kind = 'unknown'`, no `cause`, or no crops — never a throw out of `runCapture` or `diffCommand`.
- Fixtures come from real Chromium output written by committed scripts (`scripts/capture-diff-fixtures.mjs` over `scripts/structural-corpus/page.mjs`), never by hand. The generator formats with the repo's prettier, so regenerating is byte-identical. A test may transform a real fixture (clone it, nudge a rect) but never author one. Crops tests build their two images with sharp itself (the library under test), never from committed bytes.
- Determinism: every comparator is code-unit (`compareCodeUnits` from `packages/core/src/diff/structural/deltas.ts`), never `localeCompare` — the one `localeCompare` in `run.ts` is replaced in Task 3. No `Map` iteration order leaks into output (collect, then sort). No absolute paths, OS strings or timestamps in any new JSON field: `cause.files[].path` and `crops[].file` are forward-slash paths relative to the project root; `dir` likewise. Git reports paths relative to the repository top level, which is not the project root in a monorepo (`examples/storybook` inside this repo), so `prepareCause` maps every git path through `git rev-parse --show-toplevel` before it is compared with a manifest `src`. `JSON.stringify` of a verdict with a cause is byte-identical across processes.
- `none-in-closure` ("not your code") is claimed only when the closure was fully traced. A bundled workbench (Storybook puts components into chunks that have no `src` in the Vite manifest) leaves part of the closure unresolvable; a changed file found in the resolved part is still `in-closure`, but no hit plus an unresolved node is `unknown`, never `none-in-closure`. This is pinned by a test over a committed copy of the real `examples/storybook` manifest, captured by a committed script, and documented in the README as a limit.
- One wording for the cause: core's `describeCause(c): string | undefined` is the only place the sentence is written; the CLI review list and the handoff both print it.
- Size budgets hold for any input: the verdict stays ≤ 1,500 chars with a `cause` of any length (files capped at 5, each path clipped to 80 chars keeping the tail), the summary stays ≤ 300, and the tests feed adversarial inputs (200 changed files with 300-char paths, 5,000 results sharing one signature, 500 groups, 50 regions for crops).
- Human output groups by element identity, never by label string (`describeDeltas` already does; nothing here re-groups), and leads with the cause: `jux run`'s review list and `jux handoff` print the cause line before the structural summary.
- Windows-safe paths in any documented field: basename or forward-slash relative. `toPosixRelative` from `affected.ts` for cause paths; `['.juxtapose', 'crops', dir, file].join('/')` for crops.
- Every hint command the CLI prints goes through `shellQuote` (`packages/cli/src/shell-quote.ts`), including the crops command `jux handoff` prints.
- Lazy imports stay: `packages/cli/src/index.ts` keeps `await import('./commands/…')` per command. `jux diff --crops` may load sharp (it already does through `compareSnaps`) but never playwright; `scripts/check-diff.mjs` runs it under the `no-playwright.mjs` probe.
- Exit codes (owner decision, `snap`/`diff` only; `run`/`handoff` migrate in PR H): 0 identical, 1 different, 2 usage, 3 tool/environment failure. `--crops` follows `diff`: 0 when identical (no files written), 1 when different (files written), 3 when an image will not decode.
- Schema strings: `'juxtapose.verdict/v1'` is unchanged (an optional field is additive); the crops payload is `'juxtapose.crops/v1'`. Both documented in README with a real example.
- Clean code: no dead options, each module one responsibility, comments say why and carry the measurement, typed throughout (`Cause`, `CauseKind`, `RunGroup`, `Crop` — no loose dicts).
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Run `pnpm format` before every commit; CI runs `prettier --check`.
- Spec refinements made here (call out in the PR):
  1. `cause.kind = 'unknown'` when the story's `componentPath` is not a node of the Vite manifest (URL platform, a story outside the build), not `none-in-closure`: "not your code" is claimed only after an actual trace.
  2. `cause` is computed whenever `jux run` has `--since`, with or without `--all`; without `--since` there is no changed-file set and no `cause`.
  3. `groups[].summary` is the summary of the group's first story in code-unit order of `storyIds`; labels can differ per page, the signature cannot.
  4. `--crops` with no marked region (sub-threshold change, or a `dimension-change`) writes one strip of the whole overlapping frame rather than nothing: the agent escalated to see pixels, so it gets pixels.
  5. `--crops` output is both the verdict and the crops (`juxtapose.crops/v1` wraps the verdict), so the escalation is one call.
  6. The deferred child-follows-parent rule covers resize as well as move: a child whose `(dw, dh)` equals its matched parent's is suppressed the same way as one whose `(dx, dy)` does.
  7. `jux handoff` gains `cropsCommand`: the baseline image lives in the store, not the run dir, so `BaselineStore` gains an optional `locate(storyId)` and the handoff's `images.baseline` path is fixed to use it (today it points at a `-baseline.webp` that `jux run` never writes).
  8. Verification 6 ("edit one example component") is run against the corpus page served live from a file (`scripts/loop-anecdote/`), not an example Storybook component: the corpus page is the one both arms can reach with a plain URL and no workbench build, and the measured quantity (tokens spent verifying) does not depend on which page was edited. The PR says so.
  9. `cause` is `unknown`, not `none-in-closure`, whenever the story's closure reaches a manifest node without a `src` (a bundled chunk) and no changed file was found in the resolved part. A pre-flight against the real `examples/storybook` build showed the first draft saying "not your code" for a component edit, which is the worst outcome Review Focus 1 names.
  10. `--crops` orders regions and labels `explained` from the full coverage result (`SnapComparison.unexplainedRegions`), not from the verdict's budget-fitted `unexplainedRegions` prefix: when deltas fill the 1,500-char budget, the verdict lists fewer unexplained regions than there are, and a crop must not call one of the dropped ones "explained".

## Review Focus

1. **A story whose closure the manifest cannot fully resolve** (the `urls` platform's `''`, a story file outside the built workbench, or — the common case — a Storybook build whose components live in `src`-less chunks). Expect `cause.kind = 'unknown'`, never `none-in-closure` — a false "not your code" is worse than silence. Test: Task 2 (`cause.test.ts`, "a story the manifest does not know is unknown" and "the real Storybook manifest never says none-in-closure for a component edit", the latter over a committed copy of `examples/storybook/storybook-static/.vite/manifest.json`).
2. **`--crops` on a pair whose images have different dimensions** (`dimension-change`, the user forgot `--viewport`). Expect one strip of the overlapping frame, exit 1, no throw, and the human output says the sizes differ. Test: Task 4 (`crops.test.ts`, "different sizes") and Task 5 (`check-diff.mjs`).
3. **A run where hundreds of stories share one signature** (a design-token bump). Expect one group listing every id, the human output printing the first five ids and a count and at most 10 groups, `report.json` intact, and `computeGroups` on 5,000 results under 50 ms (best of 3, fixtures built outside the timed region). Test: Task 3 (`groups.test.ts`, "5,000 results, one signature").
4. **`--crops` on a sub-threshold change** (bytes differ, zero regions marked — the corpus `background` case). Expect one full-frame strip, exit 1, and a line saying no region was marked. Test: Task 5 (`check-diff.mjs`, "sub-threshold crops").
5. **A `--since` diff touching hundreds of files with long monorepo paths.** Expect `cause.files` ≤ 5, each path ≤ 80 chars ending in the real file name, the verdict ≤ 1,500 chars, and deltas still present. Test: Task 2 (`structural.test.ts`, "cause fits the budget").

---

### Task 1: Child-follows-parent suppression, nested corpus operators, fixture regeneration

**Files:**

- Modify: `scripts/structural-corpus/page.mjs` (`PageOptions.meta`, rows render, two operators, `against`, `absent` in `checkVerdict`)
- Modify: `scripts/capture-diff-fixtures.mjs` (diff each case against its `against` case; record `against`)
- Modify: `scripts/structural-corpus.mjs` (diff each operator against its `against` snap)
- Modify: `packages/core/src/diff/structural.test.ts:40-49` (`verdict()` reads the case's `against`)
- Modify: `packages/core/src/diff/structural/deltas.ts:138-143`
- Regenerate: `packages/core/src/diff/__fixtures__/structural-corpus.json`
- Modify: `packages/core/src/diff/structural/summary.test.ts:61-63` (`mentions()` drops the needle's flags; `nested` is the first case with more than one `added`)
- Test: `packages/core/src/diff/structural/deltas.test.ts`

**Interfaces:**

- Consumes: `computeFacts(a, b, match): Fact[]`, `Fact.source`, `round` (`packages/core/src/capture/structure.ts:191`), `matchElements` (`match.ts`), `label` (`label.ts`).
- Produces (page.mjs): `OPERATORS[n].against?: string` (the operator whose capture is this one's baseline; default `'noop'`), `expect.absent?: RegExp` (no delta's `el`/`after` may match); `PageOptions.meta?: boolean`.
- Produces (fixture): each `cases[name]` gains `against: string` (the baseline case name). The fixture shape is otherwise unchanged: `{ viewport, cases: Record<name, { against, structure, imagesIdentical, pixels }> }`.
- Produces (deltas.ts): unchanged signature; a matched element's `moved`/`resized` fact is omitted when its matched parent's box changed by the same `(dx, dy)` / `(dw, dh)`.

- [ ] **Step 1: Add the nested rows and operators to the corpus page**

In `scripts/structural-corpus/page.mjs`, change the `PageOptions` typedef and the row rendering:

```js
/**
 * @typedef {{ css?: string; saveText?: string; banner?: string; logo?: string;
 *   removeRow?: boolean; canvasFill?: string; rowOrder?: number[]; meta?: boolean }} PageOptions
 */
```

and in `render`, replace the `.map((n) => …)` row line with:

```js
    .map((n) =>
      o.removeRow && n === 1
        ? ''
        : // The span follows its text with no whitespace between, so the row's
          // own text node is byte-identical with and without `meta`.
          `<div class="row" id="row-${n}">Row ${ROW_WORDS[n - 1]}${o.meta ? `<span class="meta"> #${n}</span>` : ''}</div>`,
    )
```

Append two operators to `OPERATORS`, after `reorder` and before `canvas`:

```js
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
```

In `checkVerdict`, after the `e.lead` check, add:

```js
if (e.absent) {
  const hit = v.deltas.find((d) => e.absent.test(String('el' in d ? d.el : d.after)));
  if (hit) problems.push(`unexpected delta ${JSON.stringify(hit)}`);
}
```

and replace the `OPERATORS` JSDoc comment with:

```js
/** Order matters only for reporting. `noop` is the baseline every operator
 *  is diffed against unless it names another with `against`. An
 *  expectation's `absent` is a RegExp no delta's `el`/`after` may match. */
```

- [ ] **Step 2: Make the generator and the corpus script honour `against`**

In `scripts/capture-diff-fixtures.mjs`, replace the `cases` loop:

```js
const cases = {};
for (const op of OPERATORS) {
  // The first `noop` capture is the base for everything that does not name
  // its own baseline; `nested-reorder` is diffed against `nested`.
  const against = op.against ? captured[op.against] : base;
  const { mismatchPixels, mismatchPercent, changedRegions, dimensionMismatch } =
    await diffImages(against.image, captured[op.name].image);
  cases[op.name] = {
    against: op.against ?? 'noop',
    structure: captured[op.name].structure,
    // Byte equality, the pass/fail authority — not "0 mismatch pixels":
    // `background` changes the bytes while pixelmatch marks nothing.
    imagesIdentical: against.image.equals(captured[op.name].image),
    pixels: { mismatchPixels, mismatchPercent, changedRegions, dimensionMismatch },
  };
}
```

In `scripts/structural-corpus.mjs`, replace the `jux(['diff', 'base', …])` call inside the operator loop:

```js
const baseline = op.against
  ? `op-${slugs.get(`${server.url}/op/${op.against}`)}`
  : 'base';
const out = await jux(['diff', baseline, `op-${slugs.get(urls[i])}`]);
```

In `packages/core/src/diff/structural.test.ts`, change the `Case` interface and `verdict()`:

```ts
interface Case {
  against: string;
  structure: StructureSnapshot;
  imagesIdentical: boolean;
  pixels: {
    mismatchPixels: number;
    mismatchPercent: number;
    changedRegions: ChangedRegion[];
    dimensionMismatch: boolean;
  };
}
```

```ts
const verdict = (name: string, over: Partial<StructuralDiffInput> = {}) =>
  structuralDiff({
    baseline: fixture.cases[fixture.cases[name].against].structure,
    current: fixture.cases[name].structure,
    imagesIdentical: fixture.cases[name].imagesIdentical,
    pixels: fixture.cases[name].pixels,
    escalate: ESC,
    ...over,
  });
```

- [ ] **Step 3: Regenerate the fixture**

Run: `pnpm --filter @juxtapose/core build && node scripts/capture-diff-fixtures.mjs && pnpm format`
Expected: `wrote …/structural-corpus.json: 21 cases`. Sanity-check:

```bash
node -e "const f=require('./packages/core/src/diff/__fixtures__/structural-corpus.json'); for (const [k,v] of Object.entries(f.cases)) console.log(k.padEnd(16), v.against.padEnd(8), v.structure.elements.length, v.pixels.mismatchPixels)"
```

`noop` must still be 10 elements and 0 mismatch pixels; `nested` and `nested-reorder` must be 15 elements with > 0 mismatch pixels; every other case must show the same element count and mismatch count as before (`git diff --stat` on the fixture shows only the two new cases plus the `against` key on each case — if any existing case's numbers moved, the capture pipeline is nondeterministic; stop and report rather than work around it).

- [ ] **Step 4: Write the failing delta tests**

Append to `packages/core/src/diff/structural/deltas.test.ts`:

```ts
// Deferred from PR (b): a child whose box changed exactly as its parent's did
// only followed it. On the 12-item reorder probe the item's `span.meta moved
// down 222px` read as a second change beside the item's own move.
test('a child that moved exactly with its parent is not listed (nested-reorder)', () => {
  const d = deltas(snap('nested'), snap('nested-reorder'));
  expect(d.some((x) => 'el' in x && x.el.startsWith('span.meta'))).toBe(false);
  expect(d).toContainEqual({ kind: 'moved', el: 'div#row-1', dx: 0, dy: 111 });
  // rows 1–4 moved; row 5, the canvas and every span did not get a fact
  expect(d.filter((x) => x.kind === 'moved')).toHaveLength(4);
});

test('a child that moved differently from its parent is still listed', () => {
  const a = snap('nested');
  const b = structuredClone(a);
  const row = b.elements.findIndex((e) => e.id === 'row-2');
  const span = b.elements.findIndex((e) => e.parent === row && e.tag === 'span');
  b.elements[row].rect = { ...b.elements[row].rect, y: b.elements[row].rect.y + 10 };
  b.elements[span].rect = { ...b.elements[span].rect, y: b.elements[span].rect.y + 12 };
  const d = deltas(a, b);
  expect(d).toContainEqual({ kind: 'moved', el: 'div#row-2', dx: 0, dy: 10 });
  expect(d).toContainEqual({ kind: 'moved', el: 'span.meta', dx: 0, dy: 12 });
});

test('a child resized exactly like its parent is not listed either', () => {
  const a = snap('nested');
  const b = structuredClone(a);
  const row = b.elements.findIndex((e) => e.id === 'row-2');
  const span = b.elements.findIndex((e) => e.parent === row && e.tag === 'span');
  for (const k of [row, span])
    b.elements[k].rect = { ...b.elements[k].rect, w: b.elements[k].rect.w + 8 };
  const d = deltas(a, b);
  expect(d).toEqual([{ kind: 'resized', el: 'div#row-2', dw: 8, dh: 0 }]);
});

test('a grandchild following a parent that itself followed is suppressed too', () => {
  const a = snap('nested');
  const b = structuredClone(a);
  const main = b.elements.findIndex((e) => e.tag === 'main');
  const row = b.elements.findIndex((e) => e.id === 'row-2');
  const span = b.elements.findIndex((e) => e.parent === row && e.tag === 'span');
  for (const k of [main, row, span])
    b.elements[k].rect = { ...b.elements[k].rect, y: b.elements[k].rect.y + 10 };
  const d = deltas(a, b);
  // Compared on rects, not on facts: row-2's own move is suppressed and the
  // span still reads as following it, so only `main` is listed.
  const moved = d.filter(
    (x): x is Extract<Delta, { kind: 'moved' }> => x.kind === 'moved',
  );
  expect(moved.map((x) => x.el)).toEqual(['main']);
});

test('an element whose parent did not move keeps every move (inserted: 8, as before)', () => {
  // Measured before this change on the real `inserted` capture: the button,
  // the img, five rows and the canvas move (8 facts); `main` resizes but
  // does not move, so none of its children follows it. The count must not
  // change.
  const d = deltas(snap('noop'), snap('inserted'));
  expect(d.filter((x) => x.kind === 'moved')).toHaveLength(8);
});
```

`Delta` is already imported at the top of `deltas.test.ts` (`import type { Delta, StructureSnapshot } from '../../types.js';`).

- [ ] **Step 5: Run to verify failure**

Run: `pnpm vitest run packages/core/src/diff/structural/deltas.test.ts`
Expected: the first test FAILS (a `moved` for `span.meta…` is present and the moved count is > 4); the resize and grandchild tests FAIL likewise. The "differently" and "inserted: 8" tests pass already — they pin that the rule is narrow.

- [ ] **Step 6: Implement the suppression in `deltas.ts`**

In `packages/core/src/diff/structural/deltas.ts`, replace lines 138–143 (the `dw`/`dh`/`dx`/`dy` block) with:

```ts
const dw = round(eb.rect.w - ea.rect.w);
const dh = round(eb.rect.h - ea.rect.h);
const dx = round(eb.rect.x - ea.rect.x);
const dy = round(eb.rect.y - ea.rect.y);
// A child whose box changed exactly as its parent's did only followed it.
// On the 12-item reorder probe the item's `span.meta moved down 222px`
// read as a second change beside the item's own move, and in the corpus
// `nested-reorder` case the five spans doubled the shift count (6 for 3).
// The ancestor that actually moved keeps its fact, and its rect contains
// the child's, so coverage loses nothing.
const p = parentChange(a, b, i, j, aToB);
if ((dw !== 0 || dh !== 0) && !(p && p.dw === dw && p.dh === dh))
  facts.push(fact({ kind: 'resized', el, dw, dh }));
if ((dx !== 0 || dy !== 0) && !(p && p.dx === dx && p.dy === dy))
  facts.push(fact({ kind: 'moved', el, dx, dy }));
```

Add after `originatesHere`:

```ts
/** How the matched parent's box changed; undefined when the parent is the
 *  root or unmatched. Read off the rects, not off the facts, so a grandchild
 *  still reads as following when its parent's own move was itself
 *  suppressed. */
function parentChange(
  a: StructureSnapshot,
  b: StructureSnapshot,
  i: number,
  j: number,
  aToB: Map<number, number>,
): { dx: number; dy: number; dw: number; dh: number } | undefined {
  const pa = a.elements[i].parent;
  const pb = b.elements[j].parent;
  if (pa === null || pb === null || aToB.get(pa) !== pb) return undefined;
  const ra = a.elements[pa].rect;
  const rb = b.elements[pb].rect;
  return {
    dx: round(rb.x - ra.x),
    dy: round(rb.y - ra.y),
    dw: round(rb.w - ra.w),
    dh: round(rb.h - ra.h),
  };
}
```

- [ ] **Step 7: Fix the `mentions()` helper in `summary.test.ts`**

`packages/core/src/diff/structural/summary.test.ts:61-63` counts matches with `new RegExp(needle, 'g')`, which drops the needle's own flags; `/^ {2}added\b/m` then loses its `m` and counts 1 instead of 5 for `nested`, the first case with more than one `added`. Replace the helper with:

```ts
function mentions(lines: string[], needle: RegExp): number {
  // Keep the needle's own flags (`m` for line anchors) and add `g` to count.
  const flags = needle.flags.includes('g') ? needle.flags : needle.flags + 'g';
  return lines.join('\n').match(new RegExp(needle.source, flags))?.length ?? 0;
}
```

Run: `pnpm vitest run packages/core/src/diff/structural/summary.test.ts`
Expected: PASS for all 21 cases, including `nested` (5 `added` lines counted).

- [ ] **Step 8: Run the whole core suite**

Run: `pnpm vitest run packages/core && pnpm typecheck`
Expected: PASS, including `structural.test.ts`'s generated `corpus operator 'nested-reorder' → reflow` and `'nested' → element-added` cases, and the unchanged `padding`/`inserted`/`removed`/`reorder` expectations (the corpus page's rows have no children in those cases, so no fact changes). The two 5,000-element performance tests print their timings; the tree test still reports `deltaCount` 110 (the section rects do not move, so no row follows one).

- [ ] **Step 9: Run the end-to-end corpus**

Run: `pnpm build && node scripts/structural-corpus.mjs`
Expected: `ok   21 of 21 operators`, with the `nested-reorder` line showing `reflow` (measured in pre-flight: 567 chars; `nested` is `element-added` at 1009), and the budget line (`tier-0 JSON chars: … max ≤ 1500`).

- [ ] **Step 10: Commit**

```bash
pnpm format
git add scripts/structural-corpus scripts/capture-diff-fixtures.mjs scripts/structural-corpus.mjs packages/core/src/diff
git commit -m "feat(core): a child's move or resize that only follows its parent is not a delta

Two nested corpus operators (rows with inline spans; the reorder diffed
against them) capture the case from the 12-item reorder probe where the
item's span read as a second change. Operators can now name the case they
are diffed against.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Cause — the cheap link from story to changed files

**Files:**

- Modify: `packages/core/src/types.ts` (`Cause`, `CauseKind`; `cause?` on `StructuralVerdict`)
- Modify: `packages/core/src/analysis/affected.ts` (export `loadViteManifest`, `gitChangedFiles`, `toPosixRelative`, `ViteManifest`; extract `isLockfileChange`, `isConfigChange`, `keyToSrc`; add `gitTopLevel`)
- Create: `packages/core/src/analysis/cause.ts`
- Create: `scripts/capture-cause-manifest.mjs` (copies the real `examples/storybook` Vite manifest into the fixture, prettier-formatted)
- Create: `packages/core/src/analysis/__fixtures__/storybook-manifest.json` (generated, committed)
- Modify: `packages/core/src/diff/structural.ts` (`cause?` on the input, fitted into the literal; owns `MAX_CAUSE_FILES` and `MAX_CAUSE_PATH` so the pure diff module never imports `analysis/`)
- Modify: `packages/core/src/run/run.ts` (`RunOptions.cause`, `tryStructural` consults it, timed; capture time subtracts it)
- Modify: `packages/core/src/agent/handoff.ts` (`describeCause`; a `## Why` section before the structure section, present even with no structure snapshot)
- Modify: `packages/core/src/index.ts` (exports)
- Modify: `packages/cli/src/commands/run.ts` (wire `--since` to `prepareCause`; cause line in the review list through `describeCause`)
- Test: `packages/core/src/analysis/cause.test.ts` (new), `packages/core/src/diff/structural.test.ts`, `packages/core/src/run/run-structural.test.ts`, `packages/core/src/agent/handoff.test.ts`, `packages/core/src/analysis/affected.test.ts` (unchanged, must stay green)

**Interfaces:**

- Consumes: `compareCodeUnits` (`deltas.ts`), `Phases.time` (`run/phases.ts:11`), `StoryManifest.componentPath` (absolute, `''` for the urls platform), `CommonFlags.since` (`packages/cli/src/context.ts:20`), `ctx.platform.configDirs`, `ctx.buildDir`.
- Produces (types.ts):

  ```ts
  export type CauseKind = 'in-closure' | 'config' | 'none-in-closure' | 'unknown';
  export interface Cause {
    kind: CauseKind;
    /** ≤ 5, nearest first; posix paths relative to the project root. */
    files: Array<{ path: string; distance: number }>;
  }
  // StructuralVerdict gains, between `flags` and `signature`: cause?: Cause;
  ```

- Produces (affected.ts): `export function loadViteManifest(buildDir: string): Promise<ViteManifest | null>`; `export function gitChangedFiles(sinceCommit: string, cwd: string): string[] | null` (paths as git prints them: relative to the repository top level, forward slashes); `export function gitTopLevel(cwd: string): string | null`; `export function toPosixRelative(root: string, abs: string): string`; `export function isLockfileChange(file: string): boolean`; `export function isConfigChange(file: string, configDirs: string[]): boolean`; `export function keyToSrc(manifest: ViteManifest): Map<string, string>`; `export type ViteManifest`.
- Produces (cause.ts):

  ```ts
  export interface CauseIndex {
    /** Never throws; never reads anything before the first call. */
    causeFor(componentPath: string): Promise<Cause>;
  }
  export interface CauseSources {
    projectRoot: string;
    configDirs: string[];
    /** Posix paths relative to projectRoot (already mapped from git's
     *  top-level-relative form); null when git could not say. */
    changedFiles: string[] | null;
    manifest: ViteManifest | null;
  }
  export function buildCauseIndex(src: CauseSources): CauseIndex; // pure
  export function prepareCause(opts: {
    projectRoot: string;
    buildDir?: string;
    sinceCommit: string;
    configDirs: string[];
  }): CauseIndex; // lazy, memoized, guarded; maps git paths through gitTopLevel
  ```

- Produces (structural.ts): `StructuralDiffInput.cause?: Cause`; `export const MAX_CAUSE_FILES = 5`; `export const MAX_CAUSE_PATH = 80`.
- Produces (run.ts): `RunOptions.cause?: CauseIndex`.
- Produces (handoff.ts): `export function describeCause(c: Cause): string | undefined` — one sentence, no heading; `undefined` for `unknown`. The only wording of the cause: the handoff puts it under `## Why`, the CLI prints it after `cause: `.

- [ ] **Step 1: Add the types**

In `packages/core/src/types.ts`, after the `Flag` type insert:

```ts
export type CauseKind =
  /** At least one changed file is in the story's import closure. */
  | 'in-closure'
  /** A changed file reaches every story: a root lockfile or a platform config dir. */
  | 'config'
  /** The closure was traced and no changed file is in it: the strongest
   *  "this is not your code" the tool can give, especially beside render-drift. */
  | 'none-in-closure'
  /** No --since, no manifest, git failed, or the story is not in the graph. */
  | 'unknown';

/** Why this story changed: the cheap link only (story → import closure →
 *  changed files). Matched CSS rules and source lines are later rows. */
export interface Cause {
  kind: CauseKind;
  /** At most 5, nearest first; posix paths relative to the project root. */
  files: Array<{ path: string; distance: number }>;
}
```

In `StructuralVerdict`, after `flags: Flag[];` insert:

```ts
  /** Present only in `jux run --since`; absent from `jux diff`. */
  cause?: Cause;
```

In `packages/core/src/index.ts`, add `Cause, CauseKind,` to the type export list after `StructuralVerdict,`.

- [ ] **Step 2: Export the manifest and git helpers from `affected.ts`; capture the real manifest fixture**

In `packages/core/src/analysis/affected.ts`, make `ViteManifest` exported (`export type ViteManifest = …`), and replace the lockfile/config loop in `resolveAffected` (lines 76–84) with:

```ts
for (const file of changed) {
  if (isLockfileChange(file)) return { stories, reason: 'dependency-changed' };
  if (isConfigChange(file, opts.configDirs)) return { stories, reason: 'config-changed' };
}
```

Add after the `LOCKFILES` constant:

```ts
/** A root lockfile: dependencies changed, so every story may render
 *  differently. A nested package.json (a fixture) is not one. */
export function isLockfileChange(file: string): boolean {
  const base = file.split('/').pop() ?? file;
  return LOCKFILES.has(base) && !file.includes('/');
}

/** Anything under a platform config dir (`.storybook`, `.ladle`) reaches
 *  every story. */
export function isConfigChange(file: string, configDirs: string[]): boolean {
  return configDirs.some((dir) => file === dir || file.startsWith(dir + '/'));
}
```

Change `async function loadViteManifest`, `function gitChangedFiles` and `function toPosixRelative` to `export async function` / `export function` (bodies unchanged). Extract the key → src map out of `buildReverseGraph` so the forward graph in `cause.ts` cannot drift from it:

```ts
/** Vite's `imports[]` holds chunk keys, not source paths; this is the map
 *  both graph directions resolve an edge through. A chunk with no `src` (a
 *  bundled component chunk in a Storybook build) has no entry. */
export function keyToSrc(manifest: ViteManifest): Map<string, string> {
  const map = new Map<string, string>();
  for (const [key, entry] of Object.entries(manifest)) {
    if (entry.src) map.set(key, entry.src);
  }
  return map;
}
```

and in `buildReverseGraph`, replace its first four lines (the local `keyToSrc` map) with `const srcOf = keyToSrc(manifest);` and `keyToSrc.get(key)` with `srcOf.get(key)`.

Add after `gitChangedFiles`:

```ts
/** The repository root, which git's paths are relative to. Null outside a
 *  repository or without git. */
export function gitTopLevel(cwd: string): string | null {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf8',
    }).trim();
  } catch {
    return null;
  }
}
```

Run: `pnpm vitest run packages/core/src/analysis/affected.test.ts`
Expected: PASS, unchanged.

Create `scripts/capture-cause-manifest.mjs`, which copies the real Storybook build's manifest into a committed fixture (the first draft's hand-written manifest gave every module a `src`, which a real Storybook build does not — CLAUDE.md's `regions.test.ts` lesson):

```js
// Copies examples/storybook's Vite manifest into the cause fixture. A real
// Storybook build bundles components into chunks with no `src`, which a
// hand-written manifest never shows; the cause test must see the real shape.
// Run after `pnpm --filter example-storybook build`:
//   node scripts/capture-cause-manifest.mjs
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as prettier from 'prettier';

const root = path.resolve(import.meta.dirname, '..');
const src = path.join(root, 'examples/storybook/storybook-static/.vite/manifest.json');
const out = path.join(
  root,
  'packages/core/src/analysis/__fixtures__/storybook-manifest.json',
);
const manifest = JSON.parse(await readFile(src, 'utf8'));
// Formatted with the repo's prettier so the committed bytes ARE the output.
await writeFile(
  out,
  await prettier.format(JSON.stringify(manifest), { parser: 'json', filepath: out }),
);
const entries = Object.values(manifest);
console.log(
  `wrote ${out}: ${entries.length} entries, ${entries.filter((e) => !e.src).length} without src`,
);
```

Run: `pnpm --filter example-storybook build && node scripts/capture-cause-manifest.mjs`
Expected: `wrote …/storybook-manifest.json: 11 entries, 4 without src` (pre-flight measured 11 entries with the component code in `_index-*.js` chunks that have no `src`; the exact hashes differ per build and are not asserted anywhere). Commit the fixture with this task.

- [ ] **Step 3: Write the failing cause tests**

Create `packages/core/src/analysis/cause.test.ts`:

```ts
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildCauseIndex, prepareCause } from './cause.js';
import { MAX_CAUSE_FILES } from '../diff/structural.js';
import type { ViteManifest } from './affected.js';

// A minimal graph for the pure logic (Button.stories → Button → shared;
// Card.stories → Card; `_chunk` has no src, like a bundled chunk). The real
// shape — components in src-less chunks — is pinned separately below over a
// committed copy of the examples/storybook build's manifest.
const manifest: ViteManifest = {
  'src/Button.stories.tsx': {
    file: 'a.js',
    src: 'src/Button.stories.tsx',
    imports: ['_button'],
  },
  _button: { file: 'b.js', src: 'src/Button.tsx', imports: ['_shared', '_chunk'] },
  _shared: { file: 'c.js', src: 'src/shared.ts' },
  _chunk: { file: 'z.js' },
  'src/Card.stories.tsx': {
    file: 'd.js',
    src: 'src/Card.stories.tsx',
    imports: ['_card'],
  },
  _card: { file: 'e.js', src: 'src/Card.tsx' },
};

let root: string;
beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'jux-cause-'));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const index = (changedFiles: string[] | null, m: ViteManifest | null = manifest) =>
  buildCauseIndex({
    projectRoot: root,
    configDirs: ['.storybook'],
    changedFiles,
    manifest: m,
  });
const button = () => path.join(root, 'src/Button.stories.tsx');
const card = () => path.join(root, 'src/Card.stories.tsx');

describe('buildCauseIndex', () => {
  it('finds a changed file in the closure with its graph distance', async () => {
    expect(await index(['src/shared.ts']).causeFor(button())).toEqual({
      kind: 'in-closure',
      files: [{ path: 'src/shared.ts', distance: 2 }],
    });
  });

  it('reports none-in-closure for a story the change cannot reach', async () => {
    expect(await index(['src/shared.ts']).causeFor(card())).toEqual({
      kind: 'none-in-closure',
      files: [],
    });
  });

  it('the story file itself is distance 0', async () => {
    const c = await index(['src/Button.stories.tsx']).causeFor(button());
    expect(c.files).toEqual([{ path: 'src/Button.stories.tsx', distance: 0 }]);
  });

  it('orders by distance, then path (code units), and caps at 5', async () => {
    const c = await index([
      'src/shared.ts',
      'src/Button.tsx',
      'src/Button.stories.tsx',
    ]).causeFor(button());
    expect(c.files.map((f) => f.distance)).toEqual([0, 1, 2]);
    const wide: ViteManifest = {
      'src/S.stories.tsx': {
        file: 's.js',
        src: 'src/S.stories.tsx',
        imports: Array.from({ length: 9 }, (_, k) => `_m${k}`),
      },
    };
    for (let k = 0; k < 9; k++)
      wide[`_m${k}`] = { file: `m${k}.js`, src: `src/m${k}.ts` };
    const changed = Array.from({ length: 9 }, (_, k) => `src/m${8 - k}.ts`);
    const many = await index(changed, wide).causeFor(
      path.join(root, 'src/S.stories.tsx'),
    );
    expect(many.files).toHaveLength(MAX_CAUSE_FILES);
    expect(many.files.map((f) => f.path)).toEqual([
      'src/m0.ts',
      'src/m1.ts',
      'src/m2.ts',
      'src/m3.ts',
      'src/m4.ts',
    ]);
  });

  it('a lockfile or config change is `config`, listing the file', async () => {
    expect(await index(['pnpm-lock.yaml', 'src/shared.ts']).causeFor(card())).toEqual({
      kind: 'config',
      files: [{ path: 'pnpm-lock.yaml', distance: 0 }],
    });
    expect((await index(['.storybook/preview.ts']).causeFor(card())).kind).toBe('config');
    // a nested package.json is not a dependency change
    expect((await index(['src/fixtures/package.json']).causeFor(card())).kind).toBe(
      'none-in-closure',
    );
  });

  // Review Focus 1
  it('a story the manifest does not know is unknown, never none-in-closure', async () => {
    expect((await index(['src/shared.ts']).causeFor('')).kind).toBe('unknown');
    expect(
      (
        await index(['src/shared.ts']).causeFor(
          path.join(root, 'src/Elsewhere.stories.tsx'),
        )
      ).kind,
    ).toBe('unknown');
  });

  it('no manifest or no git answer is unknown', async () => {
    expect((await index(['src/shared.ts'], null).causeFor(button())).kind).toBe(
      'unknown',
    );
    expect((await index(null).causeFor(button())).kind).toBe('unknown');
  });

  // Review Focus 1 (and refinement 9): a src-less chunk means the closure
  // was not fully traced. A hit in the traced part is still a hit; no hit
  // is unknown, never "not your code".
  it('a closure through a chunk without src is unknown unless a changed file was found', async () => {
    expect((await index(['README.md']).causeFor(button())).kind).toBe('unknown');
    expect((await index(['src/shared.ts']).causeFor(button())).kind).toBe('in-closure');
    // Card's closure has no chunk: fully traced, so none-in-closure is honest.
    expect((await index(['README.md']).causeFor(card())).kind).toBe('none-in-closure');
  });

  it('an empty change set on a fully traced closure is none-in-closure', async () => {
    expect((await index([]).causeFor(card())).kind).toBe('none-in-closure');
  });
});

// The real thing: examples/storybook's Vite manifest, copied by
// scripts/capture-cause-manifest.mjs. Stories have a src; the component
// library (examples/components/src/index.jsx) is bundled into `_index-*.js`
// chunks that do not.
describe('the real Storybook manifest', () => {
  const real = JSON.parse(
    readFileSync(
      path.join(import.meta.dirname, '__fixtures__/storybook-manifest.json'),
      'utf8',
    ),
  ) as ViteManifest;
  const project = () => path.join(root, 'examples/storybook');
  const story = () => path.join(project(), 'stories/Button.stories.jsx');
  const realIndex = (changedFiles: string[]) =>
    buildCauseIndex({
      projectRoot: project(),
      configDirs: ['.storybook'],
      changedFiles,
      manifest: real,
    });

  it('has src-less chunks (or this test is pinning the wrong shape)', () => {
    expect(Object.values(real).some((e) => !e.src)).toBe(true);
    expect(real['stories/Button.stories.jsx']?.src).toBe('stories/Button.stories.jsx');
  });

  it('never says none-in-closure for a component edit', async () => {
    // Project-relative, as prepareCause maps git's `examples/components/src/index.jsx`.
    const c = await realIndex(['../components/src/index.jsx']).causeFor(story());
    expect(c.kind).toBe('unknown');
  });

  it('never says none-in-closure for an unrelated file either, since the closure is not fully traced', async () => {
    expect((await realIndex(['../../README.md']).causeFor(story())).kind).toBe('unknown');
  });

  it('still finds the story file itself', async () => {
    expect(await realIndex(['stories/Button.stories.jsx']).causeFor(story())).toEqual({
      kind: 'in-closure',
      files: [{ path: 'stories/Button.stories.jsx', distance: 0 }],
    });
  });

  it('a .storybook change is config', async () => {
    expect((await realIndex(['.storybook/preview.js']).causeFor(story())).kind).toBe(
      'config',
    );
  });
});

describe('prepareCause', () => {
  it('reads the manifest and git only on the first causeFor, and never throws', async () => {
    // No build dir, and a directory that is not a git repo: both reads fail
    // and the answer is unknown, with no exception reaching the caller.
    const ix = prepareCause({
      projectRoot: root,
      sinceCommit: 'HEAD~1',
      configDirs: ['.storybook'],
    });
    expect(await ix.causeFor(button())).toEqual({ kind: 'unknown', files: [] });
  });

  it('maps git top-level paths to the project root and traces the closure', async () => {
    // A real repository with the project in a subdirectory, like
    // examples/storybook inside this repo: git says `app/src/Card.tsx`, the
    // manifest says `src/Card.tsx`.
    const repo = await mkdtemp(path.join(tmpdir(), 'jux-cause-git-'));
    const git = (...args: string[]) =>
      execFileSync('git', args, {
        cwd: repo,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    const project = path.join(repo, 'app');
    const buildDir = path.join(project, 'build');
    await mkdir(path.join(buildDir, '.vite'), { recursive: true });
    await mkdir(path.join(project, 'src'), { recursive: true });
    await writeFile(path.join(buildDir, '.vite/manifest.json'), JSON.stringify(manifest));
    await writeFile(path.join(project, 'src/Card.tsx'), 'v1');
    git('init', '-q');
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.');
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'one');
    await writeFile(path.join(project, 'src/Card.tsx'), 'v2');
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qam', 'two');
    const ix = prepareCause({
      projectRoot: project,
      buildDir,
      sinceCommit: 'HEAD~1',
      configDirs: [],
    });
    expect(await ix.causeFor(path.join(project, 'src/Card.stories.tsx'))).toEqual({
      kind: 'in-closure',
      files: [{ path: 'src/Card.tsx', distance: 1 }],
    });
    await rm(repo, { recursive: true, force: true });
  });
});
```

- [ ] **Step 4: Run to verify failure**

Run: `pnpm vitest run packages/core/src/analysis/cause.test.ts`
Expected: FAIL — cannot find module `./cause.js`.

- [ ] **Step 5: Implement `cause.ts`**

Create `packages/core/src/analysis/cause.ts`:

```ts
// Why did this story change? The cheap link only: the story's import
// closure — a forward walk over the same Vite manifest `affected.ts` walks
// backwards — intersected with the files changed since `--since`, nearest
// first. `none-in-closure` beside `render-drift` is the strongest "this is
// not your code" the tool can give. Matched CSS rules and source lines are
// later rows.
//
// "Not your code" is said only after a full trace. A Storybook build
// bundles components into chunks that have no `src` in the manifest, so a
// story's closure usually ends in an unresolved node; a changed file found
// before that point is a hit, but no hit is `unknown`, never
// `none-in-closure`. The first draft said "not your code" for a component
// edit on examples/storybook, the worst answer the feature can give.
//
// Nothing here may fail a story. `prepareCause` reads git and the manifest
// on the first `causeFor` call, once, inside try/catch; that call happens
// only in the fail branch of `judge()`, so a green run reads neither.

import path from 'node:path';
import { compareCodeUnits } from '../diff/structural/deltas.js';
import { MAX_CAUSE_FILES } from '../diff/structural.js';
import type { Cause } from '../types.js';
import {
  gitChangedFiles,
  gitTopLevel,
  isConfigChange,
  isLockfileChange,
  keyToSrc,
  loadViteManifest,
  toPosixRelative,
  type ViteManifest,
} from './affected.js';

export interface CauseIndex {
  /** The cause for one story's component path. Never throws, never reads
   *  anything before the first call. */
  causeFor(componentPath: string): Promise<Cause>;
}

export interface CauseSources {
  projectRoot: string;
  configDirs: string[];
  /** Posix paths relative to projectRoot (git's top-level-relative paths
   *  already mapped); null when git could not say. */
  changedFiles: string[] | null;
  manifest: ViteManifest | null;
}

const UNKNOWN: Cause = { kind: 'unknown', files: [] };

/** The index from already-loaded inputs. Pure. */
export function buildCauseIndex(src: CauseSources): CauseIndex {
  const graph = src.manifest ? buildForwardGraph(src.manifest) : null;
  return {
    causeFor: async (componentPath) => causeOf(src, graph, componentPath),
  };
}

/** The index for `jux run --since`. Lazy and memoized, so the manifest and
 *  git are read once, and only if some story fails. */
export function prepareCause(opts: {
  projectRoot: string;
  buildDir?: string;
  sinceCommit: string;
  configDirs: string[];
}): CauseIndex {
  let loading: Promise<CauseIndex> | undefined;
  const load = async (): Promise<CauseIndex> =>
    buildCauseIndex({
      projectRoot: opts.projectRoot,
      configDirs: opts.configDirs,
      manifest: await orNull(() =>
        opts.buildDir ? loadViteManifest(opts.buildDir) : Promise.resolve(null),
      ),
      changedFiles: await orNull(async () =>
        projectRelative(
          gitChangedFiles(opts.sinceCommit, opts.projectRoot),
          gitTopLevel(opts.projectRoot),
          opts.projectRoot,
        ),
      ),
    });
  return {
    causeFor: async (componentPath) => {
      try {
        loading ??= load();
        return await (await loading).causeFor(componentPath);
      } catch {
        return UNKNOWN;
      }
    },
  };
}

async function orNull<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}

/** Git prints paths relative to the repository top level; the manifest's
 *  `src` is relative to the project root. In a monorepo these differ
 *  (`examples/storybook/stories/X.jsx` vs `stories/X.jsx`), and comparing
 *  them unmapped made every story `none-in-closure`. A file outside the
 *  project maps to a `../` path, which is still what the manifest would hold
 *  for it. */
function projectRelative(
  files: string[] | null,
  topLevel: string | null,
  projectRoot: string,
): string[] | null {
  if (files === null || topLevel === null) return null;
  return files.map((f) => toPosixRelative(projectRoot, path.join(topLevel, f)));
}

/** src → the srcs (or bare chunk keys) it imports, static and dynamic. */
interface ForwardGraph {
  edges: Map<string, string[]>;
  /** Manifest keys with no `src`: a node here means the walk cannot see
   *  through it. */
  unresolved: Set<string>;
}

function causeOf(
  src: CauseSources,
  graph: ForwardGraph | null,
  componentPath: string,
): Cause {
  if (src.changedFiles === null) return UNKNOWN;
  // Same rule as resolveAffected: these reach every story, so the closure
  // is beside the point.
  const global = src.changedFiles
    .filter((f) => isLockfileChange(f) || isConfigChange(f, src.configDirs))
    .sort(compareCodeUnits);
  if (global.length > 0) {
    return {
      kind: 'config',
      files: global.slice(0, MAX_CAUSE_FILES).map((path) => ({ path, distance: 0 })),
    };
  }
  if (!graph || componentPath === '') return UNKNOWN;
  const start = toPosixRelative(src.projectRoot, componentPath);
  // Not in the graph (urls platform, a story outside the build): the
  // closure was never traced, so "none of your files" would be a guess.
  if (!graph.edges.has(start)) return UNKNOWN;
  const reach = closure(graph.edges, start);
  const changed = new Set(src.changedFiles);
  const files = [...reach]
    .filter(([file]) => changed.has(file))
    .map(([path, distance]) => ({ path, distance }))
    .sort((x, y) => x.distance - y.distance || compareCodeUnits(x.path, y.path))
    .slice(0, MAX_CAUSE_FILES);
  if (files.length > 0) return { kind: 'in-closure', files };
  // No hit. Honest only if every node on the way had a src to look through.
  for (const node of reach.keys()) if (graph.unresolved.has(node)) return UNKNOWN;
  return { kind: 'none-in-closure', files: [] };
}

/** Edges resolve through the same key → src map affected.ts's reverse graph
 *  uses; a key with no src is kept as a node (so the walk can report it as
 *  unresolved) with no outgoing edges. */
function buildForwardGraph(manifest: ViteManifest): ForwardGraph {
  const srcOf = keyToSrc(manifest);
  const edges = new Map<string, string[]>();
  const unresolved = new Set<string>();
  for (const [key, entry] of Object.entries(manifest)) {
    if (!entry.src) {
      unresolved.add(key);
      continue;
    }
    edges.set(
      entry.src,
      [...(entry.imports ?? []), ...(entry.dynamicImports ?? [])].map(
        (k) => srcOf.get(k) ?? k,
      ),
    );
  }
  return { edges, unresolved };
}

/** BFS distance from `start` to everything it reaches, `start` at 0. */
function closure(edges: Map<string, string[]>, start: string): Map<string, number> {
  const dist = new Map<string, number>([[start, 0]]);
  const queue = [start];
  for (let k = 0; k < queue.length; k++) {
    const file = queue[k];
    const d = dist.get(file)!;
    for (const next of edges.get(file) ?? []) {
      if (dist.has(next)) continue;
      dist.set(next, d + 1);
      queue.push(next);
    }
  }
  return dist;
}
```

`MAX_CAUSE_FILES` lives in `packages/core/src/diff/structural.ts` (added in Step 8, a pure module), so `structural.ts` never imports `analysis/`, which pulls in `child_process` and `fs`. Until Step 8 lands, the import above fails to resolve; do Step 8's constant first if running the tests between steps.

In `packages/core/src/index.ts`, after the `resolveAffected` export block add:

```ts
// Cause: the story's import closure intersected with the changed files.
export {
  buildCauseIndex,
  prepareCause,
  type CauseIndex,
  type CauseSources,
} from './analysis/cause.js';
```

Run: `pnpm vitest run packages/core/src/analysis && pnpm typecheck && pnpm lint`
Expected: PASS (the pre-flight's two `no-useless-assignment` errors came from `manifest = null` inside `catch`; `orNull` has no such assignment).

- [ ] **Step 6: Write the failing verdict tests for `cause`**

Append to `packages/core/src/diff/structural.test.ts`:

```ts
test('cause sits between flags and signature, and is absent when not given', () => {
  const cause = {
    kind: 'in-closure' as const,
    files: [{ path: 'src/Button.tsx', distance: 1 }],
  };
  expect(Object.keys(verdict('color', { cause }))).toEqual([
    'schema',
    'classification',
    'styleTags',
    'summary',
    'deltas',
    'deltaCount',
    'coverage',
    'explained',
    'unexplainedRegions',
    'flags',
    'cause',
    'signature',
    'escalate',
  ]);
  expect(verdict('color', { cause }).cause).toEqual(cause);
  expect('cause' in verdict('color')).toBe(false);
  // the signature is about the change, not about which files caused it
  expect(verdict('color', { cause }).signature).toBe(verdict('color').signature);
});

// Review Focus 5
test('cause fits the budget for any input: ≤5 files, paths ≤80 chars keeping the tail', () => {
  const deep = (k: number) =>
    `packages/${'very-long-workspace-name/'.repeat(10)}src/components/${k}/Button.tsx`;
  const cause = {
    kind: 'in-closure' as const,
    files: Array.from({ length: 200 }, (_, k) => ({ path: deep(k), distance: k })),
  };
  const v = verdict('padding', { cause });
  expect(v.cause?.files).toHaveLength(5);
  for (const f of v.cause!.files) {
    expect(f.path.length).toBeLessThanOrEqual(80);
    expect(f.path).toMatch(/^…/);
    expect(f.path).toMatch(/\/Button\.tsx$/);
  }
  expect(JSON.stringify(v).length).toBeLessThanOrEqual(1500);
  expect(v.deltas.length).toBeGreaterThan(0);
  expect(JSON.stringify(verdict('padding', { cause }))).toBe(JSON.stringify(v));
});
```

- [ ] **Step 7: Run to verify failure**

Run: `pnpm vitest run packages/core/src/diff/structural.test.ts`
Expected: both new tests FAIL (`cause` is not a key; TypeScript error on the unknown `cause` input is reported by vitest's esbuild as a runtime absence, not a type error — the type is added next).

- [ ] **Step 8: Fit `cause` into the verdict**

In `packages/core/src/diff/structural.ts`:

Add `Cause` to the type import from `'../types.js'`. This module stays pure: the cause limits are defined here and `analysis/cause.ts` imports them, never the other way round.

Add to `StructuralDiffInput` after `escalate`:

```ts
  /** From `jux run --since`; `jux diff` has no changed-file set. */
  cause?: Cause;
```

After `export const MAX_VERDICT = 1500;` add:

```ts
/** `cause.files` is capped here as well as in the index: the budget is a
 *  guarantee for any input. */
export const MAX_CAUSE_FILES = 5;
/** Longest `cause.files[].path`. The tail is kept: the file name is what a
 *  reader greps for; a 10-deep monorepo prefix is not. */
export const MAX_CAUSE_PATH = 80;
```

In `structuralDiff`, after `const sig = signature(classification, facts);` add:

```ts
// Fitted here, not trusted from the caller: the budget is a guarantee for
// any input, and the index's cap is a courtesy.
const cause = input.cause && fitCause(input.cause);
```

In the `build` literal, after `flags,` add `...(cause ? { cause } : {}),`.

After the `signature` function add:

```ts
function fitCause(c: Cause): Cause {
  return {
    kind: c.kind,
    files: c.files.slice(0, MAX_CAUSE_FILES).map((f) => ({
      path: clipHead(f.path, MAX_CAUSE_PATH),
      distance: f.distance,
    })),
  };
}

/** `…` plus the last `max - 1` code units. */
function clipHead(s: string, max: number): string {
  return s.length <= max ? s : '…' + s.slice(s.length - (max - 1));
}
```

Run: `pnpm vitest run packages/core/src/diff && pnpm typecheck`
Expected: PASS.

- [ ] **Step 9: Write the failing run and handoff tests**

In `packages/core/src/run/run-structural.test.ts`, change the `run` helper to accept extra options:

```ts
const run = (
  s: BaselineStore,
  storyId = 's',
  extra: Partial<Parameters<typeof runCapture>[0]> = {},
) =>
  runCapture({
    browser: {} as Browser,
    platform: { name: 'x' } as never,
    store: s,
    baseUrl: 'about:blank',
    stories: [{ storyId, title: 't', name: 'n', componentPath: '', params: {} }],
    totalCount: 1,
    runId: 'r',
    branch: 'b',
    commitSha: 'c',
    ...extra,
  });
```

Append:

```ts
test('with a cause index, a failing verdict carries the cause', async () => {
  const cause = {
    kind: 'in-closure' as const,
    files: [{ path: 'src/x.ts', distance: 1 }],
  };
  const causeFor = vi.fn(async () => cause);
  const r = await run(store('ok'), 's', { cause: { causeFor } });
  expect(r.results[0].structural?.cause).toEqual(cause);
  expect(causeFor).toHaveBeenCalledWith('');
});

// Verification 5: the index is never consulted for a passing story.
test('a passing story never asks the cause index', async () => {
  const causeFor = vi.fn(async () => ({ kind: 'unknown' as const, files: [] }));
  const r = await run(store('ok'), 'green', { cause: { causeFor } });
  expect(r.results[0].status).toBe('pass');
  expect(causeFor).not.toHaveBeenCalled();
});

test('a cause index that throws leaves the verdict without a cause, run intact', async () => {
  const causeFor = vi.fn(async () => {
    throw new Error('git exploded');
  });
  const r = await run(store('ok'), 's', { cause: { causeFor } });
  expect(r.results[0].status).toBe('fail');
  expect(r.results[0].structural?.classification).toBe('style-only');
  expect(r.results[0].structural?.cause).toBeUndefined();
});
```

In `packages/core/src/agent/handoff.test.ts`, add inside the `describe('buildHandoffPrompt')` block (it already builds a real verdict with `structuralDiff` further down; this test uses a minimal one):

```ts
it('leads with the cause when the run traced one', () => {
  const v = structuralDiff({
    baseline: fixture.cases.noop.structure,
    current: fixture.cases.color.structure,
    imagesIdentical: false,
    pixels: fixture.cases.color.pixels,
    escalate: { command: 'jux handoff x' },
    cause: {
      kind: 'in-closure',
      files: [
        { path: 'src/tokens.css', distance: 2 },
        { path: 'src/Button.tsx', distance: 1 },
      ],
    },
  });
  const out = buildHandoffPrompt({ ...base, structural: v });
  expect(out.indexOf('## Why')).toBeLessThan(out.indexOf('## What changed (structure)'));
  expect(out).toContain('`src/tokens.css` (2 imports away)');
  expect(out).toContain('`src/Button.tsx` (1 import away)');
  const none = buildHandoffPrompt({
    ...base,
    structural: { ...v, cause: { kind: 'none-in-closure', files: [] } },
  });
  expect(none).toContain(
    "None of the files changed since the baseline is in this story's import closure",
  );
  const unknown = buildHandoffPrompt({
    ...base,
    structural: { ...v, cause: { kind: 'unknown', files: [] } },
  });
  expect(unknown).not.toContain('## Why');
  // The cause does not depend on structure: with no baseline sidecar the
  // structure section is replaced by a "re-approve" note, and `## Why` stays.
  const noStructure = buildHandoffPrompt({
    ...base,
    structural: { ...v, deltas: [], flags: ['no-baseline-structure'] },
  });
  expect(noStructure).toContain('## Why');
  expect(noStructure).toContain('No structure snapshot for the baseline');
});
```

`fixture` is declared at `handoff.test.ts:118` inside a later `describe`; hoist that `const fixture = …` (lines 118–121) to module scope, above the first `describe`, so this test can use it.

- [ ] **Step 10: Run to verify failure**

Run: `pnpm vitest run packages/core/src/run packages/core/src/agent`
Expected: the three run tests FAIL (`cause` is not a `RunOptions` key, so `causeFor` is never called); the handoff test FAILS (`## Why` absent).

- [ ] **Step 11: Wire the cause through `run.ts` and the handoff**

In `packages/core/src/run/run.ts`:

Add `import type { CauseIndex } from '../analysis/cause.js';`. In `RunOptions`, after `phases?: Phases;` add:

```ts
  /** From `jux run --since`: consulted only for a story that failed. */
  cause?: CauseIndex;
```

Change the `tryStructural` call in `judge` to `await tryStructural(opts, story, snapshot, diff, p)` and the function to:

```ts
/** Structure explains a failure, never decides one, so nothing in here may
 *  fail the story: a missing, corrupt or malformed sidecar, a cause index
 *  that throws, or a bug in the diff, yields no verdict (or one without a
 *  cause) and the pixel result stands. */
async function tryStructural(
  opts: RunOptions,
  story: StoryManifest,
  snapshot: Snapshot,
  pixels: Pick<DiffOutput, 'changedRegions' | 'dimensionMismatch'>,
  p: Phases,
): Promise<StructuralVerdict | undefined> {
  if (!snapshot.structure) return undefined;
  let cause: Awaited<ReturnType<CauseIndex['causeFor']>> | undefined;
  if (opts.cause) {
    try {
      cause = await p.time('cause', () => opts.cause!.causeFor(story.componentPath));
    } catch {
      cause = undefined;
    }
  }
  try {
    return structuralDiff({
      baseline: await readBaselineStructure(opts.store, story.storyId),
      current: snapshot.structure,
      imagesIdentical: false,
      pixels,
      escalate: { command: `jux handoff ${story.storyId}` },
      ...(cause ? { cause } : {}),
    });
  } catch {
    return undefined;
  }
}
```

Also in `runCapture`, the capture phase must not count the cause reads (they happen inside the loop, like the diff): change the `p.add('capture', …)` line to

```ts
// Diffing and cause tracing happen inside the loop; subtract both to
// leave capture alone.
p.add(
  'capture',
  Date.now() - captureStarted - (p.timings.diff ?? 0) - (p.timings.cause ?? 0),
);
```

In `packages/core/src/agent/handoff.ts`, add `Cause` to the type import. The cause does not depend on structure, so it is printed before the structure/missing-structure branch: directly after the `const missing = …` declaration and before `if (v && missing) {`, insert

```ts
const why = v?.cause && describeCause(v.cause);
if (why) lines.push('## Why', '', why, '');
```

Add after `describeRegion`:

```ts
/** The one wording of a cause, shared by the handoff and the CLI's review
 *  list. One sentence; undefined when there is nothing honest to say. */
export function describeCause(c: Cause): string | undefined {
  const away = (d: number) =>
    d === 0 ? 'the story file itself' : `${d} import${d === 1 ? '' : 's'} away`;
  switch (c.kind) {
    case 'in-closure':
      return `Changed files this story imports, nearest first: ${c.files
        .map((f) => `\`${f.path}\` (${away(f.distance)})`)
        .join(', ')}.`;
    case 'config':
      return `A change that reaches every story: ${c.files.map((f) => `\`${f.path}\``).join(', ')}. Expect other stories to fail the same way; the run's \`groups\` lists which.`;
    case 'none-in-closure':
      return "None of the files changed since the baseline is in this story's import closure. The cause is outside your diff: a dependency, an asset, the environment, or render drift.";
    case 'unknown':
      return undefined;
  }
}
```

Export it from `packages/core/src/index.ts`: change the handoff line to `export { buildHandoffPrompt, describeCause, type HandoffPayload } from './agent/handoff.js';`.

Run: `pnpm vitest run packages/core && pnpm typecheck`
Expected: PASS.

- [ ] **Step 12: Wire `--since` in the CLI and lead the review list with the cause**

In `packages/cli/src/commands/run.ts`:

Add `describeCause,`, `prepareCause,` and `type DiffResult,` to the `@juxtapose/core` import. After the `log(…stories to capture…)` call and before `if (selection.stories.length === 0)`, add:

```ts
// Only with --since is there a changed-file set to trace. Lazy: the index
// reads git and the manifest on the first failing story, never on a green run.
const cause = flags.since
  ? prepareCause({
      projectRoot: ctx.projectRoot,
      buildDir: ctx.buildDir,
      sinceCommit: flags.since,
      configDirs: [...ctx.platform.configDirs],
    })
  : undefined;
```

Pass it to `runCapture`: after `phases: p,` add `...(cause ? { cause } : {}),`.

In `emit`, replace the `for (const r of needsReview.slice(0, 20))` loop body with:

```ts
for (const r of needsReview.slice(0, 20)) {
  const detail =
    r.status === 'fail' && r.mismatchPercent > 0
      ? ` ${formatPercent(r.mismatchPercent)}`
      : r.error
        ? ` ${r.error}`
        : '';
  process.stdout.write(`  ${r.status.padEnd(6)} ${r.storyId}${detail}\n`);
  for (const line of explain(r)) process.stdout.write(`         ${line}\n`);
}
```

and add after `emptyReport`:

```ts
/** What an agent reads first under a failing story: the cause (the same
 *  sentence the handoff prints), then the structural summary. One line
 *  each; the handoff has the rest. */
function explain(r: DiffResult): string[] {
  const v = r.structural;
  if (!v) return [];
  const why = v.cause && describeCause(v.cause);
  return [...(why ? [`cause: ${why}`] : []), v.summary];
}
```

Run: `pnpm build && pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 13: See it on a real workbench**

The component library is `examples/components/src/index.jsx` (the only source file there); the Storybook build script is `build` (`storybook build -o storybook-static`). All of this happens on a scratch branch so the feature branch's working tree is never swept up or reset:

```bash
pnpm --filter example-storybook build
cd examples/storybook
node ../../packages/cli/dist/index.js run --all >/dev/null; node ../../packages/cli/dist/index.js approve --all >/dev/null
git switch -c scratch/cause
# edit ONE colour in ../components/src/index.jsx (e.g. the Button background), then:
git add ../components/src/index.jsx && git commit -qm "scratch: button colour"
pnpm --filter example-storybook build
node ../../packages/cli/dist/index.js run --since HEAD~1
node ../../packages/cli/dist/index.js run --since HEAD~1 --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{for(const r of JSON.parse(s).results)console.log(r.storyId,r.status,r.structural?.cause?.kind,JSON.stringify(r.structural?.cause?.files))})"
git switch - && git branch -D scratch/cause
pnpm --filter example-storybook build
```

Expected: the button stories fail; the phase line includes `cause`; the `--json` line shows `cause.kind` of `unknown` for each (the component lives in a `src`-less chunk — refinement 9 — so the closure is not fully traced and the tool says nothing rather than "not your code"), and never `none-in-closure`. Then, still on the scratch branch before deleting it, edit `stories/Button.stories.jsx` instead, commit, rebuild, and re-run: the Button stories show `in-closure` with `stories/Button.stories.jsx` at distance 0 and the CLI prints `cause: Changed files this story imports, nearest first: \`stories/Button.stories.jsx\` (the story file itself).`under each. Paste both runs' review lists into the PR; the README's groups/cause example (Task 6) is taken from this output, not written by hand. Never`git add -A`or`reset --hard` here: the only commit touches the one file, on the scratch branch.

- [ ] **Step 14: Commit**

```bash
pnpm format
git add packages/core/src packages/cli/src scripts/capture-cause-manifest.mjs
git commit -m "feat: cause — the story's import closure intersected with the files changed since --since

Lazy and guarded: a green run reads neither git nor the manifest. Git paths
are mapped from the repository top level to the project root; a closure
that reaches a src-less chunk is unknown, never none-in-closure (pinned
over a committed copy of the real examples/storybook manifest). The verdict
gains an optional cause fitted to the 1,500-char budget; jux run and jux
handoff lead with it, in one wording.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: `RunReport.groups` — signatures shared by ≥ 2 failing stories

**Files:**

- Modify: `packages/core/src/types.ts` (`RunGroup`; `groups?` on `RunReport`)
- Create: `packages/core/src/run/groups.ts`
- Modify: `packages/core/src/run/run.ts:123-139` (compute groups; code-unit sort)
- Modify: `packages/core/src/index.ts` (exports)
- Modify: `packages/cli/src/commands/run.ts` (`emit` prints groups)
- Test: `packages/core/src/run/groups.test.ts` (new), `packages/core/src/run/run-structural.test.ts`

**Interfaces:**

- Consumes: `DiffResult.structural.signature` / `.summary`, `compareCodeUnits`.
- Produces (types.ts):

  ```ts
  export interface RunGroup {
    signature: string;
    /** The summary of the first story (code-unit order of storyIds). */
    summary: string;
    /** ≥ 2, code-unit sorted. */
    storyIds: string[];
  }
  // RunReport gains, after `summary`: groups?: RunGroup[];
  ```

- Produces (groups.ts): `export function computeGroups(results: DiffResult[]): RunGroup[]` — groups sorted by `storyIds.length` descending, then `signature` code-unit; empty when no signature is shared.

- [ ] **Step 1: Add the types**

In `packages/core/src/types.ts`, before `export interface RunReport` insert:

```ts
/** One change seen on several stories: the same signature on ≥2 failing
 *  results. Listing them is what turns 40 handoffs into one decision;
 *  approving by group is a later row. */
export interface RunGroup {
  signature: string;
  /** The first story's summary, in code-unit order of `storyIds`; labels
   *  can differ per page, the signature cannot. */
  summary: string;
  /** ≥ 2, code-unit sorted. */
  storyIds: string[];
}
```

In `RunReport`, after `summary: Record<DiffStatus, number>;` add:

```ts
  /** Present when at least one signature is shared by ≥2 failing stories. */
  groups?: RunGroup[];
```

Add `RunGroup,` to the type exports in `packages/core/src/index.ts` after `RunReport,`.

- [ ] **Step 2: Write the failing groups tests**

Create `packages/core/src/run/groups.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { structuralDiff } from '../diff/structural.js';
import type { ChangedRegion, DiffResult, StructureSnapshot } from '../types.js';
import { computeGroups } from './groups.js';

// Real verdicts from the corpus fixture, so the signatures are the ones
// production computes.
const fixture = JSON.parse(
  readFileSync(
    path.join(import.meta.dirname, '../diff/__fixtures__/structural-corpus.json'),
    'utf8',
  ),
) as {
  cases: Record<
    string,
    {
      against: string;
      structure: StructureSnapshot;
      imagesIdentical: boolean;
      pixels: {
        mismatchPixels: number;
        mismatchPercent: number;
        changedRegions: ChangedRegion[];
        dimensionMismatch: boolean;
      };
    }
  >;
};
const verdict = (name: string) =>
  structuralDiff({
    baseline: fixture.cases[fixture.cases[name].against].structure,
    current: fixture.cases[name].structure,
    imagesIdentical: fixture.cases[name].imagesIdentical,
    pixels: fixture.cases[name].pixels,
    escalate: { command: `jux handoff ${name}` },
  });
const fail = (storyId: string, op: string): DiffResult => ({
  storyId,
  status: 'fail',
  mismatchPixels: 1,
  mismatchPercent: 0.1,
  changedRegions: [],
  durationMs: 1,
  structural: verdict(op),
});

test('two stories with the same change share a group; a lone change does not', () => {
  const groups = computeGroups([
    fail('b--one', 'color'),
    fail('a--two', 'color'),
    fail('c--three', 'padding'),
  ]);
  expect(groups).toEqual([
    {
      signature: verdict('color').signature,
      summary: verdict('color').summary,
      storyIds: ['a--two', 'b--one'],
    },
  ]);
});

test('only failing results with a verdict count', () => {
  const pass: DiffResult = { ...fail('p', 'color'), status: 'pass' };
  const noVerdict: DiffResult = { ...fail('n', 'color'), structural: undefined };
  expect(computeGroups([pass, noVerdict, fail('x', 'color')])).toEqual([]);
});

test('groups sort by size, then signature, with ids in code-unit order', () => {
  const groups = computeGroups([
    fail('Z', 'padding'),
    fail('a', 'padding'),
    fail('b', 'padding'),
    fail('y', 'color'),
    fail('x', 'color'),
  ]);
  expect(groups.map((g) => g.storyIds)).toEqual([
    ['Z', 'a', 'b'], // 'Z' < 'a' by code unit
    ['x', 'y'],
  ]);
  const flipped = computeGroups([
    fail('x', 'color'),
    fail('y', 'color'),
    fail('b', 'padding'),
    fail('a', 'padding'),
    fail('Z', 'padding'),
  ]);
  expect(JSON.stringify(flipped)).toBe(JSON.stringify(groups));
});

// Review Focus 3. One verdict reused for every result: building 5,000 real
// verdicts is ~300 ms of structuralDiff that has nothing to do with grouping.
test('5,000 failing stories with one signature are one group, under 50 ms', () => {
  const v = verdict('color');
  const one = fail('story', 'color');
  const results = Array.from({ length: 5000 }, (_, k) => ({
    ...one,
    storyId: `story-${k}`,
    structural: v,
  }));
  const groups = computeGroups(results);
  expect(groups).toHaveLength(1);
  expect(groups[0].storyIds).toHaveLength(5000);
  // Timing: one warm-up, then best of 3, so a cold run on a contended CI
  // runner does not flake it. Measured 1.2 ms in pre-flight.
  computeGroups(results);
  let ms = Infinity;
  for (let k = 0; k < 3; k++) {
    const t = performance.now();
    computeGroups(results);
    ms = Math.min(ms, performance.now() - t);
  }
  console.log(`computeGroups 5000 results: ${ms.toFixed(1)} ms (best of 3)`);
  expect(ms).toBeLessThan(50);
});

test('500 distinct shared signatures are 500 groups, each small', () => {
  const v = verdict('color');
  const results: DiffResult[] = [];
  for (let s = 0; s < 500; s++) {
    for (const k of [0, 1])
      results.push({
        ...fail(`s${s}-${k}`, 'color'),
        structural: { ...v, signature: `sig-${s}` },
      });
  }
  const groups = computeGroups(results);
  expect(groups).toHaveLength(500);
  expect(JSON.stringify(groups[0]).length).toBeLessThan(600);
});
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm vitest run packages/core/src/run/groups.test.ts`
Expected: FAIL — cannot find module `./groups.js`.

- [ ] **Step 4: Implement `groups.ts`**

Create `packages/core/src/run/groups.ts`:

```ts
// Which failing stories changed the same way. The verdict's signature
// already abstracts the element to role|tag and keeps the values, so "every
// button background #2563eb→#1d4ed8" hashes alike on every page that made
// that change; grouping is a bucket sort on it. Cold path: runs once per
// report, after every story is judged.

import { compareCodeUnits } from '../diff/structural/deltas.js';
import type { DiffResult, RunGroup } from '../types.js';

export function computeGroups(results: DiffResult[]): RunGroup[] {
  const bySignature = new Map<
    string,
    { ids: string[]; summaries: Map<string, string> }
  >();
  for (const r of results) {
    if (r.status !== 'fail' || !r.structural) continue;
    const { signature, summary } = r.structural;
    let g = bySignature.get(signature);
    if (!g) bySignature.set(signature, (g = { ids: [], summaries: new Map() }));
    g.ids.push(r.storyId);
    g.summaries.set(r.storyId, summary);
  }
  // Collected through a Map, emitted through a sort: insertion order never
  // reaches the report.
  const groups: RunGroup[] = [];
  for (const [signature, g] of bySignature) {
    if (g.ids.length < 2) continue;
    const storyIds = [...g.ids].sort(compareCodeUnits);
    groups.push({ signature, summary: g.summaries.get(storyIds[0])!, storyIds });
  }
  return groups.sort(
    (x, y) =>
      y.storyIds.length - x.storyIds.length || compareCodeUnits(x.signature, y.signature),
  );
}
```

Export from `packages/core/src/index.ts` after the `runCapture` block: `export { computeGroups } from './run/groups.js';`.

Run: `pnpm vitest run packages/core/src/run/groups.test.ts`
Expected: PASS, printing the 5,000-result timing.

- [ ] **Step 5: Write the failing run test**

Append to `packages/core/src/run/run-structural.test.ts`:

```ts
test('two failing stories with the same change are one group on the report', async () => {
  const s = store('ok');
  // The store's manifest only knows 's'; a second id with the same baseline
  // row is enough, since the stub pool yields the same current capture.
  const manifest = await s.readManifest();
  s.readManifest = async () => ({
    ...manifest,
    baselines: { ...manifest.baselines, s2: manifest.baselines.s },
  });
  const r = await runCapture({
    browser: {} as Browser,
    platform: { name: 'x' } as never,
    store: s,
    baseUrl: 'about:blank',
    stories: ['s2', 's'].map((storyId) => ({
      storyId,
      title: 't',
      name: 'n',
      componentPath: '',
      params: {},
    })),
    totalCount: 2,
    runId: 'r',
    branch: 'b',
    commitSha: 'c',
  });
  expect(r.results.map((x) => x.storyId)).toEqual(['s', 's2']);
  expect(r.groups).toEqual([
    {
      signature: r.results[0].structural!.signature,
      summary: r.results[0].structural!.summary,
      storyIds: ['s', 's2'],
    },
  ]);
});

test('a run with no shared signature has no groups key', async () => {
  const r = await run(store('ok'));
  expect('groups' in r).toBe(false);
});
```

- [ ] **Step 6: Run to verify failure**

Run: `pnpm vitest run packages/core/src/run/run-structural.test.ts`
Expected: the first new test FAILS (`groups` undefined).

- [ ] **Step 7: Compute groups in `runCapture`**

In `packages/core/src/run/run.ts`, add `import { computeGroups } from './groups.js';` and `import { compareCodeUnits } from '../diff/structural/deltas.js';`. Replace the return block of `runCapture` (lines 123–139) with:

```ts
const summary = tally(results);
// Code-unit order: the report is byte-stable across machines, and
// localeCompare is not.
results.sort((a, b) => compareCodeUnits(a.storyId, b.storyId));
const groups = computeGroups(results);

return {
  runId: opts.runId,
  branch: opts.branch,
  commitSha: opts.commitSha,
  // Carried on the report because `approve` has no browser of its own — it
  // reads captured images off disk, so this is the only path by which the
  // fingerprint reaches a baseline entry.
  env: captureEnv(opts.browser),
  capturedCount: opts.stories.length,
  totalCount: opts.totalCount,
  results,
  summary,
  ...(groups.length > 0 ? { groups } : {}),
  durationMs: Date.now() - started,
  startedAt: startedAt.toISOString(),
};
```

Run: `pnpm vitest run packages/core && pnpm typecheck`
Expected: PASS (any test that asserted the old `localeCompare` order on mixed-case ids would fail here — there is none on main; if one appears, it is pinning the wrong thing).

- [ ] **Step 8: Print groups in `jux run`**

In `packages/cli/src/commands/run.ts` `emit`, after the `if (needsReview.length > 20)` block and before the `report:` line, add:

```ts
// Bounded like the review list: 500 groups would be 1,000 lines. The
// report has them all.
if (report.groups?.length) {
  const n = report.groups.length;
  process.stdout.write(
    `\n  ${n} change${n === 1 ? '' : 's'} shared by several stories:\n`,
  );
  for (const g of report.groups.slice(0, MAX_GROUPS_SHOWN)) {
    const ids = g.storyIds.slice(0, 5).join(', ');
    const more = g.storyIds.length > 5 ? `, …${g.storyIds.length - 5} more` : '';
    process.stdout.write(
      `  ${g.storyIds.length} stories: ${g.summary}\n    ${ids}${more}\n`,
    );
  }
  if (n > MAX_GROUPS_SHOWN)
    process.stdout.write(`  …and ${n - MAX_GROUPS_SHOWN} more (see report.json)\n`);
}
```

with `const MAX_GROUPS_SHOWN = 10;` at module level in `packages/cli/src/commands/run.ts`, directly after the imports.

Run: `pnpm build && pnpm typecheck && pnpm lint`
Expected: PASS. Then on the example workbench (the scratch-branch edit of `stories/Button.stories.jsx` from Task 2 Step 13 only changes one story; to see a group, edit the shared component `examples/components/src/index.jsx` on the scratch branch instead, rebuild, `jux run --all`): the output prints `1 change shared by several stories:` with the Button stories listed, and `report.json` has `groups`. Paste it into the PR; Task 6's README example is this output.

- [ ] **Step 9: Commit**

```bash
pnpm format
git add packages/core/src packages/cli/src
git commit -m "feat: RunReport.groups — signatures shared by two or more failing stories

Results are now sorted by code unit, not localeCompare, so the report is
byte-stable across machines.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: `renderCrops` — side-by-side strips per region, sharp only

**Files:**

- Create: `packages/core/src/diff/crops.ts`
- Modify: `packages/core/src/index.ts` (export)
- Test: `packages/core/src/diff/crops.test.ts`

**Interfaces:**

- Consumes: `sharp` (already a core dependency), `ChangedRegion`.
- Produces:

  ```ts
  export const MAX_CROPS = 8;
  export const MAX_CROP_SIDE = 512;
  export interface Crop {
    region: ChangedRegion; // what the crop is about, page px
    box: ChangedRegion; // what was cropped: 2× the region about its centre, clamped
    scale: number; // output px per page px
    width: number; // whole strip: left + gutter + right
    height: number;
    png: Buffer;
  }
  export async function renderCrops(
    a: Buffer,
    b: Buffer,
    regions: ChangedRegion[],
  ): Promise<Crop[]>; // at most MAX_CROPS, in the order given
  export function cropBox(
    r: ChangedRegion,
    frame: { width: number; height: number },
  ): ChangedRegion;
  export function scaleFor(box: ChangedRegion): number;
  ```

- [ ] **Step 1: Write the failing crops tests**

Create `packages/core/src/diff/crops.test.ts`:

```ts
import sharp from 'sharp';
import { expect, test } from 'vitest';
import { MAX_CROPS, MAX_CROP_SIDE, cropBox, renderCrops, scaleFor } from './crops.js';

// The images are made with sharp itself: crops do not interpret page
// content, so a solid frame with one painted rectangle exercises the real
// library end to end without a committed binary.
const rgba = (r: number, g: number, b: number) => ({ r, g, b, alpha: 1 });
async function frame(
  width: number,
  height: number,
  rect?: { x: number; y: number; w: number; h: number },
): Promise<Buffer> {
  let img = sharp({
    create: { width, height, channels: 4, background: rgba(255, 255, 255) },
  });
  if (rect) {
    const red = await sharp({
      create: {
        width: rect.w,
        height: rect.h,
        channels: 4,
        background: rgba(220, 38, 38),
      },
    })
      .png()
      .toBuffer();
    img = img.composite([{ input: red, left: rect.x, top: rect.y }]);
  }
  return img.webp({ lossless: true }).toBuffer();
}
const pixel = async (png: Buffer, x: number, y: number) => {
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  const i = (y * info.width + x) * info.channels;
  return [data[i], data[i + 1], data[i + 2]];
};

test('one region → one strip: 2× box, integer upscale, left baseline, right current', async () => {
  const a = await frame(200, 100);
  const b = await frame(200, 100, { x: 50, y: 20, w: 40, h: 10 });
  const [c] = await renderCrops(a, b, [{ x: 50, y: 20, width: 40, height: 10 }]);
  expect(c.box).toEqual({ x: 30, y: 15, width: 80, height: 20 });
  expect(c.scale).toBe(6); // floor(512 / 80)
  expect(c.width).toBe(80 * 6 * 2 + 4);
  expect(c.height).toBe(20 * 6);
  const meta = await sharp(c.png).metadata();
  expect([meta.width, meta.height, meta.format]).toEqual([c.width, c.height, 'png']);
  // centre of the region, on each side: white on the left, red on the right
  const cx = (50 + 20 - 30) * 6;
  const cy = (20 + 5 - 15) * 6;
  expect(await pixel(c.png, cx, cy)).toEqual([255, 255, 255]);
  expect(await pixel(c.png, 80 * 6 + 4 + cx, cy)).toEqual([220, 38, 38]);
  // nearest-neighbour: the red edge is a hard step, not a blend
  expect(await pixel(c.png, 80 * 6 + 4 + 20 * 6 - 1, cy)).toEqual([255, 255, 255]);
  expect(await pixel(c.png, 80 * 6 + 4 + 20 * 6, cy)).toEqual([220, 38, 38]);
});

test('a region at the edge is clamped to the frame', () => {
  // doubled about the centre: (5, 5) ± 10 → starts at −5, clamped to 0, 20 wide
  expect(
    cropBox({ x: 0, y: 0, width: 10, height: 10 }, { width: 200, height: 100 }),
  ).toEqual({
    x: 0,
    y: 0,
    width: 20,
    height: 20,
  });
  // (195, 97.5) ± (10, 8): x 185..205 → 185..200; y 89.5 → 89 .. 105 → 100
  expect(
    cropBox({ x: 190, y: 95, width: 10, height: 5 }, { width: 200, height: 100 }),
  ).toEqual({ x: 185, y: 89, width: 15, height: 11 });
});

test('a tiny region gets at least a 16px box', () => {
  const box = cropBox(
    { x: 100, y: 50, width: 2, height: 1 },
    { width: 200, height: 100 },
  );
  expect(box.width).toBeGreaterThanOrEqual(16);
  expect(box.height).toBeGreaterThanOrEqual(16);
});

test('a box longer than 512px is scaled down so the longer side is 512', async () => {
  expect(scaleFor({ x: 0, y: 0, width: 1280, height: 800 })).toBeCloseTo(0.4);
  const a = await frame(1280, 800);
  const b = await frame(1280, 800, { x: 0, y: 0, w: 640, h: 400 });
  const [c] = await renderCrops(a, b, [{ x: 0, y: 0, width: 1280, height: 800 }]);
  const side = (c.width - 4) / 2;
  expect(Math.max(side, c.height)).toBeLessThanOrEqual(MAX_CROP_SIDE);
});

test('no regions → one strip of the whole frame', async () => {
  const a = await frame(200, 100);
  const crops = await renderCrops(a, a, []);
  expect(crops).toHaveLength(1);
  expect(crops[0].box).toEqual({ x: 0, y: 0, width: 200, height: 100 });
  expect(crops[0].region).toEqual({ x: 0, y: 0, width: 200, height: 100 });
});

test('at most MAX_CROPS strips, in the order given', async () => {
  const a = await frame(400, 400);
  const regions = Array.from({ length: 50 }, (_, k) => ({
    x: (k % 10) * 40,
    y: Math.floor(k / 10) * 40,
    width: 10,
    height: 10,
  }));
  const crops = await renderCrops(a, a, regions);
  expect(crops).toHaveLength(MAX_CROPS);
  expect(crops.map((c) => c.region)).toEqual(regions.slice(0, MAX_CROPS));
});

// Review Focus 2
test('images of different sizes crop the overlap and never throw', async () => {
  const a = await frame(200, 100);
  const b = await frame(390, 844, { x: 10, y: 10, w: 20, h: 20 });
  const crops = await renderCrops(a, b, []);
  expect(crops).toHaveLength(1);
  expect(crops[0].box).toEqual({ x: 0, y: 0, width: 200, height: 100 });
  // a region entirely outside the overlap is skipped, not an error
  const outside = await renderCrops(a, b, [{ x: 300, y: 500, width: 10, height: 10 }]);
  expect(outside).toEqual([]);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run packages/core/src/diff/crops.test.ts`
Expected: FAIL — cannot find module `./crops.js`.

- [ ] **Step 3: Implement `crops.ts`**

Create `packages/core/src/diff/crops.ts`:

```ts
// Tier-3: the pixels, but only where they changed and only as much as an
// agent needs. One PNG per changed region — baseline | current, side by
// side — with the region's bounding box doubled about its centre for
// context and scaled so the longer side is at most 512px. Nearest-neighbour
// when scaling up, so a 1px border reads as a hard 6px step and not a blur.
// No browser; sharp only, which `diffImages` already loads.

import sharp from 'sharp';
import type { ChangedRegion } from '../types.js';

export const MAX_CROPS = 8;
export const MAX_CROP_SIDE = 512;
const GUTTER = 4;
/** A 1×1 region still needs enough around it to recognise. */
const MIN_BOX = 16;
/** The gutter colour: magenta is in no UI palette, so it never reads as content. */
const GUTTER_RGBA = { r: 255, g: 0, b: 255, alpha: 1 };

export interface Crop {
  /** The changed region this strip shows, page px. */
  region: ChangedRegion;
  /** What was cropped: the region doubled about its centre, clamped to both frames. */
  box: ChangedRegion;
  /** Output px per page px: an integer above 1 when enlarged, under 1 when reduced. */
  scale: number;
  /** The whole strip: left side, gutter, right side. */
  width: number;
  height: number;
  png: Buffer;
}

export async function renderCrops(
  a: Buffer,
  b: Buffer,
  regions: ChangedRegion[],
): Promise<Crop[]> {
  const [ma, mb] = await Promise.all([sharp(a).metadata(), sharp(b).metadata()]);
  // Only the overlap exists on both sides; after a size change that is the
  // smaller frame's extent.
  const frame = {
    width: Math.min(ma.width ?? 0, mb.width ?? 0),
    height: Math.min(ma.height ?? 0, mb.height ?? 0),
  };
  // Nothing marked (sub-threshold, or a size change): the whole frame is
  // the one thing worth looking at.
  const wanted = regions.length > 0 ? regions : [{ x: 0, y: 0, ...frame }];
  const out: Crop[] = [];
  for (const region of wanted.slice(0, MAX_CROPS)) {
    const box = cropBox(region, frame);
    if (box.width === 0 || box.height === 0) continue;
    const scale = scaleFor(box);
    const sw = Math.max(1, Math.round(box.width * scale));
    const sh = Math.max(1, Math.round(box.height * scale));
    const side = (img: Buffer) =>
      sharp(img)
        .extract({ left: box.x, top: box.y, width: box.width, height: box.height })
        .resize(sw, sh, { kernel: scale >= 1 ? 'nearest' : 'lanczos3', fit: 'fill' })
        .ensureAlpha()
        .png()
        .toBuffer();
    const [left, right] = await Promise.all([side(a), side(b)]);
    const width = sw * 2 + GUTTER;
    const png = await sharp({
      create: { width, height: sh, channels: 4, background: GUTTER_RGBA },
    })
      .composite([
        { input: left, left: 0, top: 0 },
        { input: right, left: sw + GUTTER, top: 0 },
      ])
      .png()
      .toBuffer();
    out.push({ region, box, scale, width, height: sh, png });
  }
  return out;
}

/** The region doubled about its centre, at least MIN_BOX a side, clamped to
 *  the frame, integer px. A zero-size box means the region lies outside the
 *  frame. */
export function cropBox(
  r: ChangedRegion,
  frame: { width: number; height: number },
): ChangedRegion {
  const w = Math.max(MIN_BOX, r.width * 2);
  const h = Math.max(MIN_BOX, r.height * 2);
  const x0 = Math.min(frame.width, Math.max(0, Math.floor(r.x + r.width / 2 - w / 2)));
  const y0 = Math.min(frame.height, Math.max(0, Math.floor(r.y + r.height / 2 - h / 2)));
  const x1 = Math.min(frame.width, Math.ceil(x0 + w));
  const y1 = Math.min(frame.height, Math.ceil(y0 + h));
  return { x: x0, y: y0, width: Math.max(0, x1 - x0), height: Math.max(0, y1 - y0) };
}

/** An integer enlargement that keeps the longer side within MAX_CROP_SIDE,
 *  or a fractional reduction once the box itself is past it. */
export function scaleFor(box: ChangedRegion): number {
  const longer = Math.max(box.width, box.height);
  return longer <= MAX_CROP_SIDE
    ? Math.max(1, Math.floor(MAX_CROP_SIDE / longer))
    : MAX_CROP_SIDE / longer;
}
```

Export from `packages/core/src/index.ts`, after the `compareSnaps` line:

```ts
// Tier-3 crops: two images + regions → side-by-side PNG strips, no browser.
export { renderCrops, MAX_CROPS, MAX_CROP_SIDE, type Crop } from './diff/crops.js';
```

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run packages/core/src/diff/crops.test.ts && pnpm typecheck`
Expected: PASS. If the "edge is a hard step" assertion fails by one pixel, the `resize` kernel is being applied with a centre offset; switch to `.resize({ width: sw, height: sh, kernel: 'nearest', fit: 'fill' })` and re-check — do not loosen the assertion, since a blurred edge is what nearest-neighbour exists to prevent.

- [ ] **Step 5: Commit**

```bash
pnpm format
git add packages/core/src/diff/crops.ts packages/core/src/diff/crops.test.ts packages/core/src/index.ts
git commit -m "feat(core): renderCrops — side-by-side strips per changed region, sharp only

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: `jux diff --crops` for real; `jux handoff` ends with the crops command

**Files:**

- Modify: `packages/cli/src/commands/diff.ts` (replace the stand-in at lines 93–114; `writeCrops`)
- Modify: `packages/core/src/diff/structural.ts` (`structuralDiffWithCoverage`)
- Modify: `packages/core/src/diff/compare.ts` (`unexplainedRegions` on the comparison)
- Modify: `packages/cli/src/index.ts:22,52-65` (usage text)
- Modify: `packages/core/src/types.ts` (`BaselineStore.locate?`)
- Modify: `packages/core/src/baseline/git-store.ts` (`locate`)
- Modify: `packages/core/src/agent/handoff.ts` (`cropsCommand`; the footer)
- Modify: `packages/cli/src/commands/handoff.ts` (build `cropsCommand`; fix `images.baseline`)
- Modify: `scripts/check-diff.mjs:133-142` (crops checks)
- Test: `packages/core/src/agent/handoff.test.ts`, `packages/core/src/baseline/git-store.test.ts` (`locate`), `packages/core/src/diff/structural.test.ts` (`structuralDiffWithCoverage`), `scripts/check-diff.mjs`

**Interfaces:**

- Consumes: `renderCrops`, `Crop` (Task 4); `compareSnaps` → `{ pixels, verdict, unexplainedRegions }` (the last added here: every unexplained region from coverage, not the verdict's budget-fitted prefix); `snapName`, `snapsDir`, `shellQuote`, `EXIT`.
- Produces (structural.ts): `export function structuralDiffWithCoverage(input: StructuralDiffInput): { verdict: StructuralVerdict; unexplainedRegions: ChangedRegion[] }`; `structuralDiff(input)` returns `.verdict` of it (unchanged signature).
- Produces (compare.ts): `SnapComparison.unexplainedRegions: ChangedRegion[]`.
- Produces (diff.ts): the `--crops` payload

  ```ts
  interface CropsOutput {
    schema: 'juxtapose.crops/v1';
    verdict: StructuralVerdict;
    /** Forward-slash, relative to the project root; null when identical. */
    dir: string | null;
    crops: Array<{
      file: string; // `${dir}/crop-N.png`
      region: ChangedRegion;
      box: ChangedRegion;
      scale: number;
      width: number;
      height: number;
      /** False for a region no delta explains (full coverage result). */
      explained: boolean;
    }>;
  }
  ```

  Files land in `<project>/.juxtapose/crops/<a>-vs-<b>/crop-N.png`; the pair dir is emptied first, and `.juxtapose/crops/.gitignore` (`*`) is written so crops self-ignore like snaps. Unexplained regions come first.

- Produces (types.ts): `BaselineStore.locate?(storyId: string): string | undefined` — the baseline image's path on disk, for stores that keep one.
- Produces (handoff.ts): `HandoffPayload.cropsCommand?: string`.

- [ ] **Step 1: Write the failing handoff tests**

In `packages/core/src/agent/handoff.test.ts`, replace the `leads with structured data, not images` test's second assertion and add a footer test:

```ts
it('leads with structured data, not images', () => {
  const out = buildHandoffPrompt(base);
  // The whole efficiency argument: data first, images as a fallback.
  expect(out.indexOf('What changed')).toBeLessThan(out.indexOf('If still unsure'));
  expect(out).toContain('## If still unsure');
});

it('ends with the crops command before the image paths', () => {
  const out = buildHandoffPrompt({
    ...base,
    cropsCommand: "jux diff '/repo/.juxtapose/baselines/b.webp' /repo/c.webp --crops",
  });
  const footer = out.slice(out.indexOf('## If still unsure'));
  expect(footer).toContain(
    "`jux diff '/repo/.juxtapose/baselines/b.webp' /repo/c.webp --crops`",
  );
  expect(footer.indexOf('--crops')).toBeLessThan(footer.indexOf('b.webp`\n'));
  expect(footer.indexOf('--crops')).toBeLessThan(footer.indexOf('- baseline:'));
  // without a command, the images alone are listed under the same heading
  const bare = buildHandoffPrompt(base);
  expect(bare).toContain('## If still unsure');
  expect(bare).not.toContain('--crops');
});
```

The existing assertions on the old heading change to the new one: `handoff.test.ts:26` (`indexOf('Images')`) and `:27` (`'inspect only if the data above is insufficient'`) are the two replaced above; `:151` (`'## Images'`) becomes `'## If still unsure'`.

Append to `packages/core/src/baseline/git-store.test.ts`:

```ts
test('locate names the baseline image path, present or not', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'jux-store-'));
  const store = new GitBaselineStore({ projectRoot: root });
  const where = store.locate('Components/Button--primary');
  // Encoded like every other key the store writes, under the default dir.
  expect(where).toBe(
    path.join(root, '.juxtapose/baselines', 'Components%2FButton--primary.webp'),
  );
  await store.put('Components/Button--primary', Buffer.from('img'), meta);
  expect(await readFile(where)).toEqual(Buffer.from('img'));
  const custom = new GitBaselineStore({ projectRoot: root, dir: 'shots' });
  expect(custom.locate('x')).toBe(path.join(root, 'shots', 'x.webp'));
});
```

If `encodeStoryId('Components/Button--primary')` is not `Components%2FButton--primary`, use whatever `encodeStoryId` returns (import it from `./git-store.js`) rather than guessing: `expect(where).toBe(path.join(root, '.juxtapose/baselines', \`${encodeStoryId('Components/Button--primary')}.webp\`))`.

Append to `packages/core/src/diff/structural.test.ts` (refinement 10):

```ts
test('structuralDiffWithCoverage returns every unexplained region, even the ones the budget drops from the verdict', () => {
  const a = fixture.cases.noop.structure;
  const b = structuredClone(a);
  // 30 deltas fill the budget …
  for (const e of b.elements) {
    e.styles = {
      ...e.styles,
      opacity: '0.5',
      transform: 'matrix(1, 0, 0, 1, 1, 0)',
      'box-shadow': 'rgb(0, 0, 0) 0px 1px 2px 0px',
    };
  }
  // … and 40 regions off every element (the page ends at y≈382) are all unexplained.
  const regions = Array.from({ length: 40 }, (_, k) => ({
    x: 16 + k * 10,
    y: 440,
    width: 8,
    height: 8,
  }));
  const input: StructuralDiffInput = {
    baseline: a,
    current: b,
    imagesIdentical: false,
    pixels: { changedRegions: regions, dimensionMismatch: false },
    escalate: ESC,
  };
  const { verdict, unexplainedRegions } = structuralDiffWithCoverage(input);
  expect(unexplainedRegions).toEqual(regions);
  expect(verdict.unexplainedRegions.length).toBeLessThan(regions.length);
  expect(JSON.stringify(verdict).length).toBeLessThanOrEqual(MAX_VERDICT);
  // the plain call is the same verdict
  expect(structuralDiff(input)).toEqual(verdict);
});
```

(add `structuralDiffWithCoverage` to the import from `./structural.js`).

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run packages/core/src/agent packages/core/src/baseline packages/core/src/diff/structural.test.ts`
Expected: FAIL — `## If still unsure` absent; `store.locate is not a function`; `structuralDiffWithCoverage` is not exported.

- [ ] **Step 3: The footer and `locate`**

In `packages/core/src/agent/handoff.ts`, add to `HandoffPayload` after `structural?`:

```ts
  /** `jux diff <baseline.webp> <current.webp> --crops`, when both files exist. */
  cropsCommand?: string;
```

Replace the images block (lines 164–171) with:

```ts
if (p.cropsCommand || p.images.baseline || p.images.current || p.images.diff) {
  lines.push('', '## If still unsure', '');
  if (p.cropsCommand) {
    lines.push(
      `Side-by-side crops of each changed region, unexplained first — run \`${p.cropsCommand}\` and open the files it lists.`,
      '',
    );
  }
  lines.push('Full images, last resort:');
  if (p.images.baseline) lines.push(`- baseline: \`${p.images.baseline}\``);
  if (p.images.current) lines.push(`- current: \`${p.images.current}\``);
  if (p.images.diff) lines.push(`- diff overlay: \`${p.images.diff}\``);
}
```

In `packages/core/src/types.ts`, add to `BaselineStore` after `getStructure?`:

```ts
  /** Optional: where the baseline image lives on disk, for stores that keep
   *  one. The handoff hands it to `jux diff … --crops`. */
  locate?(storyId: string): string | undefined;
```

In `packages/core/src/baseline/git-store.ts`, add a public method after `structurePath`:

```ts
  locate(storyId: string): string {
    return this.imagePath(storyId);
  }
```

In `packages/core/src/diff/structural.ts`, rename the existing `structuralDiff` body into `structuralDiffWithCoverage` and return the full coverage list beside the verdict — the final lines of the function become:

```ts
  const kept = fit(deltas);
  return { verdict: build(kept, fit(cov.unexplainedRegions)), unexplainedRegions: cov.unexplainedRegions };
}

/** The verdict alone; what every caller but `--crops` wants. */
export function structuralDiff(input: StructuralDiffInput): StructuralVerdict {
  return structuralDiffWithCoverage(input).verdict;
}
```

with the signature `export function structuralDiffWithCoverage(input: StructuralDiffInput): { verdict: StructuralVerdict; unexplainedRegions: ChangedRegion[] }` and a doc comment: `/** The verdict plus every unexplained region: the verdict's own list is the prefix that fits the budget, and crops must order and label from the whole. */`. Export it from `packages/core/src/index.ts` beside `structuralDiff`.

In `packages/core/src/diff/compare.ts`, use it:

```ts
export interface SnapComparison {
  pixels: DiffOutput;
  verdict: StructuralVerdict;
  /** Every region no delta explains, in diff order — not the budget-fitted
   *  prefix on the verdict. `--crops` orders and labels from this. */
  unexplainedRegions: ChangedRegion[];
}

export async function compareSnaps(
  a: SnapSide,
  b: SnapSide,
  escalate: { command: string },
): Promise<SnapComparison> {
  const pixels = await diffImages(a.image, b.image);
  const { verdict, unexplainedRegions } = structuralDiffWithCoverage({
    baseline: a.structure,
    current: b.structure,
    // Byte equality, not mismatchPixels === 0: a sub-threshold colour change
    // has no mismatching pixels but is still a different image.
    imagesIdentical: a.image.equals(b.image),
    pixels,
    escalate,
  });
  return { pixels, verdict, unexplainedRegions };
}
```

(import `structuralDiffWithCoverage` instead of `structuralDiff`, and add `ChangedRegion` to the type import).

Run: `pnpm vitest run packages/core && pnpm typecheck`
Expected: PASS.

- [ ] **Step 4: Build the crops command in `jux handoff`**

In `packages/cli/src/commands/handoff.ts`: add `import { existsSync } from 'node:fs';` and `import { shellQuote } from '../shell-quote.js';`. Replace the `images:` block of `payload` and add the command above it:

```ts
// The baseline lives in the store, not the run dir (jux run writes only
// what it captured); the old `-baseline.webp` run-dir path never existed.
const baselineImage = ctx.store.locate?.(storyId);
const currentImage = path.join(images, `${safe}-current.webp`);
const haveBoth =
  baselineImage !== undefined && existsSync(baselineImage) && existsSync(currentImage);
const cropsCommand =
  result.status === 'fail' && haveBoth
    ? `jux diff ${shellQuote(baselineImage)} ${shellQuote(currentImage)} --crops`
    : undefined;
```

and in `payload`:

```ts
    ...(cropsCommand ? { cropsCommand } : {}),
    images: {
      baseline: baselineImage && existsSync(baselineImage) ? baselineImage : undefined,
      current: currentImage,
      diff: result.status === 'fail' ? path.join(images, `${safe}-diff.webp`) : undefined,
    },
```

Run: `pnpm build && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Replace the `--crops` stand-in in `diff.ts`**

In `packages/cli/src/commands/diff.ts`:

Change the imports: drop `existsSync`; `import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';`; add `renderCrops, type ChangedRegion, type SnapComparison,` to the `@juxtapose/core` import.

Replace the whole `if (flags.crops) { … }` block in `diffCommand` (lines 93–114) with:

```ts
if (flags.crops && flags.prefix) {
  process.stderr.write(
    'jux diff: --crops takes one pair at a time. Run `jux diff --prefix <a> <b>` first, then `jux diff <a>-<slug> <b>-<slug> --crops` for the page you want to see.\n',
  );
  return EXIT.usage;
}
```

Replace `diffTwo` with:

```ts
async function diffTwo(a: string, b: string, flags: DiffFlags): Promise<number> {
  const dir = snapsDir(flags.project);
  const loaded = await loadSides(dir, a, b);
  if ('code' in loaded) {
    process.stderr.write(loaded.message);
    return loaded.code;
  }
  const [sa, sb] = loaded.sides;
  const comparison = await compareSnaps(sa, sb, {
    command: `jux diff ${shellQuote(a)} ${shellQuote(b)} --crops`,
  });
  if (flags.crops) return writeCrops(a, b, flags, [sa, sb], comparison);
  const { verdict } = comparison;
  process.stdout.write(
    flags.json ? JSON.stringify(verdict) + '\n' : formatVerdict(verdict),
  );
  return verdict.classification === 'identical' ? EXIT.clean : EXIT.review;
}

/** `crops[]` entry in `juxtapose.crops/v1`. */
interface CropFile {
  /** Forward-slash path relative to the project root, the same on every OS. */
  file: string;
  region: ChangedRegion;
  box: ChangedRegion;
  scale: number;
  width: number;
  height: number;
  /** False for a region no delta explains (from the full coverage result). */
  explained: boolean;
}

/** The tier-3 escalation: the verdict plus one strip per region, unexplained
 *  first, under .juxtapose/crops/<a>-vs-<b>/. The dir is emptied first so a
 *  stale crop from an earlier pair can never sit beside a fresh one. */
async function writeCrops(
  a: string,
  b: string,
  flags: DiffFlags,
  [sa, sb]: [SnapSide, SnapSide],
  { verdict, pixels, unexplainedRegions: allUnexplained }: SnapComparison,
): Promise<number> {
  const root = path.resolve(flags.project ?? process.cwd());
  const dirName = `${cropName(a)}-vs-${cropName(b)}`;
  const relDir = ['.juxtapose', 'crops', dirName].join('/');
  const cropsRoot = path.join(root, '.juxtapose', 'crops');
  const absDir = path.join(cropsRoot, dirName);
  await rm(absDir, { recursive: true, force: true });
  // Self-ignoring, like the snaps dir: crops are scratch, never baselines.
  await mkdir(cropsRoot, { recursive: true });
  await writeFile(path.join(cropsRoot, '.gitignore'), '*\n');
  if (verdict.classification === 'identical') {
    process.stdout.write(
      flags.json
        ? JSON.stringify({
            schema: 'juxtapose.crops/v1',
            verdict,
            dir: null,
            crops: [],
          }) + '\n'
        : `${verdict.summary}\nnothing to crop\n`,
    );
    return EXIT.clean;
  }
  // From the full coverage list, not the verdict's budget-fitted prefix: a
  // region the budget dropped from the verdict is still unexplained.
  const key = (r: ChangedRegion) => `${r.x},${r.y},${r.width},${r.height}`;
  const unexplained = new Set(allUnexplained.map(key));
  const regions = [
    ...allUnexplained,
    ...pixels.changedRegions.filter((r) => !unexplained.has(key(r))),
  ];
  const crops = await renderCrops(sa.image, sb.image, regions);
  await mkdir(absDir, { recursive: true });
  const files: CropFile[] = [];
  for (const [k, c] of crops.entries()) {
    const name = `crop-${k + 1}.png`;
    await writeFile(path.join(absDir, name), c.png);
    files.push({
      file: `${relDir}/${name}`,
      region: c.region,
      box: c.box,
      scale: c.scale,
      width: c.width,
      height: c.height,
      explained: !unexplained.has(key(c.region)),
    });
  }
  if (flags.json) {
    process.stdout.write(
      JSON.stringify({
        schema: 'juxtapose.crops/v1',
        verdict,
        dir: relDir,
        crops: files,
      }) + '\n',
    );
  } else {
    // No `next:` line: crops are the last step.
    const lines = [formatVerdict(verdict, { next: false }).trimEnd()];
    lines.push(
      '',
      regions.length === 0
        ? 'crops (baseline | current) — no region was marked, so this is the whole frame:'
        : 'crops (baseline | current), unexplained first:',
    );
    for (const f of files) {
      const r = f.region;
      const tag = f.explained ? '' : '  unexplained';
      lines.push(
        `  ${path.join(root, ...f.file.split('/'))}  (${r.width}×${r.height} at ${r.x},${r.y}, ${f.scale >= 1 ? `${f.scale}×` : `${Math.round(f.scale * 100)}%`})${tag}`,
      );
    }
    process.stdout.write(lines.join('\n') + '\n');
  }
  return EXIT.review;
}

/** A snap name, or a `.webp` path's basename, made file-safe for the crops dir. */
function cropName(ref: string): string {
  const base = ref.endsWith('.webp') ? path.basename(ref, '.webp') : ref;
  return snapName(base, base);
}
```

`formatVerdict` gains an options parameter so `writeCrops` can drop the `next:` line (there is no step after crops) while keeping the summary, deltas and flags:

```ts
export function formatVerdict(
  v: StructuralVerdict,
  opts: { next?: boolean } = {},
): string {
  const lines = [v.summary];
  if (v.deltas.length > 0) {
    lines.push('', ...describeDeltas(v.deltas, v.deltaCount));
    // The JSON is capped by the same size budget, so it cannot list the rest.
    if (v.deltaCount > v.deltas.length)
      lines.push(`  …and ${v.deltaCount - v.deltas.length} more`);
  }
  if (v.flags.length) lines.push('', `flags: ${v.flags.join(', ')}`);
  if (v.classification !== 'identical' && opts.next !== false)
    lines.push('', `next: ${v.escalate.command}  (opens the pixels)`);
  return lines.join('\n') + '\n';
}
```

In `packages/cli/src/index.ts`, replace the two `--crops` usage lines (56–57) with:

```
  --crops                        also write side-by-side strips (baseline | current) per changed
                                 region, unexplained first, to .juxtapose/crops/<a>-vs-<b>/ and list
                                 them; --json wraps the verdict as juxtapose.crops/v1. No browser.
```

Run: `pnpm build && pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 6: Pin it end to end in `check-diff.mjs`**

In `scripts/check-diff.mjs`, replace the crops check (lines 133–142) with:

```js
// --crops is the real tier-3 now: strips on disk, paths listed, exit as diff.
const { existsSync, readFileSync } = await import('node:fs');
const crops = await jux(['diff', 'before', 'after', '--crops', '--json'], {
  PLAYWRIGHT_BROWSERS_PATH: '/nonexistent',
  NODE_OPTIONS: `--import ${probe}`,
});
const vc = JSON.parse(crops.out || '{}');
const cropFile = vc.crops?.[0]?.file;
const cropAbs = cropFile && path.join(project, ...cropFile.split('/'));
check(
  crops.code === 1 &&
    vc.schema === 'juxtapose.crops/v1' &&
    vc.verdict?.classification === 'style-only' &&
    vc.dir === '.juxtapose/crops/before-vs-after' &&
    vc.crops.length >= 1 &&
    cropFile.startsWith('.juxtapose/crops/before-vs-after/crop-1.png') &&
    !cropFile.includes('\\') &&
    existsSync(cropAbs) &&
    readFileSync(cropAbs).subarray(1, 4).toString('latin1') === 'PNG' &&
    vc.crops.every((c) => c.width <= 512 * 2 + 4 && c.height <= 512) &&
    Object.keys(vc.crops[0]).join() === 'file,region,box,scale,width,height,explained',
  '--crops writes PNG strips, lists relative paths, exits 1, loads no playwright',
);
const cropsHuman = await jux(['diff', 'before', 'after', '--crops']);
check(
  /^style-only \(color\)/.test(cropsHuman.out) &&
    /crops \(baseline \| current\), unexplained first:\n {2}\S.*crop-1\.png {2}\(\d+×\d+ at \d+,\d+, \d+×\)/.test(
      cropsHuman.out,
    ) &&
    !/^next:/m.test(cropsHuman.out),
  '--crops human output: verdict, then absolute crop paths, no next:',
);
// A fresh call empties the dir: a stale crop from a bigger diff cannot linger.
writeFileSync(path.join(project, '.juxtapose/crops/before-vs-after/crop-9.png'), 'stale');
await jux(['diff', 'before', 'after', '--crops']);
check(
  !existsSync(path.join(project, '.juxtapose/crops/before-vs-after/crop-9.png')) &&
    readFileSync(path.join(project, '.juxtapose/crops/.gitignore'), 'utf8') === '*\n',
  '--crops empties the pair dir first and the crops dir self-ignores',
);
const cropsSame = await jux(['diff', 'before', 'same', '--crops', '--json']);
check(
  cropsSame.code === 0 &&
    JSON.parse(cropsSame.out).dir === null &&
    !existsSync(path.join(project, '.juxtapose/crops/before-vs-same')),
  'identical snaps: --crops exits 0 and writes nothing',
);
// Review Focus 4: a sub-threshold change marks no region; the agent still gets pixels.
await snap('background', 'bg');
const cropsSub = await jux(['diff', 'before', 'bg', '--crops', '--json']);
const vsub = JSON.parse(cropsSub.out);
check(
  cropsSub.code === 1 &&
    vsub.verdict.flags.includes('sub-threshold') &&
    vsub.crops.length === 1 &&
    vsub.crops[0].box.x === 0 &&
    vsub.crops[0].box.y === 0,
  'a sub-threshold change crops the whole frame',
);
// Review Focus 2: different sizes crop the overlap.
await jux(['snap', `${server.url}/op/noop`, '--as', 'small', '--viewport', '320x240']);
const cropsDim = await jux(['diff', 'before', 'small', '--crops', '--json']);
const vdim = JSON.parse(cropsDim.out);
check(
  cropsDim.code === 1 &&
    vdim.verdict.classification === 'dimension-change' &&
    vdim.crops.length === 1 &&
    vdim.crops[0].box.width === 320 &&
    vdim.crops[0].box.height === 240,
  'a dimension change crops the overlapping frame',
);
const cropsPrefix = await jux(['diff', '--prefix', 'p1', 'p2', '--crops']);
check(
  cropsPrefix.code === 2 && /one pair at a time/.test(cropsPrefix.err),
  '--crops with --prefix is usage (2) naming the per-page command',
);
```

Place the `--prefix` + `--crops` check after the existing `p1`/`p2` snaps (it needs them to exist only for the message; it exits before reading them, so position does not matter — keep it with the other crops checks).

Run: `pnpm build && node scripts/check-diff.mjs`
Expected: every line `ok`, including the seven new crops checks (pre-flight ran 35/35 on the scratch build); exit 0.

- [ ] **Step 7: Look at one strip**

Open `<tmp project>/.juxtapose/crops/before-vs-after/crop-1.png` from a local run (`jux snap … --as before`, edit, `--as after`, `jux diff before after --crops` in any scratch dir) with the Read tool. Expected: the Save button twice, white text on the left and yellow on the right, crisp pixels, magenta gutter. At the default 1280×800 the measured line is `(35×12 at 31,84, 7×)` (region 35×12, box 70×24, strip 984×168); record the line you got in the PR, and give that same line to Task 6's README.

- [ ] **Step 8: Commit**

```bash
pnpm format
git add packages/core/src packages/cli/src scripts/check-diff.mjs
git commit -m "feat(cli): jux diff --crops writes side-by-side strips per region; handoff ends with the crops command

The baseline image lives in the store, so BaselineStore gains locate() and
the handoff's baseline path is fixed to use it.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: The Claude Code plugin, README, help, changeset

**Files:**

- Create: `plugins/claude-code/.claude-plugin/plugin.json`
- Create: `plugins/claude-code/skills/visual-check/SKILL.md`
- Modify: `README.md` (verdict table: `cause`, `escalate.command`; crops section; groups; skill section)
- Modify: `packages/cli/src/index.ts` (run `--since` mention of cause; help example)
- Create: `.changeset/cause-groups-crops-skill.md`

**Interfaces:**

- Plugin manifest format verified 2026-10-12 against <https://code.claude.com/docs/en/plugins/manifest-reference>: manifest at `.claude-plugin/plugin.json`, `name` the only required key (kebab-case; `claude-`/`anthropic-` prefixes reserved), optional `displayName`, `version`, `description`, `author { name }`, `homepage`, `repository`, `license`, `keywords`; skills load from `skills/<name>/SKILL.md` by default with no manifest key needed; unknown top-level keys are stripped with a `claude plugin validate` warning. Skill format verified against <https://code.claude.com/docs/en/skills>: YAML frontmatter with optional `name` (defaults to the directory name), `description` (the trigger; `description` + `when_to_use` truncated at 1,536 chars), `argument-hint`, `disable-model-invocation`, `allowed-tools`; body under 500 lines. Loading verified against <https://code.claude.com/docs/en/plugins/loading>: `claude --plugin-dir <path>` loads the directory in place as `<name>@inline`, and the skill is invoked as `/<plugin-name>:<skill-name>`; `/skills` lists it.

- [ ] **Step 1: Write the manifest**

Create `plugins/claude-code/.claude-plugin/plugin.json`:

```json
{
  "name": "juxtapose",
  "displayName": "Juxtapose",
  "version": "0.1.0",
  "description": "Verify a UI edit by structure, not screenshots: jux snap before and after, jux diff for the tier-0 verdict, crops only when the verdict cannot explain the pixels.",
  "author": { "name": "Magic Factory LLC" },
  "homepage": "https://github.com/juxtapose-dev/juxtapose",
  "repository": "https://github.com/juxtapose-dev/juxtapose",
  "license": "MIT",
  "keywords": ["visual-regression", "ui", "verification", "agent"]
}
```

- [ ] **Step 2: Write the skill**

Create `plugins/claude-code/skills/visual-check/SKILL.md`:

````markdown
---
name: visual-check
description: Verify that a UI edit changed what you meant and nothing else, without reading screenshots. Use before and after any change to a page, component, stylesheet or design token that a browser renders. Snap the page with jux before editing, snap again after, read the jux diff verdict (what element, what property, old → new, and whether that explains every changed pixel), and escalate to --crops only when it does not. Not for changes that render nothing (server code, tests, docs) or pages you cannot reach (behind a login you do not have).
argument-hint: [url]
---

# Visual check: snap → edit → snap → diff

Pixels say _where_ something changed. The verdict says _what_: which element,
which property, old → new, and whether that explains every changed pixel. Read
the verdict; open an image only when the verdict tells you it cannot explain
the pixels. A full-page screenshot costs thousands of tokens and misses most
fine UI changes; the verdict is a few hundred tokens and names them.

How to run `jux`: if `@juxtapose/cli` is in the project's dependencies,
`npx jux …` works. If it is not, `npx jux` fetches an unrelated npm package
called `jux`; use `npx -p @juxtapose/cli jux …` instead (or install it:
`pnpm add -D @juxtapose/cli`). Check `package.json` once before the first
call. Every command accepts `--json`; prefer it. Exit codes: 0 identical, 1 different, 2 usage
error, 3 the tool or environment failed (no browser, unreadable input) —
never treat a 3 as "different".

## 1. Before you edit: snap the page

```bash
jux snap http://localhost:5173/settings --as before
```

Snap every page the edit could touch in one call when you suspect several
(a shared component, a token):

```bash
jux snap http://localhost:5173/ http://localhost:5173/settings --as-prefix before
```

If the dev server is not running, start it first. If `jux snap` exits 3
with "could not launch the browser", run `npx playwright install chromium`
and retry. Do not skip the before snap: there is no way to take it after the
edit.

## 2. Edit the code

## 3. After you edit: snap again, then diff

```bash
jux snap http://localhost:5173/settings --as after
jux diff before after --json
```

or, for a set: `jux snap … --as-prefix after && jux diff --prefix before after --json`.

## 4. Read the verdict, not the pixels

The JSON is `juxtapose.verdict/v1`. Check, in this order:

1. `classification` and `summary`: one line saying what kind of change it is
   and the first few deltas.
2. `deltas[]`: every typed fact (`style`, `text`, `attr`, `added`, `removed`,
   `moved`, `resized`, `shift`). Compare each against what you intended. A
   delta you did not intend is the regression; fix it before moving on. A
   `shift` ("N elements after X moved down 14px") is the layout consequence
   of the delta it names, not a separate change.
3. `explained`: `full` means the structure accounts for every changed pixel.
   `partial` or `none` means some pixels changed with no DOM or style delta
   behind them (canvas, images, rendering) — see step 5.
4. `flags[]`: `element-removed` and `text-changed` always deserve a look;
   `sub-threshold` means the pixel diff marked nothing and the deltas are the
   whole change; `below-fold` means the page is taller than the viewport and
   anything below it was not checked (snap with a taller `--viewport` if the
   edit is down there); `no-baseline-structure` / `no-current-structure`
   means one snap has no structure sidecar — re-snap.

Exit 0 with `classification: identical` means the edit changed nothing at
this viewport. That is a finding, not a pass: if you meant to change
something, you did not.

## 5. Escalate only when the verdict cannot explain the pixels

When `explained` is not `full`, or a flag surprises you, run the command in
`escalate.command`:

```bash
jux diff before after --crops
```

It writes one PNG per changed region — baseline on the left, current on the
right, unexplained regions first, enlarged, at most 512px a side — under
`.juxtapose/crops/` and prints the paths. Read those crops. Do not open the
full `.webp` snaps first; a crop is a fraction of the tokens and shows the
exact pixels in question.

## 6. Report

Say what changed in terms of the deltas (element, property, old → new),
whether it matches the intent, and what you did about any delta that did not.
Quote the verdict's `summary`. Do not paste the whole JSON.

## In a workbench project (Storybook, Ladle)

The same verdict is attached to every failing story in `jux run --json` as
`results[].structural`, with `cause` (which changed files the story imports)
when you pass `--since <commit>`, and `groups[]` when several stories share
one change. `jux handoff <storyId>` prints the story's verdict as a prompt,
ending with the `--crops` command for that story.

## When not to use this

- The change renders nothing: server code, tests, build config, docs.
- The page needs a login you do not have, or a backend that is not running.
- You are asked to judge taste, not change: the verdict reports facts; it has
  no opinion on whether blue is better than green.
````

- [ ] **Step 3: Validate the plugin and load it once**

Run: `claude plugin validate ./plugins/claude-code`
Expected: `Validation passed` (a warning about a reserved-looking name would mean `juxtapose` tripped the Anthropic-name check; it does not contain `claude` or `anthropic`, so expect none). If `claude` is not on the PATH of the implementer's shell, record that and have the controller run it; do not skip the step.

Then: `claude --plugin-dir ./plugins/claude-code` and in the session type `/skills`. Expected: `juxtapose:visual-check` is listed. Exit the session. Record both outputs in the PR.

- [ ] **Step 4: README and help**

In `README.md`:

Directly under the first code block (the `npx jux run` / `approve` / `check` lines near the top), add one line:

```markdown
`npx jux` needs `@juxtapose/cli` installed in the project (`pnpm add -D @juxtapose/cli`); without it, npm resolves `jux` to an unrelated package.
```

Under the verdict table, change the `escalate.command` row to:

```
| `escalate.command`   | the next command to run: `jux diff <a> <b> --crops` for a snap pair, `jux handoff <id>` for a story in a run. Arguments are shell-quoted when needed, and a `.webp` path argument appears verbatim, so a verdict for two absolute paths names this machine's paths |
```

Task 2 (fix round 1) already added the `cause` row and the limit paragraph below the table ("`cause` follows the Vite build manifest…"); keep both, and only reconcile wording. The wording of each kind is `describeCause` in `packages/core/src/agent/handoff.ts`: `none-in-closure` reads "No changed file appears in this story's traced imports. The cause is likely outside your diff…" (never "not your code"), and `unknown` has a handoff sentence ("Cause unknown: …") while `jux run`'s review list prints nothing for it. `config` also covers a root `tsconfig*.json`; changed files include uncommitted edits and untracked files. Any skill text describing cause must match.

After the "### Exit codes" section add:

````markdown
### Crops (`juxtapose.crops/v1`)

When `explained` is not `full`, the verdict's `escalate.command` is the
tier-3 step: `jux diff before after --crops` writes one PNG per changed
region — baseline on the left, current on the right, the region's box
doubled for context, enlarged to at most 512px a side, unexplained regions
first — under `.juxtapose/crops/before-vs-after/` and lists them. No browser.

```
style-only (color): button[name="Save"] color #ffffff→#fef08a. Structure explains the changed region.

  button[name="Save"] color #ffffff → #fef08a

crops (baseline | current), unexplained first:
  /work/app/.juxtapose/crops/before-vs-after/crop-1.png  (35×12 at 31,84, 7×)
```

The block above is the real output of `jux diff before after --crops` on the corpus `color` page at 1280×800 (pre-flight measured region 35×12 at 31,84, box 70×24, 7×, strip 984×168), with the project path shortened to `/work/app`. Regenerate it by running the command (Task 5 Step 7) and paste what it printed; do not type numbers.

With `--json` the payload wraps the verdict: `{ schema, verdict, dir, crops[] }`
where each crop is `{ file, region, box, scale, width, height, explained }`
and `file` is a forward-slash path relative to the project root. Identical
snaps write nothing and exit 0; the pair's directory is emptied on every
call. With no marked region (a sub-threshold change, a size change) the one
crop is the whole overlapping frame.

### Groups and cause (`jux run`)

`jux run --json` adds `groups[]` — `{ signature, summary, storyIds }` for
every change shared by two or more failing stories, largest first — so a
token bump that turns 40 stories red reads as one decision. The review list
prints up to 10 of them. With `--since <commit>` each failing story's verdict
also carries `cause` (see the table above), and the review list prints it
first:

```
<paste the review list and the groups block from Task 2 Step 13's second run
(the stories/Button.stories.jsx edit) and Task 3 Step 8's run here, verbatim>
```
````

The placeholder in that block is filled with real output before the commit — the example is whatever `jux run --since HEAD~1` printed on `examples/storybook` for the story-file edit (a `cause: Changed files this story imports, nearest first: \`stories/Button.stories.jsx\` (the story file itself).`line under each Button story) and whatever`jux run --all`printed for the component edit (the`1 change shared by several stories:` block). Trim nothing but the leading summary line.

Add a "## Claude Code skill" section after "## Agent loop":

````markdown
## Claude Code skill

`plugins/claude-code/` is a Claude Code plugin with one skill,
`visual-check`, that teaches the loop above: snap before editing, snap after,
read the verdict, open crops only when the verdict cannot explain the pixels,
never a full screenshot first. Load it for a session with:

```bash
claude --plugin-dir path/to/juxtapose/plugins/claude-code
```

and invoke it as `/juxtapose:visual-check`, or let Claude pick it up when you
ask it to change something that renders.
````

In `packages/cli/src/index.ts` `USAGE`, change the `--since` line to:

```
  --since <commit>               only capture stories affected since this commit; failing stories
                                 then say which changed files they import (cause)
```

- [ ] **Step 5: Changeset**

Create `.changeset/cause-groups-crops-skill.md`:

```markdown
---
'@juxtapose/core': minor
'@juxtapose/cli': minor
---

`jux run --since` says why a story changed: the verdict gains `cause`, the
story's import closure intersected with the changed files. `RunReport.groups`
lists every change shared by two or more failing stories. `jux diff --crops`
writes side-by-side strips per changed region (`juxtapose.crops/v1`), no
browser; `jux handoff` ends with that command. A child whose box only
followed its parent's move or resize is no longer a delta. A Claude Code
plugin with the `visual-check` skill lives in `plugins/claude-code/`.
```

- [ ] **Step 6: Format, lint, commit**

Run: `pnpm format && pnpm lint && pnpm typecheck`
Expected: PASS (prettier formats the plugin JSON and SKILL.md; eslint ignores `plugins/` unless its config globs it — if it complains about the Markdown code fences, add `plugins/**/*.md` to the ignore list in the eslint config rather than changing the skill).

```bash
git add plugins README.md packages/cli/src/index.ts .changeset/cause-groups-crops-skill.md
git commit -m "feat: Claude Code plugin with the visual-check skill; document cause, groups and crops

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Verification 6 (the loop, once, for real), green-path timing, CI green

**Files:**

- Create: `scripts/loop-anecdote/serve.mjs`
- Create: `scripts/loop-anecdote/measure.mjs`
- Create: `scripts/loop-anecdote/arms.mjs`
- Modify: `.gitignore` (`scripts/loop-anecdote/page.html`)

**Interfaces:**

- Consumes: `render` and `LOGO` from `scripts/structural-corpus/page.mjs`; Claude Code session transcripts at `~/.claude/projects/<cwd with every / and . → ->/<sessionId>.jsonl`, where each assistant line is `{ type: 'assistant', timestamp, message: { id, usage: { input_tokens, cache_creation_input_tokens, cache_read_input_tokens, output_tokens }, content: [{ type: 'tool_use', name, input }] } }` — one line per content block, and every line of one message repeats the same `id` and `usage` (checked on a real transcript on 2026-10-13: 7 lines for 3 ids).
- Produces: `serve.mjs` serves `page.html` live from disk on `PORT` (default 4173); `measure.mjs <transcript.jsonl> [--from <ISO>]` prints a Markdown table of token totals (summed once per `message.id`) and tool calls (from every line); `arms.mjs` exports `JUX` (`node packages/cli/dist/index.js`) and the two prompts so the PR and the script cannot drift.

- [ ] **Step 1: The server the agent edits against**

Create `scripts/loop-anecdote/serve.mjs`:

```js
// Verification 6: serves scripts/loop-anecdote/page.html — written from the
// corpus page on first run — re-read on every request, so an agent's edit
// to the file is live without a rebuild. PORT=4173 by default.
import { createServer } from 'node:http';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { LOGO, render } from '../structural-corpus/page.mjs';

const file = path.join(import.meta.dirname, 'page.html');
if (!existsSync(file)) writeFileSync(file, render({}));
const port = Number(process.env.PORT ?? 4173);
createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/logo-a.svg' || url.pathname === '/logo-b.svg') {
    res.writeHead(200, { 'content-type': 'image/svg+xml' });
    res.end(
      LOGO(url.pathname === '/logo-a.svg' ? 'rgb(37, 99, 235)' : 'rgb(220, 38, 38)'),
    );
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
  res.end(readFileSync(file));
}).listen(port, '127.0.0.1', () => {
  console.log(
    `serving ${file} at http://127.0.0.1:${port}/  (edit the file; no rebuild)`,
  );
});
```

Add `scripts/loop-anecdote/page.html` to `.gitignore` (it is scratch the agent edits).

- [ ] **Step 2: The two arms**

Create `scripts/loop-anecdote/arms.mjs`:

```js
// The task is the same in both arms; only the verification method differs.
// One anecdote, not a benchmark (that is row 4): one page, one edit, one
// session per arm, run by hand.
export const TASK =
  'In scripts/loop-anecdote/page.html, change the Save button\'s background to rgb(29, 78, 216) and its text to "Save changes". The page is served at http://127.0.0.1:4173/. Verify the change rendered as intended and report what you verified.';

// `npx jux` would fetch an unrelated npm package named `jux` (this repo does
// not link a `jux` bin); both arms run the built CLI directly.
export const JUX = 'node packages/cli/dist/index.js';

export const ARMS = {
  skill: {
    launch: 'claude --plugin-dir plugins/claude-code',
    prompt: `${TASK} Use /juxtapose:visual-check to verify; in this repository \`jux\` is \`${JUX}\` (run from the repo root).`,
  },
  screenshot: {
    launch: 'claude',
    prompt: `${TASK} Verify by taking a screenshot of the page before and after with \`${JUX} snap <url> --as <name>\` (run from the repo root) and reading the two .webp files; do not use jux diff.`,
  },
};
```

- [ ] **Step 3: The measurer**

Create `scripts/loop-anecdote/measure.mjs`:

```js
// Sums a Claude Code session transcript: tokens per assistant turn and tool
// calls by name, optionally only from a timestamp (the moment the edit was
// done and verification began). Usage:
//   node scripts/loop-anecdote/measure.mjs ~/.claude/projects/<dir>/<session>.jsonl [--from 2026-10-12T20:15:00Z]
// Transcript lines are JSON; assistant lines carry message.usage. Claude
// Code writes one line per content block, and every line of one message
// repeats the same usage and message.id (checked on a real transcript,
// 2026-10-13: 7 lines for 3 ids), so usage is summed once per id while tool
// calls are collected from every line.
import { existsSync, readFileSync } from 'node:fs';
import { ARMS } from './arms.mjs';

const [file, ...rest] = process.argv.slice(2);
if (!file || file === '--prompts') {
  for (const [name, arm] of Object.entries(ARMS))
    console.log(`## ${name}\n\n${arm.launch}\n\n${arm.prompt}\n`);
  if (!file) console.log('usage: measure.mjs <transcript.jsonl> [--from <ISO>]');
  process.exit(file ? 0 : 2);
}
if (!existsSync(file)) {
  console.error(`measure.mjs: no transcript at ${file}`);
  process.exit(1);
}
const from = rest[0] === '--from' ? Date.parse(rest[1]) : -Infinity;
const totals = { turns: 0, input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
const counted = new Set();
const tools = new Map();
const imageReads = [];
for (const line of readFileSync(file, 'utf8').split('\n')) {
  if (!line.trim()) continue;
  let o;
  try {
    o = JSON.parse(line);
  } catch {
    continue;
  }
  if (o.type !== 'assistant' || !o.message) continue;
  if (Date.parse(o.timestamp) < from) continue;
  for (const c of o.message.content ?? []) {
    if (c.type !== 'tool_use') continue;
    tools.set(c.name, (tools.get(c.name) ?? 0) + 1);
    const p = c.input?.file_path ?? '';
    if (/\.(webp|png)$/i.test(p)) imageReads.push(p);
  }
  const u = o.message.usage;
  const id = o.message.id ?? o.uuid;
  if (!u || counted.has(id)) continue;
  counted.add(id);
  totals.turns++;
  totals.input += u.input_tokens ?? 0;
  totals.cacheWrite += u.cache_creation_input_tokens ?? 0;
  totals.cacheRead += u.cache_read_input_tokens ?? 0;
  totals.output += u.output_tokens ?? 0;
}
if (totals.turns === 0) {
  console.error(
    `no assistant turns with usage found in ${file}${from > -Infinity ? ' after --from' : ''}`,
  );
  process.exit(1);
}
const context = totals.input + totals.cacheWrite + totals.cacheRead;
console.log('| measure | value |');
console.log('| --- | ---: |');
console.log(`| assistant turns | ${totals.turns} |`);
console.log(
  `| context tokens (input + cache write + cache read, summed over turns) | ${context} |`,
);
console.log(`| output tokens | ${totals.output} |`);
for (const [name, n] of [...tools].sort((a, b) => (a[0] < b[0] ? -1 : 1)))
  console.log(`| tool: ${name} | ${n} |`);
console.log(`| image files read | ${imageReads.length} |`);
for (const p of imageReads) console.log(`|   ${p} | |`);
```

Run: `node scripts/loop-anecdote/measure.mjs --prompts`
Expected: both arms' launch lines and prompts print; exit 0. Then `node scripts/loop-anecdote/measure.mjs /nonexistent` exits 1 printing only `measure.mjs: no transcript at /nonexistent` (no stack). Then run it on any real transcript under `~/.claude/projects/` and confirm `assistant turns` equals the count of distinct `message.id` values (`grep -o '"id":"msg_[^"]*"' <file> | sort -u | wc -l`), not the line count.

- [ ] **Step 4: Manual steps for the controller (record in the PR)**

These are run by the controller, not an implementer subagent, because they need an interactive Claude Code session. The implementer's job in this step is to run the smoke check at the end and leave the procedure in the PR description.

1. `pnpm build`, then in one terminal `node scripts/loop-anecdote/serve.mjs` (leave it running). Delete `scripts/loop-anecdote/page.html` between arms so both start from the same page.
2. **Arm A (skill):** from the repo root, `claude --plugin-dir plugins/claude-code`. Paste `ARMS.skill.prompt` (print it with `node scripts/loop-anecdote/measure.mjs --prompts`). Let the agent finish. Note the wall-clock time at which the edit was done (the first `Edit` of `page.html`), from the transcript. Exit.
3. Reset: `git checkout -- scripts/loop-anecdote` is not needed (the file is untracked) — delete `page.html`; restart `serve.mjs` so it is regenerated.
4. **Arm B (screenshot):** `claude` (no plugin). Paste `ARMS.screenshot.prompt`. Let the agent finish. Exit.
5. Find each session's transcript: the two newest files in `~/.claude/projects/-Users-jer-Code-juxtapose--claude-worktrees-sp0c/` (the cwd with every `/` and `.` replaced by `-`, so `.claude` becomes `-claude` and the path has a double dash) — or the matching directory for wherever the session was started. Run `node scripts/loop-anecdote/measure.mjs <A.jsonl> --from <edit timestamp>` and the same for B. The `--from` cut isolates the verification step from the shared edit step.
6. Put both tables in the PR description under the heading **"Verification 6 — one anecdote, not a benchmark (row 4 is the benchmark)"**, with: the Claude Code version (`claude --version`), the model, the date, and whether each arm's final report matched the edit (both deltas named; nothing else claimed). Publish no number outside the PR (T53 in the service repo).

Implementer smoke check: `node scripts/loop-anecdote/serve.mjs & sleep 1; curl -s http://127.0.0.1:4173/ | grep -c 'id="title"'; kill %1`. Expected: `1`.

- [ ] **Step 5: Green-path timing (Verification 5)**

Run on `examples/storybook` with baselines approved and no edits (so every story passes):

```bash
cd examples/storybook
for i in 1 2 3; do node ../../packages/cli/dist/index.js run --all | sed -n 1,3p; done
for i in 1 2 3; do node ../../packages/cli/dist/index.js run --all --since HEAD | sed -n 1,3p; done
```

(`--since HEAD` alone selects no stories — `resolveAffected` reports `no-changes` — so it would capture nothing and prove nothing; `--all --since HEAD` captures everything with a cause index armed, which is the case refinement 2 covers.) Expected: the phase line never includes `cause` (no story failed, so `causeFor` was never called), no `.vite/manifest.json` read shows up under `strace`/`fs_usage` if you look, and the timings match main's within noise (check out main in a second worktree if a number looks off; never a bare `git stash`). Record the three lines per arm in the PR.

- [ ] **Step 6: The full gate**

Run: `pnpm build && pnpm typecheck && pnpm lint && pnpm format:check && pnpm test && node scripts/check-diff.mjs && node scripts/structural-corpus.mjs && pnpm check:determinism`
Expected: all green. `structural-corpus.mjs` reports 21/21 and the budget line. Paste the budget line and the three timing lines from the performance tests into the PR.

- [ ] **Step 7: Commit and finish**

```bash
pnpm format
git add scripts/loop-anecdote .gitignore
git commit -m "chore: Verification 6 — the loop once, reproducibly: live page server, two arms, transcript measurer

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Then follow `superpowers:finishing-a-development-branch`: PR against `main` titled `SP0 (c): cause, groups, crops, child-follows-parent, Claude Code skill`, body listing the spec refinements from Global Constraints, the Verification 5 and 6 records, the corpus budget line, and the plugin validation output; trailer `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

---

## Self-review

**Spec coverage.** §4 cause → Task 2 (`cause.ts`, verdict field, run/handoff/CLI). §5 groups → Task 3 (`signature` already existed; `RunReport.groups` added, sorted, printed, capped at 10 lines). §6 `--crops` with sharp, 2× bbox, upscaled, capped 512, lists paths, no browser → Tasks 4 and 5 (`renderCrops`, `writeCrops`, probe-guarded in `check-diff.mjs`); `jux handoff` footer crops-first → Task 5; `jux run` unchanged flags → `--since` reused, nothing new. §7 skill, manifest confirmed against the docs and `claude plugin validate` (pre-flight: `✔ Validation passed`) → Task 6. Verification 5 → Task 7 Step 5 (`--all --since HEAD`) plus the lazy index test in Task 2. Verification 6 → Task 7 (script + arms + measurer + manual procedure; corpus page, refinement 8). Deferred item 1 (child follows parent) → Task 1. Deferred item 2 (crops are the escalation an agent reads) → Task 5 and the skill's step 5. Production bar: exit codes (Task 5 pins 0/1/2 for `--crops`), versioned JSON (`juxtapose.crops/v1`; verdict unchanged), errors naming the next command (`--crops --prefix`), no telemetry (nothing added).

**Pre-flight rows (2026-10-13, `.superpowers/sdd/2026-10-12-sp0c-cause-groups-crops-skill/preflight.md`), each with where it is fixed.** `summary.test.ts` `mentions()` flags → Task 1 Step 7. Test 5 "unmatched parent" asserted nothing about its title → Task 1 Step 4 (now "inserted: 8, as before", exact count). `x.el` typing on the `Delta` union → Task 1 Step 4 (type guard). Git top-level vs project-relative paths → Task 2 (`gitTopLevel`, `projectRelative`, pinned by the real-repo `prepareCause` test with the project in `app/`). Src-less chunks → `none-in-closure` → Task 2 (`ForwardGraph.unresolved`; the chunk test now asserts `unknown`; the real `examples/storybook` manifest is a committed fixture from `scripts/capture-cause-manifest.mjs`; README documents the limit). Cause time counted twice in `capture` → Task 2 Step 11 (`p.add('capture', … - cause)`). `structural.ts` importing `analysis/` → Task 2 Step 8 (`MAX_CAUSE_FILES` lives in `structural.ts`). Two cause wordings → `describeCause(c): string | undefined` is the one, used by the handoff and the CLI (Task 2 Steps 11–12). `## Why` hidden when structure is missing → Task 2 Step 11 (printed before the missing-structure branch; tested). `prepareCause` test never called `prepareCause` → Task 2 Step 3 (real git repo). Lint `no-useless-assignment` → `orNull` (Task 2 Step 5). Step 13's `git add -A`/`reset --hard` on the feature branch, wrong component path, wrong build script → Task 2 Step 13 (scratch branch, `src/index.jsx`, `build`). Unbounded groups output → Task 3 Step 8 (`MAX_GROUPS_SHOWN = 10`). Groups perf test timing fixture build, < 250 vs "< 50" → Task 3 Step 2 (best of 3 over prebuilt results, < 50 ms, printed). Unused `max` parameter → Task 4 (removed). Crops ordered/labelled from the budget-trimmed prefix → Task 5 (`structuralDiffWithCoverage`, `SnapComparison.unexplainedRegions`, test). No `locate` test → Task 5 Step 1. Crops dir not self-ignored → Task 5 Step 5 (`.juxtapose/crops/.gitignore`), pinned in `check-diff.mjs`. `6×` vs measured `7×` → Task 5 Step 7 and Task 6 README (`(35×12 at 31,84, 7×)`). Handoff test line cites → Task 5 Step 1 (26, 27, 151). `npx jux` is an unrelated package → Task 6 SKILL.md (both cases stated), README note, Task 7 arms use `node packages/cli/dist/index.js`. README examples invented → Task 6 (crops line measured; groups/cause block pasted from the Task 2/3 real runs). `measure.mjs` overcounting per line, stack on a missing file → Task 7 Step 3 (once per `message.id`, tool calls from every line, clean message). `run --since HEAD` captures nothing → Task 7 Step 5 (`--all --since HEAD`). Transcript dir name → Task 7 Step 4. Verification 6 on the corpus page not listed as a refinement → Global Constraints refinement 8.

**Placeholder scan.** No TBD/TODO; every code step carries the code; every test step carries the test. Two judgement calls left to the implementer with explicit instructions: the nearest-neighbour edge assertion (Task 4 Step 4) and the `encodeStoryId` spelling in the `locate` test (Task 5 Step 1), both with the fallback spelled out. The README's groups/cause block is deliberately a paste target for real output (Task 6 Step 4), not prose to invent.

**Type consistency.** `Cause`/`CauseKind` defined once (Task 2 Step 1) and used by `cause.ts`, `structural.ts`, `handoff.ts`, CLI `run.ts`. `MAX_CAUSE_FILES` defined once in `structural.ts` and imported by `cause.ts` and `cause.test.ts`. `CauseIndex.causeFor(componentPath): Promise<Cause>` matches the `vi.fn(async …)` stubs in `run-structural.test.ts` and `p.time`'s `() => Promise<T>`. `describeCause(c): string | undefined` matches both consumers (`why && lines.push('## Why', '', why, '')`; `` `cause: ${why}` ``). `RunGroup` fields `{ signature, summary, storyIds }` match `computeGroups`, the run test and the CLI printer. `Crop` fields `{ region, box, scale, width, height, png }` match `renderCrops` (no `max` parameter anywhere), its test and `writeCrops`'s `CropFile` mapping. `SnapComparison.unexplainedRegions` is produced by `compareSnaps` from `structuralDiffWithCoverage` and consumed by `writeCrops` as `allUnexplained`. `fixture.cases[name].against` is written by the generator (Task 1 Step 2) and read by `structural.test.ts` and `groups.test.ts`. `formatVerdict(v, { next })` is used only by `writeCrops`; `diffPrefix`'s `formatPrefixSet` keeps the default. `BaselineStore.locate?` is optional, so the test stores in `run-structural.test.ts` need no change; `GitBaselineStore.locate` is tested directly.

**Review Focus.** 1 → `cause.test.ts` "a story the manifest does not know is unknown", "a closure through a chunk without src is unknown unless a changed file was found", and the real-manifest `describe` ("never says none-in-closure for a component edit"). 2 → `crops.test.ts` "images of different sizes" and `check-diff.mjs` "a dimension change crops the overlapping frame". 3 → `groups.test.ts` "5,000 failing stories with one signature … under 50 ms" and the `MAX_GROUPS_SHOWN` cap. 4 → `check-diff.mjs` "a sub-threshold change crops the whole frame". 5 → `structural.test.ts` "cause fits the budget for any input".
