# Profile the controlled Storybook

Use the existing React Storybook with an opt-in performance collection. Normal
example builds keep their original stories. The collection has eight workloads
(forms, tables, cards, typography, SVG charts, local images, nested DOM, and
async local data), each at 12, 72, and 288 items. Desktop, mobile, and dark
captures produce 72 capture keys from 24 stories. The nested workload adds six
children per item to expose structure-extraction scaling.

No story uses random data, clocks, remote resources, or intentionally variable
animations. Images are generated SVG illustrations, not photographs. This
isolates capture costs; it does not reproduce the JavaScript/module graph or
component complexity of Spectrum, Chakra, or Primer.

```sh
pnpm build
JUX_PROFILE_STORIES=1 pnpm --filter example-storybook exec storybook build --disable-telemetry -o storybook-profile
node scripts/profile-storybook.mjs examples/storybook/storybook-profile 5
```

The script creates a temporary project and `JUX_STATE_DIR`, fixes concurrency
to 3, disables the daemon, and runs one browser at a time. It captures a fresh
reference, excludes one warm-up per mode, then alternates five shared and five
fresh measured runs. The static build stays unchanged throughout. It preserves
all reports, logs, baseline hashes, system/load metadata, a build fingerprint,
and summaries in the printed temporary directory. A measured non-pass exits 1.
No repository baseline or installed package is changed.

The fresh reference prevents a consistently wrong shared capture from looking
stable merely because it repeats. Warm-ups prepare host/filesystem caches;
each measured run still launches a new browser. Run on a quiet machine for
comparisons, retain the raw run ranges, and compare the same build and viewport.
Pool order is shuffled at concurrency 3, so hash checks also exercise ordering.

Per-capture phase totals are **summed worker time**, not elapsed wall time:
three workers overlap. Final-result timing does not include earlier retry
captures, so phase distributions exclude recovered stories and report their
count separately. Process wall time includes launch, discovery, report writing,
and teardown; `RunReport.durationMs` covers the orchestration interval.
This benchmark exercises the green capture path, not changed-image diff cost,
daemon reuse, or the recovery path unless a fixture actually needs recovery.

## Measurement on October 15, 2026

Capture implementation: `90284d4` (the code released in 0.19.0). Chrome
151.0.7922.34, encoder 8.18.3, Node 26.11.1, macOS arm64, Apple M5 Pro,
15 logical CPUs, 24 GiB RAM. Desktop viewport 1280 × 800; mobile 390 × 844.
Machine load average varied from 4.1 to 6.7 across measured runs.
Build SHA-256: `029dc21ab70f6fb5436ac18012048dfd1f07f5cc74eb9b8e818e56c41a6a1b43`.

All **720 measured captures** matched the fresh reference, with zero retries,
errors, or instability. Both excluded warm-ups also matched all 72 hashes.

| Mode   | Median process wall time | Range across five runs | Median run time |
| ------ | -----------------------: | ---------------------: | --------------: |
| Shared |                   3.44 s |            3.37–3.81 s |          3.22 s |
| Fresh  |                   4.81 s |            4.63–5.01 s |          4.59 s |

Shared rendering reduced median wall time by 28.6% on this collection. These
short local runs are evidence for this build, not a universal speedup claim.
Most of the difference is navigation and Storybook render time; the fresh
renderer hop itself is a smaller part.

| Shared phase  | Per-capture p50 / p95 | Median summed worker time per run |
| ------------- | --------------------: | --------------------------------: |
| Screenshot    |       22.9 / 110.8 ms |                            2.28 s |
| Paint barrier |        16.8 / 39.6 ms |                            1.42 s |
| Story render  |        10.9 / 57.0 ms |                            1.30 s |
| Navigation    |         8.8 / 32.5 ms |                            1.08 s |
| Structure     |         6.9 / 40.6 ms |                            1.03 s |
| Encoding      |        12.8 / 28.3 ms |                            0.96 s |
| Other         |         6.4 / 35.5 ms |                            0.81 s |
| Settle        |         6.2 / 15.9 ms |                            0.53 s |

### Where to investigate next

1. **Screenshot and encoding.** Image workloads have screenshot p50/p95 of
   59.3/120.3 ms and encoding p50/p95 of 24.3/36.5 ms. Medium and large desktop
   image grids spend about 114–116 ms in screenshot capture alone. The current
   path captures PNG, then sharp decodes it and writes lossless WebP. Use this
   collection for an A/B of the existing Chrome-native lossless WebP branch;
   measure both phases, output sizes, and hash stability. The screenshot phase
   also contains preparation and CDP calls, so this profile does not attribute
   all 114 ms to PNG compression.
2. **Structure extraction on dense DOMs.** Large nested stories spend median
   105–110 ms on structure, versus about 3–9 ms for most other families.
   Instrument `DOMSnapshot.captureSnapshot`, transport, and normalization
   separately before choosing an optimization. Preserve the structural context
   used by diffs rather than dropping it to improve the benchmark.
3. **Render/loading costs on image-heavy pages.** The large image story spends
   median 126.7 ms in render; the mobile variant spends 118.9 ms. Break down
   image decoding and React/browser work with a browser trace. These generated
   SVGs do not predict photographic-image decode costs.
4. **Paint waiting is a floor to understand, not remove.** The median is near
   one display frame (16.8 ms). It protects against screenshots before paint.
   Measure scheduling overlap before changing the barrier; repeated hash
   equality is required for any proposed change.

Settling is only 0.53 summed worker seconds per shared run here, and process
work outside the run is about 0.22 seconds. Neither is the leading target in
this collection. Result caching could bypass the entire capture pipeline, but
this profile measures no cache-hit rate and cannot quantify that benefit.

Raw local evidence for this measurement:
`/var/folders/ss/kjkflpz51g58hhm2g7pqhbh00000gn/T/jux-controlled-profile-liaPlZ/`.
