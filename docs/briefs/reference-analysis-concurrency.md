# Bounded saved-reference concurrency

`evaluateReferences` overlaps up to four independent saved-reference reads,
metadata/decode operations and cache lookups. It shares one layout cache and
parses project config and the run report once. Indexed state/crop slots preserve
name order, per-target errors, absent-capture counts and crop selection.

This is asynchronous overlap in one Node process. TypeScript segmentation still
runs on the main thread. It does not add browser/page workers, change capture,
change comparison policy, or add OCR to the default response.

The actual aggregate API was compared against its serial parent on four saved
team-directory states (active/pending, desktop/mobile), with layout requested.
The entire serialized response matched. Four samples per arm/cache mode, in
alternating order, gave:

| Derived cache | Serial median | Bounded concurrency median |
| ------------- | ------------: | -------------------------: |
| Cold          |     100.29 ms |                   69.36 ms |
| Warm          |       4.12 ms |                    2.16 ms |

Each sample had a fresh in-memory layout cache. Cold means no derived layout or
comparison files, not a cold OS file cache. This is a small related corpus and
an analysis-request measurement, not whole-agent latency or CPU-thread scaling.
The experiments workspace preserves hashes and the executed reference modules
under `iteration-team/reference-parallel-product-v1/`.

The regression check forces one target's result to wait for a peer, without
wall-clock delays. Real image comparison verifies overlap stays bounded,
response order is stable, one reference error does not cancel siblings,
omissions remain visible, cached evidence is identical, and aggregate crop
selection matches the explicitly named comparison.
