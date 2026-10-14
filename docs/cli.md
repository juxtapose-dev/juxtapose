# Commands

| command                              | what it does                                                                      |
| ------------------------------------ | --------------------------------------------------------------------------------- |
| `jux init`                           | set up config and `.gitignore`, and capture the first baselines                   |
| `jux doctor [--fix]`                 | warn if baseline images are tracked by git, and print the migration commands      |
| `jux run`                            | capture affected stories and compare to baselines                                 |
| `jux run --all`                      | capture everything, skipping change analysis                                      |
| `jux approve --all`                  | promote the last run's captures to baselines (hash and structure; image to cache) |
| `jux approve --story <id>`           | approve one story                                                                 |
| `jux approve --all --allow-unstable` | also approve stories whose two run captures differed (see below)                  |
| `jux run --recheck <mode>`           | which stories get a second capture: `changed` (default), `new` or `off`           |
| `jux run --no-recheck`               | the same as `--recheck off`                                                       |
| `jux check`                          | exit non-zero if anything still needs review — for CI                             |
| `jux handoff <id>`                   | print an agent-ready prompt for one failing story                                 |
| `jux config --explain <id>`          | the effective settings for one story or variant key, and which layer set each     |
| `jux snap <url>… --as <name>`        | capture a page (or several with `--as-prefix`): pixels + structure, no workbench  |
| `jux diff <a> <b> --json`            | tier-0 verdict: what changed between two snaps, no browser                        |
| `jux diff <a> <b> --crops`           | the verdict plus side-by-side PNG strips per changed region, no browser           |
| `jux diff --runs <runA> <runB>`      | are two runs byte-identical? per-story hash comparison, no browser                |
| `jux browser install\|status\|path`  | install, inspect or locate the pinned browser                                     |
| `jux browser start\|stop`            | start or stop the warm browser (see [Warm browser](browser.md#warm-browser))      |

`jux <command> --help` (or `-h`) prints that command's usage and exits 0. An
unknown option, or a positional a command does not take (`jux run some-id`),
exits 2 with a one-line message; it is never ignored. Use `jux run --story <id>`
to run one story. A missing workbench exits 2 with its own message.

## Check the repo: `jux doctor`

`jux doctor` checks a project against the rule that it commits hashes and
structure, never images. It reads the repo and the config only, with no
workbench or browser, so it also works as a CI step.

It reports:

- `tracked-images`: baseline images tracked by git in the old layout or the
  cache directory. The fix runs `jux run --all` first, so the cache holds the
  images before the commit deletes them from other clones, then
  `git rm --cached -- ':(glob)<dir>/*.webp'`, the `.gitignore` line, and a
  commit. The pathspec is literal about the directory's own name.
- `legacy-sidecars`: per-story `.structure.json.gz` files tracked under
  `.juxtapose/baselines/`. Structure now lives in the manifest; the fix runs
  `jux doctor --fix` to fold it in, then untracks the files and commits the
  manifest. `--fix` copies each sidecar into the manifest entry it belongs to
  (the sidecar's hash matches the entry's, or, for an entry with none, the
  legacy image's hash does), and nothing else: no capture, no approval, no
  hash changes, so a failing story stays failing. A sidecar that does not match
  is left alone and named.
- `manifest-conflict`: `juxtapose.manifest.json` has merge conflict markers. It
  is a lockfile: take either side and re-approve, don't hand-merge. Other
  checks and `--fix` wait until it is regenerated.
- `untracked-images`: images that are neither tracked nor ignored, which the
  next `git add .` would commit.
- `committed-paths-ignored`: `.gitignore` (or another ignore file) ignores
  `juxtapose.manifest.json` or `juxtapose.config.json`, so `git add` skips them.
  `jux init` warns about the same thing. The pattern is yours to edit.
- `missing-ignores`: `.gitignore` lines the project needs. Git decides, so a
  broader pattern or a parent `.gitignore` counts.

A project that sets `storage.kind` to `git` or `fs` commits images on purpose,
so tracked images are not reported for it.

Pass `--project <dir>` to check another directory. The printed commands then use
`git -C <dir>` and absolute paths, so they work from where you are. A printed
command that uses pathspec magic (`:(glob)`, `:(literal)`) starts with
`GIT_LITERAL_PATHSPECS=0`, so it also works in a shell that exports
`GIT_LITERAL_PATHSPECS=1`.

`--json` prints `{ "ok": boolean, "issues": [{ "code", "message", "files?", "fix": [string] }] }`,
where `fix` is the commands to run, in order, each quoted for a POSIX shell.
Exit 0 means no issues, 1 means at least one.

## Which setting won: `jux config --explain`

Capture settings layer across the project config, a story's
`parameters.juxtapose`, the config's [`stories` overrides](configuration.md#override-stories-you-dont-own),
variants (with their `extends` chain), the live parameters the preview reports
once the story renders, and the flags of the command. `jux config --explain
<id>` runs the same resolution as `jux run` for one story and prints each
setting with its value and the layer that decided it. Nothing is captured.

```
$ jux config --explain card--default__mobile
card--default__mobile  (variant mobile of card--default)
matched stories globs: card--*, card--default__mobile

SETTING                   VALUE        SOURCE
skip                      false        default
viewport                  375x812      variant mobile (story parameters)
settle.timeout            4000         stories['card--default__mobile']
settle.ready              false        default
network.external.default  allow        default
network.external.images   placeholder  project config
threshold                 0.1          default
minDiffPercent            0            default
delay                     250          stories['card--*']

network rules (first match wins):
  allow       **/cdn/**  project config
```

`<id>` is a story id or a capture key (`<id>__<variant>`). A story id explains
its default capture and lists the capture keys of its variants. An id that
matches nothing exits 2 and suggests the closest ones. The settle,
`--network-external` and `--recheck` flags are accepted and show as `CLI flag`, so you can
check what a command would change before running it.

Sources are `default`, `project config`, `story parameters`,
`stories['<glob>']` (each glob that set the value, or all that contributed to a
list), `variant <name> (<where declared>)` (with `, extended by <name>` for a
variant reached through `extends`), `live params`, `CLI flag` and `MCP arguments` (the MCP tool's `settle`, `network` and `recheck`). A list that
unions across layers (`mask`, `settle.network.ignore`, `settle.network.require`)
shows each contributor joined by `+`.

`network.external` shows per resource type (`network.external.default`,
`.images`, `.frames`, `.media`), each with its layer. `network.rules` print
below the table in evaluation order: the first match wins, and a higher layer's
rules come first. `--json` carries them as `matched.networkRules`
(`{ match, action, source }`).

Some settings are read before the story renders, so a different value in its
live parameters is ignored: `network`, `captureTimeout`, `animations`,
`captureAfterPlay`, and the diff tolerances `threshold` and `minDiffPercent`.
They show the value that applies, from its real layer, and a note names the
ignored live value. A live `variants: { <name>: false }` skips that variant, and
shows as `skip true` from `live params`.

Discovery runs as it does for `jux run`, with the same cache. A platform that
reads parameters from the rendered preview (Storybook) also renders the one
story to read them, so the command needs the pinned browser then; `--chrome` and
`--no-daemon` work as they do for `jux run`.

`--json` prints `juxtapose.explain/v1`:

```json
{
  "schema": "juxtapose.explain/v1",
  "storyId": "card--default__mobile",
  "baseStoryId": "card--default",
  "variant": "mobile",
  "extends": ["dark"],
  "skipped": false,
  "matched": { "stories": ["card--*"], "networkRules": [] },
  "settings": [
    {
      "setting": "viewport",
      "value": { "width": 375, "height": 667 },
      "source": [{ "layer": "variant", "detail": "mobile (story parameters)" }]
    }
  ],
  "notes": []
}
```

`variants` (capture keys) appears on a story that has them, `extends` on a
variant that extends others (farthest first). `skipped` is true when the
capture is not taken; the `skip` setting names who skipped it. `layer` is one
of `default`, `project`, `story`, `stories`, `variant`, `live`, `cli`, `mcp`.
`notes` lists settings that cannot take effect where they were set, such as a
story's live `network.external`.

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
long (measured 1.7-2.0x on examples/storybook, linear in the story count), and
so does a run after a toolchain bump that fails everything.

### Choose what gets rechecked

The `recheck` config option and the `--recheck <mode>` flag of `jux run` choose
which stories the run captures twice:

| Mode        | Captures twice          | Use                                             |
| ----------- | ----------------------- | ----------------------------------------------- |
| `"changed"` | new and failing stories | Local and agent runs. The default.              |
| `"new"`     | new stories only        | CI, where many stories fail on purpose in a PR. |
| `"off"`     | nothing                 | The fastest run. `jux approve` confirms.        |

`--no-recheck` is the same as `--recheck off`. The flag overrides the config,
and `jux config --explain` shows the effective value and its source:

```text
recheck                   off          CLI flag
```

Approval stays safe in every mode. A story the run didn't capture twice has
`unrechecked: true` in `report.json`. `jux approve` (and the MCP `approve` tool)
captures it again first, which needs the same build or origin as `jux run` and
launches a browser, and approves it only if the two hashes match. A story that
comes out different is refused as unstable, and one that can't be captured
again is refused as unconfirmed. `--allow-unstable` skips the extra capture.
The confirming capture uses the project config, not the settle flags you
passed to `jux run`, and it needs the same browser and operating system as the
run: otherwise it refuses the story and tells you to run again.

With the recheck off, stories carry no `unstable` and no `flake`: nothing was
compared, so there is nothing to explain. `report.json` has `recheck: "off"`,
and `jux run` prints a line saying so. The Storybook panel's approve button
refuses an `unrechecked` story; use `jux approve`. `jux init` always rechecks.

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

| Cause              | Evidence                                                                                   | Fix                                                                  |
| ------------------ | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| `settle-timeout`   | A third-party image or frame was still loading at the settle cap.                          | A `network.rules` placeholder for that host and type. Never a block. |
| `external-image`   | A third-party image or background is where the pixels changed.                             | `network.external.images: "placeholder"`.                            |
| `embed`            | A third-party iframe is where the pixels changed.                                          | `network.external.frames: "placeholder"`.                            |
| `order-dependence` | A capture ran in a renderer process an earlier story had used, and `freshRenderer` is off. | `freshRenderer: true` (project setting; it has no per-story form).   |
| `async-element`    | An element is in only one of the two captures.                                             | `waitForSelector` for that element.                                  |
| `clock`            | Text that changed holds a time, a date or a duration.                                      | `mask` for that element.                                             |
| `random-content`   | Other text changed.                                                                        | `mask` for that element (low confidence).                            |
| `render-drift`     | The page structure is identical and under 2% of pixels differ.                             | None. Report a jux bug and confirm `freshRenderer`.                  |
| `unknown`          | None of the above.                                                                         | None.                                                                |

When three or more unstable stories in one run share a cause and a third-party
host (`external-image`, `embed`), or are `order-dependence`, `report.json` also
has a run-level `flakeGroups: [{ cause, host?, storyIds, fix }]`, where `fix`
is one project-level patch (for a host, a `network.rules` entry for
`type:Image https://<host>/**`, or `type:Document` for frames). Each story keeps its own `flake`. `jux run` and
`jux diff --runs` print one line for each group in place of the per-story
lines, and `jux handoff` adds it to a story in the group. Date and time
recognition covers numeric, English, German, French, Spanish, Italian,
Portuguese, Dutch and CJK dates, weekday names, and "today", "yesterday" and
"tomorrow"; a changed label that holds a weekday word counts as a clock.

`confidence` is `high`, `medium` or `low`. The cause is a diagnosis from the two
captures, not a proof (partial evidence, such as a truncated request list, is `low`): check that the fix is what you intend before you apply
it. An `async-element` fix waits for the element that is in only one capture,
which is the wrong one if that element is a spinner that went away.

Fix the cause: `mask` the changing region, add a `stories` override in config,
or keep `freshRenderer` on (the default). With `freshRenderer: false` or
`warmSwitch: true` a story's pixels can depend on the one captured before it,
so a story can be refused for an order dependence that those settings cause.
For a story that is nondeterministic by design, pass `--allow-unstable` to
`jux approve` or `jux init` (MCP: `allowUnstable`).
