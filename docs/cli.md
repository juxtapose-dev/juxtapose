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

All commands accept `--json` for machine-readable output. `jux run` exits
non-zero when any story fails, is new, or has a stale baseline.
