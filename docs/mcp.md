# jux MCP server

`jux mcp` runs a [Model Context Protocol](https://modelcontextprotocol.io/specification)
server on stdio. A coding agent connects to it to capture pages, compare them,
and review workbench runs without a shell.

Most tools return the same versioned JSON as the matching `jux` command with
`--json`. `run` returns a bounded `juxtapose.agent-run/v1` summary by default;
the complete `RunReport` remains in the saved run and is available through
`report` or `run({report: "full"})`. `reference` can compare two saved captures
on demand. `jux run --json` is unchanged.

The compact `run` response lists up to eight captures needing attention and
points to `report` for details. A `stale` baseline means its saved image bytes
match the capture, but its approval commit is outside the current branch's
ancestry. When every attention item is `stale`, the response says that no
visual edit or recapture is needed; re-approval is a separate baseline decision.
If stale captures appear alongside visual failures or unstable captures, the
response explains the stale status while keeping the detailed-report path for
the other issues.

When captures fail with structure evidence, the compact response carries
`changesFromApproved`: up to six lines of approved→current facts, deduplicated
across the failing captures, such as
`main>section>form gap 20px→12px (all 4)`. It lists changed computed properties
and repeated size changes, with the capture IDs when two or fewer show one, so
a mobile-only change stays visible. Each verdict stores a budgeted prefix of its
deltas, so a count means "listed in", not "affected". The lines are measured
differences from the approved baseline, not CSS causes and not the design
target. Beyond eight failing captures, a change seen in only one capture is
left to `report`. When the lines exist, they replace `groups`.

The server keeps one browser for the whole session. The first `snap` or `run`
call acquires it, and every later call reuses it. Where it comes from depends
on the warm browser:

- **Warm browser on** (the default outside CI and on macOS and Linux): the
  server connects to the warm browser daemon, starting it if needed. When the
  session ends, the server disconnects. The daemon keeps running until it has
  been idle for 10 minutes, so the next session or `jux` command starts
  without a launch. To stop it sooner, run `jux browser stop`.
- **Warm browser off** (`--no-daemon`, `JUX_NO_DAEMON=1`, CI, or Windows): the
  server launches a private browser and closes it when the session ends.

The session ends when the client closes stdin. The server finishes every call
in progress, answers each one, then exits with code 0. On `SIGTERM` or
`SIGINT`, the server stops reading input, drops every call in progress without
answering it, closes the browser, and exits with code 143 or 130. A second
signal exits immediately.

## Requirements

- Node.js 22.2 or later.
- The pinned browser. Install it once:

  ```bash
  npx -p @juxtapose/cli jux browser install
  ```

## Set up the server

The server takes three options:

- `--project <dir>`: the project root. It defaults to the directory the client
  starts the server in. Tools can work only in this directory or below it.
- `--chrome <path>`: use this Chromium binary instead of the pinned one, as for
  `jux snap`.
- `--no-daemon`: launch a private browser instead of using the warm one.

### Claude Code

```bash
claude mcp add jux -- npx -y -p @juxtapose/cli jux mcp
```

To share the server with your team, add `--scope project`. Claude Code then
writes it to `.mcp.json` in the repository.

### Cursor

Add the server to `.cursor/mcp.json` in your project, or to `~/.cursor/mcp.json`
for every project:

```json
{
  "mcpServers": {
    "jux": {
      "command": "npx",
      "args": ["-y", "-p", "@juxtapose/cli", "jux", "mcp"]
    }
  }
}
```

### Other clients

Most clients accept an `mcpServers` block. If the client does not start the
server in your project directory, pass `--project`:

```json
{
  "mcpServers": {
    "jux": {
      "command": "npx",
      "args": ["-y", "-p", "@juxtapose/cli", "jux", "mcp", "--project", "/path/to/app"]
    }
  }
}
```

If `@juxtapose/cli` is already a dev dependency, use `"command": "npx"` with
`"args": ["jux", "mcp"]` to run the installed version.

## The agent loop

1. Call `snap` on each page the change can affect, named `before`.
2. Edit the code.
3. Call `snap` on the same pages, named `after`.
4. Call `diff` with `a: "before"` and `b: "after"`. Read `summary` and
   `deltas`.
5. If the text evidence cannot settle the appearance, call `diff` again with
   `crops: true` and look at the images. Full structural coverage is spatial
   overlap, not proof that the new appearance is correct.

For a Storybook or Ladle project with baselines, call `run`, then `handoff`
for each failing story. When `designReferences` are configured, `run` includes
an additional, compact target-versus-current result block for the capture keys it
just saved. Call `reference` when you need the full measured ledger or a paired
image crop; it reads the saved images without recapturing. Call `approve` only
when the user asks you to.

## Tools

The server exposes ten tools. Each result's first text block holds the
command's JSON, except `run`, which defaults to a bounded summary, and
`reference`, which defaults to a short text ledger.
When the command also printed a warning, such as
an approved story whose structure was not saved, a successful result carries
it as a second text block. A `run` with captured design targets also carries a
final text block with `juxtapose.design-reference-hint/v1`: overall counts,
up to eight affected states, up to eight passed capture keys, and the largest
changed region ID for focused inspection. A passing hint names the captured
targets and does not require a second `reference` call to verify them. The first
run-summary block is followed by the target hint; request `report` for the
complete saved result. Targets outside a
subset run count as `notCaptured`; if none were captured, no hint is added.
For a passing target, the hint means the viewport and image geometry were
compatible and Pixelmatch found zero mismatch pixels under the stated policy.
For up to two failing targets (favoring different viewports), a hint may also
include `outline` with measured target/current border-box positions. It uses a border color from the current
capture's DOM sidecar to find matching strokes in both images. It omits the
field when those strokes are absent, the capture DPR differs from 1, or the
geometry difference is at most two pixels. The boxes do not identify elements or imply a CSS cause, and they do
not affect the Pixelmatch verdict. Read this compact observation before
requesting the full reference ledger or a crop.

Requested `reference({detail: "json"})` also adds `layout` to failing target
states when the saved current DOM is available. It contains up to eight
conservative painted-region matches with target/current boxes, current element
IDs and short labels. `dx`, `dy`, `dw` and `dh` mean current minus target;
the boxes describe pixels, not CSS border boxes. Element identity comes from
the current DOM; a design PNG has no DOM. Each match names its provenance and
a confidence-rule ID defined once in `confidenceRules`.

This analysis matches exact flat fills and unchanged inner paint, rejects
ambiguous repeated controls, and omits geometry changes of two pixels or less.
Different fonts, colors, gradients or ambiguous shapes may produce no facts.
`status: "measured"` means analysis completed, not that the UI passes;
`status: "abstained"` with `reason: "component-budget"` or
`"incompatible-geometry"` means it could not provide these measurements.
`"unavailable"` reports missing or unusable saved inputs. The existing target
verdict remains authoritative, including when there are no layout matches.

Passing targets, default run hints and crop-only requests skip layout analysis.
The MCP session retains at most 16 image analyses and 16 pair comparisons,
without retaining decoded screenshots. Content-addressed derived files under
`.juxtapose/analysis/target-layout-v2/` survive a restart. Keys include image
bytes, current structure bytes and algorithm version. Changed inputs invalidate
the analysis; corrupt caches are recomputed and a read-only cache does not
change the verdict. These facts remain on demand pending agent-value testing.
When exactly two detected outlines have an unambiguous relationship, `layout`
can report `stacked` versus `side-by-side`. `nearCurrentElementIds`, when
present, identifies current textboxes that uniquely overlap the measured
outlines. These IDs are spatial hints; they do not establish which elements
appear in the design reference or why the layouts differ.

### reference

By default, compares the last saved run with configured named design PNGs. No
browser is opened. Pass `name` to select one target, or omit it for the
captured-state ledger. To see what changed since an earlier run, call
`reference` with `compare: "previous"` and `fromRun: "<run-id>"`. `toRun`
selects the later run; it defaults to the latest. The view covers every
capture both runs saved, not only design-reference states, so it works in a
project without design PNGs. Design references keep their names; other
captures appear under their capture keys, and `name` accepts either. It
compares the saved images with Pixelmatch and, when both runs saved structure,
the structure the way `diff` compares two snaps. It does not recapture or say
whether the edit moved closer to the design.

Saved runs are never pruned, so any earlier run works as a checkpoint: keep a
good run's ID, and after later edits compare against it. `report` with
`detail: "runs"` lists up to 20 saved runs, newest first, with their counts.
To roll back, restore the checkpoint's source and run again; approving is not a
checkpoint, because it rewrites the committed baselines.

The short response counts changed and unchanged captures, lists up to eight
that changed with their changed pixel counts and region IDs, and adds up to
six observed structural changes deduplicated across them, such as
`main>section>form gap 12px→20px (all 4)`. On the four-capture billing
fixture, comparing the regressed run with the repaired one took 88 ms and
821 bytes and named all four edits. `detail: "json"`
returns `juxtapose.saved-run-change/v1`, with each changed state's structural
deltas. A region request returns a paired
previous/current PNG crop. The server caches a bounded number of these
immutable saved-run comparisons for repeated lookups in the same session. A
crop requested from a cached region reuses its analysis and validates both
saved image hashes before rendering.

Both target and checkpoint crops include their page-pixel `box` and nominal
`scale` (output pixels per page pixel). JSON detail also includes `width` and
`height` of the complete paired PNG, including the center gutter. Each side's
scaled dimensions are rounded to whole pixels. Target crops show target left,
current right; checkpoint crops show earlier left, later right. The box includes
nearby context, but content outside it is not shown. Metadata comes from the
existing crop renderer; no additional capture or image analysis is performed.
After a capture, `run` includes compact target feedback by default. Set
`compareTo: "previous"` (resolved before capture) or a saved run ID to append
the checkpoint pixel/structure change in the same call. The extra text block
starts with `juxtapose.saved-run-change/v1`. It reuses the saved comparison cache
for later `reference` detail or crop requests. Set `feedback: "none"` to skip
target analysis while still requesting a checkpoint comparison.

`progress: true` additionally includes each listed target's `progress`, when a
compatible preceding comparison exists, and `bestRun`:

```json
{
  "progress": { "fromRun": "r2", "pixels": [812, 224], "trend": "closer" },
  "bestRun": "r3"
}
```

These are opt-in measurements, not a quality score. Progress compares target
mismatch pixels against the immediately preceding run. `bestRun` is the fewest
mismatch pixels among this run and compatible saved analyses in the newest 20
runs; ties prefer this run, then the newest earlier run. Reference bytes,
capture key, geometry and comparison policy must match. Missing historical
analyses are skipped, except the preceding run, which may be analysed once
from its saved images against the current target through the existing content
cache. Stale analyses and incompatible captures contribute no trend. Old
reports without capture hashes require that re-analysis before use. No browser
is opened for history.

One `run` supplies these verdicts without a follow-up `report` or `reference`.
Use those tools only for missing detail. Stop when all required captures,
targets and behavior checks pass; `notCaptured` targets remain unchecked.
Record a useful `bestRun` as a checkpoint, and retain its source separately.
Checkpoint comparisons and progress cannot be requested with `dryRun`;
progress also requires target feedback. An invalid checkpoint is rejected
before capture. Neither option changes approval or acceptance policy.

In the default target view, configured targets outside a subset run or skipped
there count as `notCaptured`;
explicitly naming an absent target reports an error.
If none of the configured targets were captured, the result is an error with
`outcome: "no-comparison"` in JSON detail, rather than a visual pass.
The default result is a short text ledger that includes a dominant observed
target/current color pair when one exists; pass `detail: "json"` for
`juxtapose.design-reference-set/v1` with measured geometry, sampled visible target/current color pairs, and up to eight regions ranked by exact changed-pixel count. The short ledger names the largest region and its count. Pass a returned `region` ID to receive one paired target/current PNG as
an MCP image block. Region IDs remain valid after an MCP server restart while
the saved images and config remain the same. If either image changes, an old ID
is rejected; call `reference` again for current IDs. The ledger has explicit
pass, fail, incompatible, and error counts. The tool uses Pixelmatch threshold
`0.1`, independently of approved-baseline comparison settings. Design PNGs
have no DOM structure evidence.

### snap

Captures pages, pixels and structure, under a name. Same result as
`jux snap --json`.

| Argument      | Type                          | Description                                                                                                                           |
| ------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `url`         | string                        | One `http(s)` URL. Requires `as`.                                                                                                     |
| `as`          | string                        | The snap name for `url`.                                                                                                              |
| `urls`        | string[]                      | Several URLs. Requires `asPrefix`.                                                                                                    |
| `asPrefix`    | string                        | Name prefix for `urls`. Snaps are named `<prefix>-<slug>`.                                                                            |
| `viewport`    | `{ width, height }`           | CSS pixels, each 1 to 10000. Default 1280×800.                                                                                        |
| `device`      | string                        | Device preset: size, touch, user agent. A key like `pixel-8`, an alias, or a project device. See [Devices](configuration.md#devices). |
| `orientation` | `"portrait"` \| `"landscape"` | Rotate the viewport. Default is the device's listed shape.                                                                            |
| `waitFor`     | string                        | CSS selector to wait for before capturing.                                                                                            |
| `delay`       | integer                       | Fixed extra wait after settling, in ms. Last resort.                                                                                  |
| `settle`      | object                        | Settle options for this call. See below.                                                                                              |
| `network`     | object                        | `{ external: "allow" \| "block" }`: block third-party requests.                                                                       |
| `mask`        | string[]                      | CSS selectors to blank, such as clocks or random data.                                                                                |
| `project`     | string                        | Project directory: the server's `--project` or inside it.                                                                             |

Pass either `url` with `as` or `urls` with `asPrefix`.

A page that hangs costs at most the shorter of the 30 s navigation cap and
`storyTimeout`, then it errors and the next URL gets a fresh page. A call with N
hung URLs therefore holds its name lock and snap slot for about N × 30 s; other
tools and snaps under other names are not blocked.

Result: for one `url`, the snap object (`name`, `image`, `structure`,
`viewport`, `device` and `emulation` when one was used, `env`, `structureHash`, `elements`, `durationMs`). For `urls`,
`{ prefix, snaps }`, where a page that failed is `{ url, error }`. A snap
captured at the settle cap also has `flags: ["settle-timeout"]` (or
`["settle-fallback"]` when the wait couldn't run) and
`settle: { status, timeoutMs, pending }`, where `pending` lists what the page
was still doing.

`settle` has the same shape as the `settle` key in
[juxtapose config](configuration.md#settle), and it overrides the project's
and the story's values for this call:

| Field             | Type     | Description                                                                                                  |
| ----------------- | -------- | ------------------------------------------------------------------------------------------------------------ |
| `timeout`         | integer  | The cap on the wait, in ms, from 1 to 60000. Default 1500.                                                   |
| `ready`           | boolean  | Wait for the page to call `window.__juxtapose.ready()`; `false` turns off a story's or the config's `ready`. |
| `network.ignore`  | string[] | URL patterns never counted as pending.                                                                       |
| `network.require` | string[] | URL patterns that must each complete before capture.                                                         |

When a result has `settle-timeout`, read `pending` and call the tool again:
add a request that never finishes to `network.ignore`, or raise `timeout` for
slow work.

### diff

Compares two snaps. Same result as `jux diff --json`.

| Argument  | Type    | Description                                               |
| --------- | ------- | --------------------------------------------------------- |
| `a`       | string  | The earlier snap name, or a prefix with `prefix`.         |
| `b`       | string  | The later snap name, or a prefix with `prefix`.           |
| `prefix`  | boolean | Compare every `<a>-<slug>` with `<b>-<slug>`.             |
| `crops`   | boolean | Also render the changed regions. One pair at a time.      |
| `project` | string  | Project directory: the server's `--project` or inside it. |

`a` and `b` are snap names, not paths. The server normalizes them the same way
`snap` normalizes `as` and `asPrefix`, so a snap taken with `as: "Before"` is
found with `a: "Before"` or `a: "before"`. Unlike `jux diff`, the tool rejects a
reference that looks like a path: one that is empty, contains `/`, `\`, `..`
or a NUL character, or ends in `.webp`.

Result:

- `juxtapose.verdict/v1` for one pair.
- `juxtapose.verdict-set/v1` with `prefix`.
- `juxtapose.crops/v1` with `crops`: the verdict, plus one entry per crop with
  its PNG path relative to the project. The result also carries each crop as
  an MCP `image` block (`image/png`), at most 8, unexplained regions first.

A diff that finds differences is a result, not an error.

### list

Lists available capture IDs, titles and variants. Optional `stories: string[]`
filters by exact ID or ID glob (`*`, `**`, `?`); every selector must match.
Returns `{schema: "juxtapose.selection/v1", count, captures}`. No screenshots or
run report are written. Live parameter discovery may initialize the browser and
populate its cache. Use returned IDs with `run` for a focused capture.

### run

Captures workbench stories and compares them to the approved baselines. The
default result includes counts, at most eight stories needing attention (errors
and unstable captures first), and how many more were omitted. It also includes
a compact design-target hint when references are configured. The full report
is saved for focused, read-only lookups.

| Argument    | Type     | Description                                                                                          |
| ----------- | -------- | ---------------------------------------------------------------------------------------------------- |
| `all`       | boolean  | Capture every story instead of the affected ones.                                                    |
| `since`     | string   | Git ref. Traces changed files since it for `cause`.                                                  |
| `stories`   | string[] | Exact story IDs or ID globs to capture; base matches include variants.                               |
| `settle`    | object   | Settle options for every story, as for `snap`.                                                       |
| `recheck`   | string   | `"changed"` (default), `"new"` or `"off"`: which stories get a second capture. Overrides the config. |
| `feedback`  | string   | `"target"` (default) or `"none"` to skip design-target analysis after capture.                       |
| `compareTo` | string   | Saved run ID or `"previous"`; append checkpoint change (default off).                                |
| `progress`  | boolean  | Add compatible target trend and bounded best-run history (default off).                              |
| `report`    | string   | `"summary"` (default) or `"full"` for the complete `RunReport`.                                      |

`run` needs a built workbench or an `origin` in the project's juxtapose
config.

An unstable result also has `flake: { cause, confidence, evidence, fix }`:
why the two captures differed, and the exact config patch that fixes it (`null`
when none helps). See [Why it flaked](cli.md#why-it-flaked). `handoff` prints
the same fix as one line. A run-level `flakeGroups` lists stories that share one project-level fix.

With `recheck: "off"` (or `"new"`, for a failing story) the run captures a
story once. Its result has `unrechecked: true`, a placeholder `unstable` (`not rechecked`) and no `flake`,
and the report's `recheck` field names the mode. `approve` then captures it
again before it writes the baseline. See
[Choose what gets rechecked](cli.md#choose-what-gets-rechecked).

A result captured at the settle cap has `flags: ["settle-timeout"]` (or
`["settle-fallback"]`) and a
`settle` object, whatever its `status`.

Set `dryRun: true` to return the selection instead of capturing. It uses the
same selection rules and response shape as `list`, while retaining run's affected
analysis when no selectors are supplied. This does not replace the last run.

The summary's `next` guidance asks for additional saved detail only when the
returned evidence leaves a question. `changesFromApproved` describes a difference
from the approved baseline, not an instruction to match a design target. A run
with no listed capture blockers still requires checking requested coverage,
design targets and behavior before stopping; an empty or partial run is not
proof of completion.

Compact `changesFromApproved` retains ordinal labels such as `textbox (1st)`
and `textbox (2nd)` as distinct saved identities. These labels are not guaranteed
unique CSS selectors. The array contains at most six facts plus an omission
marker, within 800 UTF-8 bytes including capture labels. Facts longer than 240
characters are omitted whole and counted in `omittedLongObservations`; full
saved results retain them. A `+N more` marker counts eligible grouped facts
excluded by the count or byte budget. Request a specific saved story only when
its missing detail is needed.

Compact `run` and `report` summaries may include `controlMeasurements` when
ancestor deduplication hid a native-control resize and the element has no other
direct fact. Each item identifies a DOM ID or test ID, the measured dimension,
`approved` and `current` values, and the capture keys where it was observed.
`captures: "all-failing"` means every failing capture in this saved run—not every
story in the project. Identical measurements are grouped across captures.

This block is limited to three items and 768 UTF-8 bytes. `omittedMeasurements`
counts grouped measurements that did not fit; `unlistedDetailObservations` counts
observations already omitted from saved per-story detail. Neither count implies
that the displayed evidence is insufficient for the next edit. Request more
detail only for a specific unanswered question. Dimensions describe border boxes,
not CSS causes. No block is emitted when no qualifying measurement is available.

### report

Reads a saved run without launching a browser or capturing again. With no
arguments it returns the same bounded summary as `run`. Pass `story` to get
one complete result, including structural, pixel, and flake evidence; pass
`detail: "full"` for the complete `RunReport`. `runId` selects an older saved
run; otherwise the latest is used. `story` and `detail: "full"` are exclusive.
The server keeps a small cache of parsed reports and checks for saved-file
changes before reusing one.

First use any `controlMeasurements` in the compact summary. If a wrapper resize
still leaves the control dimensions unclear, request one
`report({story: "form--default", runId: "<saved-run>"})`. A failed capture may
include `controlGeometry`: measured approved/current border-box widths and
heights for native controls with unique matching DOM IDs or test IDs. For
example, `height: {approved: 49, current: 36}` identifies a measured size change,
not the CSS property that caused it. Typography, padding, or layout may be
responsible. No new capture or sidecar read is needed.

Full `controlGeometry` detail is not repeated in compact summaries. Its observation array is capped
at three items and 1024 UTF-8 bytes, with an explicit `omitted` count. Ambiguous
identities abstain; truncated snapshots report `unavailable: "truncated-structure"`.
`suppressedResize: true` marks a size change omitted from ordinary facts because
it followed its parent and had no other direct fact. These measurements are
prioritized before the detail budget; this flag is not a claim about a CSS cause.
Older reports may not contain it. This is approved-baseline evidence, not
geometry extracted from a PNG design target or a previous-run comparison.

| Argument | Type   | Description                        |
| -------- | ------ | ---------------------------------- |
| `runId`  | string | Saved run ID (default latest).     |
| `story`  | string | Exact capture key to inspect.      |
| `detail` | string | `"summary"` (default) or `"full"`. |

### check

Lists the stories from the last run that still need review, without
capturing. No arguments. Same result as `jux check --json`:
`{ ok, blocking: [{ storyId, status }], runId }`.

### handoff

Describes one story from the last run: what changed, the likely cause, image
paths and the next steps. Same text as `jux handoff <storyId>`, which has no
JSON form.

| Argument | Type   | Description |
| -------- | ------ | ----------- |
| `story`  | string | A story id. |

### explain

Says which settings one story or variant key would be captured with, and which
layer each came from, without capturing. Same result as `jux config --explain
<story> --json` (`juxtapose.explain/v1`; see
[the CLI reference](cli.md#which-setting-won-jux-config---explain)). Call it
before changing a setting, to see which layer wins. It needs no earlier run.

| Argument  | Type   | Description                                                        |
| --------- | ------ | ------------------------------------------------------------------ |
| `story`   | string | A story id, which also lists its variants' keys, or a capture key. |
| `settle`  | object | As for `run`; shows as the `cli` layer, as the flags would.        |
| `network` | object | As for `run`.                                                      |
| `recheck` | string | As for `run`; shows as the `mcp` layer.                            |

An id that matches nothing is a tool error that suggests the closest ones.

### approve

Promotes the last run's captures of the named stories to baselines. Same result
as `jux approve --story <id> --json`: `{ approved, failed }`. It writes the hash
and structure the project commits; the image goes to the local cache, so never
`git add` one.

| Argument        | Type     | Description                                                                   |
| --------------- | -------- | ----------------------------------------------------------------------------- |
| `stories`       | string[] | Exact story ids from the last run. Required.                                  |
| `allowUnstable` | boolean  | Approve stories the run captured twice with different results. Default false. |

A story the run captured only once (`unrechecked`) is captured again first, and
approved only if the two captures match. This launches the session's browser and
needs the same build or origin as `run`. `allowUnstable` skips it.

A story whose two run captures differed is `unstable` in the run result. It is
refused with a reason in `failed` (the rest are still approved) unless
`allowUnstable` is true. Fix it with a mask, a `stories` override or
`freshRenderer` rather than passing the flag, unless the user insists.

There is no "all". The server rejects an empty list, and any id that is not in
the last run, without approving anything. Otherwise every requested id appears
in the result, in `approved` or in `failed` with a reason. The server checks
the ids and approves them against the same run.

## Errors

A tool result has `isError: true` when the command could not do what you asked:
a usage error or an environment failure (`jux` exit code 2 or 3), or a missing
run. The text is the command's own message, which names the fix. Where the
command's message suggests a `jux` shell command, the server names the tool to
call instead. Results that
need attention, such as a `diff` with changes or a `check` with blocking
stories, are not errors.

A `snap` of several URLs where one page fails returns `isError: true` and still
includes the JSON for the pages it wrote.

A `project` outside the server's root, including through a symbolic link, or
inside a `.juxtapose` directory, and
a `diff` reference that is not a snap name are tool errors. Nothing is read or
written.

Protocol problems are JSON-RPC errors:

| Code     | Meaning                                                                                                         |
| -------- | --------------------------------------------------------------------------------------------------------------- |
| `-32700` | The line is not JSON.                                                                                           |
| `-32600` | Not a valid request, such as an `id` that is not a string or a number, or the `id` of a call still in progress. |
| `-32601` | Unknown method.                                                                                                 |
| `-32602` | Unknown tool, or `arguments` is not an object.                                                                  |
| `-32603` | Internal error.                                                                                                 |

## Protocol

The server speaks MCP `2025-06-18`: JSON-RPC 2.0, one message per line on
stdin and stdout. It implements `initialize`, `notifications/initialized`,
`notifications/cancelled`, `ping`, `tools/list` and `tools/call`. It ignores
responses from the client, because it sends no requests. It writes only
protocol messages to stdout. Logs go to stderr.

## Concurrency

Agents often call several tools in one turn. The server runs calls at the same
time when they touch different files, and makes the rest take turns. Replies
can arrive in a different order from the requests; match them by `id`.

Before a call starts, the server works out everything it reads and writes, and
waits until it can have all of it at once:

| Tool                          | Reads                                                             | Writes                                 |
| ----------------------------- | ----------------------------------------------------------------- | -------------------------------------- |
| `snap`                        |                                                                   | the `as` snap, or every `<asPrefix>-*` |
| `diff`                        | the `a` and `b` snaps, or every `<a>-*` and `<b>-*` with `prefix` | with `crops`, that pair's crops        |
| `check`, `handoff`, `explain` | the last run                                                      |                                        |
| `run`, `approve`              | everything                                                        | everything                             |

Two calls overlap only when neither writes what the other reads or writes:

- `snap` calls with different names run in parallel. Two `snap` calls with the
  same name run one after the other. A prefix covers every name that starts
  with it and a `-`: `asPrefix: "before"` and `as: "before-home"` take turns.
- By default, at most 4 `snap` calls capture at once (fewer on small
  machines). Each one uses its own browser
  context, so parallel snaps share no cookies, storage or page. A snap taken in
  parallel is byte-identical to the same snap taken alone. To change the limit,
  see [Snap concurrency](#snap-concurrency).
- A `diff` waits for any `snap` that writes one of its sides, and a `snap`
  waits for any `diff` reading the name it writes.
- `run` and `approve` run alone: they wait for every call before them, and
  every later call waits for them.
- Snaps and diffs in different `project` directories never wait for each
  other. `run` and `approve` still wait for everything.

Calls that conflict start in the order the server reads them from stdin,
including calls sent in one write: a `diff` sent before a `snap` of the same
name reads the snap as it was before that `snap`. A call that is waiting holds
back every later call that conflicts with it, so a `run` behind a stream of
`snap` calls still gets its turn. A call that conflicts with nothing before it
starts as soon as the server has checked its arguments and every earlier call's
arguments, even if it arrived after a call that is waiting.

When you cancel a call with `notifications/cancelled`, the server does not
answer it. A call that has not started never runs. A call that is running
finishes, and keeps what it reads and writes until it does, so a later call on
the same snaps still waits for it. Its result is discarded. A cancelled `run`
stops starting new stories and writes no report, so `check`, `handoff` and
`approve` keep reading the previous run.

### Snap concurrency

By default, the server captures at most half as many snaps at once as the
machine has CPU cores, from 1 up to 4. To change that, set
`mcp.concurrency` in `juxtapose.config.json`:

```json
{
  "mcp": { "concurrency": 8 }
}
```

The `--concurrency` flag overrides the file for one server, for example
`jux mcp --concurrency 2`. Both take a whole number from 1 to 16, and are not
limited by the core count; any other
value stops the server with exit code 2 before it reads any input. The server
reads the config from its `--project` directory once, at startup.

On a 15-core machine, 8 snaps at once finished in 338 ms with a limit of 8 and
in 604 ms with a limit of 4, and each capture took about 10% longer. On a
machine with fewer cores, a higher limit can make captures slower.

### Renderer reuse and approval

The project and per-story `renderer` object accepts `shared` and
`clearResourceCache` booleans; `shared` defaults to true and
`clearResourceCache` to false. Baseline mismatches receive a bounded cache-pulse
retry followed by a fresh fallback independently of `recheck`. Run and
check results carry `rendererRetry` evidence, and handoffs explain it. The
`approve` tool always confirms the selected hash on a fresh renderer, even
with `allowUnstable`; it cannot approve different bytes. See
[renderer settings](configuration.md#renderer-settings).
