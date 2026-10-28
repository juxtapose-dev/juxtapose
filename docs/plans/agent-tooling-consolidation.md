# Agent tooling consolidation

Consolidated on 2026-10-28 in `release/agent-tooling-consolidation`, based on
GitHub main `8ec03ab5`. Original branches and worktrees are preserved. This
branch is not a release or a deployment.

## Included work

| Source                                                                     | Result                                                                                                                                                                                                                                                                                              |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Saved-evidence stack through `feat/compact-target-raw-counts` (`511934ea`) | Saved checkpoints, optional target progress, compact summaries, exact RGBA counts, focused layout and pixel evidence, complete saved regions, contextual crops, target access before capture, saved element inspection, typography and scrolled coordinates. Applied in dependency order onto main. |
| `feat/focused-evidence-diversity` (`ab33f7fc`)                             | Repeated positions and explicit omissions, reconciled with the later 3 KiB target / 4 KiB maximum. Both paint inventories take priority over extra positions.                                                                                                                                       |
| `feat/mcp-saved-ancestor` (`d4d1d7fd`)                                     | Bounded, unambiguous saved ancestor lookup, preserving uncaptured-property diagnostics.                                                                                                                                                                                                             |
| `feat/mcp-focused-paint-observations` (`585396e9`)                         | Co-located color observations in requested layout detail, within the newer evidence budget.                                                                                                                                                                                                         |
| `fix/agent-feedback-gaps` (`a5fd42b0`, `a5e39ca9`)                         | Full-page extent mismatches fail with overlap and missing-area evidence; new-story runs point to their target comparison when available.                                                                                                                                                            |
| Main-based MCP ports (`45bc9f82`, `6c4e2c3d`)                              | Exact tool selection and stable latest-run ordering, including equal timestamp ties.                                                                                                                                                                                                                |
| `feat/run-checkpoint-main` (`72dda479`)                                    | Existing equivalent checkpoint implementation retained; additional validation tests imported, including pre-capture rejection of invalid/null checkpoints, no-reference projects, failure isolation and bounded large runs.                                                                         |
| Raw-count and instruction ports (`16d3c4da`, `9c5ceda7`)                   | Overlapping behavior reconciled rather than applying duplicate implementations. Exact counts reject unverified values; workflow details remain on tools, initialization stays compact, and approval requires user intent.                                                                           |

Main's device presets, orientation, full-page capture and existing Storybook
review UI remain present. The panel tab and test-provider label are now
`Juxtapose`, with a rendered-tab assertion in the live manager check. Experimental target OCR/paint providers remain opt-in
programmatic capabilities; the public CLI does not enable a provider or make
external OCR calls. Measurements never establish approval or prove CSS causes.

## Integration fixes

- Reference history now reads version 2 analysis entries, matching the newer
  extent comparison cache. Version 1 results cannot be reused as current evidence.
- Concurrent saved-reference evaluation preserves full-page layout provenance.
- Optional checkpoint arguments reject `null` before launching a capture.
- Repeated-position evidence fits around whole observations and retains omission
  counts; color observations cannot evict geometry.
- The restricted tool catalog has a budget for its combined target, ancestor,
  crop and checkpoint schemas. Default initialization no longer repeats element
  identity instructions on every tool.
- Changesets from the development stack are combined into one CLI/core minor
  changeset; main's existing device/full-page changesets are retained.

## Storybook and MSW

Storybook/Ladle capture contexts already allow service workers. URL `jux snap`
contexts still block registration; this consolidation does not change that policy.

The example now includes two real MSW 2.15.0 stories. Their loaders await
`worker.start()` before fetching, following the [MSW browser integration](https://mswjs.io/guides/integrations/browser).
The worker asset is copied from the pinned example-only dependency at build
time. Neither MSW nor its worker is added to the published addon dependencies.

`node scripts/check-msw.mjs` runs the built CLI against a temporary Storybook
project, verifies both mocked values in captured structure, checks that the two
stories have distinct pixels, and checks exact repeatability across three runs.
It never approves baselines. CI runs this check in its determinism job.

## Explicitly separate

- `feat/figma-reference`: excluded at the user's request.
- PR-native review work in `juxtapose-pr-review` and
  `juxtapose-service-pr-review`: preserved separately, not included here.
- Experimental CSS probes, repeated-paint group experiments, and unrelated
  performance prototypes: not promoted by this consolidation. Historical
  evidence documents in the included stack retain their limitations.
- No package publishing, main merge, SaaS deployment, or source branch deletion.

## Validation

- Full native suite: 174 test files passed; 2,251 tests passed, 3 skipped
  (`pnpm test --maxWorkers=4 --minWorkers=1`). An existing 100 ms framing
  performance assertion failed under simultaneous full-suite/build load, then
  passed in 10.5 ms in isolation and passed in the bounded-worker full suite.

- All six packages build; TypeScript and ESLint checks run against the combined tree.
- Focused integration suite: 66 tests passed, including the imported checkpoint tests.
- Real Storybook manager: addon and test provider registered; explanations,
  missing baselines, errors, clipboard fallback, run/cancel, approval guards,
  keyboard wipe and reduced motion passed.
- Storybook before adding MSW: 19 stories byte-identical across three captures.
- Ladle: 16 stories byte-identical across three captures.
- Real MSW: two distinct mocked stories rendered correctly and were byte-identical
  across three captures.

Native Chrome checks require access outside the execution sandbox on this Mac.
The sandbox-only suite cannot launch Chrome; validation uses the native run.
Local repeatability does not establish macOS/Linux pixel equivalence. GitHub's
Linux checks must run before merging; PR comparisons should render both sides
in the same controlled CI environment.

## Release preparation

Changesets validates the combined CLI/core minor release and addon patch.
Proposed versions are CLI 0.26.0, core 0.25.0, and Storybook addon 0.12.9,
with adapter/server dependency patches. These versions have not been published.
