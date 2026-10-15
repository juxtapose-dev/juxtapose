# Structure extraction: batching and worker experiment

Measured on macOS / Apple M5 Pro, Node 26.11.1, Chrome 151.0.7922.34.
This is local evidence, not a Linux performance result or an A/B speedup claim.

## Shipped change proposed

Batch mask marking and verification into one browser evaluation each, preserving
selector order, open shadow-root resolution, fail-closed count verification, and
cleanup after partial failure. For N mask selectors, these phases use two browser
calls instead of 2N; cleanup remains one call. No-mask captures skip both phases.

Opt-in `JUX_STRUCTURE_PROFILE=1` adds report subphase timings without changing
capture hashes or the existing phase totals. See ../profiling.md.

## Controlled capture evidence

Same controlled build as the 0.20.2 profile:
`f2d22670ae7bba589440ad17d9e34dd15749df4f85aa4e553429baef8f6a5500`.
Three measured passes per mode, 120 captures per pass, concurrency three;
one fresh reference and one excluded warm-up per mode.

- 720/720 measured captures passed, zero retries.
- All 360 shared captures also matched the earlier 0.20.2 reference hashes.
- Shared wall median 4.95 s (4.90–4.96); fresh 6.97 s (6.80–7.03).
  Different machine load prevents attributing changes from the previous profile
  to this patch. The collection primarily measures unmasked captures.

Shared captures, pooled across the three measured passes:

| Phase                                                   | All captures p50/p95 | Nested captures p50/p95 |
| ------------------------------------------------------- | -------------------- | ----------------------- |
| Chrome snapshot round trip, including transport/parsing | 4.91 / 35.61 ms      | 23.68 / 94.25 ms        |
| Node normalization and hash                             | 0.86 / 3.92 ms       | 1.74 / 6.23 ms          |

Snapshot round trips total 4,166.65 ms versus 448.19 ms normalization across
360 captures (overlapping worker time, not wall time). About 90% of these measured
subphases is extraction/transport/parsing. A Chrome trace or CDP parsing timing
is still needed to distinguish those components.

Raw reports are local at
`/var/folders/ss/kjkflpz51g58hhm2g7pqhbh00000gn/T/jux-controlled-profile-szZ0eV`.

## Persistent worker experiment: do not adopt this design

Captured real raw CDP snapshots once from the same controlled Storybook, desktop
1280 × 800. The offline harness alternates direct and persistent-worker paths,
uses five warmups and 100 measured iterations per snapshot, and requires exact
normalized JSON and structure hashes on every iteration.

| Snapshot      | Raw JSON | Direct median | Worker round trip | Synchronous postMessage |
| ------------- | -------- | ------------- | ----------------- | ----------------------- |
| Nested large  | 5.05 MB  | 2.973 ms      | 21.912 ms         | 7.631 ms                |
| Nested medium | 1.26 MB  | 0.943 ms      | 5.322 ms          | 1.802 ms                |
| Images large  | 0.51 MB  | 0.465 ms      | 1.615 ms          | 0.466 ms                |

All parity checks passed. The large snapshot contains 21,594 nodes but retains
153 normalized elements. Copying the parsed object blocks the main thread longer
than normalizing it directly. No production worker or queue was added.

These warmed offline timings differ from concurrent captures; they measure IPC
cost, not an end-to-end pipeline. Worker startup was 9.36 ms, excluded from
steady-state round trips. Full measurements: structure-worker-results.json.

Reproduce with a built core and saved `{raw, viewport}` CDP fixtures:

```sh
node scripts/bench-structure-worker.mjs --iterations 100 /tmp/profile--nested-large.cdp.json
```

Without an input it uses the committed small CDP fixture. Large raw snapshots
are temporary local files, not checked into the repository.

## Validation and next target

32 structure tests passed, including real Chrome tests for overlapping selectors,
shadow roots, missing matches and cleanup after a later selector fails. Another
26 comparison/retry tests passed. Build, typecheck and targeted lint passed.
Storybook 18 stories and Ladle 16 stories each remained byte-identical across
three runs. Independent review found no blocking issues.

Next: isolate style collection versus CDP response parsing, and investigate
reducing redundant extraction while preserving structural coverage. Parsed-object
worker normalization is rejected for these workloads. Native lossless WebP remains
a separate candidate with its own stability gates.
