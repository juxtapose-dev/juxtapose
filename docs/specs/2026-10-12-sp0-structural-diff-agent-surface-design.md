# Sub-project 0 — structural diff and the Storybook-free agent surface

Status: draft for review · 2026-10-12 · program row 0 in
`docs/specs/2026-10-12-storybook-10-migration-design.md`

## Why this is first

The thesis under test: a tool's first pass can tell an agent **what** changed —
which element, which property, by how much — in a few hundred text tokens, so
the agent never needs a ~4,000-token screenshot read that misses most fine UI
changes (evidence and sources: `juxtapose-service/docs/research/2026-10-12-agentic-visual-diffing.md`
§1.2–1.3). Today `RunReport` says _where_ and _how much_ (regions, mismatch %),
never _what_.

Everything downstream — the benchmark (row 4), the Chromatic-replacement pitch,
the paid service — depends on this being true. It needs a page and a CDP
session, not Storybook, so it ships first and works without a workbench.

## Decisions this spec makes (flagged for review)

1. **No `proposedVerdict: intentional | regression`.** The research doc proposed
   one; this spec drops it. The tool cannot know intent — the agent that made
   the edit does. Tier-0 reports facts plus whether they **explain** every
   changed pixel, and raises risk flags. Judging "is this what I meant" stays
   with the agent, which is the cheap, reliable split: symbol comparison for
   the tool, intent for the model.
2. **The URL platform lives in core**, as `core/src/platforms/urls.ts`, not a new
   `@juxtapose/adapter-urls` package. It is the null platform — generic settle,
   no workbench knowledge — and `jux snap` must always have it. A separate
   package would add a publish path (and a manual first publish under trusted
   publishing) for ~60 lines.
3. **Pass/fail does not change.** The pixel hash still decides. Structure only
   explains a failure, and is never consulted on a green run's hot path.
4. **Cause tracing is in, but only the cheap link** (story → import closure →
   changed files). Matched CSS rules, source lines and framework dev hints are
   out (later rows).

## What ships

### 1. Structure snapshot (the sidecar)

Captured in `captureStory` immediately after `waitForPaint` and before the
screenshot — the same frame the pixels come from. One CDP call:
`DOMSnapshot.captureSnapshot({ computedStyles: STRUCTURE_PROPS, includeDOMRects: true, includePaintOrder: true })`,
then normalized in Node.

```ts
interface StructureSnapshot {
  schema: 'juxtapose.structure/v1';
  viewport: Viewport;
  /** sha256 of the canonical JSON of `elements`. Equal hash ⇒ identical
   *  structure and styles, so a pixel failure is render drift. */
  structureHash: string;
  elements: StructureElement[]; // document order, visible only
  truncated?: { kept: number; total: number };
}

interface StructureElement {
  /** Stable within one snapshot: tag + id | data-testid | nth-of-type chain. */
  path: string;
  parent: number | null; // index into elements
  tag: string;
  id?: string;
  testId?: string;
  classes?: string[];
  role?: string; // explicit role attr, else implicit from tag (button, a[href], h1-6, img, input…)
  name?: string; // aria-label | alt | title | own text, trimmed to 80 chars
  text?: string; // own text nodes only, whitespace-collapsed, 200 chars
  rect: { x: number; y: number; w: number; h: number }; // rounded to 0.01px
  paintOrder: number;
  styles: Record<string, string>; // STRUCTURE_PROPS only, non-default values only
  src?: string; // img/source/video: basename + content hash if same-origin
}
```

- `STRUCTURE_PROPS` (~30): color, background-color, background-image,
  font-family, font-size, font-weight, font-style, line-height, letter-spacing,
  text-align, text-decoration-line, text-transform, padding-{4}, margin-{4},
  border-{4}-width, border-{4}-color, border-radius ({4} corners), opacity,
  transform, box-shadow, display, visibility, gap, z-index.
  "Non-default" = differs from the tag's initial value, so a plain `<div>` costs
  ~4 entries, not 30.
- **Visible only:** skip `display:none`, `visibility:hidden`, zero-area rects
  with no visible descendants, and anything fully outside the viewport.
- **Masks apply to structure too:** a `mask` selector's subtree is replaced by a
  single `{ tag: 'masked', rect }` element, so masked content cannot appear as
  a structural delta any more than as pixels.
- **Cap:** 5,000 elements, keeping document order; `truncated` records the loss.
  Exceeding it is a signal worth surfacing, not a silent cut.
- **Determinism:** computed styles and rounded rects are stable under the same
  settle pipeline that makes pixels stable. Verified, not assumed — see
  Verification §3.

Stored beside the WebP: `.juxtapose/baselines/<id>.structure.json.gz` on
approve, `.juxtapose/runs/<runId>/<id>.structure.json.gz` per run. Manifest
entries gain optional `structureHash`. Baselines approved before this land have
no sidecar; diffs against them degrade to current-only element mapping (§3).

### 2. The URL platform (closes #11)

`core/src/platforms/urls.ts` — `detect` false (never autodetected), `enumerate`
from config, `showStory` = `navigateToStory`, `settle` = resolve immediately
(core's generic pipeline does the work), no `switchStory`, `componentPath: ''`
(affected analysis already falls back to a full run).

```json
{ "platform": "urls", "urls": [{ "id": "home", "url": "http://localhost:3000/" }] }
```

`ProjectConfig.platform` gains `'urls'`; `ProjectConfig.urls?: {id, url, params?}[]`.

### 3. Structural diff → tier-0 verdict

`core/src/diff/structural.ts` — pure, no browser. Input: baseline + current
`StructureSnapshot`, the pixel `DiffOutput` (regions), optional cause context.

**Matching elements.** Per parent, align children with an LCS over
`(tag, id ?? testId ?? role+name ?? classes)`, recursing into matches.
Positional `path` alone would misreport every sibling after an insertion as
changed; LCS reports one `added` and leaves the rest matched. Bounded: LCS is
per-parent, so cost is Σ(children²), small for real DOMs.

**Deltas** (typed, one per changed fact):

```ts
type Delta =
  | { kind: 'text'; el: string; from: string; to: string }
  | { kind: 'style'; el: string; prop: string; from: string; to: string }
  | { kind: 'attr'; el: string; attr: 'src' | 'role' | 'name'; from: string; to: string }
  | { kind: 'added' | 'removed'; el: string; rect: Rect }
  | { kind: 'moved'; el: string; dx: number; dy: number }
  | { kind: 'resized'; el: string; dw: number; dh: number };
```

`el` is a short human label: `role[name="Save"]` when available, else
`tag#id` / `tag.class` / `path`.

**Layout-shift synthesis.** When ≥3 matched elements share the same `(dx, dy)`
and the moved set is contiguous in document order after some element that was
`added` / `removed` / `resized`, collapse them into one
`{ kind: 'shift', after: el, dx, dy, count }`. "Everything below the banner
moved down 14px because the banner grew 14px" — one fact, not 40.

**Coverage.** Each pixel region is _explained_ if it intersects the rect (old
or new) of some delta's element. `coverage = explainedPixels / mismatchPixels`.
Unexplained regions are listed. They mean canvas/WebGL/image content, or
rendering that changed while the DOM did not.

**Classification** (first match wins):

| class                               | condition                                                                          |
| ----------------------------------- | ---------------------------------------------------------------------------------- |
| `render-drift`                      | `structureHash` equal, pixels differ                                               |
| `dimension-change`                  | page/viewport size differs                                                         |
| `element-added` / `element-removed` | any added/removed delta                                                            |
| `reflow`                            | any `shift` delta                                                                  |
| `geometry`                          | moved/resized deltas without shift                                                 |
| `text-only`                         | only text deltas                                                                   |
| `style-only`                        | only style deltas (sub-tag: `color`, `typography`, `spacing`, `border`, `effects`) |
| `mixed`                             | more than one of the above                                                         |
| `unknown`                           | coverage < 0.5 and no deltas (canvas, images, drift without a sidecar)             |

**Tier-0 object** — attached to `DiffResult` as `structural?`, and the whole
output of `jux diff`:

```ts
interface StructuralVerdict {
  schema: 'juxtapose.verdict/v1';
  classification: string; // from the table
  summary: string; // templated, deterministic, ≤ 300 chars
  deltas: Delta[]; // capped at 20; `deltaCount` gives the total
  deltaCount: number;
  coverage: number; // 0..1
  explained: 'full' | 'partial' | 'none'; // ≥0.98 | ≥0.5 | below
  unexplainedRegions: ChangedRegion[];
  flags: Flag[];
  cause?: Cause; // §4; absent in `jux diff` URL mode
  signature: string; // §5
  escalate: { crops: string }; // the exact command for tier-3 pixels
}

type Flag =
  | 'element-removed' // something the user could interact with is gone
  | 'text-changed' // copy changed — always worth a look
  | 'large-reflow' // shift count ≥ 10 or |dy| ≥ 50
  | 'unexplained-pixels' // explained !== 'full'
  | 'structure-truncated' // either side hit the element cap
  | 'no-baseline-structure'; // baseline predates sidecars
```

`summary` example (generated from deltas, no model):
`style-only (color, spacing): button[name="Save"] background-color #2563eb→#1d4ed8, padding 8px→12px. 2 regions, fully explained.`

### 4. Cause (cheap link only)

`core/src/analysis/cause.ts`. In `jux run` with `--since`, invert the existing
affected-story walk: build the forward import graph from the same Vite
manifest `affected.ts` reads, BFS from the story's `componentPath`, intersect
with changed files, rank by graph distance.

```ts
interface Cause {
  kind: 'in-closure' | 'config' | 'none-in-closure' | 'unknown';
  files: { path: string; distance: number }[]; // ≤ 5, nearest first
}
```

`none-in-closure` plus `render-drift` is the strongest "this is not your code"
signal the tool can give. Matched CSS rules → source lines, CSS-variable
attribution and framework component hints are later rows.

### 5. Signatures and groups

`signature` = sha256 of the delta set with element identity abstracted to
`role|tag` and values kept: two stories whose only change is "every
`button` background `#2563eb→#1d4ed8`" share one. `RunReport.groups?:
{ signature, summary, storyIds }[]` lists signatures shared by ≥2 failing
stories. Approving by group is a later row; listing them is what turns 40
handoffs into one decision.

### 6. CLI

- **`jux snap <url> [--as <name>] [--viewport WxH] [--wait-for <sel>] [--mask <sel>…] [--json]`**
  Capture one page through the full settle pipeline. Writes
  `.juxtapose/snaps/<name>.webp` and `<name>.structure.json.gz` (name defaults
  to a slug of the URL; `.juxtapose/snaps/` is gitignored by `jux init`).
  Prints `{ name, image, structure, viewport, env, structureHash }`.
- **`jux diff <a> <b> [--json] [--crops]`**
  `a`, `b` are snap names or paths. Prints the tier-0 `StructuralVerdict`.
  Exit 0 identical, 1 different or failed, 2 usage error — the CLI's existing
  convention (`run.ts` returns 1 on failure, `index.ts:93` returns 2 on usage).
  `--crops` writes side-by-side strips for each region (2× bbox, upscaled,
  capped at 512px) via sharp and lists their paths. No browser.
- **`jux run`** — unchanged flags; `DiffResult.structural` and
  `RunReport.groups` appear when sidecars exist on both sides.
- **`jux handoff`** — leads with the tier-0 summary, deltas and flags; image
  paths move to an "if still unsure" footer, crops first.

The agent loop this enables, with no Storybook:

```bash
jux snap http://localhost:5173/settings --as before
# …agent edits code…
jux snap http://localhost:5173/settings --as after
jux diff before after --json   # ~300 tokens: what changed, explained or not
```

### 7. Claude Code skill

`plugins/claude-code/` in this repo: `.claude-plugin/plugin.json` +
`skills/visual-check/SKILL.md`. The skill tells the agent: snapshot before
editing UI, snapshot after, read the tier-0 JSON, compare its deltas against
what it intended to change, escalate to `--crops` only on `explained !== 'full'`
or an unexpected flag, never open a full-page screenshot first. It also says
when not to use it (non-UI changes, pages behind auth the agent cannot reach).
Confirm the current plugin manifest format against Claude Code's docs at
implementation time; do not assume. MCP is a later row.

## Code map

| file                              | change                                                                                                                                     | rough size |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------- |
| `core/src/capture/structure.ts`   | new: CDP snapshot → `StructureSnapshot`                                                                                                    | 180        |
| `core/src/capture/capture.ts`     | call it before the screenshot; return on `Snapshot`                                                                                        | 15         |
| `core/src/types.ts`               | `StructureSnapshot`, `StructuralVerdict`, optional fields on `Snapshot` / `DiffResult` / `RunReport` / `BaselineEntry`, `platform: 'urls'` | 90         |
| `core/src/platforms/urls.ts`      | new                                                                                                                                        | 60         |
| `core/src/diff/structural.ts`     | new: matching, deltas, shift, coverage, class, summary, signature                                                                          | 320        |
| `core/src/diff/crops.ts`          | new                                                                                                                                        | 60         |
| `core/src/analysis/cause.ts`      | new; reuses `affected.ts` graph loading                                                                                                    | 90         |
| `core/src/baseline/git-store.ts`  | read/write sidecar beside WebP                                                                                                             | 30         |
| `core/src/run/*`                  | attach `structural`, compute `groups`                                                                                                      | 40         |
| `core/src/agent/handoff.ts`       | tier-0 first                                                                                                                               | 40         |
| `cli/src/commands/{snap,diff}.ts` | new                                                                                                                                        | 160        |
| `plugins/claude-code/**`          | new                                                                                                                                        | —          |

≈1,100 lines plus tests. Larger than the steelman's ~750 estimate because it
includes cause, crops, groups and the URL platform; any of those can move to a
follow-up if the review wants a smaller first PR. Suggested split: (a)
structure + URL platform + `snap`; (b) structural diff + `diff` + handoff;
(c) cause + groups + crops + skill.

## Verification

Done means each of these ran and its output is recorded in the PR.

1. **Unit tests against real CDP output.** Fixtures are `DOMSnapshot` payloads
   captured from the example workbenches and committed, not hand-written —
   CLAUDE.md's `regions.test.ts` lesson. Matching, each delta kind, shift
   synthesis, coverage, classification and summary each get one.
2. **Mutation corpus.** `scripts/structural-corpus.mjs` snaps an example page,
   applies one scripted mutation, snaps again, diffs, and asserts the
   classification and the expected delta. Operators, one each: color,
   background, padding, margin, font-size, font-weight, line-height,
   letter-spacing, border-radius, border-color, box-shadow, opacity, text
   change, element removed, element inserted (expect `shift`), image src swap,
   canvas redraw (expect `unknown` + `unexplained-pixels`), no-op (expect
   identical). This is also the seed for the row-4 benchmark.
3. **Determinism.** `jux snap` the same page 10× → identical `structureHash`;
   all example stories captured 3× via `jux run` → identical sidecars.
   Any instability is a bug in normalization, fixed before merge.
4. **Budget.** Report, per example story: sidecar gzip size, capture-time
   overhead vs. today, and tier-0 JSON length (chars ÷ 4 as the token
   estimate). Targets — not claims: sidecar median < 20 KB gz, overhead < 30 ms,
   tier-0 < 1,500 chars. Misses are reported, not hidden.
5. **Green-path cost unchanged.** A run with no failures does no structural
   diffing; the per-phase timings `jux run` prints (since #83), before/after on
   the examples, show only the capture overhead from item 4.
6. **The loop, once, for real.** In a Claude Code session with the skill
   installed, edit one example component and let the agent verify with
   `snap`/`diff`. Record the transcript's token count for the verification
   step against the same task verified by screenshot. One anecdote, labelled as
   one — the benchmark is row 4.

`pnpm build && pnpm typecheck && pnpm lint && pnpm test && pnpm check:determinism`
green throughout.

## Out of scope

Matched CSS rules / source lines / CSS-variable attribution; framework
dev-hint component mapping; Figma baselines; MCP server; `approve --group`;
viewport matrix (row 1); Storybook 10 (row 2); service ingestion of sidecars;
publishing any token or accuracy number (T53 in the service repo — the
benchmark produces those).
