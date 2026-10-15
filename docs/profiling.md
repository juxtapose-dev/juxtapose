# Profile the controlled Storybook

Use the existing React Storybook with an opt-in performance collection. Normal
example builds keep their original stories. The collection has eight workloads
(forms, tables, cards, typography, SVG charts, local images, nested DOM, and
async local data), each at 12, 72, and 288 items. Desktop light/dark (1280 × 800), mobile light/dark (390 × 844), and
tablet light (768 × 1024) produce 120 capture keys from 24 stories. The nested workload adds six
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

## Structure extraction diagnostics

Set `JUX_STRUCTURE_PROFILE=1` when running `jux` or the controlled profiling
script to include `structureTimings` on each captured result in the JSON report:

```sh
JUX_STRUCTURE_PROFILE=1 node scripts/profile-storybook.mjs examples/storybook/storybook-profile 5
```

The optional fields are milliseconds: `mark` applies structure mask markers;
`snapshot` waits for `DOMSnapshot.captureSnapshot`, including Chrome work,
protocol transfer and response parsing; `verify` checks that masks remain intact;
`normalize` converts the received snapshot into structure elements and hashes
that structure; `cleanup` removes the temporary mask markers. These durations
are measured inside the existing `timings.structure` interval, not additional
phases to add to capture time. Minor overhead can make their sum differ from
that enclosing interval. Fields for stages that did not run remain zero.

The diagnostic field is absent by default and when structure capture is
disabled. If structure capture fails, its recorded partial timings can still
help identify the attempted stage. Raw reports preserve these details; the
standard profiling summary continues to aggregate the enclosing structure
phase. As with other per-capture timings, overlapping workers mean these are
not additive wall-clock savings. Compare instrumented runs with the same
setting and retain an uninstrumented control when measuring small effects.

## Initial three-configuration measurement on October 15, 2026

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

## Expanded five-configuration verification

Added tablet light (768 × 1024) and dark mobile (390 × 844), increasing the
collection to 120 captures per run. Five measured passes per renderer mode
produced **1,200 exact baseline matches**, with zero retries or failures; both
excluded warm-ups also matched all 120 captures.

| Mode   | Median process wall time | Range across five runs | Median run time |
| ------ | -----------------------: | ---------------------: | --------------: |
| Shared |                   6.06 s |            5.78–7.28 s |          5.77 s |
| Fresh  |                   8.37 s |            7.87–8.81 s |          8.15 s |

The larger matrix preserves the same leading costs: screenshot capture
(3.73 summed worker seconds/run), paint waiting (2.49), rendering (2.10),
navigation (2.08), structure (2.05), and encoding (1.86). These are independent
measurements on a shared machine; do not attribute the difference from the
initial batch solely to adding viewports.

Build SHA-256: `fd74a15c6ad7fd7b8788a0ba3b8ce759a3cb85f33bc8ce6b4546468c1ddaaf17`.
Raw evidence:
`/var/folders/ss/kjkflpz51g58hhm2g7pqhbh00000gn/T/jux-controlled-profile-3DOzah/`.

## 0.20.2 profile after the transition-freeze fix

The same 24-story, five-configuration collection was rebuilt and profiled
with five alternating measured passes per renderer mode, plus a fresh reference
and two excluded warm-ups. Both platforms produced **1,200 exact measured
matches**, with zero recovery retries and zero failures. References and warm-ups
also completed successfully. This measures the green path, not Pixelmatch or
changed-image reports.

| Platform                       | Shared median (range) | Fresh median (range)  |
| ------------------------------ | --------------------- | --------------------- |
| macOS, M5 Pro, 15 logical CPUs | 5.27 s (5.12–5.63)    | 7.31 s (7.19–7.37)    |
| Linux runner, 4 vCPUs          | 16.19 s (16.08–16.37) | 23.40 s (23.11–24.07) |

The macOS machine was busy (one-minute load 23–52); do not treat its lower
wall time than an earlier profile as a measured release improvement. The Linux
batch ran on one GitHub-hosted runner with concurrency 3. Builds are fingerprinted
separately; platform, Node version, and build differences mean these are not a
controlled macOS-versus-Linux speed comparison. Shared rendering was about 31%
faster than fresh in the Linux batch.

Linux shared-mode costs, summed across workers per run (they overlap, so these
are **not** contributions that can be subtracted directly from wall time):

| Phase                | Median worker seconds/run | Per-capture p50 / p95 |
| -------------------- | ------------------------- | --------------------- |
| Screenshot           | 8.98                      | 62.4 / 214.8 ms       |
| Story rendering      | 7.89                      | 36.1 / 199.3 ms       |
| Other capture setup  | 6.52                      | 37.0 / 174.5 ms       |
| Structure extraction | 6.30                      | 25.8 / 163.9 ms       |
| Navigation           | 5.96                      | 40.6 / 120.7 ms       |
| Paint barrier        | 4.85                      | 33.0 / 80.7 ms        |
| WebP encoding        | 3.83                      | 28.6 / 63.5 ms        |
| Settling             | 1.93                      | 10.7 / 52.4 ms        |

The next investigations, in order:

1. **Screenshot/encoding path.** Together these use 12.81 summed worker seconds,
   about 28% of measured phase time. The local-image workload has screenshot
   p50/p95 of 119.5/256.9 ms and encode p50/p95 of 49.1/82.3 ms. Recheck native
   lossless WebP PR #241 with the transition fix, preserving its exact-pixel and
   stability gates. The earlier isolated encoder result is not a full-run speedup.
2. **Structure extraction on large nested DOM.** The nested workload has
   structure p50/p95 of 116.5/429.7 ms (versus 25.8/163.9 ms overall). Instrument
   traversal, style/geometry collection, serialization, and CDP transfer before
   changing collection behavior; retain offscreen/overflow and shadow-DOM
   semantics. Disabling structure would remove useful diff context.
3. **Rendering and unclassified setup.** Local images reach a rendering p95 of
   677.9 ms. The `other` bucket is also large enough to split into subphases before
   choosing an optimization. Do not assume all of this is tool overhead: the
   workload includes real SVG/image layout and rendering.

Paint waiting is measurable but load-bearing. The Linux transition fix avoids
adding another barrier; these timings do not justify removing the existing one.
Discovery/launch/report overhead outside the run is only about 0.4 s here, so it
is not the leading target for this collection. A large real Storybook may differ.

Re-run the dispatch-only `profile` workflow on the desired branch. It builds the
controlled collection once and uploads reports, raw samples, environment/build
metadata, and summaries. No external Storybook build or installation is needed
locally. The Linux evidence run is
[38803580826](https://github.com/juxtapose-dev/juxtapose/actions/runs/38803580826).
Persisted summaries:
[Linux](briefs/controlled-profile-0202-linux.json) and
[macOS](briefs/controlled-profile-0202-macos.json).

## Isolate screenshot encoding

```sh
pnpm build
JUX_STATE_DIR=$(mktemp -d) node scripts/profile-encoder.mjs
```

This probe serves one fixed 1280 × 800 frame containing text, cards, and a
gradient. It takes four warm-up pairs, then 40 pairs in alternating order:
PNG capture plus Sharp lossless WebP (effort 0), and native Chrome lossless WebP
plus ICC metadata removal. It reports screenshot, encoding, combined median
time, and output bytes. Navigation and settling are outside the measurement.

On October 15, 2026, the paired local probe measured:

| Path        | Screenshot median | Encoding median | Combined median |  Bytes |
| ----------- | ----------------: | --------------: | --------------: | -----: |
| PNG + Sharp |          14.58 ms |        11.02 ms |        25.61 ms | 42,902 |
| Native WebP |          16.27 ms |         0.02 ms |        16.29 ms | 40,596 |

That is about 36% less time in this isolated snapshot pipeline, not 36% less
whole-suite time. Median components need not sum to the median combined value.
The real-browser encoder test independently checks lossless decoding against
PNG, including gradients, transparency, text, and masks.

## Optimized pipeline comparison

The [final paired accounting](briefs/pipeline-final-accounting.md) compares
0.20.2 with native WebP, binary Chrome transport and batched mask extraction.
Median whole-run time fell 18.4% on macOS and 19.9% on Linux for the controlled
120-capture collection. It includes per-phase means, remaining worker-time
shares, exact image/structure parity and reproducible commands.

The [follow-up experiments](briefs/pipeline-followup.md) measure concurrency
scaling and two rejected micro-optimizations, with screenshot/setup subphase
timings. The three-worker benchmark is fixed for comparability; the product
default remains eight workers.
