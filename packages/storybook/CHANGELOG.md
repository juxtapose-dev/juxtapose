# @juxtapose/storybook

## 0.13.1

### Patch Changes

- Updated dependencies [6ac22d0]
  - @juxtapose/core@0.26.1
  - @juxtapose/adapter-storybook@0.4.35
  - @juxtapose/server@0.9.15

## 0.13.0

### Minor Changes

- f2deebe: Capture bounded React, Vue, and instrumented Svelte component trees alongside DOM evidence. Component instances link to their retained DOM elements for visual review and agent inspection, while image verdicts and structure hashes remain unchanged. Masked captures suppress component identities.

  The Storybook Vite preset adds component build support automatically. Other Vite workbenches can use `juxtaposeComponentEvidence()` from `@juxtapose/core/vite`. Svelte records context parents and declared element ownership; coverage excludes uninstrumented dependencies. React and Vue source positions are not inferred from names.

### Patch Changes

- Updated dependencies [f2deebe]
  - @juxtapose/core@0.26.0
  - @juxtapose/adapter-storybook@0.4.34
  - @juxtapose/server@0.9.14

## 0.12.13

### Patch Changes

- Updated dependencies [c4e4976]
  - @juxtapose/core@0.25.3
  - @juxtapose/adapter-storybook@0.4.33
  - @juxtapose/server@0.9.13

## 0.12.12

### Patch Changes

- Updated dependencies [0a27b1c]
  - @juxtapose/core@0.25.2
  - @juxtapose/adapter-storybook@0.4.32
  - @juxtapose/server@0.9.12

## 0.12.11

### Patch Changes

- Updated dependencies [c58e1bc]
  - @juxtapose/core@0.25.1
  - @juxtapose/adapter-storybook@0.4.31
  - @juxtapose/server@0.9.11

## 0.12.10

### Patch Changes

- c47a075: Restrict the local review API to loopback callers with trusted loopback hosts and same-origin browser requests. Require an explicit review header and JSON content type for mutations, and update the Storybook client to send them. This blocks cross-site baseline approvals and capture cancellation; directly exposed network review APIs are no longer accepted.

  Keep static workbench reads within the real build directory, including symlinks. Malformed request URLs now return an error instead of terminating the capture process.

- Updated dependencies [c47a075]
  - @juxtapose/server@0.9.10

## 0.12.9

### Patch Changes

- 129c399: Label the addon panel and test-provider row **Juxtapose**. Document MSW setup and verify real service-worker-mocked responses in CI across repeated captures. MSW remains an application dependency, not a dependency of the published addon.

- Updated dependencies [129c399]
- Updated dependencies [d22d8db]
- Updated dependencies [eabc743]
  - @juxtapose/core@0.25.0
  - @juxtapose/adapter-storybook@0.4.30
  - @juxtapose/server@0.9.9

## 0.12.8

### Patch Changes

- Updated dependencies [c7f42ef]
- Updated dependencies [5a7bae3]
  - @juxtapose/core@0.24.2
  - @juxtapose/adapter-storybook@0.4.29
  - @juxtapose/server@0.9.8

## 0.12.7

### Patch Changes

- Updated dependencies [46b49ec]
- Updated dependencies [b00d733]
- Updated dependencies [2bc87d1]
  - @juxtapose/core@0.24.1
  - @juxtapose/adapter-storybook@0.4.28
  - @juxtapose/server@0.9.7

## 0.12.6

### Patch Changes

- Updated dependencies [3440b1b]
- Updated dependencies [28de788]
  - @juxtapose/core@0.24.0
  - @juxtapose/adapter-storybook@0.4.27
  - @juxtapose/server@0.9.6

## 0.12.5

### Patch Changes

- Updated dependencies [cdbf28d]
  - @juxtapose/core@0.23.3
  - @juxtapose/adapter-storybook@0.4.26
  - @juxtapose/server@0.9.5

## 0.12.4

### Patch Changes

- Updated dependencies [95a846a]
  - @juxtapose/core@0.23.2
  - @juxtapose/adapter-storybook@0.4.25
  - @juxtapose/server@0.9.4

## 0.12.3

### Patch Changes

- 5e32818: Tighten the visual review panel with a compact, expandable change summary and grouped comparison controls. Start with clean side-by-side captures and enable the diff overlay when needed. Bound comparison images on wide panels while keeping the complete captures visible.
- Updated dependencies [aa9878e]
  - @juxtapose/core@0.23.1
  - @juxtapose/adapter-storybook@0.4.24
  - @juxtapose/server@0.9.3

## 0.12.2

### Patch Changes

- Updated dependencies [a65a610]
  - @juxtapose/core@0.23.0
  - @juxtapose/adapter-storybook@0.4.23
  - @juxtapose/server@0.9.2

## 0.12.1

### Patch Changes

- Updated dependencies [a5ca6bd]
- Updated dependencies [be525cc]
  - @juxtapose/core@0.22.0
  - @juxtapose/adapter-storybook@0.4.22
  - @juxtapose/server@0.9.1

## 0.12.0

### Minor Changes

- 02495a8: Explain visual changes in the Storybook panel using structural and flake evidence already in the report. Improve keyboard and reduced-motion comparison controls, clipboard fallback, missing-image states, and approval guards.

  Expose typed run outcomes so background failures and cancellation cannot masquerade as a successful previous report. Prevent concurrent captures during discovery, surface rejected run/cancel requests, and include structural evidence in copied agent prompts.

### Patch Changes

- Updated dependencies [02495a8]
  - @juxtapose/server@0.9.0

## 0.11.0

### Minor Changes

- 87dfe16: Freeze animated GIF, WebP and APNG images on their first frame by default (#182). Set `freeze.images: false` to retain playback for a project.

  Add opt-in clock and random fixture controls (#146). `freeze.clock: true` starts `Date`, `Date.now()`, `Intl.DateTimeFormat` and `Temporal.Now` at 2024-01-01T12:00:00Z; an ISO 8601 instant selects another starting time. Timer callbacks advance the clock, with a fallback for synchronous clock polling; asynchronous callback order is not controlled. `freeze.random: true` seeds `Math.random`, `crypto.getRandomValues` and `crypto.randomUUID`. Both options default to `false`.

  Clock and random settings layer per project, story, variant and `stories` override; animated-image policy is project-wide. Types, JSON schema, configuration docs and `jux config --explain` describe the controls.

### Patch Changes

- Updated dependencies [7239da1]
- Updated dependencies [87dfe16]
- Updated dependencies [5ae3ce9]
- Updated dependencies [42eac75]
- Updated dependencies [9dbf3bc]
  - @juxtapose/core@0.21.0
  - @juxtapose/server@0.8.3
  - @juxtapose/adapter-storybook@0.4.21

## 0.10.2

### Patch Changes

- Updated dependencies [41f0c65]
  - @juxtapose/core@0.20.2
  - @juxtapose/adapter-storybook@0.4.20
  - @juxtapose/server@0.8.2

## 0.10.1

### Patch Changes

- Updated dependencies [0751c38]
  - @juxtapose/core@0.20.1
  - @juxtapose/adapter-storybook@0.4.19
  - @juxtapose/server@0.8.1

## 0.10.0

### Minor Changes

- 25261d6: Add opt-in `comparison: { mode: "pixelmatch", threshold: 0.05 }` at project, story, variant, and override level. Exact SHA-256 matches remain the fast path and default. Hash mismatches can pass only with a verified baseline image, valid ancestry, equal dimensions, and zero pixels remaining after Pixelmatch color/antialias filtering. Reports identify visual-equivalence passes and preserve both exact hashes; approved baselines, fresh approval, and exact renderer recovery are unchanged.

### Patch Changes

- Updated dependencies [25261d6]
  - @juxtapose/core@0.20.0
  - @juxtapose/server@0.8.0
  - @juxtapose/adapter-storybook@0.4.18

## 0.9.7

### Patch Changes

- Updated dependencies [af4e714]
  - @juxtapose/core@0.19.1
  - @juxtapose/adapter-storybook@0.4.17
  - @juxtapose/server@0.7.11

## 0.9.6

### Patch Changes

- Updated dependencies [9461f93]
  - @juxtapose/core@0.19.0
  - @juxtapose/server@0.7.10
  - @juxtapose/adapter-storybook@0.4.16

## 0.9.5

### Patch Changes

- Updated dependencies [1dda4b6]
- Updated dependencies [1dda4b6]
  - @juxtapose/core@0.18.4
  - @juxtapose/adapter-storybook@0.4.15
  - @juxtapose/server@0.7.9

## 0.9.4

### Patch Changes

- Updated dependencies [0dde787]
  - @juxtapose/core@0.18.3
  - @juxtapose/adapter-storybook@0.4.14
  - @juxtapose/server@0.7.8

## 0.9.3

### Patch Changes

- Updated dependencies [bea2cfd]
  - @juxtapose/adapter-storybook@0.4.13

## 0.9.2

### Patch Changes

- Updated dependencies [6dac140]
  - @juxtapose/core@0.18.2
  - @juxtapose/adapter-storybook@0.4.12
  - @juxtapose/server@0.7.7

## 0.9.1

### Patch Changes

- Updated dependencies [62fb1ec]
  - @juxtapose/core@0.18.1
  - @juxtapose/adapter-storybook@0.4.11
  - @juxtapose/server@0.7.6

## 0.9.0

### Minor Changes

- f5c1b67: `jux run --since` now captures only the stories a changed component reaches, instead of every story (#200). Vite's build manifest lists chunks, not the modules bundled into them, so a shared component never appeared in it and almost every UI edit fell back to a full run. The Storybook addon now adds a Vite plugin to `storybook build` that records every source module and its imports to `.vite/juxtapose-modules.json`; the analysis walks that. Ladle and other Vite workbenches add `juxtaposeModuleGraph()` from the new `@juxtapose/core/vite` export to their `vite.config.js`. Rebuild once after upgrading, and before each `--since` run.

  Only script edits narrow. Editing a stylesheet or any other asset runs every story (`asset-changed`), because plugins rewrite `@import`, `@use` and `url()` before they could be read. The graph is the bundler's import graph plus `new URL(…, import.meta.url)`. Anything else it cannot place still captures everything, and the printed reason names the file: a changed file the build never saw (`unmapped-change`, even beside mapped files), a module that runs for every story such as the preview, including when each story imports it (`shared-entry-changed`), a build with workers, worklets or computed asset paths, where no change is narrowed, a source whose content differs from the hash recorded at build time (`stale-graph`; content, not mtime, so a fresh checkout is fine), a graph built from another root (`graph-root-mismatch`), and any `--origin` run (`origin-run`). Markdown in the source tree is not exempt (a glob can load it), nothing under `public/` is, and only `.github/` and repo-root meta files (README, LICENSE, …) are ignored. A file a build plugin read from disk to make a virtual module, a virtual module from a user plugin, and `cssCodeSplit: false` with a `.vue`/`.svelte` edit also escalate. Docs pages (`.mdx`) no longer force a full run. The plugin never fails a build: on an error it warns and writes no graph. A webpack Storybook build is told narrowing is not available instead of being asked to add a Vite plugin. Also fixed: repository-relative paths are mapped to project paths, so affected-only runs work when the workbench is below the repository root (#96), and a project-level `tsconfig.json`, lockfile or `.storybook` there now escalates.

### Patch Changes

- Updated dependencies [f5c1b67]
  - @juxtapose/core@0.18.0
  - @juxtapose/adapter-storybook@0.4.10
  - @juxtapose/server@0.7.5

## 0.8.2

### Patch Changes

- d7558ed: Make the stable-approve recheck configurable. `recheck` in the config, `--recheck <mode>` and `--no-recheck` on `jux run`, and a `recheck` argument on the MCP `run` tool choose which stories the run captures twice: `"changed"` (new and failing, the default and today's behavior), `"new"` (new only) or `"off"` (none). A story the run didn't capture twice is marked `unrechecked` in `report.json`, and `jux approve` captures it again and approves it only if the two hashes match, so approval stays safe; `--allow-unstable` still overrides. A story captured once also carries an `unstable` verdict (`not rechecked`), so an older approver refuses it rather than baselining one capture. With the recheck off, stories carry no `flake`, and `report.json` (`recheck`) and the `jux run` output say so. `jux config --explain` shows the effective `recheck` and its source. The Storybook panel's approve button refuses an `unrechecked` story; use `jux approve`.
- Updated dependencies [d7558ed]
  - @juxtapose/core@0.17.0
  - @juxtapose/server@0.7.4
  - @juxtapose/adapter-storybook@0.4.9

## 0.8.1

### Patch Changes

- Updated dependencies [34f879d]
  - @juxtapose/core@0.16.1
  - @juxtapose/adapter-storybook@0.4.8
  - @juxtapose/server@0.7.3

## 0.8.0

### Minor Changes

- 6ec8d81: Projects no longer commit snapshot images. The default storage is now `{ "kind": "cache" }`: baseline images live in a git-ignored, hash-keyed cache (`.juxtapose/cache/baselines/<sha256>.webp`), and the repo carries only `juxtapose.manifest.json`, a lockfile holding each story's hash (which decides pass/fail) and its approved structure inline (one element per line, stories sorted by id, so an approval diff shows what moved; the file stays `"version": 1`, which an older jux reads as the same hashes). On a merge conflict, don't hand-merge it: take either side and re-run `jux approve --story <id>`. `.juxtapose/` is entirely machine-local and ignored with one line. A failing story whose image is not in the cache is reported by hash and structure ("baseline image not available (not in cache); structure diff only") instead of erroring, in run output, the PR comment, the handoff, the HTML report and the panel. A passing run keeps its capture in the cache; `jux run` never writes the manifest. `jux init` writes the `.gitignore` entries, and the new `jux doctor` lists tracked images and prints the migration. `docs/ci.md` has a GitHub Actions snippet that saves and restores the cache. The cache is not pruned yet (see #114). A cache or tmp directory that is a symlink is never written to or swept. The cache's `dir` is now validated: a relative path inside the project with no `..`, absolute or UNC path, glob characters, control characters or leading `-`. A `git` or `fs` `dir` is unchanged (any path, including outside the project), apart from refusing a leading `-` and control characters. A refused value exits 2.

  Migration. Projects with `storage.kind: "git"` (or `"fs"`) set explicitly are unchanged. Projects with no `storage` key and images committed under `.juxtapose/baselines/` keep working: jux still reads those images (when they match the manifest hash) and writes new ones to the cache. To move over, run `jux doctor` and follow what it prints: `jux run --all` first (it copies each image that matches the manifest into the cache, which matters because the commit that untracks the images deletes them from every other clone), then `git rm --cached -- ':(glob).juxtapose/baselines/*.webp'`, the `.gitignore` line `.juxtapose/`, and a commit. Teammates and CI then have no images until their own run or a restored CI cache fills the cache, and report structure only until then. The old per-story `.structure.json.gz` files are folded into the manifest by `jux doctor --fix` (no capture, no approval); doctor then prints the commands to untrack them. To keep committing images, set `"storage": { "kind": "git" }`.

### Patch Changes

- Updated dependencies [7a53ce1]
- Updated dependencies [6ec8d81]
  - @juxtapose/core@0.16.0
  - @juxtapose/adapter-storybook@0.4.7
  - @juxtapose/server@0.7.2

## 0.7.2

### Patch Changes

- 7f8daae: Fix the addon panel crashing in React 19 projects (`Cannot read properties of undefined (reading 'recentlyCreatedOwnerStacks')`). The manager code imported `react/jsx-runtime`, which Storybook does not provide to the manager, so it was bundled from the project's React 19 and ran against the manager's React 18. The manager now compiles with the classic JSX transform and imports only modules the manager provides.

## 0.7.1

### Patch Changes

- Updated dependencies [e3608de]
  - @juxtapose/core@0.15.0
  - @juxtapose/adapter-storybook@0.4.6
  - @juxtapose/server@0.7.1

## 0.7.0

### Minor Changes

- 48258e9: Approving a baseline now requires two identical captures (#148). `jux run` captures each new or failing story a second time and records `unstable` in report.json when the hashes differ, or `unstable.unconfirmed` when the second capture fails, so an unverified story is never approved. Passing and stale stories are not rechecked (stale already matches a recorded hash), so a green run costs nothing extra; a first run and `jux init` take about 2x as long. `jux approve`, `jux init`, the MCP `approve` tool and the Storybook panel refuse an unstable story and name it, while approving the rest; the review server answers 409. Pass `--allow-unstable` (MCP: `allowUnstable`) to baseline one anyway. `jux run`, `check`, `handoff`, the PR comment and the HTML report mark unstable stories, and the panel's "approve all" now shows refusals instead of swallowing them.

### Patch Changes

- b40e080: One schema for the project config and story parameters (#178). `@juxtapose/core` now publishes `@juxtapose/core/schema.json`, a JSON Schema for `juxtapose.config.json` that gives editors completion, hover docs and validation. It also exports `JuxtaposeParameters`, the schemas themselves, and `registerFormats()` for checking them with TypeBox. The TypeScript types, the JSON Schema, the MCP tool argument shapes and the runtime checks are all derived from it. The runtime accepts and rejects exactly what it did before, with the same messages. An unknown key now prints a warning on stderr with the closest option it could mean; it never fails a command. Adds the `@sinclair/typebox` dependency. `jux init` writes a `$schema` line pinned to the installed version on jsDelivr, and `@juxtapose/cli` ships a copy of `schema.json` for offline use. `@juxtapose/storybook` exports `JuxtaposeParameters` and types `parameters.juxtapose` in CSF files (#180).
- Updated dependencies [4638d64]
- Updated dependencies [b40e080]
- Updated dependencies [535c676]
- Updated dependencies [48258e9]
  - @juxtapose/core@0.14.0
  - @juxtapose/server@0.7.0
  - @juxtapose/adapter-storybook@0.4.5

## 0.6.4

### Patch Changes

- Updated dependencies [e2d1770]
- Updated dependencies [3668e0e]
- Updated dependencies [a7e5e61]
  - @juxtapose/core@0.13.0
  - @juxtapose/adapter-storybook@0.4.4
  - @juxtapose/server@0.6.4

## 0.6.3

### Patch Changes

- Updated dependencies [c602676]
- Updated dependencies [981f6b9]
- Updated dependencies [f251aa8]
- Updated dependencies [0807b4f]
- Updated dependencies [a646af0]
  - @juxtapose/core@0.12.0
  - @juxtapose/adapter-storybook@0.4.3
  - @juxtapose/server@0.6.3

## 0.6.2

### Patch Changes

- Updated dependencies [16d7ed3]
- Updated dependencies [8f38247]
- Updated dependencies [dc60343]
- Updated dependencies [c7f9ffb]
- Updated dependencies [255fc28]
  - @juxtapose/core@0.11.0
  - @juxtapose/adapter-storybook@0.4.2
  - @juxtapose/server@0.6.2

## 0.6.1

### Patch Changes

- Updated dependencies [746d075]
  - @juxtapose/core@0.10.0
  - @juxtapose/server@0.6.1
  - @juxtapose/adapter-storybook@0.4.1

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
