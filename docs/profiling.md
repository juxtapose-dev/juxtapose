# Profile the controlled Storybook

Contributor measurement guide. See the [documentation index](README.md) for user setup.

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

## Compare two implementations

Build both revisions and retain their CLI entry points and package outputs. Run
against one unchanged controlled build:

```sh
node scripts/compare-pipeline.mjs BASELINE_CLI CANDIDATE_CLI BUILD_DIRECTORY 5 --pixel-parity
```

The script requires at least three measured passes and never installs packages.
It records source/build provenance, excluded warm-ups, fresh references and paired
measurements. `JUX_PROFILE_CONCURRENCY=1..8` sets the common worker count;
`JUX_PROFILE_CANDIDATE_CONCURRENCY` changes only candidate measured/warm-up runs,
so use it only when concurrency is the variable under investigation.

The dispatch-only [profile workflow](../.github/workflows/profile.yml) builds the
controlled collection and retains reports, samples and metadata. Its optional
`baseline_ref` enables the paired comparison. Workflow artifacts have finite
retention: a public result needs a reviewed, sufficient account of the method,
revision, workload, ranges, failures and correctness checks, not a link to a
maintainer's temporary directory.

Compare like-for-like runs. Keep browser/encoder versions, build fingerprint,
viewport matrix, machine/load, daemon policy and concurrency explicit. Report
hash/structure parity and retries alongside timing. Summed worker time, process
wall time and individual capture latency answer different questions.

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

## Publish only the measured conclusion

An isolated encoder or worker probe is not an end-to-end speedup. A controlled
synthetic collection does not establish compatibility with every Storybook, a
universal token saving or an agent-quality improvement. Keep failures and missing
coverage visible; reject optimizations that improve timing by skipping work or
weakening correctness checks.

Use the retained benchmark scripts with your own captured inputs. Keep experiment
plans, raw results, machine-specific paths and historical scorecards outside the
public guides; publish only a reviewed conclusion with sufficient reproduction
steps and limitations.
