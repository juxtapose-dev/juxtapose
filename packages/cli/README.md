# @juxtapose/cli

Visual regression testing for component workbenches. Captures every story,
compares against approved baselines, and tells you exactly what changed.

Works with **Storybook** and **Ladle**. Baselines live in your repo by default,
no bucket, no account, no service.

```bash
pnpm add -D @juxtapose/cli
npx storybook build          # or: npx ladle build
npx jux run --all            # everything is "new" the first time
npx jux approve --all        # establish baselines
git add juxtapose.manifest.json .juxtapose/baselines
```

From then on, `jux run` captures only the stories your changes could have
affected.

| command             | what it does                                      |
| ------------------- | ------------------------------------------------- |
| `jux run`           | capture affected stories and compare to baselines |
| `jux approve --all` | promote the last run's captures to baselines      |
| `jux check`         | exit non-zero if anything needs review, for CI    |
| `jux handoff <id>`  | print an agent-ready prompt for one failing story |

All commands accept `--json`.

Reviewing diffs inside Storybook? Add
[`@juxtapose/storybook`](https://www.npmjs.com/package/@juxtapose/storybook).

Full documentation: https://github.com/juxtapose-dev/juxtapose

MIT © Magic Factory LLC
