# jux MCP server

`jux mcp` runs a [Model Context Protocol](https://modelcontextprotocol.io/specification)
server on stdio. A coding agent connects to it to capture pages, compare them,
and review workbench runs without a shell.

Each tool calls the same code as the matching `jux` command and returns the
same versioned JSON that the command prints with `--json`. There is no second
schema: a parser for `jux diff --json` reads the `diff` tool's result.

The server keeps one browser open for the whole session. The first `snap` or
`run` call acquires it (the warm browser when it is enabled, otherwise a
private launch), and every later call reuses it. The server closes it when the
client closes stdin or sends `SIGTERM`.

## Requirements

- Node.js 22.2 or later.
- The pinned browser. Install it once:

  ```bash
  npx -p @juxtapose/cli jux browser install
  ```

## Set up the server

The server takes one option, `--project <dir>`, the project root. It defaults
to the directory the client starts the server in. `--chrome <path>` and
`--no-daemon` work as they do for `jux snap`.

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

The server exposes six tools. Each result is one text block that holds the
command's JSON, unless noted.

### snap

Captures pages, pixels and structure, under a name. Same result as
`jux snap --json`.

| Argument   | Type                | Description                                                |
| ---------- | ------------------- | ---------------------------------------------------------- |
| `url`      | string              | One `http(s)` URL. Requires `as`.                          |
| `as`       | string              | The snap name for `url`.                                   |
| `urls`     | string[]            | Several URLs. Requires `asPrefix`.                         |
| `asPrefix` | string              | Name prefix for `urls`. Snaps are named `<prefix>-<slug>`. |
| `viewport` | `{ width, height }` | Viewport in CSS pixels. Default 1280×800.                  |
| `waitFor`  | string              | CSS selector to wait for before capturing.                 |
| `mask`     | string[]            | CSS selectors to blank, such as clocks or random data.     |
| `project`  | string              | Project directory. Defaults to the server's `--project`.   |

Pass either `url` with `as` or `urls` with `asPrefix`.

Result: for one `url`, the snap object (`name`, `image`, `structure`,
`viewport`, `env`, `structureHash`, `elements`, `durationMs`). For `urls`,
`{ prefix, snaps }`, where a page that failed is `{ url, error }`.

### diff

Compares two snaps. Same result as `jux diff --json`.

| Argument  | Type    | Description                                              |
| --------- | ------- | -------------------------------------------------------- |
| `a`       | string  | The earlier snap name, or a prefix with `prefix`.        |
| `b`       | string  | The later snap name, or a prefix with `prefix`.          |
| `prefix`  | boolean | Compare every `<a>-<slug>` with `<b>-<slug>`.            |
| `crops`   | boolean | Also render the changed regions. One pair at a time.     |
| `project` | string  | Project directory. Defaults to the server's `--project`. |

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

Protocol problems are JSON-RPC errors: `-32601` for an unknown method, `-32602`
for an unknown tool, and `-32700` for a line that is not JSON.

## Protocol

The server speaks MCP `2025-06-18`: JSON-RPC 2.0, one message per line on
stdin and stdout. It implements `initialize`, `notifications/initialized`,
`ping`, `tools/list` and `tools/call`. It writes only protocol messages to
stdout. Logs go to stderr.

The server runs tool calls one at a time, in the order it receives them,
because they share the browser and the snaps directory.
