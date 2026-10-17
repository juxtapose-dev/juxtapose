# Commands

| command                              | what it does                                                                      |
| ------------------------------------ | --------------------------------------------------------------------------------- |
| `jux init`                           | set up config and `.gitignore`, and capture the first baselines                   |
| `jux doctor [--fix]`                 | warn if baseline images are tracked by git, and print the migration commands      |
| `jux run`                            | capture affected stories and compare to baselines                                 |
| `jux run --since <ref>`              | capture only the stories a change since `<ref>` can reach (see below)             |
| `jux run --all`                      | capture everything, skipping change analysis                                      |
| `jux approve --all`                  | promote the last run's captures to baselines (hash and structure; image to cache) |
| `jux approve --story <id>`           | approve one story                                                                 |
| `jux approve --all --allow-unstable` | also approve stories whose two run captures differed (see below)                  |
| `jux run --recheck <mode>`           | which stories get a second capture: `changed` (default), `new` or `off`           |
| `jux run --no-recheck`               | the same as `--recheck off`                                                       |
| `jux check`                          | exit non-zero if anything still needs review — for CI                             |
| `jux handoff <id>`                   | print an agent-ready prompt for one failing story                                 |
| `jux reference [name] [--run <id>]`  | compare configured design PNGs with a saved run, without browser capture          |
| `jux config --explain <id>`          | the effective settings for one story or variant key, and which layer set each     |
| `jux snap <url>… --as <name>`        | capture a page (or several with `--as-prefix`): pixels + structure, no workbench  |
| `jux diff <a> <b> --json`            | tier-0 verdict: what changed between two snaps, no browser                        |
| `jux diff <a> <b> --crops`           | the verdict plus side-by-side PNG strips per changed region, no browser           |
| `jux diff --runs <runA> <runB>`      | are two runs byte-identical? per-story hash comparison, no browser                |
| `jux browser install\|status\|path`  | install, inspect or locate the pinned browser                                     |
| `jux browser start\|stop`            | start or stop the warm browser (see [Warm browser](browser.md#warm-browser))      |

`jux <command> --help` (or `-h`) prints that command's usage and exits 0. An
unknown option, or a positional a command does not take, exits 2 with a one-line
message; it is never ignored. A missing workbench exits 2 with its own message.

## Select specific examples

```sh
jux list
jux list 'components-button--*'
jux run components-button--basic components-button--loading
jux run 'components-button--*' --dry-run
jux run 'components-button--*'
```

`list` shows copyable capture IDs alongside titles and names. Positional selectors
and repeatable `--story` flags can be combined. They match IDs exactly or through
quoted globs: `*` matches any characters except `/`, `**` crosses `/`, and `?`
matches one non-`/` character. Quote globs so your shell does not expand them.
Selectors are case-sensitive and form a union without duplicate captures.
A base story match includes its variants; a complete variant key selects only
that capture. Use `'*__dark-mobile'` to select that variant across stories.
Every selector must match: a typo exits 2 and never falls back to capturing all.

Explicit selectors take precedence over `--all` and affected-story analysis.
`run --dry-run` prints the same selection it would capture; `list` selects from
all available stories by default. Neither takes screenshots nor writes a run,
config, or baseline manifest. Live parameters can require preview/browser
initialization, and discovery may populate its local cache.

With `--json`, both return `{schema: "juxtapose.selection/v1", count, captures}`.
Each capture has `storyId`, `title`, `name`, and `baseStoryId` for a variant.
Approval still uses exact reviewed IDs; run selection globs do not broaden it.

## Compare a saved run with design references

Add named `designReferences` to the project config (see [configuration](configuration.md#design-references)), then run `jux run` once to capture the exact story and variant keys. `jux reference` compares configured targets with capture keys present in that saved run; targets outside a subset run or skipped there are counted as `notCaptured`. `jux reference mobile --run r1` selects a name and a saved run; an explicitly named target absent from the run is an error. The command never launches Chrome or changes a baseline. Exit 0 means every evaluated target passes, 1 means a visual mismatch or incompatible geometry, and 3 means a missing or unreadable input or no configured target captured in the run. An empty comparison reports `outcome: "no-comparison"` and tells you to capture a referenced story or select another run.

The default output is a short ledger with the `notCaptured` count. It leads with the region containing the most changed pixels, not necessarily the topmost region. For a dominant color change it also shows the observed target/current colors; these are sampled co-located pixels, not inferred CSS values. `--json` returns `juxtapose.design-reference-set/v1`, including measured pixels, geometry, up to eight regions ranked by exact changed-pixel count, sampled visible color pairs (at most three), and stable region IDs. The color-pair counts are exact within a deterministic sample of at most one million image pixels and exclude antialias-only differences. `jux reference mobile --region <id> --json` returns one paired target/current PNG crop as base64. A region ID is derived from the image hashes and comparison settings; it remains valid after a process restart while those inputs remain the same.

The design-reference policy is Pixelmatch threshold `0.1` with antialiasing excluded. It is separate from approved-baseline `comparison` settings. A design PNG has no DOM snapshot, so these results report pixel evidence without claiming a CSS cause.

## Hosted uploads

`jux run --upload` uploads a completed run while retaining its local verdict.
`jux upload --run <directory>` uploads existing artifacts without recapturing;
its exit code reports transfer success. Both require a project token through
`JUXTAPOSE_TOKEN`. See [Hosted uploads](hosted-uploads.md) for setup, JSON output,
limits, CI association, and retries. Uploading does not approve snapshots.

## Capture only what a change reaches: `jux run --since`

`jux run --since <ref>` diffs the working tree against `<ref>` (committed,
uncommitted and untracked files all count) and captures the stories whose
import graph contains a changed file. Editing `ui/Legend.tsx` captures the
stories that import it, directly or through other modules. Without `--since`,
`jux run` captures everything and prints `no-baseline`, which means "no ref to
compare against".

The graph comes from the build. Vite's own manifest lists chunks, not the
modules bundled into them, so a shared component never appears in it. The
juxtapose Vite plugin records every source module and what it imports to
`.vite/juxtapose-modules.json` in the build directory:

- **Storybook:** automatic. The `@juxtapose/storybook` addon adds the plugin to
  `storybook build`. Rebuild after upgrading, since a build made earlier has no
  graph.
- **Ladle, or any Vite workbench:** add it to `vite.config.js`. Ladle reads that
  file for `ladle build`:

  ```js
  import { juxtaposeModuleGraph } from '@juxtapose/core/vite';

  export default { plugins: [juxtaposeModuleGraph()] };
  ```

  `@juxtapose/core` must be a direct dependency under pnpm.

You don't need `build.manifest: true` for this. The Vite manifest is still read
as a fallback for builds made without the plugin, and by the `cause` trace.

**What narrows: script modules only.** Editing a script module (`.js`, `.jsx`,
`.ts`, `.tsx`, `.mjs`, `.cjs`, `.mts`, `.cts`, `.vue`, `.svelte`, `.astro`,
`.mdx`) captures the stories that import it. The graph is the bundler's own
import graph (static and dynamic `import`, `import.meta.glob`) plus
`new URL('./x', import.meta.url)`. **Editing a stylesheet or any other asset
runs every story** (`asset-changed`): Tailwind, PostCSS and Sass rewrite
`@import`, `@use` and `url()` before anything could read them, so jux does not
guess at those edges. Modules under `node_modules` are left out (a dependency
change arrives as a lockfile change).

**What escalates.** Unknown means everything. Each of these captures every
story, and the line `jux run` prints says why:

| printed reason                                                   | why it captured everything                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dependency-changed`                                             | a lockfile changed (also a project's own, one level below the repository root)                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `config-changed`                                                 | `tsconfig*.json`, a juxtapose config or the project's `package.json`, or a workbench config dir (`.storybook`, `.ladle`) changed                                                                                                                                                                                                                                                                                                                                                                                 |
| `unmapped-change: <file> …`                                      | a changed file is not in the build's module graph (a server file, a deleted module, one added since the build); anything under `public/`, which is fetched by URL; a file a build plugin read from disk to make a virtual module (`<file> is read by a build plugin, not imported`); or any change at all when the build has a worker, worklet, service worker, computed `new URL` path, or a virtual module from a plugin other than Vite, Storybook or Ladle. One such file is enough, even beside mapped ones |
| `shared-entry-changed: <file> is imported …`                     | a changed file is in the import closure of something that runs for every story: a module under `.storybook`/`.ladle` (the preview, even when each story imports it, as CSF factories do) or a module no story imports. Docs pages (`.mdx`) are leaves, not entries                                                                                                                                                                                                                                               |
| `asset-changed: <file> (stylesheets and assets aren't narrowed)` | a changed file that is not a script module: a stylesheet, image, font, JSON, markdown in the source tree, or any other asset. Also any `.vue`/`.svelte` edit when the build has `cssCodeSplit: false`, since every style block then reaches every story                                                                                                                                                                                                                                                          |
| `origin-run`                                                     | `--origin` captures a running server, not the build in the build dir, so that build's graph does not describe it                                                                                                                                                                                                                                                                                                                                                                                                 |
| `stale-graph`                                                    | the content of a changed file or of any module in the graph differs from what the build recorded (a sha256 per file): rebuild the workbench before `--since`                                                                                                                                                                                                                                                                                                                                                     |
| `graph-root-mismatch`                                            | the build was made from another directory than the jux project root; the message names both. Build from the project root, or set `JUXTAPOSE_ROOT` for the build                                                                                                                                                                                                                                                                                                                                                  |
| `no-match-fallback`                                              | no module graph in the build (the detail says to add the plugin and rebuild), or the changed files reach no story                                                                                                                                                                                                                                                                                                                                                                                                |
| `git-unavailable`                                                | git could not list the changes (not a repository, or `<ref>` unusable)                                                                                                                                                                                                                                                                                                                                                                                                                                           |

Only two things never reach a story and never escalate: anything under
`.github/`, and a repo-root meta file (`README*`, `LICENSE*`, `CHANGELOG*`,
`CONTRIBUTING*`, `CODE_OF_CONDUCT*`, `SECURITY*`). Even those count once the
graph contains them or another module with the same extension (an
`import.meta.glob('*.md')` loads every markdown file).
A story whose file is missing from the graph is always captured.

**Rebuild before every `--since` run.** The captures come from the build, so a
build older than your edit would be captured as it was. The graph records a
sha256 of every source file as the build read it and refuses (`stale-graph`) when
a changed file, or any file in the graph, now differs or is gone. It compares
content, not modification times, so a fresh checkout after the build (split CI)
is not stale. Under a webpack Storybook builder there is no graph and narrowing
is not available.

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
  `.juxtapose/baselines/`. Structure now lives in readable `juxtapose.structures/` files;
  `jux doctor --fix` migrates it, then untrack the old files and commit the
  manifest and structure directory. `--fix` also migrates existing inline
  structures. It copies each legacy sidecar only when it belongs to the entry
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

When you use `--origin`, jux doesn't serve a build, and `--since` captures every
story (`origin-run`): the running server is not the build in the build dir, so
that build's import graph can't describe it. See [Capture a built or deployed Storybook](configuration.md#capture-a-built-or-deployed-storybook)
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
again is refused as unconfirmed. Every selected story, including one already
rechecked, is confirmed on a fresh renderer. `--allow-unstable` can waive an
earlier instability verdict, but cannot skip this capture or approve a hash
different from the reviewed run.
The confirming capture uses the project config, not the settle flags you
passed to `jux run`, and it needs the same browser and operating system as the
run: otherwise it refuses the story and tells you to run again. Render flags that only
`jux run` took, such as `--no-fresh-renderer` and the settle flags, aren't
replayed, so a story that depended on them can differ and be refused; approval
errs toward refusing, never toward granting. `jux approve` accepts `--chrome`
and `--no-daemon` so the confirming capture can use the browser the run used.

With the recheck off, stories carry no `flake`: nothing was compared, so
there is nothing to explain. Each story captured once has `unrechecked: true`
and also a placeholder `unstable: { unconfirmed: "not rechecked (recheck <mode>)" }`,
so an older `jux approve`, review server or Storybook panel, which only read
`unstable`, refuse it instead of baselining one capture. The current
`jux approve` keys on `unrechecked` and confirms the story. `report.json` has
`recheck: "off"`, and `jux run` prints a line saying so. The Storybook panel's
approve button also confirms on a fresh renderer.
`jux init` always uses fresh renderers and rechecks.

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
| `order-dependence` | A capture ran in a renderer process an earlier story had used, and `freshRenderer` is off. | `renderer: { shared: false }` (project or per-story).                |
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
or use `renderer: { shared: false }` for the affected stories. Shared rendering
is the default and retries baseline mismatches with a cache pulse and then a
fresh renderer. With shared rendering or
`warmSwitch: true` a story's pixels can depend on the one captured before it,
so a story can be refused for an order dependence that those settings cause.
For a story that is nondeterministic by design, pass `--allow-unstable` to
`jux approve` or `jux init` (MCP: `allowUnstable`).
