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
| `jux diff --runs <runA> <runB>`     | are two runs byte-identical? per-story hash comparison, no browser               |
| `jux browser install\|status\|path` | install, inspect or locate the pinned browser                                    |
| `jux browser start\|stop`           | start or stop the warm browser (see [Warm browser](browser.md#warm-browser))     |

`jux <command> --help` (or `-h`) prints that command's usage and exits 0. An
unknown option, or a positional a command does not take (`jux run some-id`),
exits 2 with a one-line message; it is never ignored. Use `jux run --story <id>`
to run one story. A missing workbench exits 2 with its own message.

`jux diff --runs <runA> <runB>` compares two runs by the `hash` each
`report.json` result carries: the sha256 of that story's current capture, the
same hash `baselines/` compares. Each argument is a run id (a directory under
`.juxtapose/runs/`) or a path to a run directory. It prints the identical and
different counts and the ids of the stories that differ, plus any story present
in only one run. `--json` prints `juxtapose.run-diff/v1`:
`{ a, b, summary: { identical, different, missing }, different: [id], missing: [{ storyId, in }] }`.
Exit 0 when every story is identical, 1 when any differ or are missing, 2 for an
unknown run, 3 for an unreadable report. A report from before `hash` existed is
compared by hashing its `images/*-current.webp`. Skipped and errored stories
have no hash and compare equal only to the same status. This is the
determinism check: run twice, then `jux diff --runs <first> <second>`.

All commands accept `--json` for machine-readable output. `jux run` exits
non-zero when any story fails, is new, or has a stale baseline.

`jux snap` and `jux run` take settle options that override the config and the
story for that command: `--settle-timeout <ms>`, `--settle-ready` or
`--no-settle-ready`, `--settle-ignore <pattern>` and `--settle-require <pattern>`, the last two
repeatable. `jux snap` also takes `--delay <ms>`. See
[Settle](configuration.md#settle).
