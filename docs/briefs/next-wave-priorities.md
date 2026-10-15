# Next wave: reliability first, then measured capture speed

Evidence reviewed 2026-10-15, main `b8642e5`, published CLI/core 0.19.0.

## Recommendation

Keep renderer sharing on by default, with bounded exact-hash recovery. Start
with HTTP failure classification and the Linux text-rendering investigation;
then close network isolation gaps and finish deterministic clock/GIF work.
Native lossless WebP is the next measured performance experiment. Do not merge
`--no-opt` based on measurements made before shared rendering became the default.

## Release readiness and new evidence

The actual published `@juxtapose/cli@0.19.0` was installed through `npm exec`
using a temporary npm cache and exercised against hosted Storybooks. No workspace
install was performed. This validates package installation and basic end-to-end
use on macOS, not every platform or integration.

The controlled benchmark in PR #234 is merged. Its 24 deterministic stories span
five viewport/theme configurations, including tablet and dark mobile. Five
measured runs per renderer mode produced **1,200 exact baseline matches, zero
retries**. Shared median wall time was 6.06 s versus 8.37 s fresh. See
[profiling methodology and phase measurements](../profiling.md).

A separate hosted sample used 60 stories each from Fluent, Carbon, and Gutenberg:
48 spread across component defaults plus 12 additional states. Each used a fresh
reference, fresh control, and two planned shared runs, concurrency 3, desktop
1280 × 800, no daemon, recheck off. The published CLI ran with Chrome
151.0.7922.34 and encoder 8.18.7 on darwin-arm64. The controlled local benchmark
used encoder 8.18.3; these are separate experiments and baselines.

| Hosted suite | Fresh control | Shared comparisons                       | Reported run durations: fresh / shared |
| ------------ | ------------- | ---------------------------------------- | -------------------------------------- |
| Fluent       | 60/60 exact   | 120/120 exact; no recovery               | 15.63 / 9.02, 7.20 s                   |
| Carbon       | 60/60 exact   | 120/120 exact; no recovery               | 8.57 / 9.68, 6.54 s                    |
| Gutenberg    | 59/60 exact   | Inconclusive: host rate limited requests | Excluded from performance conclusions  |

Fluent and Carbon index hashes were unchanged before/after sampling. Deployments
were not pinned; remote loading, cache warmth, and host load affect timings.
These results support compatibility, not a speedup claim or exhaustive coverage.
Selection IDs and index hashes are in `next-wave-hosted-evidence.json` beside this
brief. Raw captures and reports are local under `/tmp/jux-major-storybooks/`.

Gutenberg's fresh control differed on `components-responsivewrapper--default`;
its cause remains unclassified. The first shared run produced 4 matches and 56
failures. All 56 failures had the **same image hash**, and inspection showed the
GitHub Pages “Rate limit exceeded” page. The next run could not load index.json;
a subsequent HTTP probe returned 429. Requests to that host were stopped. This
is not evidence of 56 renderer incompatibilities. It exposes a reporting gap:
the captures were ordinary visual failures without a capture error. Baseline
structure was omitted by this hash-comparison harness, so its structural
explanations should not be used to evaluate normal product diagnostics.

## Ordered work

### 1. Distinguish failed page loads from visual regressions

The Gutenberg experiment provides a concrete reproduction. Track main-document
HTTP status in Storybook capture, retain reviewable evidence, and report 429/5xx
as infrastructure/capture failures rather than ordinary visual changes. Avoid
spending the renderer retry budget on known HTTP failures. Surface retry-after
information and use bounded host-level backoff; do not hammer a public host.
Prevent error documents becoming silently acceptable initial baselines.

Done when a local fixture returning 429/503 is identified correctly on initial
capture and comparison, a valid 200 story remains unchanged, and approval cannot
silently bless the error page. Re-run Gutenberg from a pinned local build.

### 2. Resolve Linux text instability under load (#197)

The latest reviewed nightly, run 38717899287, failed Spectrum's tolerance gate
with 12 unlisted differences, concentrated in text fields, labels, textareas,
and a tooltip. That run predates 0.19.0: current sharing/recovery must be measured
before concluding those failures remain unchanged. Related local fresh-vs-fresh
text differences mean these cannot all be dismissed as nondeterministic stories.

Use a pinned Spectrum subset on Linux, fresh and shared modes, concurrency 1/2/3,
with repeated captures and retained font/layout/raster evidence. Distinguish
layout changes from antialiasing changes. Done when current behavior is quantified
and a minimal reproduction supports either a targeted fix or a precise limitation.

### 3. Close isolation and determinism gaps (#191, #146, #182)

Service-worker fetches can bypass `network.external` policy (#191). The regular
capture context does not have snap's service-worker blocking policy; preserve
MSW-based stories while enforcing external request policy. Verify first and later
navigations, service-worker fetches, and valid mocks.

Then finish the existing clock/GIF branch with Chakra and Primer verification,
explicit clock semantics, and both daemon/non-daemon determinism checks. Do not
silently freeze timer progression or merge an unverified default. Add actionable
findings for remaining time/random/external-resource sources (#208); findings
should help agents propose mocks or masks without automatically approving pixels.

### 4. Finish the native lossless WebP experiment (#17)

The controlled profile places screenshot work first, with encoding also material:
shared worker-time sums per run were 3.73 s screenshot and 1.86 s encoding. These
are overlapping worker durations, not additive wall-time savings. Native WebP
could remove the PNG intermediate; the remaining gain must be measured.

Rebase `perf/chrome-webp`, complete Ladle ×20, Spectrum ×20, and both determinism
modes, then compare the same controlled fixture. Require lossless pixels, explicit
baseline/encoder migration, and a repeatable end-to-end improvement. The user has
already authorized the necessary re-baseline. Also split large-DOM structure cost
into browser snapshot, transport, and normalization before optimizing it further.

### 5. Reduce work on small changes, then design result caching

Finish draft #228 after verifying Storybook 9/10, `--since`, selection-sensitive
cache invalidation, and conservative fallback. Measure startup/discovery on a
small selection from a large pinned workbench. This is a more direct path to fast
small-change runs than optimizing cold-path pixel diffs.

Next design result caching around complete invalidation inputs: build and story
dependencies, preview/config, viewport/theme, capture options, tool/browser/encoder,
and environment. Measure hit rates before claiming savings. Uncertain inputs must
capture normally; a cached verdict must never hide a relevant change.

## Small fixes and deferred work

- Batch runtime/schema validation parity (#188) and cancelled MCP context cleanup
  (#194) into small independently verified fixes.
- Audit remaining environment-mismatch diagnostics (#74) and warning propagation
  (#174). Some environment recording and approval checks already exist; do not
  treat these as entirely unimplemented.
- Hold #229 (`--no-opt`): its fresh-renderer premise changed with shared-by-default
  rendering. Re-measure on Linux and macOS with the shipped default before merging.
- Defer native diff/region acceleration (#19/#20), competitor benchmarks (#205),
  multi-browser support, and automatic masking until the measured priorities above
  justify moving them forward. Pixel diff is a cold path on changed captures.
- Reconcile older issues such as benchmark harness (#21) and MCP server (#15)
  against what has shipped, rather than treating all open issues as missing features.

The npm package is usable now. The next release should improve failure diagnosis
and determinism before accumulating more speculative performance switches.

## Implementation follow-up

HTTP error documents now fail capture before comparison and produce no approvable
hash. Run artifacts retain a diagnostic screenshot when available. HTTP 429/503
stops scheduling remaining captures in that pool; already active requests can
finish. This intentionally requires a later rerun rather than sleeping or retrying
a public host automatically. `Retry-After`, when supplied, appears in the error.
Other HTTP errors fail the affected capture without stopping unrelated stories.

A focused five-pass Spectrum investigation on current main was dispatched as
[run 38766251251](https://github.com/juxtapose-dev/juxtapose/actions/runs/38766251251).
This establishes the current-release Linux result before changing concurrency or
renderer settings; it is not yet the controlled 1/2/3-worker experiment.

The current-main Linux run completed: 5 of the 10 selected stories differed across
five passes, with no capture errors: `field-label--standard`,
`textarea--default-autofocus`, `textfield--default`, `textfield--empty`, and
`textfield--quiet`. The workflow's success means execution completed, not that
those stories were deterministic (subset runs skip the gate). Saved structures
were identical across the differing captures, but Spectrum uses shadow DOM and
the structures do not establish complete coverage; this does not prove a raster
root cause. A same-runner 1/2/3-worker sweep is the next control.
