# @juxtapose/cli

Visual regression testing for component workbenches. Captures every story,
compares against approved baselines, and tells you exactly what changed.

Works with **Storybook** and **Ladle**. The repo holds hashes and structure only —
images stay in a local cache. No bucket, no account, no service.

```bash
pnpm add -D @juxtapose/cli
npx -p @juxtapose/cli jux browser install   # once, ~100 MB
npx storybook build          # or: npx ladle build
npx -p @juxtapose/cli jux run --all         # everything is "new" the first time
npx -p @juxtapose/cli jux approve --all     # establish baselines
git add juxtapose.manifest.json .gitignore
```

From then on, `jux run` captures only the stories your changes could have
affected.

| command             | what it does                                          |
| ------------------- | ----------------------------------------------------- |
| `jux run`           | capture affected stories and compare to baselines     |
| `jux approve --all` | promote the last run's captures to baselines          |
| `jux check`         | exit non-zero if anything still needs review — for CI |
| `jux handoff <id>`  | print an agent-ready prompt for one failing story     |
| `jux browser`       | `install`, `status`, `path`, `start` or `stop`        |
| `jux mcp`           | MCP server on stdio for coding agents; [docs][mcp]    |

All commands accept `--json`. `jux mcp` returns the same JSON as tool results.

[mcp]: https://github.com/juxtapose-dev/juxtapose/blob/main/docs/mcp.md

The browser is `chrome-headless-shell` 151.0.7922.34, installed once by
`jux browser install` (an existing Playwright cache of the same build is
reused; `JUX_CHROME=<path>` or `--chrome <path>` uses your own). Mask and
`--wait-for` selectors are CSS.

Outside CI, `jux snap`, `jux run` and `jux init` keep one browser warm in the
background between invocations (idle exit after 10 minutes; byte-identical
captures). `--no-daemon` or `JUX_NO_DAEMON=1` turns it off for a command; it is
also off in CI and on Windows. `jux browser start|stop|status` manage it, and
`JUX_STATE_DIR` moves its socket and state apart from `JUX_CACHE_DIR`. The
warm browser keeps the system fonts and time zone it started with, so after you
install fonts or change the system time zone, run `jux browser stop`. See the
[main README](https://github.com/juxtapose-dev/juxtapose#browser) for details.

Reviewing diffs inside Storybook? Add
[`@juxtapose/storybook`](https://www.npmjs.com/package/@juxtapose/storybook).

Full documentation: [juxtapose on GitHub](https://github.com/juxtapose-dev/juxtapose)

MIT © Magic Factory LLC
