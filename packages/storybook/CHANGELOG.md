# @juxtapose/storybook

## 0.4.0

### Minor Changes

- bfb0e03: Add a pixel loupe to the compare panel

  The existing modes answer "did something move". None of them answer "is this one
  pixel or two", which is the question that blocks a review: a 1px border shift
  and an antialiasing change look identical at 1:1 and the diff overlay marks
  both.

  Hovering the comparison now magnifies the pixels under the cursor at 4x, with
  smoothing off so a magnified pixel reads as a pixel. Toggle it with the Loupe
  button or `z`. It works in every mode, and in side-by-side each pane magnifies
  its own image.

### Patch Changes

- 474a0db: Add npm keywords and a homepage link to each package

  Nothing installed changes; this is what the registry listing shows and how the
  packages are found in search.

- Updated dependencies [474a0db]
- Updated dependencies [04615a6]
- Updated dependencies [f40f5cf]
  - @juxtapose/core@0.4.0
  - @juxtapose/server@0.4.0
  - @juxtapose/adapter-storybook@0.2.2

## 0.3.0

### Minor Changes

- d47ddc4: Watch mode: recapture stories as you edit them.

  Storybook's own render event is the trigger rather than a file watcher — HMR
  rerenders a story, and the story knows which component file it came from, so
  there is no second source of truth about which files matter. A render counts as
  an edit only when no navigation preceded it, which is what separates "I saved a
  file" from "I clicked a story in the sidebar".

  Scope is every story sharing the edited component. When a static build is
  available the import graph widens that to dependents; the dev server has no
  bundler graph, so without one it stays at the component. `liveCapture: false`
  opts a story out of live recapture while leaving normal runs alone.

  Unlike `jux run`'s analysis, an uncertain answer here narrows rather than
  capturing everything: this fires on a keystroke pause, where escalating to the
  whole suite is a hang rather than a safety net. CI remains the backstop.

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

- 0c1826a: Explain why two packages both say "Storybook".

  `@juxtapose/storybook` is the addon you install; `@juxtapose/adapter-storybook`
  is how the CLI drives a browser, and arrives as a dependency. Nothing renamed —
  the addon keeps the short name, matching `@chromatic-com/storybook` — but the
  docs never said which was which, which made the split look backwards.

  The addon's directory is now `packages/storybook/` rather than
  `packages/addon-storybook/`, so every directory matches its published name.
  That mismatch is what produced a changeset naming a package that did not exist,
  which failed the release.

- 81fc005: Update sharp to ^0.35.3 for four libvips CVEs.

  CVE-2026-33327, -33328, -35590 and -35591 affect sharp below 0.35.0. This was
  the only advisory reaching published packages — the others `pnpm audit` reports
  are devDependencies (vitest, vite) or example-only.

  **This invalidates existing baselines.** The new libvips encodes identical
  pixels to different WebP bytes, so the first run after upgrading reports
  changes with `0.000%` mismatch and no changed regions — the images are
  pixel-for-pixel the same, only the encoding differs. Run `jux approve --all`
  once to re-anchor. Verified: two example stories failed at exactly 0 mismatched
  pixels, and `check:determinism` passes at 14/14 byte-identical across 3 runs
  on the new version, so encoding remains deterministic within it.

  Also declares `@emotion/react` as a devDependency of the addon. It was imported
  by `emotion.d.ts` and resolvable from nowhere; `skipLibCheck` hid it, which
  meant the `Theme` augmentation silently did not apply.

- Updated dependencies [c28a95a]
- Updated dependencies [b6dd903]
- Updated dependencies [0c1826a]
- Updated dependencies [c10ec5c]
- Updated dependencies [81fc005]
- Updated dependencies [77fac97]
- Updated dependencies [d47ddc4]
  - @juxtapose/core@0.3.0
  - @juxtapose/server@0.3.0
  - @juxtapose/adapter-storybook@0.2.1

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
  - @juxtapose/server@0.2.0
