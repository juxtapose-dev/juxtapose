# @juxtapose/cli

## 0.10.0

### Minor Changes

- 746d075: Event-driven settle. Instead of waiting for 150 ms without DOM changes (capped at 500 ms), juxtapose now waits until the page has no pending timers due within 1000 ms, animation frames, posted messages, DOM changes, loading fonts, loading in-viewport images or network requests in flight. On the example workbenches the captures are byte-identical to before, and settling takes about 40 ms per story instead of about 165 ms. Pages that finish late, such as a 300 ms timer or a slow fetch, are now captured in their final state.

  The wait is capped by `settle.timeout` (default 1500 ms). At the cap the page is captured anyway, and the result is flagged `settle-timeout` with a list of what was still pending, such as `1 request to /api/feed in flight (Fetch)`. The flag appears in `DiffResult.flags` and `DiffResult.settle`, in the verdict's `flags`, in `jux snap` results, in `jux run` output and in `jux handoff`. It never changes a pass or a failure. If the wait can't run (for example, the page navigated during it), juxtapose waits for fonts, images and a quiet DOM instead and flags the result `settle-fallback`.

  New settle options, layered from the project config through story parameters (including variants) to the command: `settle.timeout`, `settle.ready` (wait for the page to call `window.__juxtapose.ready()`), `settle.network.ignore` and `settle.network.require` (URL glob patterns with an optional `type:<ResourceType>`). WebSocket, EventSource, beacon and prefetch requests are ignored by default. The project config also accepts `waitForSelector` and `delay`. `jux snap` and `jux run` take `--settle-timeout`, `--settle-ready`, `--no-settle-ready`, `--settle-ignore` and `--settle-require`, `jux snap` takes `--delay`, and the MCP `snap` and `run` tools take a `settle` argument (and `delay` on `snap`). An invalid settle option exits 2 and names where it came from; the review server reports an invalid project `settle` as a config error.

  Fixes a hang: the image wait before capture had no cap, so a story with an image that never loaded held its worker until the page's 30 s evaluation timeout. Images are now part of the capped wait, and a lazy image outside the viewport is not waited for.

  The exported `Page` interface gains an optional internal `on` for CDP events; a `Page` implemented outside core doesn't need it.

### Patch Changes

- 3ccb1e4: Fix truncated `--json` output when stdout is a pipe (#135). The CLI called `process.exit()` as soon as a command returned. Pipes are asynchronous on macOS, so output still queued in the process was dropped and a reader saw at most 64 KiB. The CLI now waits for stdout and stderr to drain, up to 30 seconds, before exiting. This applies to every command.
- Updated dependencies [746d075]
  - @juxtapose/core@0.10.0
  - @juxtapose/adapter-ladle@0.3.5
  - @juxtapose/adapter-storybook@0.4.1

## 0.9.0

### Minor Changes

- 8b80785: Per-story capture variants. Declare `variants` on a story's juxtapose params, on a URL entry, or project-wide in `juxtapose.config.json`, for example `{ "variants": { "dark": { "colorScheme": "dark" }, "mobile": { "viewport": { "width": 375, "height": 812 } } } }`. Each variant is captured, judged and approved on its own under the key `<story id>__<variant>`. A story can opt out of a project variant with `false`, and `extends` builds one variant on another. Existing baselines are default captures and keep passing.

  `jux run --story <id>` now works: a story id captures the story with all its variants, a capture key just that one, and an unknown id exits 2. The MCP `run` tool's `stories` argument now applies the same selection. `jux approve --story` and the MCP `approve` tool accept a story id to approve every variant in the run. Story ids in the commands that the PR comment and handoff print are now shell-quoted.

  `jux run --since` now captures every story when `juxtapose.config.json` or `.juxtaposerc.json` changes, because a project-wide variant there changes every story's captures. The exported `Page` interface gains an optional `setColorScheme`. A `Page` implemented outside core doesn't need it: core falls back to raw `Emulation.setEmulatedMedia`.

  Storybook story parameters are now read before capture. The adapter loads the preview once and reads every story's `parameters.juxtapose`, so story-level variants, `skip` and `viewport` apply from the first frame. Before this, they were only known after the story rendered. Platforms can provide the same through the new optional `Platform.discoverParams`. If discovery fails, jux warns and falls back to the index. A story skipped in its parameters no longer appears as a `skip` row in Storybook reports, which matches Ladle.

  CLI output and the PR comment show a variant as `story · variant` and count captures across stories. The HTML report nests variants under their story, and a handoff on a variant says what the variant sets. In the Storybook addon, a story's sidebar dot shows the worst status across its variants. The panel switches between the default capture and each variant, with "Approve all variants", and watch mode recaptures a story's variants. The review server expands a story id to its captures.

  Discovered parameters are cached in `.juxtapose/runs/.cache`, keyed by the built preview's `index.json` and `iframe.html`, so an unchanged static build skips the preview load. The cache is never used against a dev server. `jux run --since` now also captures every story when the project's own `package.json` changes, including a project in a subdirectory of its repository. `jux approve --story <story id>` only approves the captures that need it (changed, new or stale) when the story has variants in the run, and that rule covers the story's default capture too.

### Patch Changes

- 9830e0d: Capture no longer depends on repaint timing: Chrome launches with `--disable-partial-raster`. A repaint re-rastered only its invalidated rect, and a rounded border on that rect's edge rasterized a few pixels differently, so about 1 capture in 600 on Linux differed from the rest (issue #120). Pages that never repaint capture the same bytes as before. A warm browser started by an older jux is not reused, because the daemon key covers the flags.
- Updated dependencies [9830e0d]
- Updated dependencies [8b80785]
  - @juxtapose/core@0.9.0
  - @juxtapose/adapter-storybook@0.4.0
  - @juxtapose/adapter-ladle@0.3.4

## 0.8.1

### Patch Changes

- 6b98571: CDP calls are typed through Chrome's own protocol definitions (`devtools-protocol`, a types-only dependency of `@juxtapose/core`, pinned to the protocol revision of the pinned Chrome), and JSON read from disk or the wire is checked where it enters instead of cast. `Page.send` infers params and results for protocol methods; an untyped fallback overload keeps existing `page.send<T>('Method', params)` calls, and methods newer than the pinned protocol, compiling unchanged. New exports `parseRunReport` and `isRunReport` read a `report.json`. Files that are not what they claim now fail with a message at the boundary: a `report.json` that is not a run report, a structure sidecar that is not one `jux` wrote (read as absent, like a corrupt one), and a review-server `/run` body whose `storyIds` is not a list of ids (400). The Storybook addon now calls `addons.add` bound to `addons`. Capture output is unchanged.
- Updated dependencies [6b98571]
  - @juxtapose/core@0.8.0
  - @juxtapose/adapter-ladle@0.3.3
  - @juxtapose/adapter-storybook@0.3.3

## 0.8.0

### Minor Changes

- dfb006b: `jux mcp` runs tool calls in parallel when they touch different files. Snaps
  with different names capture at the same time (each in its own browser
  context, byte-identical to a snap taken alone); a `diff` waits for any snap
  writing its inputs; `run` and `approve` still run alone. Calls that conflict
  start in the order the server reads them, even when sent in one write, and a
  waiting `run` is never starved. A call id that is still in progress is refused
  with `-32600`, and a `project` inside `.juxtapose` is refused. Four
  snaps through one server took 299 ms instead of 1028 ms on a 15-core M5 Pro.

  The snap limit defaults to half the CPU cores, from 1 up to 4, and is set with `mcp.concurrency` in `juxtapose.config.json` or `jux mcp --concurrency <n>` (1 to 16).

### Patch Changes

- Updated dependencies [dfb006b]
  - @juxtapose/core@0.7.0
  - @juxtapose/adapter-ladle@0.3.2
  - @juxtapose/adapter-storybook@0.3.2

## 0.7.0

### Minor Changes

- 93e4dbd: Add `jux mcp`, a Model Context Protocol server on stdio for coding agents. It exposes six tools (`snap`, `diff`, `run`, `check`, `handoff`, `approve`) that return the same JSON as the matching commands with `--json`, and it keeps one browser open for the whole session. `approve` takes explicit story ids only. See `docs/mcp.md`.

  `jux snap --viewport` now accepts each side from 1 to 10000 and reports anything larger as a usage error. `jux approve --json` now prints `{"approved":[],"failed":[]}` when there is nothing to approve, instead of printing nothing.

## 0.6.0

### Minor Changes

- a4593ae: Keep one browser warm between `jux snap`, `jux run` and `jux init` invocations (per user and rendering environment, idle exit after 10 minutes). It is off in CI, on Windows, with `--no-daemon`, and with `JUX_NO_DAEMON=1`. Captures are byte-identical warm and cold. `jux browser start|stop|status` manage it. The daemon's socket and state live in `JUX_STATE_DIR`, which defaults to the cache dir (`JUX_CACHE_DIR`) so existing setups do not move.

### Patch Changes

- Updated dependencies [8ea2e71]
- Updated dependencies [a4593ae]
  - @juxtapose/core@0.6.0
  - @juxtapose/adapter-ladle@0.3.1
  - @juxtapose/adapter-storybook@0.3.1

## 0.5.0

### Minor Changes

- 373ff1b: `jux run --since` says why a story changed: the verdict gains `cause`, the
  story's import closure intersected with the changed files, with
  `partial: true` when that closure could not be fully traced. `RunReport.groups`
  lists every change shared by two or more failing stories. `jux diff --crops`
  writes side-by-side strips per changed region (`juxtapose.crops/v1`), no
  browser (below the pixel tolerance, the changed elements instead); `jux
handoff` ends with that command. Core exports `shellQuote`. A child whose box only
  followed its parent's move or resize is no longer a delta. A Claude Code
  plugin with the `visual-check` skill lives in `plugins/claude-code/`. The review server's merged reports regroup over all results.
- 31bc685: Capture through juxtapose's own CDP driver instead of Playwright. Captures stay byte-identical (verified on both example workbenches), so existing baselines remain valid and nothing needs re-approving.

  Playwright is no longer a dependency or peer dependency. The browser is a pinned `chrome-headless-shell` 151.0.7922.34, installed once with `npx -p @juxtapose/cli jux browser install` (also `jux browser status` and `jux browser path`). An existing `ms-playwright` cache of the same build is reused and nothing is downloaded. New: `JUX_CHROME=<path>` or `--chrome <path>` uses your own Chromium, and `JUX_CACHE_DIR` moves the cache.

  **Breaking:**

  - Mask and `--wait-for` selectors must be CSS. Playwright-only syntax (`text=`, `>>`, `:has-text()`, `:visible`, `nth=`) now fails the story with `jux: selector '…' is not a CSS selector` instead of silently matching nothing.
  - Node >= 22.2.0 is required (it was 20).
  - Adapters receive `@juxtapose/core`'s `Page`, not Playwright's. Third-party adapters that used Playwright-only `Page` methods need to move to the `Page` interface core exports.

- 68c7ceb: Structural diff and `jux diff`: two structure sidecars plus the pixel diff
  become a deterministic tier-0 verdict (`juxtapose.verdict/v1`) — what
  changed, by how much, whether it explains every changed pixel, with risk
  flags. `jux run` attaches it to failing stories as `results[].structural`;
  `jux handoff` leads with it. `jux snap` takes several urls with
  `--as-prefix`, one browser launch; `jux diff --prefix before after` verdicts
  every page.
- 966f6e7: Capture a structure snapshot sidecar per story, add a URL platform, and add `jux snap`.

### Patch Changes

- Updated dependencies [373ff1b]
- Updated dependencies [31bc685]
- Updated dependencies [e65f1bd]
- Updated dependencies [68c7ceb]
- Updated dependencies [966f6e7]
  - @juxtapose/core@0.5.0
  - @juxtapose/adapter-storybook@0.3.0
  - @juxtapose/adapter-ladle@0.3.0

## 0.4.0

### Minor Changes

- 04615a6: Report per-phase timings on `jux run`

  A run reported one total, which is enough to know it was slow and not enough to
  know why:

  ```
  15 pass   (1.0s)
    enumerate 5ms | launch 137ms | baselines 1ms | capture 1.0s
  ```

  `diff(N)` reports how many diffs actually ran. Under a byte-exact hash that is
  the figure that explains a slow run, since diffing is a cold path only reached
  by stories that already failed:

  ```
  10 pass  ·  5 fail   (0.9s)
    enumerate 5ms | launch 76ms | diff(5) 110ms | capture 828ms
  ```

  Capture is measured across the whole streamed loop rather than summed per
  story, because the pool runs several pages at once and summing would report
  multiples of the wall-clock actually spent.

- f40f5cf: Record what captured each baseline

  Baselines now carry a `CaptureEnv` — browser version, OS/arch, and the libvips
  that encoded the WebP. Under a byte-exact hash a toolchain bump and a real
  regression look identical, so an all-red suite could not be explained. This is
  the fact that explains it.

  The encoder is a separate field because it moves bytes far more readily than the
  browser does. Measured on the examples: a libvips bump changed all 17 baseline
  hashes with zero changed pixels, while Chromium 149 to 151 left 16 of 18 stories
  byte-identical.

  Existing baselines have no fingerprint and are left alone; an unknown
  environment is treated as unknown rather than as current, so nothing is
  silently assumed to match. Approvals made from the CLI, from `init`, and from
  the addon panel all record it.

### Patch Changes

- 857c104: Fix `jux check` clearing every visual regression

  `check` decided a story was approved if the manifest merely had an entry for it.
  `resolveStatus` only reports `changed` when an entry already exists, so every
  real regression had one and every real regression was cleared. `jux check`
  exited 0 on a suite `jux run` had just failed, which is worse than no gate
  because CI looks green.

  It now confirms the approval against the bytes, comparing the run's captured
  image to the manifest hash the way the addon already does. A capture that cannot
  be read blocks rather than clears.

  Verified end to end against `examples/storybook`: a colour change failing 5
  stories now exits 1 and names them, and `jux approve --all` returns it to 0.

- 474a0db: Add npm keywords and a homepage link to each package

  Nothing installed changes; this is what the registry listing shows and how the
  packages are found in search.

- Updated dependencies [474a0db]
- Updated dependencies [04615a6]
- Updated dependencies [f40f5cf]
  - @juxtapose/core@0.4.0
  - @juxtapose/adapter-storybook@0.2.2
  - @juxtapose/adapter-ladle@0.2.2

## 0.3.0

### Minor Changes

- 338110f: Add `jux --version`.

  There was no version flag at all. Packages version independently, so one number
  does not describe an install — this prints the whole set plus the Node version,
  which is what a bug report needs.

- c10ec5c: Make the PR comment a triage surface rather than a report.

  The heading now carries the decisive number — `3 visual changes need review —
largest 1.01%` — because it is the only part that renders in the PR timeline
  and in notification emails. Under a byte-exact hash a bare count cannot be
  acted on: three antialiasing hairs and three collapsed layouts both read as
  "3 changed".

  Fixes a correctness bug in the instructions: `jux approve` reads the last
  **local** run, so the `jux approve --all` the comment printed after a CI run
  either failed outright or silently approved a stale local run. Every command
  block now leads with `jux run`.

  Other changes: per-status guidance instead of one instruction for `fail`, `new`
  and `stale`; commands uncollapsed and prose collapsed, so a first-time reader
  does not pay a click to find the CTA; errors sorted above magnitude, and never
  offered as an approve target; `new` and `stale` cells say `first capture` and
  `pixels identical` rather than an em-dash; columns dropped when every row
  shares a value; pipes escaped so a story id or error message cannot corrupt the
  table.

  `DiffResult` now records the `viewport` a capture used. This fixes `jux
handoff` computing region-area percentages against the project default for any
  story with a per-story viewport override.

  `--html` is now registered in the argument parser — it previously worked only
  because unknown flags are tolerated.

### Patch Changes

- c28a95a: Trim the public API surface before it becomes a semver commitment.

  `@juxtapose/core` exported sixteen symbols with no consumer outside the package
  — `armSettle`, `waitForPaint`, `DOM_IDLE_MS`, `captureStory`, `capturePool`,
  `diffImages`, `computeChangedRegions` and similar. These are exactly the
  internals CLAUDE.md describes as load-bearing and easy to break, so publishing
  them invites downstream code to pin the parts that most need freedom to change.
  The barrel is now organised by who consumes it — adapter authors, store
  authors, run drivers, reporters — with a note saying so.

  `formatPercent` moves to `core` and is shared. It had five copies, one already
  stylistically drifted, and it encodes a product rule rather than a format: a
  real change must never display as "0.00%".

  `hashImage` is now exported and used by the review server, which had its own
  copy. Anything comparing against a manifest entry has to use the function the
  manifest was written with; a second implementation silently diverges the moment
  the algorithm changes.

- b6dd903: Remove two options that were declared but never read.

  `ProjectConfig.ignore` (glob patterns of story ids to never capture) and the
  CLI's `--force` flag both parsed fine and did nothing. Setting either was a
  silent no-op, which is worse than the option not existing — you would conclude
  the tool ignored your config rather than that the feature was never wired up.
  Use `parameters.juxtapose.skip` for the `ignore` case.

  Also corrects documentation that had drifted from the code ahead of the first
  publish: hosted S3 storage was advertised as available when the CLI throws on
  it, the HTML report and PR comments were listed as unbuilt after shipping, the
  settle pipeline was documented with animation-freezing in the wrong position
  (the exact ordering bug that was fixed), and the packages table omitted
  `@juxtapose/storybook` — the package you install for the addon.

- Updated dependencies [c28a95a]
- Updated dependencies [b6dd903]
- Updated dependencies [0c1826a]
- Updated dependencies [c10ec5c]
- Updated dependencies [81fc005]
- Updated dependencies [77fac97]
- Updated dependencies [d47ddc4]
  - @juxtapose/core@0.3.0
  - @juxtapose/adapter-storybook@0.2.1
  - @juxtapose/adapter-ladle@0.2.1

## 0.2.0

### Minor Changes

- 97b4994: Initial release.

  Visual regression testing for component workbenches, with Storybook and Ladle
  adapters behind a shared platform seam.

  - Pass/fail is a byte-exact hash against a committed manifest; the pixel diff is
    a cold path that only runs to explain a failure.
  - Baselines live in the repo by default, so approving a change is a reviewable
    diff in the pull request that caused it. S3/R2 is available behind the same
    interface.
  - Affected-story analysis walks the Vite build manifest and escalates to a full
    run on any uncertainty.
  - `jux handoff` emits an agent-ready prompt carrying exact mismatch figures and
    changed-region coordinates rather than screenshots.

### Patch Changes

- Updated dependencies [97b4994]
  - @juxtapose/core@0.2.0
  - @juxtapose/adapter-storybook@0.2.0
  - @juxtapose/adapter-ladle@0.2.0
