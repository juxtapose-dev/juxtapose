# jux MCP server

`jux mcp` runs a [Model Context Protocol](https://modelcontextprotocol.io/specification)
server on stdio. A coding agent connects to it to capture pages, compare them,
and review workbench runs without a shell.

Each tool calls the same code as the matching `jux` command and returns the
same versioned JSON that the command prints with `--json`. There is no second
schema: a parser for `jux diff --json` reads the `diff` tool's result.

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
for each failing story. For a configured design target, call `reference` after
`run` to compare saved images without recapturing. Call `approve` only when
the user asks you to.

## Tools

The server exposes eight tools. Each result's first text block holds the
command's JSON, except `reference`, which defaults to a short text ledger.
When the command also printed a warning, such as
an approved story whose structure was not saved, a successful result carries
it as a second text block. The JSON itself never changes shape.

### reference

Compares the last saved run with configured named design PNGs. No browser is
opened. Pass `name` to select one target, or omit it for the all-state ledger.
The default result is a short text ledger; pass `detail: "json"` for
`juxtapose.design-reference-set/v1` with measured geometry and bounded region
lists. Pass a returned `region` ID to receive one paired target/current PNG as
an MCP image block. Region IDs remain valid after an MCP server restart while
the saved images and config remain the same. If either image changes, an old ID
is rejected; call `reference` again for current IDs. The ledger has explicit
pass, fail, incompatible, and error counts. The tool uses Pixelmatch threshold
`0.1`, independently of approved-baseline comparison settings. Design PNGs
have no DOM structure evidence.

### snap

Captures pages, pixels and structure, under a name. Same result as
`jux snap --json`.

| Argument   | Type                | Description                                                     |
| ---------- | ------------------- | --------------------------------------------------------------- |
| `url`      | string              | One `http(s)` URL. Requires `as`.                               |
| `as`       | string              | The snap name for `url`.                                        |
| `urls`     | string[]            | Several URLs. Requires `asPrefix`.                              |
| `asPrefix` | string              | Name prefix for `urls`. Snaps are named `<prefix>-<slug>`.      |
| `viewport` | `{ width, height }` | CSS pixels, each 1 to 10000. Default 1280×800.                  |
| `waitFor`  | string              | CSS selector to wait for before capturing.                      |
| `delay`    | integer             | Fixed extra wait after settling, in ms. Last resort.            |
| `settle`   | object              | Settle options for this call. See below.                        |
| `network`  | object              | `{ external: "allow" \| "block" }`: block third-party requests. |
| `mask`     | string[]            | CSS selectors to blank, such as clocks or random data.          |
| `project`  | string              | Project directory: the server's `--project` or inside it.       |

Pass either `url` with `as` or `urls` with `asPrefix`.

A page that hangs costs at most the shorter of the 30 s navigation cap and
`storyTimeout`, then it errors and the next URL gets a fresh page. A call with N
hung URLs therefore holds its name lock and snap slot for about N × 30 s; other
tools and snaps under other names are not blocked.

Result: for one `url`, the snap object (`name`, `image`, `structure`,
`viewport`, `env`, `structureHash`, `elements`, `durationMs`). For `urls`,
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

Captures workbench stories and compares them to the approved baselines. Same
result as `jux run --json`: a `RunReport`.

| Argument  | Type     | Description                                                                                          |
| --------- | -------- | ---------------------------------------------------------------------------------------------------- |
| `all`     | boolean  | Capture every story instead of the affected ones.                                                    |
| `since`   | string   | Git ref. Traces changed files since it for `cause`.                                                  |
| `stories` | string[] | Exact story IDs or ID globs to capture; base matches include variants.                               |
| `settle`  | object   | Settle options for every story, as for `snap`.                                                       |
| `recheck` | string   | `"changed"` (default), `"new"` or `"off"`: which stories get a second capture. Overrides the config. |

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
