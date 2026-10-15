# Follow-up performance experiments — October 15, 2026

The useful win is configuration headroom: on the M5 Pro, the unchanged optimized
pipeline processes the controlled collection in **2.70 seconds at eight workers**,
versus **3.81 seconds at three**. Eight is already the product default; previous
profiling deliberately fixed concurrency at three. This is not an additional
code optimization or a reason to increase the default.

Two proposed code optimizations failed to produce a convincing whole-run gain
and were removed. Production capture code remains unchanged from `7239da1`.

## Paired measurements

Same 24 stories × five viewport/theme configurations, 120 captures/run, fresh
browser per run, renderer sharing on, recheck off. Five alternating AB/BA runs
per comparison, separate fresh references and excluded warmups. All references
use concurrency three, including the six/eight-worker candidate arms.

| Experiment                                      | Baseline median | Candidate median | Change | Decision                          |
| ----------------------------------------------- | --------------: | ---------------: | -----: | --------------------------------- |
| Three → six workers, unchanged code             |         3.886 s |          2.838 s | −27.0% | Useful local configuration        |
| Three → eight workers, unchanged code           |         3.808 s |          2.700 s | −29.1% | Existing default works well here  |
| Normalize structure while screenshot setup runs |         3.840 s |          3.806 s |  −0.9% | Reject: within observed variation |
| Combine screenshot preparation and font wait    |         3.840 s |          3.846 s |  +0.2% | Reject: no whole-run gain         |

Across these four comparisons, all **4,800 measured captures** match their own
fresh image hashes. All 480 cross-arm decoded image pairs match exactly, and all
4,800 complete structure sidecars match each comparison's baseline reference.
Zero retries or failures. Independently recomputed structure hashes also match.
The overlap prototype passed 33 focused tests; the screenshot prototype passed 44. Both built and typechecked before measurement.

The host was quieter than during the previous 4.63-second measurement, so these
results should only be compared within each paired experiment. Six versus eight
was not itself a paired experiment. More workers increase contention: average
per-capture screenshot time rose from 21.0 to 40.8 ms at eight workers even as
total throughput improved. This collection does not establish memory limits or
an appropriate concurrency for a small Linux runner or heavier real stories.
The examples explicitly configure four workers; this experiment changes neither
their configuration nor the product default.

## Why the micro-optimizations did not pay

A separate serial desktop diagnostic runs the real capture path with timing
wrappers. It checks 72 measured captures against fresh-renderer references,
requiring exact images and complete structures. It is a stage diagnostic, not a
concurrent throughput benchmark.

| Screenshot subphase                   | Mean ms/capture |
| ------------------------------------- | --------------: |
| Preparation, including caret handling |           0.467 |
| Font readiness                        |           0.194 |
| Layout metrics                        |           0.145 |
| Chrome capture/encode/response        |          19.340 |
| Cleanup                               |           0.381 |
| Entire screenshot phase               |          20.560 |

Chrome's capture command is **94% of screenshot time**. Eliminating one small
round trip cannot remove the dominant work. The command includes browser capture,
encoding, transfer and decoding; these timings do not isolate compression alone.

Serial `other` time averages 1.24 ms/capture. Renderer identity checking (0.443 ms),
freeze stylesheet injection (0.324 ms) and shadow-root freezing (0.374 ms) explain
most of it. Those are determinism safeguards. The larger concurrent `other`
bucket includes contention and waiting; it is not evidence of a similarly large
block of avoidable CPU work. These subphases are inside the reported phases and
must not be added to them.

The overlap prototype starts screenshot preparation after structural extraction,
mask verification and cleanup, then normalizes the immutable response on Node.
It overlaps only the first Chrome setup call, not the later screenshot encoder:
Node must resume the screenshot promise chain to issue that command. Its <1%
result does not justify the extra deferred-normalization interface. A design
that overlaps the actual encoder would need a new scheduling boundary and new
failure/timing accounting; this experiment does not establish a benefit for it.

## Next worthwhile targets

1. Trace inside Chrome's capture command before choosing an encoding or capture
   change. Preserve lossless pixels and full capture coverage.
2. Avoid provably unnecessary captures through reliable affected-story discovery
   and eventually result caching. That requires dependency/environment/baseline
   invalidation; it cannot treat a previous pass as proof of current determinism.
3. Test concurrency on the actual target runner and representative heavy stories.
   Keep the standard three-worker benchmark for comparing code revisions.

No paint/settle barriers, structural coverage or exact comparison rules were
relaxed. No new production dependency, worker pool or default was added.

## Evidence and reproduction

- [Paired summaries, provenance, ranges and parity](pipeline-followup-results.json)
- [Screenshot/setup diagnostic summary](capture-call-results.json)
- [Rejected overlap prototype](experiment-normalization-overlap.patch)
- [Rejected screenshot prototype](experiment-screenshot-batching.patch)

The patches apply to `7239da1` for reproducing the experiments; they are not
production changes. Build the candidate before profiling. Do not run separate
Chrome experiments concurrently.

```sh
# Same built CLI for both arms: isolate configuration, not code.
JUX_PROFILE_CANDIDATE_CONCURRENCY=8 node scripts/compare-pipeline.mjs BASELINE_CLI BASELINE_CLI examples/storybook/storybook-profile 5 --pixel-parity
node scripts/check-pipeline-structure-parity.mjs PROFILE_DIRECTORY
node scripts/profile-capture-calls.mjs examples/storybook/storybook-profile 3
```

`JUX_PROFILE_CONCURRENCY` selects the baseline/reference concurrency (default
three); `JUX_PROFILE_CANDIDATE_CONCURRENCY` changes only candidate warmup and
measured runs. Both accept 1–8. Per-arm settings are retained in metadata.
