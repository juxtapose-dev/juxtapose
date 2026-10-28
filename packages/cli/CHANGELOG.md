# @juxtapose/cli

## 0.26.0

### Minor Changes

- 129c399: Compare saved runs as checkpoints and optionally return the checkpoint change and target progress with an MCP run. Keep saved-run selection stable when analysis caches change, and reject invalid checkpoints before capturing.

  Inspect saved elements and their ancestors, measured control geometry, named grid areas, exact pixel counts, and all saved changed regions. Read configured design targets before the first capture and request focused paired crops with context padding. Keep explanations distinct from approval and inferred CSS causes distinct from measured facts.

  Bound compact MCP evidence while preserving complete observations, repeated positions, and explicit omissions. Reuse validated analysis caches and allow exact MCP tool selection with `jux mcp --tools`. Experimental OCR/paint providers remain opt-in and are not enabled by the public CLI.

  Compare full-page reference extent mismatches over their shared pixels, count pixels present in only one image, and report a failing extent comparison instead of incompatible geometry. Preserve main's device emulation and full-page capture support; normalize scrolled structure coordinates against the captured viewport.

  Label the Storybook panel and test provider Juxtapose. Validate real MSW-backed stories in CI without adding MSW to the published addon dependencies.

- d22d8db: Add device presets. A `device` (`iphone-15`, `pixel-8`, `ipad`, the aliases `mobile`, `tablet` and `desktop`, or one you define under `devices`) sets the viewport and emulates the device: mobile layout, touch, user agent and client hints, at device scale factor 1. `orientation` rotates it. Use them with `jux snap --device` and `--orientation` (and the MCP `snap` tool), in project config, story parameters, URL entry `params` and variants. A baseline approved on another device is reported as `previous device emulation`. `jux snap --help` now lists `--viewport`. Captures with no device and no orientation are unchanged.
- eabc743: Add opt-in full-document capture: `jux snap <url> --full-page`, or `fullPage: true` for a story. The image covers the whole rendered document while the browser keeps its layout viewport, which full-page captures record as `layoutViewport`. Before capturing, the page is scrolled through once so lazy images and scroll-triggered reveals load and finish animating.

### Patch Changes

- a122587: List the distinct approved-to-current property and size changes, deduplicated across failing captures, in the compact MCP run result as `changesFromApproved`. A fact only one viewport shows, such as a mobile-only grid, no longer disappears behind a truncated group line.
- Updated dependencies [129c399]
- Updated dependencies [d22d8db]
- Updated dependencies [eabc743]
  - @juxtapose/core@0.25.0
  - @juxtapose/adapter-ladle@0.3.33
  - @juxtapose/adapter-storybook@0.4.30

## 0.25.1

### Patch Changes

- 83daa01: Explain stale baseline ancestry in compact MCP run results so agents do not reopen a full report or recapture images after an exact visual match.

## 0.25.0

### Minor Changes

- 978a0b1: Keep MCP `run` output bounded for large workbenches, with a read-only `report` tool for a saved run or one full story result. MCP sessions cache parsed saved reports; `run({report: 'full'})` retains the complete response.
- 5a7bae3: Let MCP agents request a saved previous/current image diff only when they need
  to inspect an edit. Keep target comparison as the default, return focused
  region crops on demand, and cache repeated saved-run comparisons in the MCP
  session.

### Patch Changes

- c7f42ef: Add a compact target-versus-current layout relationship to design-reference
  outline hints when two detected textboxes are clearly stacked in one image and
  side by side in the other. Include uniquely overlapping current textbox IDs as
  spatial hints so agents can act without requesting a crop in simple cases.
- Updated dependencies [c7f42ef]
- Updated dependencies [5a7bae3]
  - @juxtapose/core@0.24.2
  - @juxtapose/adapter-ladle@0.3.32
  - @juxtapose/adapter-storybook@0.4.29

## 0.24.1

### Patch Changes

- d7e5b46: Guide MCP agents to reuse saved visual evidence, run affected Storybook stories after coherent edits, and request reference detail or crops only for unresolved questions. Passing design-reference hints now tell agents they can stop querying even when more than eight targets passed.
- b00d733: Add a bounded image-outline observation to MCP design-reference run hints when matching border strokes reveal a meaningful layout difference. The observation uses saved images and the current DOM sidecar, abstains when evidence is weak, and leaves the visual verdict unchanged.
- 2bc87d1: Cache design-reference comparison metadata alongside each saved run, keyed by the reference and current image hashes, geometry, and comparison policy. Include the largest changed region's bounds in the compact MCP run hint so agents can locate it without requesting the full reference ledger.
- Updated dependencies [46b49ec]
- Updated dependencies [b00d733]
- Updated dependencies [2bc87d1]
  - @juxtapose/core@0.24.1
  - @juxtapose/adapter-ladle@0.3.31
  - @juxtapose/adapter-storybook@0.4.28

## 0.24.0

### Minor Changes

- 3440b1b: Compare saved story captures with configured design reference images. MCP runs automatically include compact target feedback for captured references; the CLI and MCP reference tools return an all-state result and allow agents to request a paired crop by region ID without recapturing the page.

### Patch Changes

- 60e0f5b: List passing design reference capture keys in the compact MCP run hint so agents can verify complete matches without requesting the full reference ledger.
- e2f9c23: State the exact geometry and Pixelmatch pass conditions in the compact design-reference MCP hint, so agents can verify target matches without a redundant full-ledger call.
- Updated dependencies [3440b1b]
- Updated dependencies [28de788]
  - @juxtapose/core@0.24.0
  - @juxtapose/adapter-ladle@0.3.30
  - @juxtapose/adapter-storybook@0.4.27

## 0.23.3

### Patch Changes

- Updated dependencies [cdbf28d]
  - @juxtapose/core@0.23.3
  - @juxtapose/adapter-ladle@0.3.29
  - @juxtapose/adapter-storybook@0.4.26

## 0.23.2

### Patch Changes

- Updated dependencies [95a846a]
  - @juxtapose/core@0.23.2
  - @juxtapose/adapter-storybook@0.4.25
  - @juxtapose/adapter-ladle@0.3.28

## 0.23.1

### Patch Changes

- Updated dependencies [aa9878e]
  - @juxtapose/core@0.23.1
  - @juxtapose/adapter-ladle@0.3.27
  - @juxtapose/adapter-storybook@0.4.24

## 0.23.0

### Minor Changes

- 41936d5: Add opt-in hosted review uploads with `jux run --upload` and `jux upload --run <directory>`. Preserve local verdicts and artifacts, validate credentials and images before uploading, and retain complete run diagnostics in the hosted report.
- a65a610: Keep baseline manifests small by writing readable per-story structure JSON under juxtapose.structures/. Compact repeated paths into relative segments with parent indexes, preserving original structure hashes and explanations. Add generated-file guidance, checksum-verified loading, commit instructions, and doctor migration for existing inline structures. Existing inline and legacy files remain readable.

### Patch Changes

- Updated dependencies [a65a610]
  - @juxtapose/core@0.23.0
  - @juxtapose/adapter-ladle@0.3.26
  - @juxtapose/adapter-storybook@0.4.23

## 0.22.0

### Minor Changes

- a5ca6bd: Add story listing, positional capture selectors, ID globs, and run dry-run output. CLI and MCP share variant-aware selection; unmatched selectors fail instead of silently broadening the capture. Approval remains explicit and uses exact reviewed IDs.

### Patch Changes

- be525cc: Batch manifest updates during init and bulk approval, avoiding repeated parsing and rewriting for every story. Write manifests through an atomic replacement while retaining the existing readable format and structure evidence.
- Updated dependencies [a5ca6bd]
- Updated dependencies [be525cc]
  - @juxtapose/core@0.22.0
  - @juxtapose/adapter-ladle@0.3.25
  - @juxtapose/adapter-storybook@0.4.22

## 0.21.0

### Minor Changes

- 87dfe16: Freeze animated GIF, WebP and APNG images on their first frame by default (#182). Set `freeze.images: false` to retain playback for a project.

  Add opt-in clock and random fixture controls (#146). `freeze.clock: true` starts `Date`, `Date.now()`, `Intl.DateTimeFormat` and `Temporal.Now` at 2024-01-01T12:00:00Z; an ISO 8601 instant selects another starting time. Timer callbacks advance the clock, with a fallback for synchronous clock polling; asynchronous callback order is not controlled. `freeze.random: true` seeds `Math.random`, `crypto.getRandomValues` and `crypto.randomUUID`. Both options default to `false`.

  Clock and random settings layer per project, story, variant and `stories` override; animated-image policy is project-wide. Types, JSON schema, configuration docs and `jux config --explain` describe the controls.

- 5ae3ce9: Capture lossless WebP directly in Chrome to avoid PNG decoding and Sharp re-encoding. Remove ICC metadata without changing pixels and reject lossy screenshots. Pixelmatch remains opt-in and can accept equivalent pixels without replacing approvals.

### Patch Changes

- 42eac75: Load only selected stories during Storybook parameter discovery, and include the selection in discovery cache keys so partial results cannot be reused for full runs. Preserve whole-store extraction for full selections and previews without per-story loading support.
- Updated dependencies [7239da1]
- Updated dependencies [87dfe16]
- Updated dependencies [5ae3ce9]
- Updated dependencies [42eac75]
- Updated dependencies [9dbf3bc]
  - @juxtapose/core@0.21.0
  - @juxtapose/adapter-storybook@0.4.21
  - @juxtapose/adapter-ladle@0.3.24

## 0.20.2

### Patch Changes

- Updated dependencies [41f0c65]
  - @juxtapose/core@0.20.2
  - @juxtapose/adapter-ladle@0.3.23
  - @juxtapose/adapter-storybook@0.4.20

## 0.20.1

### Patch Changes

- Updated dependencies [0751c38]
  - @juxtapose/core@0.20.1
  - @juxtapose/adapter-ladle@0.3.22
  - @juxtapose/adapter-storybook@0.4.19

## 0.20.0

### Minor Changes

- 25261d6: Add opt-in `comparison: { mode: "pixelmatch", threshold: 0.05 }` at project, story, variant, and override level. Exact SHA-256 matches remain the fast path and default. Hash mismatches can pass only with a verified baseline image, valid ancestry, equal dimensions, and zero pixels remaining after Pixelmatch color/antialias filtering. Reports identify visual-equivalence passes and preserve both exact hashes; approved baselines, fresh approval, and exact renderer recovery are unchanged.

### Patch Changes

- Updated dependencies [25261d6]
  - @juxtapose/core@0.20.0
  - @juxtapose/adapter-ladle@0.3.21
  - @juxtapose/adapter-storybook@0.4.18

## 0.19.1

### Patch Changes

- Updated dependencies [af4e714]
  - @juxtapose/core@0.19.1
  - @juxtapose/adapter-storybook@0.4.17
  - @juxtapose/adapter-ladle@0.3.20

## 0.19.0

### Minor Changes

- 9461f93: Add project and per-story `renderer: { shared, clearResourceCache }` settings. Shared rendering is the default. Baseline mismatches receive bounded cache-pulse retries followed by fresh retries, with retry evidence and per-story pinning instructions in reports. Proactive cache clearing is optional. Reports identify which recovery matched the baseline.

  Approval now confirms every selected capture on a fresh renderer, including with `--allow-unstable`, and requires the reviewed hash to match. Initial baselines also use fresh renderers.

### Patch Changes

- Updated dependencies [9461f93]
  - @juxtapose/core@0.19.0
  - @juxtapose/adapter-ladle@0.3.19
  - @juxtapose/adapter-storybook@0.4.16

## 0.18.5

### Patch Changes

- Updated dependencies [1dda4b6]
- Updated dependencies [1dda4b6]
  - @juxtapose/core@0.18.4
  - @juxtapose/adapter-ladle@0.3.18
  - @juxtapose/adapter-storybook@0.4.15

## 0.18.4

### Patch Changes

- Updated dependencies [0dde787]
  - @juxtapose/core@0.18.3
  - @juxtapose/adapter-ladle@0.3.17
  - @juxtapose/adapter-storybook@0.4.14

## 0.18.3

### Patch Changes

- Updated dependencies [bea2cfd]
  - @juxtapose/adapter-storybook@0.4.13

## 0.18.2

### Patch Changes

- 6dac140: Each result in `report.json` now carries `timings`: milliseconds per capture phase (navigate, freshRenderer, render, settle, paint, structure, screenshot, encode, other) that sum to `durationMs`. They are clock reads around existing calls and change no pixels or hashes.
- Updated dependencies [6dac140]
  - @juxtapose/core@0.18.2
  - @juxtapose/adapter-ladle@0.3.16
  - @juxtapose/adapter-storybook@0.4.12

## 0.18.1

### Patch Changes

- Updated dependencies [62fb1ec]
  - @juxtapose/core@0.18.1
  - @juxtapose/adapter-ladle@0.3.15
  - @juxtapose/adapter-storybook@0.4.11

## 0.18.0

### Minor Changes

- f5c1b67: `jux run --since` now captures only the stories a changed component reaches, instead of every story (#200). Vite's build manifest lists chunks, not the modules bundled into them, so a shared component never appeared in it and almost every UI edit fell back to a full run. The Storybook addon now adds a Vite plugin to `storybook build` that records every source module and its imports to `.vite/juxtapose-modules.json`; the analysis walks that. Ladle and other Vite workbenches add `juxtaposeModuleGraph()` from the new `@juxtapose/core/vite` export to their `vite.config.js`. Rebuild once after upgrading, and before each `--since` run.

  Only script edits narrow. Editing a stylesheet or any other asset runs every story (`asset-changed`), because plugins rewrite `@import`, `@use` and `url()` before they could be read. The graph is the bundler's import graph plus `new URL(…, import.meta.url)`. Anything else it cannot place still captures everything, and the printed reason names the file: a changed file the build never saw (`unmapped-change`, even beside mapped files), a module that runs for every story such as the preview, including when each story imports it (`shared-entry-changed`), a build with workers, worklets or computed asset paths, where no change is narrowed, a source whose content differs from the hash recorded at build time (`stale-graph`; content, not mtime, so a fresh checkout is fine), a graph built from another root (`graph-root-mismatch`), and any `--origin` run (`origin-run`). Markdown in the source tree is not exempt (a glob can load it), nothing under `public/` is, and only `.github/` and repo-root meta files (README, LICENSE, …) are ignored. A file a build plugin read from disk to make a virtual module, a virtual module from a user plugin, and `cssCodeSplit: false` with a `.vue`/`.svelte` edit also escalate. Docs pages (`.mdx`) no longer force a full run. The plugin never fails a build: on an error it warns and writes no graph. A webpack Storybook build is told narrowing is not available instead of being asked to add a Vite plugin. Also fixed: repository-relative paths are mapped to project paths, so affected-only runs work when the workbench is below the repository root (#96), and a project-level `tsconfig.json`, lockfile or `.storybook` there now escalates.

### Patch Changes

- Updated dependencies [f5c1b67]
  - @juxtapose/core@0.18.0
  - @juxtapose/adapter-ladle@0.3.14
  - @juxtapose/adapter-storybook@0.4.10

## 0.17.0

### Minor Changes

- d7558ed: Make the stable-approve recheck configurable. `recheck` in the config, `--recheck <mode>` and `--no-recheck` on `jux run`, and a `recheck` argument on the MCP `run` tool choose which stories the run captures twice: `"changed"` (new and failing, the default and today's behavior), `"new"` (new only) or `"off"` (none). A story the run didn't capture twice is marked `unrechecked` in `report.json`, and `jux approve` captures it again and approves it only if the two hashes match, so approval stays safe; `--allow-unstable` still overrides. A story captured once also carries an `unstable` verdict (`not rechecked`), so an older approver refuses it rather than baselining one capture. With the recheck off, stories carry no `flake`, and `report.json` (`recheck`) and the `jux run` output say so. `jux config --explain` shows the effective `recheck` and its source. The Storybook panel's approve button refuses an `unrechecked` story; use `jux approve`.

### Patch Changes

- Updated dependencies [d7558ed]
  - @juxtapose/core@0.17.0
  - @juxtapose/adapter-ladle@0.3.13
  - @juxtapose/adapter-storybook@0.4.9

## 0.16.1

### Patch Changes

- 34f879d: A small pixel mismatch is no longer called noise or safe to approve (#201). The handoff, PR comment and structural summary only say "likely rendering noise" when the structural diff positively shows nothing changed and the regions are thin hairlines. With no baseline structure the handoff says the change is unexplained, shows the regions and magnitude, and tells the agent to inspect the crops before approving. The PR comment heading states the largest mismatch instead of "all under 0.1%" and always offers `jux handoff`. Adds `scripts/check-init.mjs` to CI, a regression check that `jux init` saves structure for every baseline (#199).
- Updated dependencies [34f879d]
  - @juxtapose/core@0.16.1
  - @juxtapose/adapter-ladle@0.3.12
  - @juxtapose/adapter-storybook@0.4.8

## 0.16.0

### Minor Changes

- 6ec8d81: Projects no longer commit snapshot images. The default storage is now `{ "kind": "cache" }`: baseline images live in a git-ignored, hash-keyed cache (`.juxtapose/cache/baselines/<sha256>.webp`), and the repo carries only `juxtapose.manifest.json`, a lockfile holding each story's hash (which decides pass/fail) and its approved structure inline (one element per line, stories sorted by id, so an approval diff shows what moved; the file stays `"version": 1`, which an older jux reads as the same hashes). On a merge conflict, don't hand-merge it: take either side and re-run `jux approve --story <id>`. `.juxtapose/` is entirely machine-local and ignored with one line. A failing story whose image is not in the cache is reported by hash and structure ("baseline image not available (not in cache); structure diff only") instead of erroring, in run output, the PR comment, the handoff, the HTML report and the panel. A passing run keeps its capture in the cache; `jux run` never writes the manifest. `jux init` writes the `.gitignore` entries, and the new `jux doctor` lists tracked images and prints the migration. `docs/ci.md` has a GitHub Actions snippet that saves and restores the cache. The cache is not pruned yet (see #114). A cache or tmp directory that is a symlink is never written to or swept. The cache's `dir` is now validated: a relative path inside the project with no `..`, absolute or UNC path, glob characters, control characters or leading `-`. A `git` or `fs` `dir` is unchanged (any path, including outside the project), apart from refusing a leading `-` and control characters. A refused value exits 2.

  Migration. Projects with `storage.kind: "git"` (or `"fs"`) set explicitly are unchanged. Projects with no `storage` key and images committed under `.juxtapose/baselines/` keep working: jux still reads those images (when they match the manifest hash) and writes new ones to the cache. To move over, run `jux doctor` and follow what it prints: `jux run --all` first (it copies each image that matches the manifest into the cache, which matters because the commit that untracks the images deletes them from every other clone), then `git rm --cached -- ':(glob).juxtapose/baselines/*.webp'`, the `.gitignore` line `.juxtapose/`, and a commit. Teammates and CI then have no images until their own run or a restored CI cache fills the cache, and report structure only until then. The old per-story `.structure.json.gz` files are folded into the manifest by `jux doctor --fix` (no capture, no approval); doctor then prints the commands to untrack them. To keep committing images, set `"storage": { "kind": "git" }`.

### Patch Changes

- 7a53ce1: Follow-up to the no-committed-images change, shipping in the same release. The manifest stays `"version": 1` (the inline `structure` per story is an additive field, so a previous release still reads the same hashes instead of an empty manifest), and `jux run` never writes the manifest: only `jux approve` does. Legacy `.structure.json.gz` sidecars move into the manifest with the new `jux doctor --fix`, which folds them in where they match the approved baseline and captures and approves nothing; doctor no longer suggests `jux approve --all` for this. `jux doctor` and `jux handoff` report a manifest with merge conflict markers (exit 2 for handoff), and `jux approve` exits 2 once instead of failing every story. A symlinked `.juxtapose` or `.juxtapose/cache` is refused before any directory is created at its target. Printed git commands that use pathspec magic work when `GIT_LITERAL_PATHSPECS=1` is exported.
- Updated dependencies [7a53ce1]
- Updated dependencies [6ec8d81]
  - @juxtapose/core@0.16.0
  - @juxtapose/adapter-ladle@0.3.11
  - @juxtapose/adapter-storybook@0.4.7

## 0.15.0

### Minor Changes

- e3608de: An unstable story now says why it flaked and what to change (#190, step 1). `report.json` gains `flake: { cause, confidence, evidence, fix }` on a story whose two run captures differed, and `jux diff --runs` explains each story that differs the same way. `cause` is one of `settle-timeout`, `external-image`, `embed`, `async-element`, `clock`, `random-content`, `render-drift` or `unknown`, from the first check that matches. `fix` is an exact patch for `juxtapose.config.json`, scoped to the story (`stories["card--basic"].network.external.images = "placeholder"`), or `null` when no config change helps. `jux run`, `jux diff --runs` and `jux handoff` print one line for it, and the MCP `run` result carries the object. The structure snapshot records the origin and path of third-party images, backgrounds and iframes (not part of `structureHash`, and read from the same browser response, so captures are unchanged). `@juxtapose/core` exports `analyzeFlake`, `describeFlake`, `formatFix` and the `Flake` types.

  A new `order-dependence` cause (a capture reused a renderer process while `freshRenderer` is off) suggests the project-level `freshRenderer: true`. When three or more unstable stories share a cause and host, or are order dependent, `report.json` and `jux diff --runs --json` add `flakeGroups` with one project-level patch, and the text output prints one line per group. The clock check also recognises month-and-year, weekday names, today/yesterday/tomorrow, `2026/10/14`, lowercase day-month, German, French, Spanish, Italian, Portuguese and Dutch month names, and CJK dates.

  Structure sidecars gain an `external` field (the origin and path of third-party images, backgrounds and frames) on elements that have one, so committed sidecars change once for pages with third-party resources. `structureHash` is unchanged. A settle report at the cap now also lists the pending requests by full URL (`requests`, `requestsOmitted`, `origin`). A suggested settle-timeout fix is only ever a `type:Image` or `type:Document` placeholder rule for a third-party host; jux never suggests blocking a stylesheet, script, font, API call or first-party request. `jux run` reads the first capture of an unstable story back from the run directory instead of keeping it in memory.

### Patch Changes

- Updated dependencies [e3608de]
  - @juxtapose/core@0.15.0
  - @juxtapose/adapter-ladle@0.3.10
  - @juxtapose/adapter-storybook@0.4.6

## 0.14.0

### Minor Changes

- 4638d64: `jux config --explain <storyId>` prints the capture settings one story or variant key would use and which layer each came from (#179): the project config, the story's `parameters.juxtapose`, the `stories` globs that matched, the variant and its `extends` chain, live params, or a CLI flag. `--json` prints `juxtapose.explain/v1`. The `explain` MCP tool returns the same. It shows `network.external` per resource type and the effective `network.rules` in evaluation order, each with its layer. Nothing is captured; discovery runs as it does for `jux run`. An unknown id exits 2 with the closest ids. `@juxtapose/core` exports `ProvenanceLog`, `explainCapture`, `findCaptures` and `liveReader`, and `expandVariants`, `mergeLiveParams` and `prepareCaptures` take an optional trace that records sources and changes no result.
- 535c676: `network.external` now also takes an object, `{ default, images, frames, media }`, and a new `network.rules` list matches URLs (#177, part of #147). Each type key is `allow`, `block` or `placeholder`, applies to third-party requests only and overrides `default` for that type; the string form still means `{ default }` and behaves as before. A rule is `{ match, action }`, with `match` in the `settle.network.ignore` pattern syntax (URL glob, `type:`), checked before the type defaults in array order, first match wins, on any URL including the Storybook's own origin. `placeholder` answers an image with a fixed 64x64 gray PNG and a sub-frame document with a fixed empty HTML page through `Fetch.fulfillRequest`, so a random photo or an embed renders the same pixels every run; media has no stand-in and is blocked; any other request a `placeholder` rule matches is blocked. `placeholder` as `default`, or on a rule that matches only types with no stand-in (`type:Script`), is a config error. Story, `stories` override and variant rules are checked before the project's, and the type map merges field by field. Blocked and placeholder requests never count as in flight for settle. Adds `--network <json>` to `jux snap` and `jux run`; the MCP `network` argument takes the whole object. A string `external` at a higher layer (story, override, `--network-external`, MCP `external`) means that policy for every resource type: it replaces `default` and clears lower layers' per-type entries. A `placeholder` image answers a `crossorigin="use-credentials"` request with the request's origin and `Access-Control-Allow-Credentials`.
- 48258e9: Approving a baseline now requires two identical captures (#148). `jux run` captures each new or failing story a second time and records `unstable` in report.json when the hashes differ, or `unstable.unconfirmed` when the second capture fails, so an unverified story is never approved. Passing and stale stories are not rechecked (stale already matches a recorded hash), so a green run costs nothing extra; a first run and `jux init` take about 2x as long. `jux approve`, `jux init`, the MCP `approve` tool and the Storybook panel refuse an unstable story and name it, while approving the rest; the review server answers 409. Pass `--allow-unstable` (MCP: `allowUnstable`) to baseline one anyway. `jux run`, `check`, `handoff`, the PR comment and the HTML report mark unstable stories, and the panel's "approve all" now shows refusals instead of swallowing them.

### Patch Changes

- b40e080: One schema for the project config and story parameters (#178). `@juxtapose/core` now publishes `@juxtapose/core/schema.json`, a JSON Schema for `juxtapose.config.json` that gives editors completion, hover docs and validation. It also exports `JuxtaposeParameters`, the schemas themselves, and `registerFormats()` for checking them with TypeBox. The TypeScript types, the JSON Schema, the MCP tool argument shapes and the runtime checks are all derived from it. The runtime accepts and rejects exactly what it did before, with the same messages. An unknown key now prints a warning on stderr with the closest option it could mean; it never fails a command. Adds the `@sinclair/typebox` dependency. `jux init` writes a `$schema` line pinned to the installed version on jsDelivr, and `@juxtapose/cli` ships a copy of `schema.json` for offline use. `@juxtapose/storybook` exports `JuxtaposeParameters` and types `parameters.juxtapose` in CSF files (#180).
- Updated dependencies [4638d64]
- Updated dependencies [b40e080]
- Updated dependencies [535c676]
- Updated dependencies [48258e9]
  - @juxtapose/core@0.14.0
  - @juxtapose/adapter-ladle@0.3.9
  - @juxtapose/adapter-storybook@0.4.5

## 0.13.0

### Minor Changes

- 3668e0e: **Default change:** each cold capture after a page's first now starts in a new Chrome renderer process (#153). The new `freshRenderer` config option (default `true`) controls this, and `--no-fresh-renderer` turns it off for one `jux run` or `jux snap`.

  Chrome's renderer kept canvas text measurement, font and raster state across navigations, so the story captured before could change the next story's pixels, and the shuffled queue made that verdict random. Primer's PageLayout pull-request-page hashed 37d0ff51 after PageHeader webhooks and 76cf4695 alone. Spectrum's card--default hashed 28d933b6 after a button group and 2faf799d alone. A story's hash no longer depends on the story captured before it.

  **This makes runs slower.** It costs about 220 ms per Storybook story: the full 1,086-story Spectrum pass went from 47 to 83 s at concurrency 8, and from 36 to 70 s at 16. Set `"freshRenderer": false` for speed-critical runs where you accept order dependence. A non-boolean `freshRenderer` is a config error in run, init, snap, MCP and the review server.

### Patch Changes

- e2d1770: The fresh renderer from #153 now holds at high concurrency, and a capture that doesn't get one is flagged. Chrome reuses a renderer that already ran a story once a browser holds its renderer-process limit, which Chrome derives from memory (24 on a 4 GB machine). Measured on Chrome 151 at concurrency 16 with a limit of 24, 14 of 128 captures stayed in a used renderer. At concurrency 8 with a limit of 8, 56 of 56 did. jux now launches Chrome with `--renderer-process-limit=1000`: 0 of 128 at concurrency 16. The flag changes no pixels. The Storybook, Ladle and Vue examples hash byte-identical to before. It also changes the warm browser's key, so an older warm browser is not reused.

  A story that still lands in a used renderer, for example in a browser started with a lower limit, is flagged `renderer-reused` in `report.json` `flags`, in `jux snap` results and output, and in a warning printed once per run. The check compares the page's `Runtime.getIsolateId`, which is random per renderer process, and costs about 0.2 ms a capture.

- Updated dependencies [e2d1770]
- Updated dependencies [3668e0e]
- Updated dependencies [a7e5e61]
  - @juxtapose/core@0.13.0
  - @juxtapose/adapter-ladle@0.3.8
  - @juxtapose/adapter-storybook@0.4.4

## 0.12.0

### Minor Changes

- c602676: Per-story overrides in the project config (#128). `stories: { "<id glob>": { skip, mask, delay, waitForSelector, captureTimeout, settle, network, threshold, minDiffPercent } }` stabilizes or skips volatile stories in a Storybook you don't own (a deployed `origin`, a third-party `buildDir`), where `parameters.juxtapose` can't be edited. An override beats the story's own parameters (including live ones) and loses only to the command line; when several keys match, the more specific wins, masks union and settle merges. A key matching a story also covers its variants, and `<id>__<variant>` targets one. Bad entries fail up front naming the glob and option, in run, init, snap, MCP and the review server. Stories skipped by config are reported (`skippedBy` in the report, the run summary, the PR comment and `jux handoff`).

### Patch Changes

- 981f6b9: jux runs its pinned browser only from its own cache or an explicit `JUX_CHROME` / `--chrome` (#141). It used to run chrome-headless-shell straight out of Playwright's cache, so `playwright install` or a disk cleanup deleting that directory broke every launch, mid-run included. A matching Playwright build is now copied into jux's cache once (a clone where the filesystem supports it), version-checked, and used from there; Playwright's directory is only read. When there is no browser, the error names the expected path and `jux browser install`.
- 0807b4f: `jux snap` and the MCP `snap` tool give each URL its own budget and replace the shared page after a timeout (#163). One wedged URL used to poison the page every later URL shared: three URLs gave 90 s and all three failed. Now the hung URL errors once, within `storyTimeout` or the 30 s navigation cap, whichever fires first, with an error naming the stuck step; the following URLs get a fresh page and capture normally. `jux snap` still exits 3 when any URL failed. Snaps that do not time out keep sharing one page, so they are byte-identical to before.
- Updated dependencies [c602676]
- Updated dependencies [981f6b9]
- Updated dependencies [f251aa8]
- Updated dependencies [0807b4f]
- Updated dependencies [a646af0]
  - @juxtapose/core@0.12.0
  - @juxtapose/adapter-ladle@0.3.7
  - @juxtapose/adapter-storybook@0.4.3

## 0.11.0

### Minor Changes

- 16d7ed3: Navigation no longer waits for the `load` event, and a new `network.external` option can block third-party requests (#125, part of #147). `page.goto` now resolves on `DOMContentLoaded` by default (`waitUntil: 'load'` restores the old behavior), so one subresource that never answers, such as Chakra's avatar fallback `<img src="https://bit.ly/broken-link">` that 522s after ~20 s, no longer holds a worker for 20-30 s on every run or errors the story. The settle wait, which already tracks requests and images in flight, waits for it up to `settle.timeout` and flags the capture `settle-timeout` naming the request. `network.external: 'block'` (config, story parameters, `--network-external`, and the MCP `network` argument) fails requests to origins other than the page's own through CDP `Fetch`, so a random photo or a broken external link neither changes the pixels nor stalls the capture. Default is `'allow'`. Record/replay (#147) is not implemented.
- c7f9ffb: `report.json` results now carry `hash`, the sha256 of the story's current capture (the hash `baselines/` compares), and `jux diff --runs <runA> <runB>` compares two runs by it (#129). It takes run ids or run directories, prints identical and different counts and the differing story ids (`--json`: `juxtapose.run-diff/v1`), and exits 0 when identical, 1 otherwise. `hash` is optional, so older reports still parse and are compared by hashing their images.

### Patch Changes

- 8d24388: `jux diff --crops` no longer lets same-named images share a crops dir (#131). A `.webp` path input is named `<basename>.<8 hex of sha256(absolute path)>`, so `runA/images/X-current.webp` vs `runB/images/X-current.webp` and `runA/...` vs `runC/...` write to different dirs under `.juxtapose/crops/` instead of overwriting `X-current~vs~X-current`. Snap-name pairs keep their readable `<a>~vs~<b>` dirs.
- 44bf5ae: Reject unknown arguments and add per-command `--help` (#130). `jux run some-story-id` used to ignore the positional and run every story; it now exits 2 with `unexpected argument 'some-story-id'. Did you mean --story some-story-id?`. Unknown flags and extra positionals on every command (`init`, `run`, `approve`, `check`, `handoff`, `snap`, `diff`, `mcp`) exit 2 with a one-line message, and a value flag with no value (`--story`) is an error. `jux <command> --help` and `-h` print that command's usage and exit 0. "could not detect a workbench" and other expected configuration errors print their own message and exit 2 instead of "unexpected failure" and exit 3. Breaking for scripts that passed stray positionals or flags a command does not take: they now fail instead of being ignored.
- Updated dependencies [16d7ed3]
- Updated dependencies [8f38247]
- Updated dependencies [dc60343]
- Updated dependencies [c7f9ffb]
- Updated dependencies [255fc28]
  - @juxtapose/core@0.11.0
  - @juxtapose/adapter-ladle@0.3.6
  - @juxtapose/adapter-storybook@0.4.2

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
