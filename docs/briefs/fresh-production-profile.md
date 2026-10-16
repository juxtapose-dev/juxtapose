# Fresh production profile — October 15, 2026

The current production pipeline takes **2.692 s median for 120 captures** at the
product default of eight page workers: 22.4 ms amortized wall time per capture.
That is throughput, not latency; shared-mode median individual capture latency
is 150 ms. No experimental worker, browser-sharding or lookup changes are active.
Package sources match main at `f398504`; the research branch only adds tooling
and documentation. This is a fresh profile, not a paired release-speedup claim.

## Method and correctness

Apple M5 Pro, 15 logical CPUs, Chrome 151.0.7922.34, Node 26.11.1, macOS arm64.
The unchanged controlled Storybook contains 24 stories across eight workload
families, at 12, 72 and 288 items each. Five viewport/theme configurations yield
120 captures. Small and medium sizes are the primary diagnostic group (80
captures/run); large examples are reported separately rather than used to justify
specialized optimization. These local synthetic workloads are not a substitute
for compatibility tests of real component libraries.

Five alternating shared/fresh runs, separate excluded fresh reference and one
warmup per mode, fresh Chrome launch each run, daemon off, recheck off, temp state.
`JUX_STRUCTURE_PROFILE=1` records the structure breakdown. No memory sampling.
One-minute host load was approximately 7.5–9.0 during shared runs, which were
consistent within this batch. All **1,200 measured image hashes and complete
structures** matched the fresh reference; independently recomputed structure
hashes also matched. Zero failures or retries.

| Mode                        | Median wall |         Range |
| --------------------------- | ----------: | ------------: |
| Shared (production default) |     2.692 s | 2.657–2.783 s |
| Fresh                       |     3.532 s | 3.462–3.588 s |

Shared-run time outside the run interval was 218 ms median. Reported browser
launch was 75–85 ms, enumeration 4 ms and discovery 1–3 ms. Browser launch is
part of that outside-run interval, not an additional cost to add to it.

## Where ordinary capture time goes

Means across 400 measured small/medium shared captures. These are **summed worker
phase shares**, not elapsed wall-time shares or directly recoverable savings:
eight workers overlap and contention adds waiting to individual stages.

| Stage                                      | Mean per capture | Worker-time share |
| ------------------------------------------ | ---------------: | ----------------: |
| Screenshot, including Chrome WebP encoding |         40.67 ms |             27.8% |
| Navigation                                 |         24.66 ms |             16.8% |
| Paint barrier                              |         24.10 ms |             16.5% |
| Other setup/accounting                     |         23.19 ms |             15.8% |
| Story rendering                            |         14.83 ms |             10.1% |
| Settling                                   |         11.52 ms |              7.9% |
| DOM structure                              |          7.37 ms |              5.0% |
| Node WebP canonicalization                 |         0.019 ms |             <0.1% |

Within structure, the browser snapshot/response averages 6.24 ms and Node
normalization 1.10 ms. Large stories average 22.16 ms for structure (19.64 ms
snapshot/response and 2.50 ms normalization), versus 7.37 ms for small/medium.
Optimizing that large-story tail would distort priorities for ordinary captures.

## Interpretation

No clear new low-cost optimization stands out. Screenshot remains the largest
stage, but prior traces show browser-side encoding and prior experiments already
cover native WebP, fast PNG and browser sharding. Node encoding is effectively
gone. Normalization is too small here to motivate a dedicated worker, consistent
with the earlier mixed/slower worker results.

Paint and settling are correctness barriers, not disposable overhead. The `other`
bucket is worth tracking, but concurrent waiting cannot be treated as pure Node
CPU work: the earlier serial capture diagnostic found only about 1.24 ms of
setup, and batching screenshot preparation did not improve full-run time. This
profile does not further isolate that concurrent bucket.

Keep the production pipeline as-is. If user-visible slow runs emerge, profile
that workload before changing scheduling or data structures. A separate changed-
image/report profile could reveal cold-path improvements, but no changed images
occurred here, so this evidence makes no claims about that path. Avoid new
complexity solely to improve the dense-DOM benchmark.

[Machine-readable results, size breakdown and per-run load](fresh-production-profile-results.json).
Raw reports and sidecars remain at the `rawEvidence` path recorded there.

```sh
JUX_PROFILE_CONCURRENCY=8 JUX_STRUCTURE_PROFILE=1 node scripts/profile-storybook.mjs examples/storybook/storybook-profile 5
```

The harness still defaults to three workers for continuity with earlier profiles;
`JUX_PROFILE_CONCURRENCY` accepts 1–8 and is recorded in metadata.
