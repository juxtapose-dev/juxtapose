# Pipeline performance accounting — October 15, 2026

The combined pipeline reduces median whole-run time by **18.4% on macOS** and
**19.9% on Linux CI** against 0.20.2. These are measured end-to-end improvements,
including process startup and reporting, not estimates from isolated stages.

## What changed

- Native Chrome lossless WebP replaces PNG transfer, PNG decoding and Sharp
  re-encoding. Node only canonicalizes metadata. This changes encoded hashes and
  requires rebaselining, while preserving decoded pixels.
- Binary Chrome protocol messages eliminate redundant JSON conversions around
  DOM snapshots. The Node driver preserves the same response shapes; daemon
  clients retain their JSON socket protocol. `JUX_CDP_JSON=1` is a diagnostic
  fallback. No new dependency or public configuration is needed.
- Mask extraction batches its browser calls. Capture order, paint barriers,
  renderer recovery, exact comparison and approval requirements are preserved.

## Paired whole-run measurements

Each platform used the same immutable Storybook build for both arms: eight
workloads at three sizes, across desktop light/dark, mobile light/dark and
tablet light. That is 24 stories and 120 capture keys per run. Each arm had its
own fresh-renderer reference and excluded warmup; five measured runs alternated
AB/BA order. Concurrency was three, renderer sharing enabled, recheck disabled,
and each run launched a fresh browser. There were no intentional visual changes.

| Platform             | 0.20.2 mean / median | Optimized mean / median | Median reduction |  Baseline range | Optimized range |
| -------------------- | -------------------: | ----------------------: | ---------------: | --------------: | --------------: |
| macOS, M5 Pro        |      5.689 / 5.676 s |         4.657 / 4.633 s |            18.4% |   5.532–5.875 s |   4.337–5.038 s |
| Linux CI, Xeon 8573C |    13.416 / 13.453 s |       10.830 / 10.781 s |            19.9% | 13.063–13.817 s | 10.627–11.010 s |

All 600 measured captures per arm per platform passed their exact fresh
reference: **2,400 measured captures, zero failures, zero retries**. All 120
cross-arm image pairs on each platform had exactly equal dimensions and decoded
RGBA pixels. This compares revisions within each OS, not macOS pixels to Linux.
All 2,400 measured normalized structure objects also exactly match each
platform's baseline fresh reference, including every element/style/rectangle,
paint order and metadata. Their canonical structure hashes were independently
recomputed. No fields were omitted from object equality.

Baseline commit: `9bcca71412e56c671bbca7f9905dd23a932467f3`. Linux candidate:
`4d872768047bac585dc67127e03e18fae3c7ebda`; macOS candidate:
`3a9a9d66aaefe6c6b93f1de175e0882cad082978`. The intervening commits only fix
profiling failure handling and a timing-test assertion; production builds are
unchanged. Summaries retain built-package hashes, environment and working-tree
status. The baseline's untracked `node_modules` entry is the dependency symlink,
not a source modification. Node versions differ between platforms (26 on macOS,
24 on Linux), but match within each comparison. Host load varies; these five
passes are a bounded measurement, not a universal speed guarantee.

## Where time remains

Mean milliseconds per capture, before → after. Percentages are the optimized
share of **summed worker time**, not elapsed wall time; three pages overlap.

| Phase                                 |      macOS ms | macOS share |      Linux ms | Linux share |
| ------------------------------------- | ------------: | ----------: | ------------: | ----------: |
| Navigation                            | 14.62 → 16.26 |       15.3% | 46.89 → 38.82 |       15.0% |
| Story rendering / parameters          | 17.78 → 16.23 |       15.3% | 45.43 → 45.87 |       17.7% |
| Settling                              |   7.11 → 6.88 |        6.5% | 16.57 → 15.44 |        6.0% |
| Paint barrier                         | 18.71 → 18.19 |       17.1% | 36.64 → 35.43 |       13.7% |
| DOM structure                         | 15.79 → 10.20 |        9.6% | 43.31 → 28.41 |       11.0% |
| Screenshot, including native encoding | 29.83 → 25.72 |       24.2% | 64.78 → 57.81 |       22.3% |
| Node encoding / metadata              |  14.22 → 0.05 |       <0.1% |  27.30 → 0.05 |       <0.1% |
| Other capture setup / bookkeeping     | 14.19 → 12.70 |       12.0% | 41.18 → 37.20 |       14.4% |

The structure stage is about 35% faster on both platforms. Node encoding is
effectively removed. Screenshot plus encoding falls from 44.05 to 25.77 ms on
macOS and 92.08 to 57.86 ms on Linux. These phase reductions cannot be added to
predict wall-time savings. Outside the reported run, process/startup/reporting
overhead averages 310 ms on macOS and 323 ms on Linux for the candidate.

The remaining largest costs are browser screenshot/encoding, rendering,
navigation and paint synchronization. DOM access and layout remain on the
renderer main thread; blindly issuing extraction and screenshot concurrently
does not create independent renderer threads and risks capture consistency.
Node workers for normalization were measured slower because of transfer costs;
compact CSS snapshots were also slower after expansion. Neither ships.

Next useful investigation: split the remaining `other` bucket and trace Chrome
screenshot subphases, then test bounded concurrency on a fixed runner. Preserve
paint/settle barriers unless a replacement demonstrates equal determinism.
Artifact hashing/compression is small in the measured collection; an unbounded
worker queue would add memory risk without a demonstrated payoff. Changed-image
diffing, massive external Storybooks, warm-daemon throughput and resource-cache
recovery are outside this green-path performance claim.

## Evidence and reproduction

- [macOS accounting](pipeline-final-macos.json)
- [Linux accounting](pipeline-final-linux.json)
- [macOS structure parity](pipeline-final-macos-structure.json)
- [Linux structure parity](pipeline-final-linux-structure.json)
- [Linux run and retained raw artifacts](https://github.com/juxtapose-dev/juxtapose/actions/runs/38821835082)
- [Binary protocol validation](binary-cdp-validation.md)
- [Native WebP validation](native-webp-validation.md)
- [Extraction alternatives](structure-extraction-research.md)

```sh
node scripts/compare-pipeline.mjs BASELINE_CLI CANDIDATE_CLI examples/storybook/storybook-profile 5 --pixel-parity
node scripts/check-pipeline-structure-parity.mjs PROFILE_DIRECTORY
```

The dispatch-only `profile` workflow accepts `baseline_ref` for the same paired
comparison. The initial Linux evidence predates a workflow `pipefail` fix; its
raw summary and all 120 parity records were independently checked and contain
zero failures. Current workflow failure propagation is explicit.
