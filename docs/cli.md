# Commands

| command                              | what it does                                                                     |
| ------------------------------------ | -------------------------------------------------------------------------------- |
| `jux init`                           | set up config and capture the first baselines                                    |
| `jux run`                            | capture affected stories and compare to baselines                                |
| `jux run --all`                      | capture everything, skipping change analysis                                     |
| `jux approve --all`                  | promote the last run's captures to baselines                                     |
| `jux approve --story <id>`           | approve one story                                                                |
| `jux approve --all --allow-unstable` | also approve stories whose two run captures differed (see below)                 |
| `jux check`                          | exit non-zero if anything still needs review — for CI                            |
| `jux handoff <id>`                   | print an agent-ready prompt for one failing story                                |
| `jux snap <url>… --as <name>`        | capture a page (or several with `--as-prefix`): pixels + structure, no workbench |
| `jux diff <a> <b> --json`            | tier-0 verdict: what changed between two snaps, no browser                       |
| `jux diff <a> <b> --crops`           | the verdict plus side-by-side PNG strips per changed region, no browser          |
| `jux diff --runs <runA> <runB>`      | are two runs byte-identical? per-story hash comparison, no browser               |
| `jux browser install\|status\|path`  | install, inspect or locate the pinned browser                                    |
| `jux browser start\|stop`            | start or stop the warm browser (see [Warm browser](browser.md#warm-browser))     |

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
repeatable, `--network-external <allow|block>`, and `--network <json>` (a config `network` object, for per-type actions and URL rules). `jux snap` also takes `--delay <ms>`. See
[Settle](configuration.md#settle).

`jux snap` and `jux run` also take `--no-fresh-renderer`, which overrides the
config's `freshRenderer` for that command: captures reuse each page's renderer,
which is faster, but a story's pixels can depend on the story captured before it.

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

## Approval requires two identical captures

A flaky capture that gets approved becomes a permanently red baseline. So when
`jux run` sees a story come out `new` or `fail`, it captures it a second time
and compares the hashes. If they differ, the story's `report.json` result
carries `unstable: { hashes: [a, b] }`. If the second capture errors, times
out or is cut short by an abort, the result carries
`unstable: { hashes: [a], unconfirmed: "<reason>" }` instead: stability is
unknown, so it is refused the same way (fail closed).

What it costs: a green run captures nothing extra, and `stale` stories are not
rechecked (their hash already matches a recorded baseline). Every `new` or
`fail` story is captured twice, so a first run and `jux init` take about 2x as
long (measured 1.7-1.9x on examples/storybook, linear in the story count), and
so does a run after a toolchain bump that fails everything.

`jux approve`, `jux init`, the MCP `approve` tool and the Storybook panel all
refuse an unstable story, name it, and approve the rest. The CLI exits 1; the
panel's endpoint answers 409 and the panel shows the refusal. `jux run`,
`jux check`, `jux handoff`, the PR comment and the HTML report all mark the
story `unstable`.

### Why it flaked

An unstable story's result also carries `flake`, which says why the two
captures differed and what to change:

```json
{
  "flake": {
    "cause": "external-image",
    "confidence": "high",
    "evidence": {
      "selector": "img.cover",
      "host": "picsum.photos",
      "url": "https://picsum.photos/200"
    },
    "fix": {
      "stories": {
        "card--basic": { "network": { "external": { "images": "placeholder" } } }
      }
    }
  }
}
```

`jux run` prints one line for each unstable story:

```text
Unstable: external image from picsum.photos in img.cover; fix: stories["card--basic"].network.external.images = "placeholder"
```

`fix` is a patch for `juxtapose.config.json`: merge it in. It is scoped to the
one story, so it changes nothing for the others. It is `null` when no config
change helps. `jux diff --runs` explains each story that differs the same way
(`flake` in its `--json` output, keyed by story id), and `jux handoff` prints
the line.

`cause` is the first of these that matches, in this order:

| Cause              | Evidence                                                                                   | Fix                                                                |
| ------------------ | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `settle-timeout`   | A request was still pending at the settle cap.                                             | A `network.rules` entry for that path.                             |
| `external-image`   | A third-party image or background is where the pixels changed.                             | `network.external.images: "placeholder"`.                          |
| `embed`            | A third-party iframe is where the pixels changed.                                          | `network.external.frames: "placeholder"`.                          |
| `order-dependence` | A capture ran in a renderer process an earlier story had used, and `freshRenderer` is off. | `freshRenderer: true` (project setting; it has no per-story form). |
| `async-element`    | An element is in only one of the two captures.                                             | `waitForSelector` for that element.                                |
| `clock`            | Text that changed holds a time, a date or a duration.                                      | `mask` for that element.                                           |
| `random-content`   | Other text changed.                                                                        | `mask` for that element (low confidence).                          |
| `render-drift`     | The page structure is identical and under 2% of pixels differ.                             | None. Report a jux bug and confirm `freshRenderer`.                |
| `unknown`          | None of the above.                                                                         | None.                                                              |

When three or more unstable stories in one run share a cause and a third-party
host (`external-image`, `embed`), or are `order-dependence`, `report.json` also
has a run-level `flakeGroups: [{ cause, host?, storyIds, fix }]`, where `fix`
is one project-level patch (for a host, a `network.rules` entry for
`https://<host>/**`). Each story keeps its own `flake`. `jux run` and
`jux diff --runs` print one line for each group in place of the per-story
lines, and `jux handoff` adds it to a story in the group. Date and time
recognition covers numeric, English, German, French, Spanish, Italian,
Portuguese, Dutch and CJK dates, weekday names, and "today", "yesterday" and
"tomorrow"; a changed label that holds a weekday word counts as a clock.

`confidence` is `high`, `medium` or `low`. The cause is a diagnosis from the two
captures, not a proof: check that the fix is what you intend before you apply
it. An `async-element` fix waits for the element that is in only one capture,
which is the wrong one if that element is a spinner that went away.

Fix the cause: `mask` the changing region, add a `stories` override in config,
or keep `freshRenderer` on (the default). With `freshRenderer: false` or
`warmSwitch: true` a story's pixels can depend on the one captured before it,
so a story can be refused for an order dependence that those settings cause.
For a story that is nondeterministic by design, pass `--allow-unstable` to
`jux approve` or `jux init` (MCP: `allowUnstable`).
