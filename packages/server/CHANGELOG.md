# @juxtapose/server

## 0.7.11

### Patch Changes

- Updated dependencies [af4e714]
  - @juxtapose/core@0.19.1

## 0.7.10

### Patch Changes

- 9461f93: Add project and per-story `renderer: { shared, clearResourceCache }` settings. Shared rendering is the default. Baseline mismatches receive bounded cache-pulse retries followed by fresh retries, with retry evidence and per-story pinning instructions in reports. Proactive cache clearing is optional. Reports identify which recovery matched the baseline.

  Approval now confirms every selected capture on a fresh renderer, including with `--allow-unstable`, and requires the reviewed hash to match. Initial baselines also use fresh renderers.

- Updated dependencies [9461f93]
  - @juxtapose/core@0.19.0

## 0.7.9

### Patch Changes

- Updated dependencies [1dda4b6]
- Updated dependencies [1dda4b6]
  - @juxtapose/core@0.18.4

## 0.7.8

### Patch Changes

- Updated dependencies [0dde787]
  - @juxtapose/core@0.18.3

## 0.7.7

### Patch Changes

- Updated dependencies [6dac140]
  - @juxtapose/core@0.18.2

## 0.7.6

### Patch Changes

- Updated dependencies [62fb1ec]
  - @juxtapose/core@0.18.1

## 0.7.5

### Patch Changes

- Updated dependencies [f5c1b67]
  - @juxtapose/core@0.18.0

## 0.7.4

### Patch Changes

- d7558ed: Make the stable-approve recheck configurable. `recheck` in the config, `--recheck <mode>` and `--no-recheck` on `jux run`, and a `recheck` argument on the MCP `run` tool choose which stories the run captures twice: `"changed"` (new and failing, the default and today's behavior), `"new"` (new only) or `"off"` (none). A story the run didn't capture twice is marked `unrechecked` in `report.json`, and `jux approve` captures it again and approves it only if the two hashes match, so approval stays safe; `--allow-unstable` still overrides. A story captured once also carries an `unstable` verdict (`not rechecked`), so an older approver refuses it rather than baselining one capture. With the recheck off, stories carry no `flake`, and `report.json` (`recheck`) and the `jux run` output say so. `jux config --explain` shows the effective `recheck` and its source. The Storybook panel's approve button refuses an `unrechecked` story; use `jux approve`.
- Updated dependencies [d7558ed]
  - @juxtapose/core@0.17.0

## 0.7.3

### Patch Changes

- Updated dependencies [34f879d]
  - @juxtapose/core@0.16.1

## 0.7.2

### Patch Changes

- Updated dependencies [7a53ce1]
- Updated dependencies [6ec8d81]
  - @juxtapose/core@0.16.0

## 0.7.1

### Patch Changes

- Updated dependencies [e3608de]
  - @juxtapose/core@0.15.0

## 0.7.0

### Minor Changes

- 48258e9: Approving a baseline now requires two identical captures (#148). `jux run` captures each new or failing story a second time and records `unstable` in report.json when the hashes differ, or `unstable.unconfirmed` when the second capture fails, so an unverified story is never approved. Passing and stale stories are not rechecked (stale already matches a recorded hash), so a green run costs nothing extra; a first run and `jux init` take about 2x as long. `jux approve`, `jux init`, the MCP `approve` tool and the Storybook panel refuse an unstable story and name it, while approving the rest; the review server answers 409. Pass `--allow-unstable` (MCP: `allowUnstable`) to baseline one anyway. `jux run`, `check`, `handoff`, the PR comment and the HTML report mark unstable stories, and the panel's "approve all" now shows refusals instead of swallowing them.

### Patch Changes

- Updated dependencies [4638d64]
- Updated dependencies [b40e080]
- Updated dependencies [535c676]
- Updated dependencies [48258e9]
  - @juxtapose/core@0.14.0

## 0.6.4

### Patch Changes

- Updated dependencies [e2d1770]
- Updated dependencies [3668e0e]
- Updated dependencies [a7e5e61]
  - @juxtapose/core@0.13.0

## 0.6.3

### Patch Changes

- Updated dependencies [c602676]
- Updated dependencies [981f6b9]
- Updated dependencies [f251aa8]
- Updated dependencies [0807b4f]
- Updated dependencies [a646af0]
  - @juxtapose/core@0.12.0

## 0.6.2

### Patch Changes

- Updated dependencies [16d7ed3]
- Updated dependencies [8f38247]
- Updated dependencies [dc60343]
- Updated dependencies [c7f9ffb]
- Updated dependencies [255fc28]
  - @juxtapose/core@0.11.0

## 0.6.1

### Patch Changes

- 746d075: Event-driven settle. Instead of waiting for 150 ms without DOM changes (capped at 500 ms), juxtapose now waits until the page has no pending timers due within 1000 ms, animation frames, posted messages, DOM changes, loading fonts, loading in-viewport images or network requests in flight. On the example workbenches the captures are byte-identical to before, and settling takes about 40 ms per story instead of about 165 ms. Pages that finish late, such as a 300 ms timer or a slow fetch, are now captured in their final state.

  The wait is capped by `settle.timeout` (default 1500 ms). At the cap the page is captured anyway, and the result is flagged `settle-timeout` with a list of what was still pending, such as `1 request to /api/feed in flight (Fetch)`. The flag appears in `DiffResult.flags` and `DiffResult.settle`, in the verdict's `flags`, in `jux snap` results, in `jux run` output and in `jux handoff`. It never changes a pass or a failure. If the wait can't run (for example, the page navigated during it), juxtapose waits for fonts, images and a quiet DOM instead and flags the result `settle-fallback`.

  New settle options, layered from the project config through story parameters (including variants) to the command: `settle.timeout`, `settle.ready` (wait for the page to call `window.__juxtapose.ready()`), `settle.network.ignore` and `settle.network.require` (URL glob patterns with an optional `type:<ResourceType>`). WebSocket, EventSource, beacon and prefetch requests are ignored by default. The project config also accepts `waitForSelector` and `delay`. `jux snap` and `jux run` take `--settle-timeout`, `--settle-ready`, `--no-settle-ready`, `--settle-ignore` and `--settle-require`, `jux snap` takes `--delay`, and the MCP `snap` and `run` tools take a `settle` argument (and `delay` on `snap`). An invalid settle option exits 2 and names where it came from; the review server reports an invalid project `settle` as a config error.

  Fixes a hang: the image wait before capture had no cap, so a story with an image that never loaded held its worker until the page's 30 s evaluation timeout. Images are now part of the capped wait, and a lazy image outside the viewport is not waited for.

  The exported `Page` interface gains an optional internal `on` for CDP events; a `Page` implemented outside core doesn't need it.

- Updated dependencies [746d075]
  - @juxtapose/core@0.10.0

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
  - @juxtapose/core@0.9.0

## 0.5.3

### Patch Changes

- 6b98571: CDP calls are typed through Chrome's own protocol definitions (`devtools-protocol`, a types-only dependency of `@juxtapose/core`, pinned to the protocol revision of the pinned Chrome), and JSON read from disk or the wire is checked where it enters instead of cast. `Page.send` infers params and results for protocol methods; an untyped fallback overload keeps existing `page.send<T>('Method', params)` calls, and methods newer than the pinned protocol, compiling unchanged. New exports `parseRunReport` and `isRunReport` read a `report.json`. Files that are not what they claim now fail with a message at the boundary: a `report.json` that is not a run report, a structure sidecar that is not one `jux` wrote (read as absent, like a corrupt one), and a review-server `/run` body whose `storyIds` is not a list of ids (400). The Storybook addon now calls `addons.add` bound to `addons`. Capture output is unchanged.
- Updated dependencies [6b98571]
  - @juxtapose/core@0.8.0

## 0.5.2

### Patch Changes

- Updated dependencies [dfb006b]
  - @juxtapose/core@0.7.0

## 0.5.1

### Patch Changes

- Updated dependencies [8ea2e71]
- Updated dependencies [a4593ae]
  - @juxtapose/core@0.6.0

## 0.5.0

### Minor Changes

- 31bc685: Capture through juxtapose's own CDP driver instead of Playwright. Captures stay byte-identical (verified on both example workbenches), so existing baselines remain valid and nothing needs re-approving.

  Playwright is no longer a dependency or peer dependency. The browser is a pinned `chrome-headless-shell` 151.0.7922.34, installed once with `npx -p @juxtapose/cli jux browser install` (also `jux browser status` and `jux browser path`). An existing `ms-playwright` cache of the same build is reused and nothing is downloaded. New: `JUX_CHROME=<path>` or `--chrome <path>` uses your own Chromium, and `JUX_CACHE_DIR` moves the cache.

  **Breaking:**

  - Mask and `--wait-for` selectors must be CSS. Playwright-only syntax (`text=`, `>>`, `:has-text()`, `:visible`, `nth=`) now fails the story with `jux: selector '…' is not a CSS selector` instead of silently matching nothing.
  - Node >= 22.2.0 is required (it was 20).
  - Adapters receive `@juxtapose/core`'s `Page`, not Playwright's. Third-party adapters that used Playwright-only `Page` methods need to move to the `Page` interface core exports.

### Patch Changes

- 373ff1b: `jux run --since` says why a story changed: the verdict gains `cause`, the
  story's import closure intersected with the changed files, with
  `partial: true` when that closure could not be fully traced. `RunReport.groups`
  lists every change shared by two or more failing stories. `jux diff --crops`
  writes side-by-side strips per changed region (`juxtapose.crops/v1`), no
  browser (below the pixel tolerance, the changed elements instead); `jux
handoff` ends with that command. Core exports `shellQuote`. A child whose box only
  followed its parent's move or resize is no longer a delta. A Claude Code
  plugin with the `visual-check` skill lives in `plugins/claude-code/`. The review server's merged reports regroup over all results.
- Updated dependencies [373ff1b]
- Updated dependencies [31bc685]
- Updated dependencies [e65f1bd]
- Updated dependencies [68c7ceb]
- Updated dependencies [966f6e7]
  - @juxtapose/core@0.5.0

## 0.4.0

### Minor Changes

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

- Updated dependencies [474a0db]
- Updated dependencies [04615a6]
- Updated dependencies [f40f5cf]
  - @juxtapose/core@0.4.0

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
