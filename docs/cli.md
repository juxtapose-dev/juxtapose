# Commands

| command                             | what it does                                                                     |
| ----------------------------------- | -------------------------------------------------------------------------------- |
| `jux init`                          | set up config and capture the first baselines                                    |
| `jux run`                           | capture affected stories and compare to baselines                                |
| `jux run --all`                     | capture everything, skipping change analysis                                     |
| `jux approve --all`                 | promote the last run's captures to baselines                                     |
| `jux approve --story <id>`          | approve one story                                                                |
| `jux check`                         | exit non-zero if anything still needs review — for CI                            |
| `jux handoff <id>`                  | print an agent-ready prompt for one failing story                                |
| `jux snap <url>… --as <name>`       | capture a page (or several with `--as-prefix`): pixels + structure, no workbench |
| `jux diff <a> <b> --json`           | tier-0 verdict: what changed between two snaps, no browser                       |
| `jux diff <a> <b> --crops`          | the verdict plus side-by-side PNG strips per changed region, no browser          |
| `jux browser install\|status\|path` | install, inspect or locate the pinned browser                                    |
| `jux browser start\|stop`           | start or stop the warm browser (see [Warm browser](browser.md#warm-browser))     |

`jux <command> --help` (or `-h`) prints that command's usage and exits 0. An
unknown option, or a positional a command does not take (`jux run some-id`),
exits 2 with a one-line message; it is never ignored. Use `jux run --story <id>`
to run one story. A missing workbench exits 2 with its own message.

All commands accept `--json` for machine-readable output. `jux run` exits
non-zero when any story fails, is new, or has a stale baseline.

`jux snap` and `jux run` take settle options that override the config and the
story for that command: `--settle-timeout <ms>`, `--settle-ready` or
`--no-settle-ready`, `--settle-ignore <pattern>` and `--settle-require <pattern>`, the last two
repeatable. `jux snap` also takes `--delay <ms>`. See
[Settle](configuration.md#settle).

## Capture a built or deployed Storybook

Use `--build-dir <dir>` to capture a static build. Use `--origin <url>` to
capture a deployed Storybook. Each flag overrides the matching key in the
config, and each one works with `jux run`:

```bash
jux run --build-dir storybook-static
jux run --origin https://storybook.chakra-ui.com/
```

When you use `--origin`, jux doesn't serve a build. Keep `--build-dir` or
`buildDir` set as well if you want `jux run` to use the build's manifest for
change analysis. See [Capture a built or deployed Storybook](configuration.md#capture-a-built-or-deployed-storybook)
for the precedence rules and caching behavior.
