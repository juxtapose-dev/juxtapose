# juxtapose

Visual regression testing for component workbenches. Captures every story,
compares against approved baselines, and tells you exactly what changed.

Works with **Storybook** and **Ladle** through the same CLI. Baselines live in
your repo by default — no bucket, no account, no service.

```bash
npx jux run           # capture and compare
npx jux approve --all # bless the current rendering
npx jux check         # exit 0/1, for CI
```

## Why another one

**Pass/fail is exact.** A story passes if it renders identically to its
approved baseline. There is no "5% is probably fine" threshold to argue about,
and no slow drift as a dozen small changes accumulate into a redesign nobody
approved. When a story does change, you get the mismatch percentage and the
exact regions that moved.

**Baselines are committed.** Approving a change is a diff in the pull request
that caused it, reviewable next to the code. Branches get the right baselines
by checking out the branch, and undoing a bad approval is `git revert`. Hosted
storage (S3/R2) is available for suites too large to carry in git.

**Agent-first, not agent-compatible.** Every command emits JSON, and
`jux handoff` turns a failing story into a prompt an agent can act on — exact
mismatch figures, changed-region coordinates and the component's source path,
rather than screenshots it has to squint at.

## Getting started

```bash
pnpm add -D @juxtapose/cli
npx storybook build          # or: npx ladle build
npx jux run --all            # everything is "new" the first time
npx jux approve --all        # establish baselines
git add juxtapose.manifest.json .juxtapose/baselines
```

From then on, `jux run` captures only the stories your changes could have
affected, by following the import graph from each changed file. When it can't
be certain — a config or dependency change, or anything it can't trace — it
captures everything instead. Missing a regression is much worse than spending a
few extra seconds, so it errs that way deliberately. Every report says which
set it chose and why; `--all` forces a full run.

## Commands

| command                    | what it does                                          |
| -------------------------- | ----------------------------------------------------- |
| `jux run`                  | capture affected stories and compare to baselines     |
| `jux run --all`            | capture everything, skipping change analysis          |
| `jux approve --all`        | promote the last run's captures to baselines          |
| `jux approve --story <id>` | approve one story                                     |
| `jux check`                | exit non-zero if anything still needs review — for CI |
| `jux handoff <id>`         | print an agent-ready prompt for one failing story     |

All commands accept `--json` for machine-readable output. `jux run` exits
non-zero when any story fails, is new, or has a stale baseline.

## Configuration

`juxtapose.config.json`, or a `juxtapose` key in package.json:

```json
{
  "platform": "storybook",
  "concurrency": 8,
  "viewport": { "width": 1280, "height": 800 },
  "storage": { "kind": "git" }
}
```

Concurrency defaults to 8. Higher is not automatically better — past your core
count, contention slows captures down rather than speeding them up.

Per-story options go through the platform's own parameter mechanism
(`parameters.juxtapose` in Storybook, `meta.juxtapose` in Ladle):

| option                         | purpose                                            |
| ------------------------------ | -------------------------------------------------- |
| `skip`                         | never capture this story                           |
| `viewport`                     | override the capture size                          |
| `animations: 'play'`           | let animations run (for stories testing animation) |
| `captureAfterPlay`             | screenshot after interactions, not at first render |
| `waitForSelector`              | wait for async content juxtapose can't detect      |
| `delay`                        | fixed extra wait; last resort                      |
| `threshold` / `minDiffPercent` | tune the _reported_ diff, not pass/fail            |

Captures are reproducible by design: animations are frozen, webfonts and images
are awaited, and rendering is pinned to settings that don't vary by machine. If
a story still flakes, `waitForSelector` is usually the answer.

## Packages

| package                | what it is                                                 |
| ---------------------- | ---------------------------------------------------------- |
| `@juxtapose/core`      | capture, diff, baselines, analysis — no platform knowledge |
| `@juxtapose/storybook` | Storybook adapter                                          |
| `@juxtapose/ladle`     | Ladle adapter                                              |
| `@juxtapose/cli`       | the `jux` command                                          |

## Status

Early. The capture, diff and approve loop is verified end to end on both
Storybook and Ladle. The Storybook addon panel, HTML report, GitHub PR comments
and hosted storage are not built yet — see the
[issues](https://github.com/juxtapose-dev/juxtapose/issues) for the roadmap.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) to get set up, and
[ARCHITECTURE.md](ARCHITECTURE.md) for the design and the reasoning behind it.

## License

MIT © Magic Factory LLC. See [LICENSE](LICENSE).
