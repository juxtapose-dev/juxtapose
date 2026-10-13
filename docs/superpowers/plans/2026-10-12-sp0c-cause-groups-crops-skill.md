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
- Determinism: every comparator is code-unit (`compareCodeUnits` from `packages/core/src/diff/structural/deltas.ts`), never `localeCompare` — the one `localeCompare` in `run.ts` is replaced in Task 3. No `Map` iteration order leaks into output (collect, then sort). No absolute paths, OS strings or timestamps in any new JSON field: `cause.files[].path` and `crops[].file` are forward-slash paths relative to the project root; `dir` likewise. `JSON.stringify` of a verdict with a cause is byte-identical across processes.
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

## Review Focus

1. **A story whose `componentPath` the manifest does not know** (the `urls` platform's `''`, a story file outside the built workbench). Expect `cause.kind = 'unknown'`, never `none-in-closure` — a false "not your code" is worse than silence. Test: Task 2 (`cause.test.ts`, "unknown story path").
2. **`--crops` on a pair whose images have different dimensions** (`dimension-change`, the user forgot `--viewport`). Expect one strip of the overlapping frame, exit 1, no throw, and the human output says the sizes differ. Test: Task 4 (`crops.test.ts`, "different sizes") and Task 5 (`check-diff.mjs`).
3. **A run where hundreds of stories share one signature** (a design-token bump). Expect one group listing every id, the human output printing the first five ids and a count, `report.json` intact, and `computeGroups` on 5,000 results well under 50 ms. Test: Task 3 (`groups.test.ts`, "5,000 results, one signature").
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

and extend the JSDoc `@param` for `op` so the typedef includes `against` — replace the `OPERATORS` JSDoc comment with:

```js
/** Order matters only for reporting. `noop` is the baseline every operator
 *  is diffed against unless it names another with `against`. */
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
  expect(d.filter((x) => x.kind === 'moved').map((x) => x.el)).toEqual(['main']);
});

test('a child of an unmatched parent is never compared to it', () => {
  // `inserted` adds a banner; its descendants (none here) and every matched
  // element whose parent is matched keep today's behaviour: no fact vanishes.
  const d = deltas(snap('noop'), snap('inserted'));
  expect(d.filter((x) => x.kind === 'moved').length).toBeGreaterThanOrEqual(3);
});
```

- [ ] **Step 5: Run to verify failure**

Run: `pnpm vitest run packages/core/src/diff/structural/deltas.test.ts`
Expected: the first test FAILS (a `moved` for `span.meta…` is present and the moved count is > 4); the resize and grandchild tests FAIL likewise. The "differently" and "unmatched parent" tests pass already — they pin that the rule is narrow.

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

- [ ] **Step 7: Run the whole core suite**

Run: `pnpm vitest run packages/core && pnpm typecheck`
Expected: PASS, including `structural.test.ts`'s generated `corpus operator 'nested-reorder' → reflow` and `'nested' → element-added` cases, and the unchanged `padding`/`inserted`/`removed`/`reorder` expectations (the corpus page's rows have no children in those cases, so no fact changes). The two 5,000-element performance tests print their timings; the tree test still reports `deltaCount` 110 (the section rects do not move, so no row follows one).

- [ ] **Step 8: Run the end-to-end corpus**

Run: `pnpm build && node scripts/structural-corpus.mjs`
Expected: `ok   21 of 21 operators`, with the `nested-reorder` line showing `reflow`, and the budget line (`tier-0 JSON chars: … max ≤ 1500`).

- [ ] **Step 9: Commit**

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
- Modify: `packages/core/src/analysis/affected.ts` (export `loadViteManifest`, `gitChangedFiles`, `toPosixRelative`, `ViteManifest`; extract `isLockfileChange`, `isConfigChange`)
- Create: `packages/core/src/analysis/cause.ts`
- Modify: `packages/core/src/diff/structural.ts` (`cause?` on the input, fitted into the literal)
- Modify: `packages/core/src/run/run.ts` (`RunOptions.cause`, `tryStructural` consults it, timed)
- Modify: `packages/core/src/agent/handoff.ts` (a `## Why` section before `## What changed (structure)`)
- Modify: `packages/core/src/index.ts` (exports)
- Modify: `packages/cli/src/commands/run.ts` (wire `--since` to `prepareCause`; cause line in the review list)
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

- Produces (affected.ts): `export function loadViteManifest(buildDir: string): Promise<ViteManifest | null>`; `export function gitChangedFiles(sinceCommit: string, cwd: string): string[] | null`; `export function toPosixRelative(root: string, abs: string): string`; `export function isLockfileChange(file: string): boolean`; `export function isConfigChange(file: string, configDirs: string[]): boolean`; `export type ViteManifest`.
- Produces (cause.ts):

  ```ts
  export const MAX_CAUSE_FILES = 5;
  export interface CauseIndex {
    /** Never throws; never reads anything before the first call. */
    causeFor(componentPath: string): Promise<Cause>;
  }
  export interface CauseSources {
    projectRoot: string;
    configDirs: string[];
    /** Posix-relative; null when git could not say. */
    changedFiles: string[] | null;
    manifest: ViteManifest | null;
  }
  export function buildCauseIndex(src: CauseSources): CauseIndex; // pure
  export function prepareCause(opts: {
    projectRoot: string;
    buildDir?: string;
    sinceCommit: string;
    configDirs: string[];
  }): CauseIndex; // lazy, memoized, guarded
  ```

- Produces (structural.ts): `StructuralDiffInput.cause?: Cause`; `export const MAX_CAUSE_PATH = 80`.
- Produces (run.ts): `RunOptions.cause?: CauseIndex`.
- Produces (handoff.ts): `export function describeCause(c: Cause): string[]`.

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

- [ ] **Step 2: Export the manifest and git helpers from `affected.ts`**

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

Change `async function loadViteManifest`, `function gitChangedFiles` and `function toPosixRelative` to `export async function` / `export function` (bodies unchanged).

Run: `pnpm vitest run packages/core/src/analysis/affected.test.ts`
Expected: PASS, unchanged.

- [ ] **Step 3: Write the failing cause tests**

Create `packages/core/src/analysis/cause.test.ts`:

```ts
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildCauseIndex, prepareCause, MAX_CAUSE_FILES } from './cause.js';
import type { ViteManifest } from './affected.js';

// The same shape affected.test.ts uses: Button.stories → Button → shared;
// Card.stories → Card. `_chunk` has no src (a shared Vite chunk).
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

  it('a chunk without src ends the walk without throwing', async () => {
    expect((await index(['z.js']).causeFor(button())).kind).toBe('none-in-closure');
  });

  it('an empty change set is none-in-closure', async () => {
    expect((await index([]).causeFor(button())).kind).toBe('none-in-closure');
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

  it('with a manifest on disk and explicit changed files, traces the closure', async () => {
    const buildDir = path.join(root, 'build');
    await mkdir(path.join(buildDir, '.vite'), { recursive: true });
    await writeFile(path.join(buildDir, '.vite/manifest.json'), JSON.stringify(manifest));
    const ix = buildCauseIndex({
      projectRoot: root,
      configDirs: [],
      changedFiles: ['src/Card.tsx'],
      manifest: JSON.parse(
        await (
          await import('node:fs/promises')
        ).readFile(path.join(buildDir, '.vite/manifest.json'), 'utf8'),
      ) as ViteManifest,
    });
    expect(await ix.causeFor(card())).toEqual({
      kind: 'in-closure',
      files: [{ path: 'src/Card.tsx', distance: 1 }],
    });
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
// Nothing here may fail a story. `prepareCause` reads git and the manifest
// on the first `causeFor` call, once, inside try/catch; that call happens
// only in the fail branch of `judge()`, so a green run reads neither.

import { compareCodeUnits } from '../diff/structural/deltas.js';
import type { Cause } from '../types.js';
import {
  gitChangedFiles,
  isConfigChange,
  isLockfileChange,
  loadViteManifest,
  toPosixRelative,
  type ViteManifest,
} from './affected.js';

export const MAX_CAUSE_FILES = 5;

export interface CauseIndex {
  /** The cause for one story's component path. Never throws, never reads
   *  anything before the first call. */
  causeFor(componentPath: string): Promise<Cause>;
}

export interface CauseSources {
  projectRoot: string;
  configDirs: string[];
  /** Posix paths relative to projectRoot; null when git could not say. */
  changedFiles: string[] | null;
  manifest: ViteManifest | null;
}

const UNKNOWN: Cause = { kind: 'unknown', files: [] };

/** The index from already-loaded inputs. Pure. */
export function buildCauseIndex(src: CauseSources): CauseIndex {
  const forward = src.manifest ? buildForwardGraph(src.manifest) : null;
  return {
    causeFor: async (componentPath) => causeOf(src, forward, componentPath),
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
  const load = async (): Promise<CauseIndex> => {
    let manifest: ViteManifest | null = null;
    try {
      manifest = opts.buildDir ? await loadViteManifest(opts.buildDir) : null;
    } catch {
      manifest = null;
    }
    let changedFiles: string[] | null = null;
    try {
      changedFiles = gitChangedFiles(opts.sinceCommit, opts.projectRoot);
    } catch {
      changedFiles = null;
    }
    return buildCauseIndex({
      projectRoot: opts.projectRoot,
      configDirs: opts.configDirs,
      changedFiles,
      manifest,
    });
  };
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

function causeOf(
  src: CauseSources,
  forward: Map<string, string[]> | null,
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
  if (!forward || componentPath === '') return UNKNOWN;
  const start = toPosixRelative(src.projectRoot, componentPath);
  // Not in the graph (urls platform, a story outside the build): the
  // closure was never traced, so "none of your files" would be a guess.
  if (!forward.has(start)) return UNKNOWN;
  const changed = new Set(src.changedFiles);
  const files = [...closure(forward, start)]
    .filter(([file]) => changed.has(file))
    .map(([path, distance]) => ({ path, distance }))
    .sort((x, y) => x.distance - y.distance || compareCodeUnits(x.path, y.path))
    .slice(0, MAX_CAUSE_FILES);
  return files.length > 0
    ? { kind: 'in-closure', files }
    : { kind: 'none-in-closure', files: [] };
}

/** src → the srcs it imports, static and dynamic. Vite's `imports[]` holds
 *  chunk keys, so each is mapped through key → src first; a chunk with no
 *  src (a shared chunk) stays a key with no outgoing edges, the same limit
 *  affected.ts's reverse graph has. */
function buildForwardGraph(manifest: ViteManifest): Map<string, string[]> {
  const keyToSrc = new Map<string, string>();
  for (const [key, entry] of Object.entries(manifest)) {
    if (entry.src) keyToSrc.set(key, entry.src);
  }
  const forward = new Map<string, string[]>();
  for (const entry of Object.values(manifest)) {
    if (!entry.src) continue;
    forward.set(
      entry.src,
      [...(entry.imports ?? []), ...(entry.dynamicImports ?? [])].map(
        (key) => keyToSrc.get(key) ?? key,
      ),
    );
  }
  return forward;
}

/** BFS distance from `start` to everything it reaches, `start` at 0. */
function closure(forward: Map<string, string[]>, start: string): Map<string, number> {
  const dist = new Map<string, number>([[start, 0]]);
  const queue = [start];
  for (let k = 0; k < queue.length; k++) {
    const file = queue[k];
    const d = dist.get(file)!;
    for (const next of forward.get(file) ?? []) {
      if (dist.has(next)) continue;
      dist.set(next, d + 1);
      queue.push(next);
    }
  }
  return dist;
}
```

In `packages/core/src/index.ts`, after the `resolveAffected` export block add:

```ts
// Cause: the story's import closure intersected with the changed files.
export {
  buildCauseIndex,
  prepareCause,
  MAX_CAUSE_FILES,
  type CauseIndex,
  type CauseSources,
} from './analysis/cause.js';
```

Run: `pnpm vitest run packages/core/src/analysis && pnpm typecheck`
Expected: PASS.

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

Add to the imports: `import { MAX_CAUSE_FILES } from '../analysis/cause.js';` and `Cause` to the type import from `'../types.js'`.

Add to `StructuralDiffInput` after `escalate`:

```ts
  /** From `jux run --since`; `jux diff` has no changed-file set. */
  cause?: Cause;
```

After `export const MAX_VERDICT = 1500;` add:

```ts
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
});
```

(`fixture` is already loaded at the top of `handoff.test.ts` — see its existing structural tests; if it is loaded inside a later `describe`, hoist that `const fixture = …` to module scope.)

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

In `packages/core/src/agent/handoff.ts`, add `Cause` to the type import and, before `lines.push('## What changed (structure)');` inside the `else if (v)` branch — i.e. the branch becomes:

```ts
  } else if (v) {
    if (v.cause) lines.push(...describeCause(v.cause));
    lines.push('## What changed (structure)');
```

(`describeCause` returns `[]` for `unknown`, so the section only appears when there is something to say.) Add after `describeRegion`:

```ts
/** The cause, in the order an agent should weigh it: what changed that this
 *  story imports, or the fact that nothing it imports changed. */
export function describeCause(c: Cause): string[] {
  const away = (d: number) =>
    d === 0 ? 'the story file itself' : `${d} import${d === 1 ? '' : 's'} away`;
  switch (c.kind) {
    case 'in-closure':
      return [
        '## Why',
        '',
        `Changed files this story imports, nearest first: ${c.files
          .map((f) => `\`${f.path}\` (${away(f.distance)})`)
          .join(', ')}.`,
        '',
      ];
    case 'config':
      return [
        '## Why',
        '',
        `A change that reaches every story: ${c.files.map((f) => `\`${f.path}\``).join(', ')}. Expect other stories to fail the same way; the run's \`groups\` lists which.`,
        '',
      ];
    case 'none-in-closure':
      return [
        '## Why',
        '',
        "None of the files changed since the baseline is in this story's import closure. The cause is outside your diff: a dependency, an asset, the environment, or render drift.",
        '',
      ];
    case 'unknown':
      return [];
  }
}
```

Export it from `packages/core/src/index.ts`: change the handoff line to `export { buildHandoffPrompt, describeCause, type HandoffPayload } from './agent/handoff.js';`.

Run: `pnpm vitest run packages/core && pnpm typecheck`
Expected: PASS.

- [ ] **Step 12: Wire `--since` in the CLI and lead the review list with the cause**

In `packages/cli/src/commands/run.ts`:

Add `prepareCause,` and `type DiffResult,` to the `@juxtapose/core` import. After the `log(…stories to capture…)` call and before `if (selection.stories.length === 0)`, add:

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
/** What an agent reads first under a failing story: the cause, then the
 *  structural summary. One line each; the handoff has the rest. */
function explain(r: DiffResult): string[] {
  const v = r.structural;
  if (!v) return [];
  const out: string[] = [];
  const c = v.cause;
  if (c?.kind === 'in-closure')
    out.push(`cause: ${c.files.map((f) => f.path).join(', ')}`);
  else if (c?.kind === 'config')
    out.push(`cause: reaches every story (${c.files.map((f) => f.path).join(', ')})`);
  else if (c?.kind === 'none-in-closure')
    out.push('cause: none of the changed files reach this story');
  out.push(v.summary);
  return out;
}
```

Run: `pnpm build && pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 13: See it on a real workbench**

Run (from `examples/storybook`, after `pnpm --filter example-storybook build-storybook` or whatever `pnpm --filter example-storybook visual` builds — check its `package.json` `scripts`):

```bash
cd examples/storybook && node ../../packages/cli/dist/index.js run --all >/dev/null; node ../../packages/cli/dist/index.js approve --all >/dev/null
# edit one shared component, e.g. change a colour in ../components/src/Button.tsx, commit it on a scratch branch
git add -A && git commit -qm "scratch: button colour" && node ../../packages/cli/dist/index.js run --since HEAD~1
```

Expected: the failing stories print a `cause: examples/components/src/Button.tsx` line (path relative to the example's project root as the manifest records it) under each, the phase line includes `cause`, and `--json` shows `results[].structural.cause.kind === 'in-closure'`. Then `git reset --hard HEAD~1` to drop the scratch commit (never a bare `git stash`). If the example has no Vite manifest in its build output, the cause is `unknown` — record what the build produced in the PR and verify against the Ladle example instead (`examples/ladle`, `.ladle`/`build` dir), whichever has `.vite/manifest.json`.

- [ ] **Step 14: Commit**

```bash
pnpm format
git add packages/core/src packages/cli/src
git commit -m "feat: cause — the story's import closure intersected with the files changed since --since

Lazy and guarded: a green run reads neither git nor the manifest. The
verdict gains an optional cause fitted to the 1,500-char budget; jux run
and jux handoff lead with it.

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

// Review Focus 3
test('5,000 failing stories with one signature are one group, fast', () => {
  const v = verdict('color');
  const results = Array.from({ length: 5000 }, (_, k) => ({
    ...fail(`story-${k}`, 'color'),
    structural: v,
  }));
  const t = performance.now();
  const groups = computeGroups(results);
  const ms = performance.now() - t;
  console.log(`computeGroups 5000 results: ${ms.toFixed(1)} ms`);
  expect(groups).toHaveLength(1);
  expect(groups[0].storyIds).toHaveLength(5000);
  expect(ms).toBeLessThan(250);
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
if (report.groups?.length) {
  process.stdout.write(
    `\n  ${report.groups.length} change${report.groups.length === 1 ? '' : 's'} shared by several stories:\n`,
  );
  for (const g of report.groups) {
    const ids = g.storyIds.slice(0, 5).join(', ');
    const more = g.storyIds.length > 5 ? `, …${g.storyIds.length - 5} more` : '';
    process.stdout.write(
      `  ${g.storyIds.length} stories: ${g.summary}\n    ${ids}${more}\n`,
    );
  }
}
```

Run: `pnpm build && pnpm typecheck && pnpm lint`
Expected: PASS. Then on the example workbench (same scratch edit as Task 2 Step 13, which touches a shared component): `jux run --all` prints `N changes shared by several stories:` with the button stories listed, and `report.json` has `groups`.

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
    max?: number,
  ): Promise<Crop[]>;
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
  max = MAX_CROPS,
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
  for (const region of wanted.slice(0, max)) {
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
- Modify: `packages/cli/src/index.ts:22,52-65` (usage text)
- Modify: `packages/core/src/types.ts` (`BaselineStore.locate?`)
- Modify: `packages/core/src/baseline/git-store.ts` (`locate`)
- Modify: `packages/core/src/agent/handoff.ts` (`cropsCommand`; the footer)
- Modify: `packages/cli/src/commands/handoff.ts` (build `cropsCommand`; fix `images.baseline`)
- Modify: `scripts/check-diff.mjs:133-142` (crops checks)
- Test: `packages/core/src/agent/handoff.test.ts`, `packages/core/src/baseline/git-store.test.ts` (if present; else the handoff test covers `locate` through a stub), `scripts/check-diff.mjs`

**Interfaces:**

- Consumes: `renderCrops`, `Crop` (Task 4); `compareSnaps` → `{ pixels, verdict }`; `snapName`, `snapsDir`, `shellQuote`, `EXIT`.
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
      /** False for a region the verdict lists as unexplained. */
      explained: boolean;
    }>;
  }
  ```

  Files land in `<project>/.juxtapose/crops/<a>-vs-<b>/crop-N.png`; the dir is emptied first. Unexplained regions come first.

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

Any existing test that asserts `'## Images'` or `'inspect only if the data above is insufficient'` (there are two: lines 26 and 151 on main) changes to `'## If still unsure'`.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run packages/core/src/agent`
Expected: FAIL — `## If still unsure` absent.

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
  /** False for a region the verdict lists as unexplained. */
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
  { verdict, pixels }: SnapComparison,
): Promise<number> {
  const root = path.resolve(flags.project ?? process.cwd());
  const dirName = `${cropName(a)}-vs-${cropName(b)}`;
  const relDir = ['.juxtapose', 'crops', dirName].join('/');
  const absDir = path.join(root, '.juxtapose', 'crops', dirName);
  await rm(absDir, { recursive: true, force: true });
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
  const key = (r: ChangedRegion) => `${r.x},${r.y},${r.width},${r.height}`;
  const unexplained = new Set(verdict.unexplainedRegions.map(key));
  const regions = [
    ...verdict.unexplainedRegions,
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
  !existsSync(path.join(project, '.juxtapose/crops/before-vs-after/crop-9.png')),
  '--crops empties the pair dir first',
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
Expected: every line `ok`, including the seven new crops checks; exit 0.

- [ ] **Step 7: Look at one strip**

Open `<tmp project>/.juxtapose/crops/before-vs-after/crop-1.png` from a local run (`jux snap … --as before`, edit, `--as after`, `jux diff before after --crops` in any scratch dir) with the Read tool. Expected: the Save button twice, white text on the left and yellow on the right, crisp pixels, magenta gutter. Record "opened crop-1.png: button left white, right #fef08a, 6×" in the PR.

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

`jux` is `npx jux` unless the project puts it on your PATH. Every command
accepts `--json`; prefer it. Exit codes: 0 identical, 1 different, 2 usage
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

Under the verdict table, change the `escalate.command` row to:

```
| `escalate.command`   | the next command to run: `jux diff <a> <b> --crops` for a snap pair, `jux handoff <id>` for a story in a run. Arguments are shell-quoted when needed, and a `.webp` path argument appears verbatim, so a verdict for two absolute paths names this machine's paths |
| `cause`              | only in `jux run --since`: `{ kind, files }` where `kind` is `in-closure` (a changed file is in this story's import closure; `files` lists up to 5, nearest first, as `{ path, distance }`), `config` (a lockfile or platform config dir changed, so every story is affected), `none-in-closure` (the closure was traced and no changed file is in it — the strongest "this is not your code" the tool can give, especially beside `render-drift`) or `unknown` (no manifest, git failed, or the story is not in the build graph) |
```

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
  /work/app/.juxtapose/crops/before-vs-after/crop-1.png  (60×44 at 16,69, 6×)
```

With `--json` the payload wraps the verdict: `{ schema, verdict, dir, crops[] }`
where each crop is `{ file, region, box, scale, width, height, explained }`
and `file` is a forward-slash path relative to the project root. Identical
snaps write nothing and exit 0; the pair's directory is emptied on every
call. With no marked region (a sub-threshold change, a size change) the one
crop is the whole overlapping frame.

### Groups and cause (`jux run`)

`jux run --json` adds `groups[]` — `{ signature, summary, storyIds }` for
every change shared by two or more failing stories, largest first — so a
token bump that turns 40 stories red reads as one decision. With
`--since <commit>` each failing story's verdict also carries `cause` (see the
table above), and the review list prints it first:

```
  fail   components-button--primary 0.42%
         cause: src/tokens.css
         style-only (color): button[name="Save"] background-color #2563eb→#1d4ed8. Structure explains the changed region.
```
````

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

- Consumes: `render` and `LOGO` from `scripts/structural-corpus/page.mjs`; Claude Code session transcripts at `~/.claude/projects/<cwd with / → ->/<sessionId>.jsonl`, where each assistant line is `{ type: 'assistant', timestamp, message: { usage: { input_tokens, cache_creation_input_tokens, cache_read_input_tokens, output_tokens }, content: [{ type: 'tool_use', name, input }] } }` (shape checked on a real transcript on 2026-10-12).
- Produces: `serve.mjs` serves `page.html` live from disk on `PORT` (default 4173); `measure.mjs <transcript.jsonl> [--from <ISO>]` prints a Markdown table of token totals and tool calls; `arms.mjs` exports the two prompts so the PR and the script cannot drift.

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

export const ARMS = {
  skill: {
    launch: 'claude --plugin-dir plugins/claude-code',
    prompt: `${TASK} Use /juxtapose:visual-check to verify.`,
  },
  screenshot: {
    launch: 'claude',
    prompt: `${TASK} Verify by taking a screenshot of the page before and after with \`npx jux snap <url> --as <name>\` and reading the two .webp files; do not use jux diff.`,
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
// Transcript lines are JSON; assistant lines carry message.usage (shape
// checked on a real transcript, 2026-10-12). Anything else is skipped.
import { readFileSync } from 'node:fs';
import { ARMS } from './arms.mjs';

const [file, ...rest] = process.argv.slice(2);
if (!file || file === '--prompts') {
  for (const [name, arm] of Object.entries(ARMS))
    console.log(`## ${name}\n\n${arm.launch}\n\n${arm.prompt}\n`);
  if (!file) console.log('usage: measure.mjs <transcript.jsonl> [--from <ISO>]');
  process.exit(file ? 0 : 2);
}
const from = rest[0] === '--from' ? Date.parse(rest[1]) : -Infinity;
const totals = { turns: 0, input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
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
  if (o.type !== 'assistant' || !o.message?.usage) continue;
  if (Date.parse(o.timestamp) < from) continue;
  const u = o.message.usage;
  totals.turns++;
  totals.input += u.input_tokens ?? 0;
  totals.cacheWrite += u.cache_creation_input_tokens ?? 0;
  totals.cacheRead += u.cache_read_input_tokens ?? 0;
  totals.output += u.output_tokens ?? 0;
  for (const c of o.message.content ?? []) {
    if (c.type !== 'tool_use') continue;
    tools.set(c.name, (tools.get(c.name) ?? 0) + 1);
    const p = c.input?.file_path ?? '';
    if (/\.(webp|png)$/i.test(p)) imageReads.push(p);
  }
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
Expected: both arms' launch lines and prompts print; exit 0. Then `node scripts/loop-anecdote/measure.mjs /nonexistent` exits 1 with a message.

- [ ] **Step 4: Manual steps for the controller (record in the PR)**

These are run by the controller, not an implementer subagent, because they need an interactive Claude Code session. The implementer's job in this step is to run the smoke check at the end and leave the procedure in the PR description.

1. `pnpm build`, then in one terminal `node scripts/loop-anecdote/serve.mjs` (leave it running). Delete `scripts/loop-anecdote/page.html` between arms so both start from the same page.
2. **Arm A (skill):** from the repo root, `claude --plugin-dir plugins/claude-code`. Paste `ARMS.skill.prompt` (print it with `node scripts/loop-anecdote/measure.mjs --prompts`). Let the agent finish. Note the wall-clock time at which the edit was done (the first `Edit` of `page.html`), from the transcript. Exit.
3. Reset: `git checkout -- scripts/loop-anecdote` is not needed (the file is untracked) — delete `page.html`; restart `serve.mjs` so it is regenerated.
4. **Arm B (screenshot):** `claude` (no plugin). Paste `ARMS.screenshot.prompt`. Let the agent finish. Exit.
5. Find each session's transcript: the two newest files in `~/.claude/projects/-Users-jer-Code-juxtapose-.claude-worktrees-sp0c/` (the cwd with `/` replaced by `-`) — or wherever the session was started. Run `node scripts/loop-anecdote/measure.mjs <A.jsonl> --from <edit timestamp>` and the same for B. The `--from` cut isolates the verification step from the shared edit step.
6. Put both tables in the PR description under the heading **"Verification 6 — one anecdote, not a benchmark (row 4 is the benchmark)"**, with: the Claude Code version (`claude --version`), the model, the date, and whether each arm's final report matched the edit (both deltas named; nothing else claimed). Publish no number outside the PR (T53 in the service repo).

Implementer smoke check: `node scripts/loop-anecdote/serve.mjs & sleep 1; curl -s http://127.0.0.1:4173/ | grep -c 'id="title"'; kill %1`. Expected: `1`.

- [ ] **Step 5: Green-path timing (Verification 5)**

Run on `examples/storybook` with baselines approved and no edits (so every story passes):

```bash
cd examples/storybook
for i in 1 2 3; do node ../../packages/cli/dist/index.js run --all | sed -n 1,3p; done
for i in 1 2 3; do node ../../packages/cli/dist/index.js run --since HEAD | sed -n 1,3p; done
```

Expected: the phase line never includes `cause` (no story failed, so `causeFor` was never called), no `.vite/manifest.json` read shows up under `strace`/`fs_usage` if you look, and the timings match main's within noise (compare against `git stash`-free: check out main in a second worktree if a number looks off). Record the three lines per arm in the PR.

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

**Spec coverage.** §4 cause → Task 2 (`cause.ts`, verdict field, run/handoff/CLI). §5 groups → Task 3 (`signature` already existed; `RunReport.groups` added, sorted, printed). §6 `--crops` with sharp, 2× bbox, upscaled, capped 512, lists paths, no browser → Tasks 4 and 5 (`renderCrops`, `writeCrops`, probe-guarded in `check-diff.mjs`); `jux handoff` footer crops-first → Task 5; `jux run` unchanged flags → `--since` reused, nothing new. §7 skill, manifest confirmed against the docs → Task 6. Verification 5 → Task 7 Step 5 plus the lazy index test in Task 2. Verification 6 → Task 7 (script + arms + measurer + manual procedure). Deferred item 1 (child follows parent) → Task 1. Deferred item 2 (crops are the escalation an agent reads) → Task 5 and the skill's step 5. Production bar: exit codes (Task 5 pins 0/1/2 for `--crops`), versioned JSON (`juxtapose.crops/v1`; verdict unchanged), errors naming the next command (`--crops --prefix`), no telemetry (nothing added).

**Placeholder scan.** No TBD/TODO; every code step carries the code; every test step carries the test. One judgement call left to the implementer with explicit instructions: the nearest-neighbour edge assertion (Task 4 Step 4) and the Storybook-vs-Ladle manifest presence (Task 2 Step 13), both with the fallback spelled out.

**Type consistency.** `Cause`/`CauseKind` defined once (Task 2 Step 1) and used by `cause.ts`, `structural.ts`, `handoff.ts`, CLI `run.ts`. `CauseIndex.causeFor(componentPath): Promise<Cause>` matches the `vi.fn(async …)` stubs in `run-structural.test.ts` and `p.time`'s `() => Promise<T>`. `RunGroup` fields `{ signature, summary, storyIds }` match `computeGroups`, the run test and the CLI printer. `Crop` fields `{ region, box, scale, width, height, png }` match `renderCrops`, its test and `writeCrops`'s `CropFile` mapping. `fixture.cases[name].against` is written by the generator (Task 1 Step 2) and read by `structural.test.ts` and `groups.test.ts`. `formatVerdict(v, { next })` is used only by `writeCrops`; `diffPrefix`'s `formatPrefixSet` keeps the default. `BaselineStore.locate?` is optional, so the test stores in `run-structural.test.ts` need no change.

**Review Focus.** 1 → `cause.test.ts` "a story the manifest does not know is unknown". 2 → `crops.test.ts` "images of different sizes" and `check-diff.mjs` "a dimension change crops the overlapping frame". 3 → `groups.test.ts` "5,000 failing stories with one signature". 4 → `check-diff.mjs` "a sub-threshold change crops the whole frame". 5 → `structural.test.ts` "cause fits the budget for any input".
