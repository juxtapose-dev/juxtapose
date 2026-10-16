# @juxtapose/core

## 0.22.0

### Minor Changes

- a5ca6bd: Add story listing, positional capture selectors, ID globs, and run dry-run output. CLI and MCP share variant-aware selection; unmatched selectors fail instead of silently broadening the capture. Approval remains explicit and uses exact reviewed IDs.

### Patch Changes

- be525cc: Batch manifest updates during init and bulk approval, avoiding repeated parsing and rewriting for every story. Write manifests through an atomic replacement while retaining the existing readable format and structure evidence.

## 0.21.0

### Minor Changes

- 87dfe16: Freeze animated GIF, WebP and APNG images on their first frame by default (#182). Set `freeze.images: false` to retain playback for a project.

  Add opt-in clock and random fixture controls (#146). `freeze.clock: true` starts `Date`, `Date.now()`, `Intl.DateTimeFormat` and `Temporal.Now` at 2024-01-01T12:00:00Z; an ISO 8601 instant selects another starting time. Timer callbacks advance the clock, with a fallback for synchronous clock polling; asynchronous callback order is not controlled. `freeze.random: true` seeds `Math.random`, `crypto.getRandomValues` and `crypto.randomUUID`. Both options default to `false`.

  Clock and random settings layer per project, story, variant and `stories` override; animated-image policy is project-wide. Types, JSON schema, configuration docs and `jux config --explain` describe the controls.

- 5ae3ce9: Capture lossless WebP directly in Chrome to avoid PNG decoding and Sharp re-encoding. Remove ICC metadata without changing pixels and reject lossy screenshots. Pixelmatch remains opt-in and can accept equivalent pixels without replacing approvals.

### Patch Changes

- 7239da1: Use Chromium's binary CDP pipe to avoid repeated JSON conversion of large DOM snapshots. Preserve existing screenshot, structure, and daemon client formats. Keep `JUX_CDP_JSON=1` as an internal diagnostic fallback, including private-browser fallback and daemon identity.
- 42eac75: Load only selected stories during Storybook parameter discovery, and include the selection in discovery cache keys so partial results cannot be reused for full runs. Preserve whole-store extraction for full selections and previews without per-story loading support.
- 9dbf3bc: Batch structure mask marking and verification to reduce browser round trips while preserving shadow-DOM coverage and cleanup. Add optional structure extraction subphase timings with `JUX_STRUCTURE_PROFILE=1`.

## 0.20.2

### Patch Changes

- 41f0c65: Stop already-running CSS transitions when freezing animations. Setting duration to zero only prevented new transitions, allowing intermediate border and placeholder colors into captures. The freeze now removes transition properties, reaching the final style without an added delay. The `animations: 'play'` opt-out is unchanged.

## 0.20.1

### Patch Changes

- 0751c38: Freeze placeholder color transitions along with other CSS animations, including inside open shadow roots. This prevents captures of intermediate placeholder colors while preserving the `animations: 'play'` opt-out.

## 0.20.0

### Minor Changes

- 25261d6: Add opt-in `comparison: { mode: "pixelmatch", threshold: 0.05 }` at project, story, variant, and override level. Exact SHA-256 matches remain the fast path and default. Hash mismatches can pass only with a verified baseline image, valid ancestry, equal dimensions, and zero pixels remaining after Pixelmatch color/antialias filtering. Reports identify visual-equivalence passes and preserve both exact hashes; approved baselines, fresh approval, and exact renderer recovery are unchanged.

## 0.19.1

### Patch Changes

- af4e714: Report HTTP error documents as capture errors instead of visual regressions. Keep diagnostic screenshots without approvable hashes, include Retry-After guidance, and stop scheduling captures after a rate-limited or unavailable workbench returns 429 or 503.

  Hosted Storybook index failures now report HTTP status and Retry-After instead of suggesting that the build is missing.

## 0.19.0

### Minor Changes

- 9461f93: Add project and per-story `renderer: { shared, clearResourceCache }` settings. Shared rendering is the default. Baseline mismatches receive bounded cache-pulse retries followed by fresh retries, with retry evidence and per-story pinning instructions in reports. Proactive cache clearing is optional. Reports identify which recovery matched the baseline.

  Approval now confirms every selected capture on a fresh renderer, including with `--allow-unstable`, and requires the reviewed hash to match. Initial baselines also use fresh renderers.

## 0.18.4

### Patch Changes

- 1dda4b6: Faster structure snapshots and structural diffs on large pages, with byte-identical output. Normalizing Primer's 110k-node TreeView story is about 3x faster. Four quadratic paths in the structural diff and flake analysis are now linear: inherited-style lookups, ordering removed elements, keyed alignment of large flat lists, and selector uniqueness counts.
- 1dda4b6: Avoid repeated class-permutation scans, index structural fallback matching, and memoize follower geometry ancestors while preserving output order.

## 0.18.3

### Patch Changes

- 0dde787: The structure snapshot is faster on very large pages. It no longer asks Chrome for DOM rects, which nothing read and which made Chrome lay out every `content-visibility` subtree, and normalizing it is now linear in the page's node count rather than quadratic in sibling count. On Primer's `treeview-features--contain-intrinsic-size` (110k elements) the snapshot went from about 3.0 s to 0.9 s (median of 3). Capture hashes are unchanged. Sidecars are byte-identical except that a closed `<details>`'s menu, which is never painted, is no longer recorded as visible.

## 0.18.2

### Patch Changes

- 6dac140: Each result in `report.json` now carries `timings`: milliseconds per capture phase (navigate, freshRenderer, render, settle, paint, structure, screenshot, encode, other) that sum to `durationMs`. They are clock reads around existing calls and change no pixels or hashes.

## 0.18.1

### Patch Changes

- 62fb1ec: Settle waits out nested animation frames that are not a loop. A `requestAnimationFrame` chain stopped counting at depth 3, so an overlay that opens through three nested frames and then a `nextFrame()` (Spectrum's `guaranteedAllTransitionend`) was captured mid-open. Frames now stop counting only when the same call site re-arms itself 3 times, and frames still pending after the paint barrier get a second wait, like timers do. Part of #197.

## 0.18.0

### Minor Changes

- f5c1b67: `jux run --since` now captures only the stories a changed component reaches, instead of every story (#200). Vite's build manifest lists chunks, not the modules bundled into them, so a shared component never appeared in it and almost every UI edit fell back to a full run. The Storybook addon now adds a Vite plugin to `storybook build` that records every source module and its imports to `.vite/juxtapose-modules.json`; the analysis walks that. Ladle and other Vite workbenches add `juxtaposeModuleGraph()` from the new `@juxtapose/core/vite` export to their `vite.config.js`. Rebuild once after upgrading, and before each `--since` run.

  Only script edits narrow. Editing a stylesheet or any other asset runs every story (`asset-changed`), because plugins rewrite `@import`, `@use` and `url()` before they could be read. The graph is the bundler's import graph plus `new URL(…, import.meta.url)`. Anything else it cannot place still captures everything, and the printed reason names the file: a changed file the build never saw (`unmapped-change`, even beside mapped files), a module that runs for every story such as the preview, including when each story imports it (`shared-entry-changed`), a build with workers, worklets or computed asset paths, where no change is narrowed, a source whose content differs from the hash recorded at build time (`stale-graph`; content, not mtime, so a fresh checkout is fine), a graph built from another root (`graph-root-mismatch`), and any `--origin` run (`origin-run`). Markdown in the source tree is not exempt (a glob can load it), nothing under `public/` is, and only `.github/` and repo-root meta files (README, LICENSE, …) are ignored. A file a build plugin read from disk to make a virtual module, a virtual module from a user plugin, and `cssCodeSplit: false` with a `.vue`/`.svelte` edit also escalate. Docs pages (`.mdx`) no longer force a full run. The plugin never fails a build: on an error it warns and writes no graph. A webpack Storybook build is told narrowing is not available instead of being asked to add a Vite plugin. Also fixed: repository-relative paths are mapped to project paths, so affected-only runs work when the workbench is below the repository root (#96), and a project-level `tsconfig.json`, lockfile or `.storybook` there now escalates.

## 0.17.0

### Minor Changes

- d7558ed: Make the stable-approve recheck configurable. `recheck` in the config, `--recheck <mode>` and `--no-recheck` on `jux run`, and a `recheck` argument on the MCP `run` tool choose which stories the run captures twice: `"changed"` (new and failing, the default and today's behavior), `"new"` (new only) or `"off"` (none). A story the run didn't capture twice is marked `unrechecked` in `report.json`, and `jux approve` captures it again and approves it only if the two hashes match, so approval stays safe; `--allow-unstable` still overrides. A story captured once also carries an `unstable` verdict (`not rechecked`), so an older approver refuses it rather than baselining one capture. With the recheck off, stories carry no `flake`, and `report.json` (`recheck`) and the `jux run` output say so. `jux config --explain` shows the effective `recheck` and its source. The Storybook panel's approve button refuses an `unrechecked` story; use `jux approve`.

## 0.16.1

### Patch Changes

- 34f879d: A small pixel mismatch is no longer called noise or safe to approve (#201). The handoff, PR comment and structural summary only say "likely rendering noise" when the structural diff positively shows nothing changed and the regions are thin hairlines. With no baseline structure the handoff says the change is unexplained, shows the regions and magnitude, and tells the agent to inspect the crops before approving. The PR comment heading states the largest mismatch instead of "all under 0.1%" and always offers `jux handoff`. Adds `scripts/check-init.mjs` to CI, a regression check that `jux init` saves structure for every baseline (#199).

## 0.16.0

### Minor Changes

- 6ec8d81: Projects no longer commit snapshot images. The default storage is now `{ "kind": "cache" }`: baseline images live in a git-ignored, hash-keyed cache (`.juxtapose/cache/baselines/<sha256>.webp`), and the repo carries only `juxtapose.manifest.json`, a lockfile holding each story's hash (which decides pass/fail) and its approved structure inline (one element per line, stories sorted by id, so an approval diff shows what moved; the file stays `"version": 1`, which an older jux reads as the same hashes). On a merge conflict, don't hand-merge it: take either side and re-run `jux approve --story <id>`. `.juxtapose/` is entirely machine-local and ignored with one line. A failing story whose image is not in the cache is reported by hash and structure ("baseline image not available (not in cache); structure diff only") instead of erroring, in run output, the PR comment, the handoff, the HTML report and the panel. A passing run keeps its capture in the cache; `jux run` never writes the manifest. `jux init` writes the `.gitignore` entries, and the new `jux doctor` lists tracked images and prints the migration. `docs/ci.md` has a GitHub Actions snippet that saves and restores the cache. The cache is not pruned yet (see #114). A cache or tmp directory that is a symlink is never written to or swept. The cache's `dir` is now validated: a relative path inside the project with no `..`, absolute or UNC path, glob characters, control characters or leading `-`. A `git` or `fs` `dir` is unchanged (any path, including outside the project), apart from refusing a leading `-` and control characters. A refused value exits 2.

  Migration. Projects with `storage.kind: "git"` (or `"fs"`) set explicitly are unchanged. Projects with no `storage` key and images committed under `.juxtapose/baselines/` keep working: jux still reads those images (when they match the manifest hash) and writes new ones to the cache. To move over, run `jux doctor` and follow what it prints: `jux run --all` first (it copies each image that matches the manifest into the cache, which matters because the commit that untracks the images deletes them from every other clone), then `git rm --cached -- ':(glob).juxtapose/baselines/*.webp'`, the `.gitignore` line `.juxtapose/`, and a commit. Teammates and CI then have no images until their own run or a restored CI cache fills the cache, and report structure only until then. The old per-story `.structure.json.gz` files are folded into the manifest by `jux doctor --fix` (no capture, no approval); doctor then prints the commands to untrack them. To keep committing images, set `"storage": { "kind": "git" }`.

### Patch Changes

- 7a53ce1: Follow-up to the no-committed-images change, shipping in the same release. The manifest stays `"version": 1` (the inline `structure` per story is an additive field, so a previous release still reads the same hashes instead of an empty manifest), and `jux run` never writes the manifest: only `jux approve` does. Legacy `.structure.json.gz` sidecars move into the manifest with the new `jux doctor --fix`, which folds them in where they match the approved baseline and captures and approves nothing; doctor no longer suggests `jux approve --all` for this. `jux doctor` and `jux handoff` report a manifest with merge conflict markers (exit 2 for handoff), and `jux approve` exits 2 once instead of failing every story. A symlinked `.juxtapose` or `.juxtapose/cache` is refused before any directory is created at its target. Printed git commands that use pathspec magic work when `GIT_LITERAL_PATHSPECS=1` is exported.

## 0.15.0

### Minor Changes

- e3608de: An unstable story now says why it flaked and what to change (#190, step 1). `report.json` gains `flake: { cause, confidence, evidence, fix }` on a story whose two run captures differed, and `jux diff --runs` explains each story that differs the same way. `cause` is one of `settle-timeout`, `external-image`, `embed`, `async-element`, `clock`, `random-content`, `render-drift` or `unknown`, from the first check that matches. `fix` is an exact patch for `juxtapose.config.json`, scoped to the story (`stories["card--basic"].network.external.images = "placeholder"`), or `null` when no config change helps. `jux run`, `jux diff --runs` and `jux handoff` print one line for it, and the MCP `run` result carries the object. The structure snapshot records the origin and path of third-party images, backgrounds and iframes (not part of `structureHash`, and read from the same browser response, so captures are unchanged). `@juxtapose/core` exports `analyzeFlake`, `describeFlake`, `formatFix` and the `Flake` types.

  A new `order-dependence` cause (a capture reused a renderer process while `freshRenderer` is off) suggests the project-level `freshRenderer: true`. When three or more unstable stories share a cause and host, or are order dependent, `report.json` and `jux diff --runs --json` add `flakeGroups` with one project-level patch, and the text output prints one line per group. The clock check also recognises month-and-year, weekday names, today/yesterday/tomorrow, `2026/10/14`, lowercase day-month, German, French, Spanish, Italian, Portuguese and Dutch month names, and CJK dates.

  Structure sidecars gain an `external` field (the origin and path of third-party images, backgrounds and frames) on elements that have one, so committed sidecars change once for pages with third-party resources. `structureHash` is unchanged. A settle report at the cap now also lists the pending requests by full URL (`requests`, `requestsOmitted`, `origin`). A suggested settle-timeout fix is only ever a `type:Image` or `type:Document` placeholder rule for a third-party host; jux never suggests blocking a stylesheet, script, font, API call or first-party request. `jux run` reads the first capture of an unstable story back from the run directory instead of keeping it in memory.

## 0.14.0

### Minor Changes

- 4638d64: `jux config --explain <storyId>` prints the capture settings one story or variant key would use and which layer each came from (#179): the project config, the story's `parameters.juxtapose`, the `stories` globs that matched, the variant and its `extends` chain, live params, or a CLI flag. `--json` prints `juxtapose.explain/v1`. The `explain` MCP tool returns the same. It shows `network.external` per resource type and the effective `network.rules` in evaluation order, each with its layer. Nothing is captured; discovery runs as it does for `jux run`. An unknown id exits 2 with the closest ids. `@juxtapose/core` exports `ProvenanceLog`, `explainCapture`, `findCaptures` and `liveReader`, and `expandVariants`, `mergeLiveParams` and `prepareCaptures` take an optional trace that records sources and changes no result.
- b40e080: One schema for the project config and story parameters (#178). `@juxtapose/core` now publishes `@juxtapose/core/schema.json`, a JSON Schema for `juxtapose.config.json` that gives editors completion, hover docs and validation. It also exports `JuxtaposeParameters`, the schemas themselves, and `registerFormats()` for checking them with TypeBox. The TypeScript types, the JSON Schema, the MCP tool argument shapes and the runtime checks are all derived from it. The runtime accepts and rejects exactly what it did before, with the same messages. An unknown key now prints a warning on stderr with the closest option it could mean; it never fails a command. Adds the `@sinclair/typebox` dependency. `jux init` writes a `$schema` line pinned to the installed version on jsDelivr, and `@juxtapose/cli` ships a copy of `schema.json` for offline use. `@juxtapose/storybook` exports `JuxtaposeParameters` and types `parameters.juxtapose` in CSF files (#180).
- 535c676: `network.external` now also takes an object, `{ default, images, frames, media }`, and a new `network.rules` list matches URLs (#177, part of #147). Each type key is `allow`, `block` or `placeholder`, applies to third-party requests only and overrides `default` for that type; the string form still means `{ default }` and behaves as before. A rule is `{ match, action }`, with `match` in the `settle.network.ignore` pattern syntax (URL glob, `type:`), checked before the type defaults in array order, first match wins, on any URL including the Storybook's own origin. `placeholder` answers an image with a fixed 64x64 gray PNG and a sub-frame document with a fixed empty HTML page through `Fetch.fulfillRequest`, so a random photo or an embed renders the same pixels every run; media has no stand-in and is blocked; any other request a `placeholder` rule matches is blocked. `placeholder` as `default`, or on a rule that matches only types with no stand-in (`type:Script`), is a config error. Story, `stories` override and variant rules are checked before the project's, and the type map merges field by field. Blocked and placeholder requests never count as in flight for settle. Adds `--network <json>` to `jux snap` and `jux run`; the MCP `network` argument takes the whole object. A string `external` at a higher layer (story, override, `--network-external`, MCP `external`) means that policy for every resource type: it replaces `default` and clears lower layers' per-type entries. A `placeholder` image answers a `crossorigin="use-credentials"` request with the request's origin and `Access-Control-Allow-Credentials`.
- 48258e9: Approving a baseline now requires two identical captures (#148). `jux run` captures each new or failing story a second time and records `unstable` in report.json when the hashes differ, or `unstable.unconfirmed` when the second capture fails, so an unverified story is never approved. Passing and stale stories are not rechecked (stale already matches a recorded hash), so a green run costs nothing extra; a first run and `jux init` take about 2x as long. `jux approve`, `jux init`, the MCP `approve` tool and the Storybook panel refuse an unstable story and name it, while approving the rest; the review server answers 409. Pass `--allow-unstable` (MCP: `allowUnstable`) to baseline one anyway. `jux run`, `check`, `handoff`, the PR comment and the HTML report mark unstable stories, and the panel's "approve all" now shows refusals instead of swallowing them.

## 0.13.0

### Minor Changes

- 3668e0e: **Default change:** each cold capture after a page's first now starts in a new Chrome renderer process (#153). The new `freshRenderer` config option (default `true`) controls this, and `--no-fresh-renderer` turns it off for one `jux run` or `jux snap`.

  Chrome's renderer kept canvas text measurement, font and raster state across navigations, so the story captured before could change the next story's pixels, and the shuffled queue made that verdict random. Primer's PageLayout pull-request-page hashed 37d0ff51 after PageHeader webhooks and 76cf4695 alone. Spectrum's card--default hashed 28d933b6 after a button group and 2faf799d alone. A story's hash no longer depends on the story captured before it.

  **This makes runs slower.** It costs about 220 ms per Storybook story: the full 1,086-story Spectrum pass went from 47 to 83 s at concurrency 8, and from 36 to 70 s at 16. Set `"freshRenderer": false` for speed-critical runs where you accept order dependence. A non-boolean `freshRenderer` is a config error in run, init, snap, MCP and the review server.

### Patch Changes

- e2d1770: The fresh renderer from #153 now holds at high concurrency, and a capture that doesn't get one is flagged. Chrome reuses a renderer that already ran a story once a browser holds its renderer-process limit, which Chrome derives from memory (24 on a 4 GB machine). Measured on Chrome 151 at concurrency 16 with a limit of 24, 14 of 128 captures stayed in a used renderer. At concurrency 8 with a limit of 8, 56 of 56 did. jux now launches Chrome with `--renderer-process-limit=1000`: 0 of 128 at concurrency 16. The flag changes no pixels. The Storybook, Ladle and Vue examples hash byte-identical to before. It also changes the warm browser's key, so an older warm browser is not reused.

  A story that still lands in a used renderer, for example in a browser started with a lower limit, is flagged `renderer-reused` in `report.json` `flags`, in `jux snap` results and output, and in a warning printed once per run. The check compares the page's `Runtime.getIsolateId`, which is random per renderer process, and costs about 0.2 ms a capture.

- a7e5e61: A client that wins the launch lock just after the daemon it was waiting on came up now re-checks for that daemon before spawning, instead of starting a redundant supervisor that only loses the socket bind.

## 0.12.0

### Minor Changes

- c602676: Per-story overrides in the project config (#128). `stories: { "<id glob>": { skip, mask, delay, waitForSelector, captureTimeout, settle, network, threshold, minDiffPercent } }` stabilizes or skips volatile stories in a Storybook you don't own (a deployed `origin`, a third-party `buildDir`), where `parameters.juxtapose` can't be edited. An override beats the story's own parameters (including live ones) and loses only to the command line; when several keys match, the more specific wins, masks union and settle merges. A key matching a story also covers its variants, and `<id>__<variant>` targets one. Bad entries fail up front naming the glob and option, in run, init, snap, MCP and the review server. Stories skipped by config are reported (`skippedBy` in the report, the run summary, the PR comment and `jux handoff`).
- a646af0: One per-story capture budget, and real `durationMs` on errored stories (#154). A page whose main thread stays busy after `DOMContentLoaded` (Primer's ~110k-element treeview story) stalled every browser call for its own 30 s cap, so one story cost 127-160 s and triple a run's wall time. The new `storyTimeout` config option (ms, default 60000) bounds the whole capture of a story: when it runs out the story fails once, with an error naming the step it was stuck in, the worker's page is discarded and replaced, and the run continues. Errored stories now record the time they really took instead of `durationMs: 0`, so they show up in slow-story stats.

  The budget never pre-empts settle: a story's effective budget is the larger of `storyTimeout` and its settle timeout plus `delay` plus 15 s. `storyTimeout` must be a whole number of ms from 1000 to 2147483647.

### Patch Changes

- 981f6b9: jux runs its pinned browser only from its own cache or an explicit `JUX_CHROME` / `--chrome` (#141). It used to run chrome-headless-shell straight out of Playwright's cache, so `playwright install` or a disk cleanup deleting that directory broke every launch, mid-run included. A matching Playwright build is now copied into jux's cache once (a clone where the filesystem supports it), version-checked, and used from there; Playwright's directory is only read. When there is no browser, the error names the expected path and `jux browser install`.
- f251aa8: Freeze, settle and the image wait now reach into open shadow roots (#152). The animation freeze is adopted into every open shadow root, including ones attached after the story starts rendering; DOM changes and loading images inside open shadow roots are waited for like the document's. Closed shadow roots stay out of reach. Stories with animations or transitions inside shadow DOM (spinners, progress bars, web component dialogs and tooltips) capture their frozen frame from now on, so they change once and need re-approval.
- 0807b4f: `jux snap` and the MCP `snap` tool give each URL its own budget and replace the shared page after a timeout (#163). One wedged URL used to poison the page every later URL shared: three URLs gave 90 s and all three failed. Now the hung URL errors once, within `storyTimeout` or the 30 s navigation cap, whichever fires first, with an error naming the stuck step; the following URLs get a fresh page and capture normally. `jux snap` still exits 3 when any URL failed. Snaps that do not time out keep sharing one page, so they are byte-identical to before.

## 0.11.0

### Minor Changes

- 16d7ed3: Navigation no longer waits for the `load` event, and a new `network.external` option can block third-party requests (#125, part of #147). `page.goto` now resolves on `DOMContentLoaded` by default (`waitUntil: 'load'` restores the old behavior), so one subresource that never answers, such as Chakra's avatar fallback `<img src="https://bit.ly/broken-link">` that 522s after ~20 s, no longer holds a worker for 20-30 s on every run or errors the story. The settle wait, which already tracks requests and images in flight, waits for it up to `settle.timeout` and flags the capture `settle-timeout` naming the request. `network.external: 'block'` (config, story parameters, `--network-external`, and the MCP `network` argument) fails requests to origins other than the page's own through CDP `Fetch`, so a random photo or a broken external link neither changes the pixels nor stalls the capture. Default is `'allow'`. Record/replay (#147) is not implemented.
- c7f9ffb: `report.json` results now carry `hash`, the sha256 of the story's current capture (the hash `baselines/` compares), and `jux diff --runs <runA> <runB>` compares two runs by it (#129). It takes run ids or run directories, prints identical and different counts and the differing story ids (`--json`: `juxtapose.run-diff/v1`), and exits 0 when identical, 1 otherwise. `hash` is optional, so older reports still parse and are compared by hashing their images.

### Patch Changes

- 8f38247: Rebuild `will-change` compositor layers before the paint barrier, so a capture no longer depends on the page's history (#136). Chrome keeps the subpixel offset a `will-change: transform` layer was first rasterized at, so a marquee whose animation ran for a frame before the freeze, or whose width changed after its first raster when a font loaded, kept glyph antialiasing from an earlier frame. That earlier frame depended on timing, so one Chakra marquee story captured three different hashes depending on whether it ran alone, in a full run, or through the warm browser. It now captures one. Only a story whose `will-change` layer changed after its first raster can capture differently from before, and it may need a one-time re-approval, because its new baseline is the page's final state. Other stories, including frozen CSS transform animations without `will-change`, capture as before: on Chakra UI's 1227 stories the only differences from the previous release are stories whose content depends on the network or the clock. The examples capture byte-identical to before.
- dc60343: `network.external: 'block'` now treats the committed main-frame document's origin as first-party, so a top-level redirect to another origin keeps its own CSS, JS and images. A request left open by a child frame of the previous document no longer stays in flight after navigation; on a full local Chakra pass this removed spurious `settle-timeout` flags (55 and 40 per pass before, 3 and 2 after). Story and variant `network` values are validated before the run, and a `network` value only the live preview declares now warns.
- 255fc28: Rebuilding `will-change` layers before a capture (#136) now changes only the elements that declare `will-change`, through an inline style that is put back afterwards. It no longer adopts a page-wide stylesheet. Those elements keep their containing block, so a `position: fixed` child no longer moves to the viewport for two frames, and IntersectionObserver or ResizeObserver code no longer reacts to that move and changes the captured state. Layers inside open shadow roots and layers set by an inline `!important` style are now rebuilt too. A story with no `will-change` element skips the step, which saves about one frame per capture.

## 0.10.0

### Minor Changes

- 746d075: Event-driven settle. Instead of waiting for 150 ms without DOM changes (capped at 500 ms), juxtapose now waits until the page has no pending timers due within 1000 ms, animation frames, posted messages, DOM changes, loading fonts, loading in-viewport images or network requests in flight. On the example workbenches the captures are byte-identical to before, and settling takes about 40 ms per story instead of about 165 ms. Pages that finish late, such as a 300 ms timer or a slow fetch, are now captured in their final state.

  The wait is capped by `settle.timeout` (default 1500 ms). At the cap the page is captured anyway, and the result is flagged `settle-timeout` with a list of what was still pending, such as `1 request to /api/feed in flight (Fetch)`. The flag appears in `DiffResult.flags` and `DiffResult.settle`, in the verdict's `flags`, in `jux snap` results, in `jux run` output and in `jux handoff`. It never changes a pass or a failure. If the wait can't run (for example, the page navigated during it), juxtapose waits for fonts, images and a quiet DOM instead and flags the result `settle-fallback`.

  New settle options, layered from the project config through story parameters (including variants) to the command: `settle.timeout`, `settle.ready` (wait for the page to call `window.__juxtapose.ready()`), `settle.network.ignore` and `settle.network.require` (URL glob patterns with an optional `type:<ResourceType>`). WebSocket, EventSource, beacon and prefetch requests are ignored by default. The project config also accepts `waitForSelector` and `delay`. `jux snap` and `jux run` take `--settle-timeout`, `--settle-ready`, `--no-settle-ready`, `--settle-ignore` and `--settle-require`, `jux snap` takes `--delay`, and the MCP `snap` and `run` tools take a `settle` argument (and `delay` on `snap`). An invalid settle option exits 2 and names where it came from; the review server reports an invalid project `settle` as a config error.

  Fixes a hang: the image wait before capture had no cap, so a story with an image that never loaded held its worker until the page's 30 s evaluation timeout. Images are now part of the capped wait, and a lazy image outside the viewport is not waited for.

  The exported `Page` interface gains an optional internal `on` for CDP events; a `Page` implemented outside core doesn't need it.

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

## 0.8.0

### Minor Changes

- 6b98571: CDP calls are typed through Chrome's own protocol definitions (`devtools-protocol`, a types-only dependency of `@juxtapose/core`, pinned to the protocol revision of the pinned Chrome), and JSON read from disk or the wire is checked where it enters instead of cast. `Page.send` infers params and results for protocol methods; an untyped fallback overload keeps existing `page.send<T>('Method', params)` calls, and methods newer than the pinned protocol, compiling unchanged. New exports `parseRunReport` and `isRunReport` read a `report.json`. Files that are not what they claim now fail with a message at the boundary: a `report.json` that is not a run report, a structure sidecar that is not one `jux` wrote (read as absent, like a corrupt one), and a review-server `/run` body whose `storyIds` is not a list of ids (400). The Storybook addon now calls `addons.add` bound to `addons`. Capture output is unchanged.

## 0.7.0

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

## 0.6.0

### Minor Changes

- 8ea2e71: The CDP driver, launch flags, installer and warm-browser daemon are exported on their own as `@juxtapose/core/browser`. That entry imports nothing else from core, and the main entry still exports everything it did.
- a4593ae: Keep one browser warm between `jux snap`, `jux run` and `jux init` invocations (per user and rendering environment, idle exit after 10 minutes). It is off in CI, on Windows, with `--no-daemon`, and with `JUX_NO_DAEMON=1`. Captures are byte-identical warm and cold. `jux browser start|stop|status` manage it. The daemon's socket and state live in `JUX_STATE_DIR`, which defaults to the cache dir (`JUX_CACHE_DIR`) so existing setups do not move.

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

- e65f1bd: Stop the PR comment and HTML report calling a real change "0%"

  Pass/fail is a byte hash, but the percentage comes from pixelmatch, which tolerates small colour deltas. A colour nudge like `#2563eb` to `#1d4ed8` therefore failed the hash, marked zero pixels, and was listed as **0%** in the comment and "0% changed" in the HTML report. It now reads "subtle, diff marks no pixels". A crashed capture still shows its error.

  The comment also now names the Storybook panel by its actual tab label, **Visual**.

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

- 474a0db: Add npm keywords and a homepage link to each package

  Nothing installed changes; this is what the registry listing shows and how the
  packages are found in search.

## 0.3.0

### Minor Changes

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

- 77fac97: Add `mask` for content that changes every run.

  A clock or a random avatar makes a story permanently red under a byte-exact
  hash, and `minDiffPercent` cannot help — the hash decides before the diff runs.
  `parameters.juxtapose.mask` takes CSS selectors and paints a solid box over
  each before the screenshot, so that region is identical every run while
  everything around it is still compared exactly.

  The docs lead with the better fix: make the input deterministic. Stubbing the
  date keeps full pixel coverage; masking gives it up for that region, and is for
  nondeterminism you do not control.

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
