# @juxtapose/cli

Visual regression testing for Storybook and Ladle. Capture selected stories,
compare them with approved baselines, and inspect screenshots and recorded DOM changes.

Requires **Node.js 22.2 or later**. Local testing needs no hosted account: the repo
holds configuration, hashes and structure; images stay in a local cache. Hosted
uploads and review are optional and have separate review decisions.

```bash
pnpm add -D @juxtapose/cli
npx -p @juxtapose/cli jux browser install   # once, ~100 MB
npx storybook build --quiet --disable-telemetry --loglevel error  # or: npx ladle build
npx -p @juxtapose/cli jux init              # writes config, captures and approves initial baselines
git add juxtapose.config.json juxtapose.manifest.json juxtapose.structures/ .gitignore
```

Review the initial captures before treating them as your reference. Subsequent
`jux run` commands select affected stories when the dependency graph is usable,
and fall back to a full run when selection is uncertain.

| command                    | what it does                                          |
| -------------------------- | ----------------------------------------------------- |
| `jux run`                  | capture affected stories and compare to baselines     |
| `jux approve --story <id>` | confirm captures and update local baselines           |
| `jux check`                | exit non-zero if anything still needs review — for CI |
| `jux handoff <id>`         | print an agent-ready prompt for one failing story     |
| `jux browser`              | `install`, `status`, `path`, `start` or `stop`        |
| `jux mcp`                  | MCP server on stdio for coding agents; [docs][mcp]    |

Commands with structured results support `--json`; `jux handoff` produces text.
MCP tools use structured results where available, and `run` defaults to a bounded
summary rather than the full CLI run report. See [MCP output modes][mcp].

[mcp]: https://github.com/juxtapose-dev/juxtapose/blob/main/docs/mcp.md

The browser is `chrome-headless-shell` 151.0.7922.34, installed once by
`jux browser install` (an existing Playwright cache of the same build is
reused; `JUX_CHROME=<path>` or `--chrome <path>` uses your own). Mask and
`--wait-for` selectors are CSS.

Outside CI, `jux snap`, `jux run` and `jux init` keep one browser warm in the
background between invocations (idle exit after 10 minutes). Reuse avoids browser
launches; it does not make changing content deterministic. `--no-daemon` or `JUX_NO_DAEMON=1` turns it off for a command; it is
also off in CI and on Windows. `jux browser start|stop|status` manage it, and
`JUX_STATE_DIR` moves its socket and state apart from `JUX_CACHE_DIR`. The
warm browser keeps the system fonts and time zone it started with, so after you
install fonts or change the system time zone, run `jux browser stop`. See the
[browser guide](https://github.com/juxtapose-dev/juxtapose/blob/main/docs/browser.md) for details.

Reviewing diffs inside Storybook? Add
[`@juxtapose/storybook`](https://www.npmjs.com/package/@juxtapose/storybook).

Full documentation: [juxtapose on GitHub](https://github.com/juxtapose-dev/juxtapose)

MIT © Magic Factory LLC
