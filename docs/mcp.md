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

The session ends when the client closes stdin. The server finishes the call in
progress, then exits with code 0. On `SIGTERM` or `SIGINT`, the server stops
reading input, drops the call in progress without answering it, closes the
browser, and exits with code 143 or 130. A second signal exits immediately.

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
5. If `explained` is `"full"`, the deltas account for every changed pixel.
   Otherwise, call `diff` again with `crops: true` and look at the images.

For a Storybook or Ladle project with baselines, call `run`, then `handoff`
for each failing story. Call `approve` only when the user asks you to.

## Tools

The server exposes six tools. Each result's first text block holds the
command's JSON, unless noted. When the command also printed a warning, such as
an approved story whose structure was not saved, a successful result carries
it as a second text block. The JSON itself never changes shape.

### snap

Captures pages, pixels and structure, under a name. Same result as
`jux snap --json`.

| Argument   | Type                | Description                                                |
| ---------- | ------------------- | ---------------------------------------------------------- |
| `url`      | string              | One `http(s)` URL. Requires `as`.                          |
| `as`       | string              | The snap name for `url`.                                   |
| `urls`     | string[]            | Several URLs. Requires `asPrefix`.                         |
| `asPrefix` | string              | Name prefix for `urls`. Snaps are named `<prefix>-<slug>`. |
| `viewport` | `{ width, height }` | CSS pixels, each 1 to 10000. Default 1280×800.             |
| `waitFor`  | string              | CSS selector to wait for before capturing.                 |
| `mask`     | string[]            | CSS selectors to blank, such as clocks or random data.     |
| `project`  | string              | Project directory: the server's `--project` or inside it.  |

Pass either `url` with `as` or `urls` with `asPrefix`.

Result: for one `url`, the snap object (`name`, `image`, `structure`,
`viewport`, `env`, `structureHash`, `elements`, `durationMs`). For `urls`,
`{ prefix, snaps }`, where a page that failed is `{ url, error }`.

### diff

Compares two snaps. Same result as `jux diff --json`.

| Argument  | Type    | Description                                               |
| --------- | ------- | --------------------------------------------------------- |
| `a`       | string  | The earlier snap name, or a prefix with `prefix`.         |
| `b`       | string  | The later snap name, or a prefix with `prefix`.           |
| `prefix`  | boolean | Compare every `<a>-<slug>` with `<b>-<slug>`.             |
| `crops`   | boolean | Also render the changed regions. One pair at a time.      |
| `project` | string  | Project directory: the server's `--project` or inside it. |

`a` and `b` are snap names only: lowercase letters, digits and hyphens,
starting with a letter or digit. Use the `name` that `snap` returned. Unlike
`jux diff`, the tool does not accept `.webp` paths.

Result:

- `juxtapose.verdict/v1` for one pair.
- `juxtapose.verdict-set/v1` with `prefix`.
- `juxtapose.crops/v1` with `crops`: the verdict, plus one entry per crop with
  its PNG path relative to the project. The result also carries each crop as
  an MCP `image` block (`image/png`), at most 8, unexplained regions first.

A diff that finds differences is a result, not an error.

### run

Captures workbench stories and compares them to the approved baselines. Same
result as `jux run --json`: a `RunReport`.

| Argument  | Type     | Description                                         |
| --------- | -------- | --------------------------------------------------- |
| `all`     | boolean  | Capture every story instead of the affected ones.   |
| `since`   | string   | Git ref. Traces changed files since it for `cause`. |
| `stories` | string[] | Story ids to capture.                               |

`run` needs a built workbench or an `origin` in the project's juxtapose
config.

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

### approve

Promotes the last run's captures of the named stories to baselines. Same result
as `jux approve --story <id> --json`: `{ approved, failed }`.

| Argument  | Type     | Description                                  |
| --------- | -------- | -------------------------------------------- |
| `stories` | string[] | Exact story ids from the last run. Required. |

There is no "all". The server rejects an empty list, and any id that is not in
the last run, without approving anything.

## Errors

A tool result has `isError: true` when the command could not do what you asked:
a usage error or an environment failure (`jux` exit code 2 or 3), or a missing
run. The text is the command's own message, which names the fix. Results that
need attention, such as a `diff` with changes or a `check` with blocking
stories, are not errors.

A `snap` of several URLs where one page fails returns `isError: true` and still
includes the JSON for the pages it wrote.

A `project` outside the server's root, including through a symbolic link, and
a `diff` reference that is not a snap name are tool errors. Nothing is read or
written.

Protocol problems are JSON-RPC errors:

| Code     | Meaning                                                                |
| -------- | ---------------------------------------------------------------------- |
| `-32700` | The line is not JSON.                                                  |
| `-32600` | Not a valid request, such as an `id` that is not a string or a number. |
| `-32601` | Unknown method.                                                        |
| `-32602` | Unknown tool, or `arguments` is not an object.                         |
| `-32603` | Internal error.                                                        |

## Protocol

The server speaks MCP `2025-06-18`: JSON-RPC 2.0, one message per line on
stdin and stdout. It implements `initialize`, `notifications/initialized`,
`notifications/cancelled`, `ping`, `tools/list` and `tools/call`. It ignores
responses from the client, because it sends no requests. It writes only
protocol messages to stdout. Logs go to stderr.

The server runs tool calls one at a time, in the order it receives them,
because they share the browser and the snaps directory.

When you cancel a call with `notifications/cancelled`, the server does not
answer it. A call that has not started never runs. A call that is running no
longer holds up the calls behind it: `run` stops starting new stories, and
other tools finish in the background and their result is discarded.
