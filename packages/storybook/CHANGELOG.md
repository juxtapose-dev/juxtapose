# @juxtapose/storybook

## 0.6.0

### Minor Changes

- 8b80785: Per-story capture variants. Declare `variants` on a story's juxtapose params, on a URL entry, or project-wide in `juxtapose.config.json`, for example `{ "variants": { "dark": { "colorScheme": "dark" }, "mobile": { "viewport": { "width": 375, "height": 812 } } } }`. Each variant is captured, judged and approved on its own under the key `<story id>__<variant>`. A story can opt out of a project variant with `false`, and `extends` builds one variant on another. Existing baselines are default captures and keep passing.

  `jux run --story <id>` now works: a story id captures the story with all its variants, a capture key just that one, and an unknown id exits 2. The MCP `run` tool's `stories` argument now applies the same selection. `jux approve --story` and the MCP `approve` tool accept a story id to approve every variant in the run. Story ids in the commands that the PR comment and handoff print are now shell-quoted.

  `jux run --since` now captures every story when `juxtapose.config.json` or `.juxtaposerc.json` changes, because a project-wide variant there changes every story's captures. The exported `Page` interface gains an optional `setColorScheme`. A `Page` implemented outside core doesn't need it: core falls back to raw `Emulation.setEmulatedMedia`.

  Storybook story parameters are now read before capture. The adapter loads the preview once and reads every story's `parameters.juxtapose`, so story-level variants, `skip` and `viewport` apply from the first frame. Before this, they were only known after the story rendered. Platforms can provide the same through the new optional `Platform.discoverParams`. If discovery fails, jux warns and falls back to the index. A story skipped in its parameters no longer appears as a `skip` row in Storybook reports, which matches Ladle.

  CLI output and the PR comment show a variant as `story · variant` and count captures across stories. The HTML report nests variants under their story, and a handoff on a variant says what the variant sets. In the Storybook addon, a story's sidebar dot shows the worst status across its variants. The panel switches between the default capture and each variant, with "Approve all variants", and watch mode recaptures a story's variants. The review server expands a story id to its captures.

  Discovered parameters are cached in `.juxtapose/runs/.cache`, keyed by the built preview's `index.json` and `iframe.html`, so an unchanged static build skips the preview load. The cache is never used against a dev server. `jux run --since` now also captures every story when the project's own `package.json` changes, including a project in a subdirectory of its repository. `jux approve --story <story id>` only approves the captures that need it (changed, new or stale) when the story has variants in the run, and that rule covers the story's default capture too.

### Patch Changes

- 4303231: The **Visual** test provider now registers in Storybook's testing module. On Storybook 9 and 10 the addon reads `experimental_getTestProviderStore` from `storybook/manager-api`, where Storybook exports it, instead of from the manager `api` object. On Storybook 8.5 and 8.6 the addon uses the older test provider contract, so **Run tests** runs the visual suite there too.

  The review server's agent handoff now points at the baseline image in the baseline store, the same file `jux handoff` names. For a variant, that's the variant's own baseline. Before, it pointed at a run-dir path that nothing writes.

- Updated dependencies [9830e0d]
- Updated dependencies [8b80785]
- Updated dependencies [4303231]
  - @juxtapose/core@0.9.0
  - @juxtapose/adapter-storybook@0.4.0
  - @juxtapose/server@0.6.0

## 0.5.3

### Patch Changes

- 6b98571: CDP calls are typed through Chrome's own protocol definitions (`devtools-protocol`, a types-only dependency of `@juxtapose/core`, pinned to the protocol revision of the pinned Chrome), and JSON read from disk or the wire is checked where it enters instead of cast. `Page.send` infers params and results for protocol methods; an untyped fallback overload keeps existing `page.send<T>('Method', params)` calls, and methods newer than the pinned protocol, compiling unchanged. New exports `parseRunReport` and `isRunReport` read a `report.json`. Files that are not what they claim now fail with a message at the boundary: a `report.json` that is not a run report, a structure sidecar that is not one `jux` wrote (read as absent, like a corrupt one), and a review-server `/run` body whose `storyIds` is not a list of ids (400). The Storybook addon now calls `addons.add` bound to `addons`. Capture output is unchanged.
- Updated dependencies [6b98571]
  - @juxtapose/core@0.8.0
  - @juxtapose/server@0.5.3
  - @juxtapose/adapter-storybook@0.3.3

## 0.5.2

### Patch Changes

- Updated dependencies [dfb006b]
  - @juxtapose/core@0.7.0
  - @juxtapose/adapter-storybook@0.3.2
  - @juxtapose/server@0.5.2

## 0.5.1

### Patch Changes

- Updated dependencies [8ea2e71]
- Updated dependencies [a4593ae]
  - @juxtapose/core@0.6.0
  - @juxtapose/adapter-storybook@0.3.1
  - @juxtapose/server@0.5.1

## 0.5.0

### Minor Changes

- 31bc685: Capture through juxtapose's own CDP driver instead of Playwright. Captures stay byte-identical (verified on both example workbenches), so existing baselines remain valid and nothing needs re-approving.

  Playwright is no longer a dependency or peer dependency. The browser is a pinned `chrome-headless-shell` 151.0.7922.34, installed once with `npx -p @juxtapose/cli jux browser install` (also `jux browser status` and `jux browser path`). An existing `ms-playwright` cache of the same build is reused and nothing is downloaded. New: `JUX_CHROME=<path>` or `--chrome <path>` uses your own Chromium, and `JUX_CACHE_DIR` moves the cache.

  **Breaking:**

  - Mask and `--wait-for` selectors must be CSS. Playwright-only syntax (`text=`, `>>`, `:has-text()`, `:visible`, `nth=`) now fails the story with `jux: selector '…' is not a CSS selector` instead of silently matching nothing.
  - Node >= 22.2.0 is required (it was 20).
  - Adapters receive `@juxtapose/core`'s `Page`, not Playwright's. Third-party adapters that used Playwright-only `Page` methods need to move to the `Page` interface core exports.

- 095a958: Keep the review panel's keyboard flow working, and stop the diff hiding the change

  - **Comparison modes are now `s` (side by side), `w` (slider), `o` (onion) and `f` (flicker).** They used to be `1` to `4`, but Storybook already binds bare `1`, `2` and `3` to focus the sidebar, preview and panel, and its handler runs first. Pressing `2` for Slider moved focus into the preview iframe, and from then on `j`, `a` and the other shortcuts went to the story instead of the panel.
  - **The diff overlay now tints the current capture instead of covering it.** It was drawn at full opacity over Current. Because pixelmatch's output contains the whole frame, the reviewer saw a red silhouette and never the new render.
  - **A failing story whose diff marks no pixels now says so.** Before, it read "0% changed" next to Approve. This happens with a small colour change, such as `#2563eb` to `#1d4ed8`, that fails the byte hash but sits inside pixelmatch's colour tolerance. The panel now says the change is too subtle for the overlay and points to Flicker, and it hides the Diff and Unfocus toggles, which would show nothing.

### Patch Changes

- Updated dependencies [373ff1b]
- Updated dependencies [31bc685]
- Updated dependencies [e65f1bd]
- Updated dependencies [68c7ceb]
- Updated dependencies [966f6e7]
  - @juxtapose/core@0.5.0
  - @juxtapose/server@0.5.0
  - @juxtapose/adapter-storybook@0.3.0

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
