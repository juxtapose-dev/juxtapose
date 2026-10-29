# @juxtapose/adapter-storybook

## 0.4.31

### Patch Changes

- Updated dependencies [c58e1bc]
  - @juxtapose/core@0.25.1

## 0.4.30

### Patch Changes

- Updated dependencies [129c399]
- Updated dependencies [d22d8db]
- Updated dependencies [eabc743]
  - @juxtapose/core@0.25.0

## 0.4.29

### Patch Changes

- Updated dependencies [c7f42ef]
- Updated dependencies [5a7bae3]
  - @juxtapose/core@0.24.2

## 0.4.28

### Patch Changes

- Updated dependencies [46b49ec]
- Updated dependencies [b00d733]
- Updated dependencies [2bc87d1]
  - @juxtapose/core@0.24.1

## 0.4.27

### Patch Changes

- Updated dependencies [3440b1b]
- Updated dependencies [28de788]
  - @juxtapose/core@0.24.0

## 0.4.26

### Patch Changes

- Updated dependencies [cdbf28d]
  - @juxtapose/core@0.23.3

## 0.4.25

### Patch Changes

- 95a846a: Keep Storybook's preview root out of component diff explanations. Preserve component children, inherited style changes, and portals, including comparisons against existing baselines.
- Updated dependencies [95a846a]
  - @juxtapose/core@0.23.2

## 0.4.24

### Patch Changes

- Updated dependencies [aa9878e]
  - @juxtapose/core@0.23.1

## 0.4.23

### Patch Changes

- Updated dependencies [a65a610]
  - @juxtapose/core@0.23.0

## 0.4.22

### Patch Changes

- Updated dependencies [a5ca6bd]
- Updated dependencies [be525cc]
  - @juxtapose/core@0.22.0

## 0.4.21

### Patch Changes

- 42eac75: Load only selected stories during Storybook parameter discovery, and include the selection in discovery cache keys so partial results cannot be reused for full runs. Preserve whole-store extraction for full selections and previews without per-story loading support.
- Updated dependencies [7239da1]
- Updated dependencies [87dfe16]
- Updated dependencies [5ae3ce9]
- Updated dependencies [42eac75]
- Updated dependencies [9dbf3bc]
  - @juxtapose/core@0.21.0

## 0.4.20

### Patch Changes

- Updated dependencies [41f0c65]
  - @juxtapose/core@0.20.2

## 0.4.19

### Patch Changes

- Updated dependencies [0751c38]
  - @juxtapose/core@0.20.1

## 0.4.18

### Patch Changes

- Updated dependencies [25261d6]
  - @juxtapose/core@0.20.0

## 0.4.17

### Patch Changes

- af4e714: Report HTTP error documents as capture errors instead of visual regressions. Keep diagnostic screenshots without approvable hashes, include Retry-After guidance, and stop scheduling captures after a rate-limited or unavailable workbench returns 429 or 503.

  Hosted Storybook index failures now report HTTP status and Retry-After instead of suggesting that the build is missing.

- Updated dependencies [af4e714]
  - @juxtapose/core@0.19.1

## 0.4.16

### Patch Changes

- Updated dependencies [9461f93]
  - @juxtapose/core@0.19.0

## 0.4.15

### Patch Changes

- Updated dependencies [1dda4b6]
- Updated dependencies [1dda4b6]
  - @juxtapose/core@0.18.4

## 0.4.14

### Patch Changes

- Updated dependencies [0dde787]
  - @juxtapose/core@0.18.3

## 0.4.13

### Patch Changes

- bea2cfd: Capture navigations set Storybook's `a11y.manual` global, so addon-a11y no longer runs axe-core in each story's afterEach while jux captures it. On a very large story axe held the page's main thread past the 60 s story budget: Primer's `treeview-features--contain-intrinsic-size` (110k elements) failed on every run and now captures in seconds. Hashes of other stories are unchanged.

## 0.4.12

### Patch Changes

- Updated dependencies [6dac140]
  - @juxtapose/core@0.18.2

## 0.4.11

### Patch Changes

- Updated dependencies [62fb1ec]
  - @juxtapose/core@0.18.1

## 0.4.10

### Patch Changes

- Updated dependencies [f5c1b67]
  - @juxtapose/core@0.18.0

## 0.4.9

### Patch Changes

- Updated dependencies [d7558ed]
  - @juxtapose/core@0.17.0

## 0.4.8

### Patch Changes

- Updated dependencies [34f879d]
  - @juxtapose/core@0.16.1

## 0.4.7

### Patch Changes

- Updated dependencies [7a53ce1]
- Updated dependencies [6ec8d81]
  - @juxtapose/core@0.16.0

## 0.4.6

### Patch Changes

- Updated dependencies [e3608de]
  - @juxtapose/core@0.15.0

## 0.4.5

### Patch Changes

- Updated dependencies [4638d64]
- Updated dependencies [b40e080]
- Updated dependencies [535c676]
- Updated dependencies [48258e9]
  - @juxtapose/core@0.14.0

## 0.4.4

### Patch Changes

- Updated dependencies [e2d1770]
- Updated dependencies [3668e0e]
- Updated dependencies [a7e5e61]
  - @juxtapose/core@0.13.0

## 0.4.3

### Patch Changes

- Updated dependencies [c602676]
- Updated dependencies [981f6b9]
- Updated dependencies [f251aa8]
- Updated dependencies [0807b4f]
- Updated dependencies [a646af0]
  - @juxtapose/core@0.12.0

## 0.4.2

### Patch Changes

- Updated dependencies [16d7ed3]
- Updated dependencies [8f38247]
- Updated dependencies [dc60343]
- Updated dependencies [c7f9ffb]
- Updated dependencies [255fc28]
  - @juxtapose/core@0.11.0

## 0.4.1

### Patch Changes

- Updated dependencies [746d075]
  - @juxtapose/core@0.10.0

## 0.4.0

### Minor Changes

- 8b80785: Per-story capture variants. Declare `variants` on a story's juxtapose params, on a URL entry, or project-wide in `juxtapose.config.json`, for example `{ "variants": { "dark": { "colorScheme": "dark" }, "mobile": { "viewport": { "width": 375, "height": 812 } } } }`. Each variant is captured, judged and approved on its own under the key `<story id>__<variant>`. A story can opt out of a project variant with `false`, and `extends` builds one variant on another. Existing baselines are default captures and keep passing.

  `jux run --story <id>` now works: a story id captures the story with all its variants, a capture key just that one, and an unknown id exits 2. The MCP `run` tool's `stories` argument now applies the same selection. `jux approve --story` and the MCP `approve` tool accept a story id to approve every variant in the run. Story ids in the commands that the PR comment and handoff print are now shell-quoted.

  `jux run --since` now captures every story when `juxtapose.config.json` or `.juxtaposerc.json` changes, because a project-wide variant there changes every story's captures. The exported `Page` interface gains an optional `setColorScheme`. A `Page` implemented outside core doesn't need it: core falls back to raw `Emulation.setEmulatedMedia`.

  Storybook story parameters are now read before capture. The adapter loads the preview once and reads every story's `parameters.juxtapose`, so story-level variants, `skip` and `viewport` apply from the first frame. Before this, they were only known after the story rendered. Platforms can provide the same through the new optional `Platform.discoverParams`. If discovery fails, jux warns and falls back to the index. A story skipped in its parameters no longer appears as a `skip` row in Storybook reports, which matches Ladle.

  CLI output and the PR comment show a variant as `story · variant` and count captures across stories. The HTML report nests variants under their story, and a handoff on a variant says what the variant sets. In the Storybook addon, a story's sidebar dot shows the worst status across its variants. The panel switches between the default capture and each variant, with "Approve all variants", and watch mode recaptures a story's variants. The review server expands a story id to its captures.

  Discovered parameters are cached in `.juxtapose/runs/.cache`, keyed by the built preview's `index.json` and `iframe.html`, so an unchanged static build skips the preview load. The cache is never used against a dev server. `jux run --since` now also captures every story when the project's own `package.json` changes, including a project in a subdirectory of its repository. `jux approve --story <story id>` only approves the captures that need it (changed, new or stale) when the story has variants in the run, and that rule covers the story's default capture too.

### Patch Changes

- Updated dependencies [9830e0d]
- Updated dependencies [8b80785]
  - @juxtapose/core@0.9.0

## 0.3.3

### Patch Changes

- Updated dependencies [6b98571]
  - @juxtapose/core@0.8.0

## 0.3.2

### Patch Changes

- Updated dependencies [dfb006b]
  - @juxtapose/core@0.7.0

## 0.3.1

### Patch Changes

- Updated dependencies [8ea2e71]
- Updated dependencies [a4593ae]
  - @juxtapose/core@0.6.0

## 0.3.0

### Minor Changes

- 31bc685: Capture through juxtapose's own CDP driver instead of Playwright. Captures stay byte-identical (verified on both example workbenches), so existing baselines remain valid and nothing needs re-approving.

  Playwright is no longer a dependency or peer dependency. The browser is a pinned `chrome-headless-shell` 151.0.7922.34, installed once with `npx -p @juxtapose/cli jux browser install` (also `jux browser status` and `jux browser path`). An existing `ms-playwright` cache of the same build is reused and nothing is downloaded. New: `JUX_CHROME=<path>` or `--chrome <path>` uses your own Chromium, and `JUX_CACHE_DIR` moves the cache.

  **Breaking:**

  - Mask and `--wait-for` selectors must be CSS. Playwright-only syntax (`text=`, `>>`, `:has-text()`, `:visible`, `nth=`) now fails the story with `jux: selector '…' is not a CSS selector` instead of silently matching nothing.
  - Node >= 22.2.0 is required (it was 20).
  - Adapters receive `@juxtapose/core`'s `Page`, not Playwright's. Third-party adapters that used Playwright-only `Page` methods need to move to the `Page` interface core exports.

### Patch Changes

- Updated dependencies [373ff1b]
- Updated dependencies [31bc685]
- Updated dependencies [e65f1bd]
- Updated dependencies [68c7ceb]
- Updated dependencies [966f6e7]
  - @juxtapose/core@0.5.0

## 0.2.2

### Patch Changes

- 474a0db: Add npm keywords and a homepage link to each package

  Nothing installed changes; this is what the registry listing shows and how the
  packages are found in search.

- Updated dependencies [474a0db]
- Updated dependencies [04615a6]
- Updated dependencies [f40f5cf]
  - @juxtapose/core@0.4.0

## 0.2.1

### Patch Changes

- 0c1826a: Explain why two packages both say "Storybook".

  `@juxtapose/storybook` is the addon you install; `@juxtapose/adapter-storybook`
  is how the CLI drives a browser, and arrives as a dependency. Nothing renamed —
  the addon keeps the short name, matching `@chromatic-com/storybook` — but the
  docs never said which was which, which made the split look backwards.

  The addon's directory is now `packages/storybook/` rather than
  `packages/addon-storybook/`, so every directory matches its published name.
  That mismatch is what produced a changeset naming a package that did not exist,
  which failed the release.

- Updated dependencies [c28a95a]
- Updated dependencies [b6dd903]
- Updated dependencies [c10ec5c]
- Updated dependencies [81fc005]
- Updated dependencies [77fac97]
- Updated dependencies [d47ddc4]
  - @juxtapose/core@0.3.0

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
