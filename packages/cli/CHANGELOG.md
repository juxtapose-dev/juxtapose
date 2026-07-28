# @juxtapose/cli

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
