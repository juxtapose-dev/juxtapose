# @juxtapose/cli

Visual regression testing for component workbenches. Captures every story,
compares against approved baselines, and tells you exactly what changed.

Works with **Storybook** and **Ladle**. Baselines live in your repo by default —
no bucket, no account, no service.

```bash
pnpm add -D @juxtapose/cli
npx -p @juxtapose/cli jux browser install   # once, ~100 MB
npx storybook build          # or: npx ladle build
npx -p @juxtapose/cli jux run --all         # everything is "new" the first time
npx -p @juxtapose/cli jux approve --all     # establish baselines
git add juxtapose.manifest.json .juxtapose/baselines
```

From then on, `jux run` captures only the stories your changes could have
affected.

| command             | what it does                                          |
| ------------------- | ----------------------------------------------------- |
| `jux run`           | capture affected stories and compare to baselines     |
| `jux approve --all` | promote the last run's captures to baselines          |
| `jux check`         | exit non-zero if anything still needs review — for CI |
| `jux handoff <id>`  | print an agent-ready prompt for one failing story     |
| `jux browser`       | `install`, `status` or `path` for the pinned browser  |

All commands accept `--json`.

The browser is `chrome-headless-shell` 151.0.7922.34, installed once by
`jux browser install` (an existing Playwright cache of the same build is
reused; `JUX_CHROME=<path>` or `--chrome <path>` uses your own). Mask and
`--wait-for` selectors are CSS. See the
[main README](https://github.com/juxtapose-dev/juxtapose#browser) for details.

Reviewing diffs inside Storybook? Add
[`@juxtapose/storybook`](https://www.npmjs.com/package/@juxtapose/storybook).

Full documentation: [juxtapose on GitHub](https://github.com/juxtapose-dev/juxtapose)

MIT © Magic Factory LLC
