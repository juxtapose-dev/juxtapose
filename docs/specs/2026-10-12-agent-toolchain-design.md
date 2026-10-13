# The jux CLI and toolchain for agentic UI development

Status: draft for review · 2026-10-12 · follows sub-project 0
(`docs/specs/2026-10-12-sp0-structural-diff-agent-surface-design.md`, "SP0")
and maps onto the program table in
`docs/specs/2026-10-12-storybook-10-migration-design.md` ("row N").

Line references are to this branch (`spec/agent-toolchain`, stacked on PR #92,
SP0 part a). SP0 parts (b) and (c) (`jux diff`, verdict, cause, groups, crops,
skill) are specified but not on this branch; where this doc describes them it
cites the SP0 spec, not code.

## Why

An agent building UI needs one thing from a visual tool: after an edit, a
trustworthy answer to "did the screen change the way I meant, and nothing
else?" Four measures judge that answer. **Tokens**: SP0's tier-0 verdict is
designed to cost hundreds of text tokens where a screenshot set costs
thousands of image tokens (research §1.2). **Round-trips**: every extra tool
call is a turn of latency and a chance to stop early. **Determinism**: a
verdict that flips between identical runs teaches the agent to ignore it.
**Confidence**: the answer must cover the states and sizes where the bug
lives, and say plainly what it did not look at. SP0 makes the answer cheap
for one page at one size in its resting state. This spec is about reach
(more states, sizes and facts per call), reliability (a contract an agent can
parse blind), and first-contact success. It also covers how the free tool
leads to a product teams pay for.

## The agent loop today, with SP0 done

Friction points are marked **F1–F12**. Each is an observed fact about the
code or the SP0 design.

1. **Find the page.** The agent needs a URL, so it has to know which dev
   server is running and on which port. `jux snap` takes an absolute URL
   only (`commands/snap.ts:28-31`). `config.origin` exists
   (`core/src/types.ts:207-208`) but `snap` never reads it. **F1**
2. **Snap "before".** The agent must remember to do this _before_ it edits.
   If it forgets, there is no way back short of `git stash` and a re-snap,
   and the user's rules often forbid that. Snaps are scratch and
   self-ignored (`snap.ts:76-77`). A re-snap under the same name deletes the
   old sidecar (`snap.ts:84`), so the previous state is gone. **F2**
3. **Each snap launches Chromium.** `snapPage` launches and closes a browser
   per call (`core/src/capture/snap.ts:34,57`). SP0 (b) batches URLs within
   one call, but before and after are still two launches. **F3**
4. **One size, resting state, viewport only.** The default is 1280×800
   (`capture/snap.ts:27`) with one `--viewport` (`cli/src/index.ts:50`). The
   screenshot takes no `fullPage` (`capture/capture.ts:180-185`), so the
   agent learns about off-screen content only through SP0's `below-fold`
   flag. Hover, focus, open menus, dark mode and mobile widths are never
   captured in URL mode. `StoryParams` has `captureAfterPlay`
   (`types.ts:17-18`) for stories only. **F4**
5. **Whole page, not the component.** Unrelated churn elsewhere on the page,
   such as a clock or a feed, becomes deltas unless the agent knows to
   `--mask` it. **F5**
6. **Read the verdict.** This is good: SP0 caps deltas at 20 and the summary
   at 300 characters. **No friction.**
7. **Interpret the exit code.** Today, 1 means "needs review" from `run.ts:130`,
   "no run found" from `check.ts:38`, `approve.ts:21` and `handoff.ts:33`, and
   any uncaught crash from `index.ts:150-153`. A capture that throws is
   recorded as status `fail` (`types.ts:129-130`). The agent cannot tell
   "your change broke the page" from "the tool broke". **F6**
8. **Accessibility is invisible unless pixels move.** A lost `aria-label` is
   an SP0 `attr name` delta, but a contrast drop is just two hex values the
   agent must reason about. Focus order and tap-target size are never
   reported. **F7**
9. **Runtime errors are invisible.** If the edit throws in an effect and an
   error boundary renders a fallback, the verdict says `element-removed`. The
   console message that names the cause is never recorded: `snap.ts` listens
   only for `response` (`capture/snap.ts:39-43`). **F8**
10. **Stories mode: verifying one story costs a run.** `--story` is parsed
    globally (`index.ts:83`), but `runCommand` ignores it and selects only by
    `--all` or `--since` (`run.ts:57-65`). **F9**
11. **`run --json` prints every result**, passes included (`run.ts:243-245`).
    On a large suite that is the biggest token sink in the loop. **F10**
12. **First contact.** There is no `doctor` command. A missing browser
    surfaces as Playwright's raw message (`snap.ts:58-60`). The skill is
    installed by hand (SP0 §7). Per-command `--help` does not exist (see
    Production bar). **F11**
13. **Progress output costs tokens.** `run` writes `\r` progress lines to
    stderr whenever `--json` is absent (`run.ts:106-111`), without checking
    for a TTY. Agent harnesses that capture stderr pay for those lines (true
    in Claude Code; not verified for other harnesses). **F12**

## Candidate capabilities, ranked

The ranking is by value to an agent per line of code and per unit of risk.
⭐ marks capabilities that land in a "recommended next" PR (see Proposed
sequence). The **Lane** column records whether a capability drives OSS
adoption (free) or is a paid hook (see "What people pay for"). Every
capability here keeps three invariants:

- pass/fail stays the byte hash;
- `core` gets no platform knowledge;
- facts never change the exit status of a pixel-identical capture (SP0
  decision 3).

| #   | Capability                                    | Fixes     | Rough size | Row   | Lane  |
| --- | --------------------------------------------- | --------- | ---------- | ----- | ----- |
| 1⭐ | Contract: schema ids, exit codes, JSON errors | F6, F11   | 250        | new   | OSS   |
| 2⭐ | Snap history: implicit "before"               | F2        | 80         | new   | OSS   |
| 3⭐ | Matrix in one call: viewports × color scheme  | F3, F4    | 150        | 1     | OSS   |
| 4⭐ | Runtime-error facts                           | F8        | 70         | new   | OSS   |
| 5⭐ | Accessibility facts from the sidecar          | F7        | 200        | new   | OSS   |
| 6⭐ | `run --story`, compact `run --json`           | F9, F10   | 60         | new   | OSS   |
| 7   | Interaction states (closed step vocabulary)   | F4        | 200        | new   | OSS   |
| 8   | Element scope `--selector`                    | F5        | 120        | new   | OSS   |
| 9   | `init --agent` and `doctor`                   | F1, F11   | 220        | new   | OSS   |
| 10  | Local MCP server (`jux mcp`)                  | F3, reach | 350        | 0     | OSS   |
| 11  | `approve --group <sig>`                       | groups    | 50         | 0     | OSS   |
| 12  | Matched CSS rule → source line                | cause     | 300+       | 0     | OSS   |
| 13  | Figma frame as a structural baseline          | design    | 400+       | later | paid? |

**1. Contract.** Every `--json` payload carries `schema: 'juxtapose.<kind>/vN'`,
the way `StructureSnapshot` already does. Errors become
`{ schema: 'juxtapose.error/v1', code, message, next }` on stdout under
`--json`, plus four exit codes:

- 0 OK or identical;
- 1 needs review or different;
- 2 usage error;
- 3 the tool or its environment failed (browser launch, unreachable origin,
  missing run).

A capture that threw keeps `status: 'fail'` for the hash's sake and gains
`error`, which already exists (`types.ts:129-130`). The run exits 3 if every
non-pass is an error. Value: the agent branches on the code without parsing
prose, and it stops treating tool failures as regressions. Cost: small, but
the change is breaking (decision 1). Invariants: none touched.

**2. Snap history.** `jux snap <url> --as settings` rotates an existing
`settings` to `settings@1` before writing. `jux diff settings` with one
argument diffs `@1` against the latest. The agent no longer has to plan a
"before". The first snap of a session is the before, and each re-snap after
an edit is the after. Keep at most 3 generations. Value: it removes the most
common way the loop fails silently (snapping only after the edit), and it
cuts one call per iteration. Invariants: snaps stay scratch, under
`.juxtapose/snaps/`.

**3. Matrix in one call.** `--viewport` becomes repeatable, and
`--scheme light|dark` is added through Playwright's `emulateMedia`
(<https://playwright.dev/docs/api/class-page#page-emulate-media>). One browser
launch serves the whole matrix, and each cell is named `<name>.<w>x<h>[.dark]`.
`jux diff` pairs cells by name and prints one verdict per cell plus a matrix
summary. Value: responsive and dark-mode breakage are bug classes a single
1280×800 capture cannot see, and N checks cost one call instead of N. For
stories, this is row 1 (viewport in the story id and manifest); URL mode gets
it first because snaps have no manifest to migrate. Invariant risk: color
scheme must be set before navigation, alongside `ensureViewport`
(`capture.ts:75`), so it is in place before the render signal (CLAUDE.md
"Ordering in `captureStory` is load-bearing"). Determinism is re-verified per
cell.

**4. Runtime-error facts.** Listen passively for `pageerror`, `console` errors
and failed requests during capture, and record at most 5, deduplicated, on
the snapshot. These are facts, not part of the structural hash. The verdict
gains a `runtime-errors` flag and lists them. Value: it turns "element-removed,
investigate" into "TypeError: x is undefined at Settings.tsx:41", which saves
the investigation round-trips. Invariants: listeners do not touch the page.

**5. Accessibility facts.** These are pure functions over two sidecars, with
no capture change for the first three:

- **contrast deltas**: WCAG ratio of `color` against the nearest opaque
  ancestor `background-color`, both already in `STRUCTURE_PROPS`
  (`capture/structure.ts:25-37`). Flag a crossing of 4.5:1, or 3:1 for large
  text (<https://www.w3.org/TR/WCAG22/#contrast-minimum>). An ancestor with a
  `background-image` reports "unknown", never a guess.
- **lost accessible names**: an interactive role whose `name` became empty.
  The name is already computed (`structure.ts:344-359`).
- **touch targets**: an interactive element whose rect fell below 24×24 CSS px
  (<https://www.w3.org/TR/WCAG22/#target-size-minimum>).
- **focus order** needs `tabindex` and focusability in the sidecar. That is a
  schema bump (`structure/v2`), so it ships second.

These are deltas, not an audit: the tool reports what got _worse_ between
before and after, so existing debt is not noise in every verdict. Value: it
catches a regression class that pixel review misses entirely (a lost label)
or that a vision model judges poorly (contrast). Invariants: pure `core`, and
the cold path only.

**6. `run --story` and compact `run --json`.** Honour `--story` (repeatable)
as a selection. `run --json` on stdout prints the summary, non-pass results
and groups, and points to the full `report.json` on disk. Value: a one-story
check costs one capture, and output scales with failures, not suite size.
Breaking for stdout consumers (decision 2). Nothing in this repo parses it:
the addon goes through `core` and `server`.

**7. Interaction states.** URL mode gets a closed vocabulary that runs in
order after settle and before `waitForPaint`:

```
--hover <sel>   --focus <sel>   --click <sel>   --press <key>   --wait-for <sel>
```

`--focus` uses `locator.focus()` so `:focus-visible` matches keyboard focus
(not verified across Chromium versions; the conformance suite, row 6, must
pin it). Stories keep using play functions through `captureAfterPlay`. There
is no arbitrary JS, because a script is unbounded nondeterminism and a
remote-code surface (decision 7). Value: hover, focus and open-state styles
are where the "looks fine at rest" bugs live, including focus rings removed
by a reset. Risk: transitions on hover. The animation freeze already covers
CSS transitions, but each step needs its own `drain` and settle. This is new
code inside the load-bearing ordering (`capture.ts:151-167`), so it ranks
below the pure-function items.

**8. `--selector`.** Clip both pixels and structure to one element's rect from
the same frame, using the `clip` option on the existing screenshot call and
filtering structure to that subtree. Do not use `locator.screenshot`, which
scrolls and re-lays out. Value: fewer irrelevant deltas, smaller crops, and
component-level checks without a workbench. Cost: a clip is a different
image, so it gets a different snap name. An element below the fold needs a
taller viewport, which is reported as a usage error, not a scroll.

**9. `init --agent` and `doctor`.** `jux init --agent` installs the SP0 skill,
or writes an `AGENTS.md` snippet (<https://agents.md>) when Claude Code is
not detected, and records `origin`. Once `origin` is set, `jux snap /settings`
resolves against it (F1). `jux doctor` checks five things and returns JSON
with a `next` command for each failure:

- the Playwright browser is installed;
- the origin is reachable;
- fonts are present;
- the same URL snapped twice gives an equal hash (determinism on this
  machine);
- `.juxtapose/` is gitignored correctly.

Value: first contact succeeds, and the positioning doc notes that in the agent
channel a failed first contact is not retried (`juxtapose-service`
`keel/positioning.md`, "The hero claim").

**10. Local MCP server.** `jux mcp`, a stdio server in the CLI package
(decision 6). It has at most 6 tools (`snap`, `diff`, `run`, `check`,
`verdict`/handoff, `approve`) whose results are the same versioned JSON as the
CLI, with no second schema. It keeps one warm browser for the session, which
is the only real fix for F3. `approve` requires explicit ids, and there is no
"all". Value: it reaches agents without a shell and removes per-call launch
cost. It ranks 10th because Bash-capable agents already reach the CLI, tool
descriptions cost tokens on every turn (research §3.9), and every schema
change becomes a frozen-contract problem. The MCP server ships only after #1
freezes the contract. It is a skin over `ReviewSource`
(`server/src/types.ts:1-5,35`). Spec: <https://modelcontextprotocol.io/specification>.

**11. `approve --group`.** Deferred by SP0. Once groups exist, it is about 50
lines and turns 40 approvals into one. It reuses `approveCapture` per id.

**12. Matched rule → source.** `CSS.getMatchedStylesForNode` at capture time
for changed elements only (research §3.5). This is high value ("tokens.css:14")
but needs the page alive and sourcemaps, so it costs capture time on the
failing path. It is the next row after SP0's cause tracing, not before.

**13. Figma baseline.** This is a third baseline kind for the structural diff:
a converter turns a Figma node tree into a `StructureSnapshot`, then
`jux diff <snap> figma:<file>/<node>`. The converter belongs in its own
package, never in `core`, because it is platform knowledge. It is sequenced
after the structural diff proves itself (keel `notes.md`, Product direction).
The steelman expects Figma may own this space (§1.3), so it stays "later".

### Cut, and why

- **`jux watch` for agents.** Agents act at turn boundaries. A stream either
  blocks a tool call or needs background-process plumbing in each harness.
  What a watcher really buys is a warm browser, and #10 provides that. The
  human watch mode already exists in the addon (`storybook/src/watch.ts`).
- **`--budget <tokens>`.** Token counts depend on the tokenizer and the model.
  A budget flag would promise a precision the tool cannot keep, and output
  would vary across models, which breaks determinism. The fix is to bound
  output by construction: SP0's caps, #6's compact run, and `--limit <n>` on
  multi-verdict output (decision 3).
- **Dev-server auto-detection.** Port scanning guesses wrong exactly when
  agents are busiest: several worktrees, several dev servers. A wrong guess
  gives a confident "identical" for the wrong app, which is a false green.
  `origin` plus relative paths (#9) is explicit and costs one line of config
  (decision 4).
- **`jux diff --since main` via a worktree build.** For URL apps, juxtapose
  would have to know how to install, build and serve any app at any ref. That
  is minutes per call and a large failure surface. Snap history (#2) covers
  the in-session case. Across commits, stories already have git baselines
  plus `run --since`, and URL pages get them through the `urls` platform
  (`types.ts:202-204`) (decision 5).
- **Full-page capture.** Lazy loading and sticky headers make it the least
  deterministic mode. `below-fold` plus `--selector` or a taller viewport
  covers the need.

## What people pay for

Juxtapose is open-core: the CLI, addon and core are OSS, and the paid product
is juxtapose-service on Cloudflare. The line this spec proposes (decision 8):
**anything that runs on one developer's machine is free and must be
excellent; anything that needs a shared, always-on, trusted environment is
paid.** Agents adopt only what works with no account, so every capability
ranked above is OSS. If the free tool is mediocre, nobody reaches the paid
product.

The paid hooks that agentic UI development creates:

| Hook                                  | Why a team pays                                                                                                                                                                                                                                                 | What exists                                                                                    |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Hosted deterministic rendering        | A laptop, CI and a cloud agent produce identical bytes without anyone maintaining a Docker image. It is also where Firefox and WebKit arrive (keel `notes.md`, "Browsers in the renderer"). Cross-machine mismatch is the known gap (CLAUDE.md, last paragraph) | renderer K82/K83 paused; row 5 Docker image is the free floor                                  |
| Team review, accept and PR check      | Many agents opening PRs means many verdicts for humans to judge. Accept by group, roles, audit, and a check that blocks merge are a team workflow, not a CLI                                                                                                    | service draft PRs #157 (triage), #158 (keyboard review), #159 (check links), #160–161 (accept) |
| Hosted MCP for cloud agents           | Cloud coding agents that cannot install Chromium in their sandbox (not verified per vendor) call one endpoint that renders and returns the verdict                                                                                                              | keel C30–C36, K34–K37 (read and deny tools); unbuilt                                           |
| Cross-run history and flake analytics | "Which stories flake, since when, on which env" needs every run in one place. Local runs are ephemeral by design                                                                                                                                                | none                                                                                           |
| Cross-project verdict grouping        | One token change touches three apps in a monorepo or org. SP0 groups within a run; across runs and repos needs a shared store                                                                                                                                   | none                                                                                           |
| Usage metering                        | The billing unit, not a value: per-snapshot, with skipped and deduplicated snapshots free (keel `positioning.md`, supporting claim 2)                                                                                                                           | built in the service                                                                           |

Not worth paying for, and so it stays free:

- the verdict itself;
- the local MCP server;
- accessibility and runtime facts;
- the matrix;
- `doctor`;
- baseline storage, because git already stores it free, which is the
  positioning's own point.

A Figma baseline might become a team feature, since designers are the
reviewers. That is a guess, and Figma may ship it first.

The steelman's gate still holds. The renderer, billing and hosted MCP stay
paused until the row 4 benchmark reads (keel `notes.md`, Product direction).
This section sets out which work feeds which lane; it is not a schedule.
Pricing and copy are the owner's.

## Production bar

Every command, new or existing, must meet these standards. The audit records
the current CLI against each one.

| Standard                                                     | Current state (audit)                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Versioned JSON schema on every `--json` payload              | **Gap.** `snap` (`snap.ts:88-97`), `run` (`run.ts:244`), `check` (`check.ts:64-70`) and `approve` (`approve.ts:90`) emit unversioned objects. `approve --json` with nothing to approve prints nothing (`approve.ts:40-42`). `handoff` has no JSON mode (`handoff.ts:102`), although README:89 says every command does |
| Documented exit codes                                        | **Gap.** Only `run` is documented (README:89-90). 1 is overloaded (F6)                                                                                                                                                                                                                                                |
| Actionable errors that name the next command                 | **Partial.** Good: "Run \`jux run\` first" (`check.ts:37`) and the platform list (`context.ts:116`). Missing: "no stories found" (`run.ts:53`) and raw Playwright text (`snap.ts:59`)                                                                                                                                 |
| `--help` per command, with examples                          | **Gap, and a hazard.** Help is handled only as the first argument (`index.ts:58`). With `strict: false` (`index.ts:71`), `jux run --help` reaches `runCommand`, which starts a run (read from code, not executed), and `--sinse main` is silently ignored                                                             |
| Fast startup, browser reuse                                  | **Gap.** `index.ts:10-15` imports every command eagerly, and `run.ts:5` imports Playwright at load, so `jux --version` pays for it. One browser per `snap` (F3). Startup time is unmeasured                                                                                                                           |
| No hangs: a timeout on every wait                            | **Partial.** Settle is capped (`capture.ts:18`, `settle.ts:48`). `goto` relies on Playwright's default (`platforms/urls.ts:77`). The GitHub `fetch` has no timeout (`report/github.ts:166`)                                                                                                                           |
| Writes only under `.juxtapose/`, except the documented files | **Holds**, with two documented exceptions: config (`init.ts:73`) and manifest (CLAUDE.md:166). Snap names cannot traverse (`snap-name.ts:1-2`). **Gap:** runs accumulate with no retention (`run.ts:85-87`)                                                                                                           |
| Quiet by default, `--verbose` for detail                     | **Gap.** There is no `--verbose`. Progress is not TTY-gated (`run.ts:106-111`), and phase timings always print (`run.ts:260-261`)                                                                                                                                                                                     |
| Windows, Linux and macOS paths                               | **Untested.** Code uses `path.join` throughout, but CI is `ubuntu-latest` only (`ci.yml:15,51,117`)                                                                                                                                                                                                                   |
| Telemetry: none without opt-in                               | **Holds.** No telemetry code in `packages/*/src`. Make it a written policy in README                                                                                                                                                                                                                                  |
| Semver discipline                                            | **Partial.** Changesets are in place (`.changeset/`) and the CLI is 0.4.0 (`cli/package.json:3`). JSON schema versions are not decoupled from the package version yet. Rule: a breaking payload change gets a new `vN`, and the old version is emitted for one minor release under `--schema vN-1`                    |

## Proposed sequence

These follow SP0 (b) and (c). Each PR is useful on its own. ⭐ = recommended
next.

1. ⭐ **H: hardening and contract** (#1, #6, the production-bar gaps).
   - Exit codes 0/1/2/3, schema ids, JSON error envelope.
   - Per-command `--help` with examples and strict flag parsing.
   - Lazy command imports.
   - TTY-gated progress and `--verbose`.
   - Fetch timeouts.
   - Run retention: keep the last 10 runs, configurable.
   - `run --story` and compact `run --json`.
   - A macOS and Windows CI smoke job running `snap` and `diff` on a static
     fixture.
   - Documented exit-code and schema tables in README.

   This freezes the contract that everything after it, especially MCP,
   depends on.

2. ⭐ **S: snap sets** (#2, #3, #4). Snap history, the viewport × scheme
   matrix in one launch, and runtime-error facts. All live in
   `snap`/`diff` and `core/capture/snap.ts`. This PR is the largest
   reduction in round-trips for the URL loop.
3. ⭐ **A: accessibility facts** (#5, first three facts). Pure `core`, verdict
   flags `contrast-dropped`, `name-lost` and `target-shrunk`. Focus order
   follows with `structure/v2`.
4. **I: interaction and scope** (#7, #8). Inside the capture ordering, so
   determinism runs (`pnpm check:determinism`, 10× snap) gate it.
5. **D: `init --agent` and `doctor`** (#9). This lands before any public
   launch post, since it is the first-contact path.
6. **M: `jux mcp`** (#10), after H has shipped in a release.
7. **G: `approve --group`** (#11).
8. Later rows: matched rules (#12), story viewports (row 1, informed by S),
   Figma (#13).

## Decisions this spec makes (flagged for review)

1. **Exit code 3 for tool and environment failures.** Today a crash exits 1,
   the same as "needs review". Scripts that test for exactly 1 will see 3;
   anything that treats nonzero as failure is unaffected, since both 1 and 3
   still fail a build.
2. **`run --json` stdout becomes compact** (summary, non-pass results,
   groups, report path). The full report stays in `report.json`.
3. **No token-budget flag.** Output is bounded by construction, with
   `--limit <n>` where there are many verdicts.
4. **No dev-server auto-detection.** Use `origin` plus relative URLs.
5. **No git-ref worktree builds for URL mode.** Snap history covers the
   in-session case; baselines cover the across-commits case.
6. **MCP lives in the CLI as `jux mcp`, not a new package.** This is the same
   reasoning as SP0 decision 2: no extra publish path. It has at most 6 tools
   using the CLI's own schemas, and `approve` takes explicit ids only.
7. **Interaction steps are a closed vocabulary.** No arbitrary scripts in URL
   mode. Stories keep play functions.
8. **The free/paid line is "one machine" versus "shared, trusted
   environment".** Every capability in this spec is OSS.
9. **Accessibility and runtime facts are flags, never status.** They extend
   SP0 decision 3: pixels decide.

## Out of scope

- Pricing, plan names and marketing copy (owner).
- Service-side work: renderer, hosted MCP, history and team review are
  specced in juxtapose-service keel.
- Story-mode viewport ids (row 1).
- Storybook 10 (row 2).
- The Docker image (row 5).
- Firefox and WebKit.
- A full accessibility audit, which is a different tool.
- Arbitrary pre-capture scripts.
- Publishing any token or accuracy number before row 4 (T53).

## Verification

Every capability has a measured claim. Targets are not claims, and misses are
reported, not hidden.

1. **Agent task suite (extends row 4).** Take SP0's mutation corpus and add
   tasks that need the new reach:
   - a mobile-only overflow (needs #3);
   - a dark-mode contrast drop (needs #3 and #5);
   - a focus ring removed (needs #7);
   - a lost `aria-label` (needs #5);
   - a thrown effect (needs #4);
   - an edit done before any "before" snap (needs #2).

   Record per task and per arm (before and after each PR): input tokens, tool
   calls, wall time, and whether the agent's final verdict matched the label.
   These numbers are the PR's acceptance evidence. Publishing them is still
   gated by row 4.

2. **Round-trips, deterministically.** For each loop in this doc, count the
   CLI invocations a scripted agent needs, for example a 3-viewport check:
   today 6 snaps + 3 diffs, target 2 + 1. Assert this in a test.
3. **Startup and launch.** Measure `jux --version` and
   `jux snap --help` wall time before and after H, and browser launches per
   S matrix call (target: 1).
4. **Determinism.** Run every new capture mode (matrix cells, interaction
   steps, `--selector`) 10× and require identical hashes. Add it to
   `pnpm check:determinism`.
5. **Contract.** A schema snapshot test of every `--json` payload and error
   envelope, which fails on drift, like the service's T30 for MCP. Add an
   exit-code table test that drives each documented path.
6. **Accessibility facts against a reference.** Compare contrast ratios on
   fixture pairs with a published calculator's output. Ratios must match to
   0.01.
7. **Cross-platform.** The H smoke job is green on macOS and Windows runners.

`pnpm build && pnpm typecheck && pnpm lint && pnpm test && pnpm check:determinism`
green throughout.
