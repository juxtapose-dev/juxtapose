# @juxtapose/cli

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
