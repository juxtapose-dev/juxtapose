# Chrome capture internals — October 15, 2026

Tracing identified a concrete serialization point: lossless WebP encoding runs
on **CrBrowserMain**, shared by all pages in one browser. A two-browser prototype
improves the local eight-worker benchmark by 15.2%, with higher memory use.
This is research evidence, not a production default change.

## Inside the screenshot command

Pinned Chrome 151.0.7922.34, M5 Pro, ten screenshots per prepared desktop story.
Every screenshot and the post-trace screenshot match the pre-trace WebP bytes.
The figures are traced diagnostic means, not full-suite throughput measurements.

| Story        | Entire screenshot call | WebP encoding span | Encoding thread |
| ------------ | ---------------------: | -----------------: | --------------- |
| Nested large |               18.15 ms |           10.54 ms | CrBrowserMain   |
| Images large |               33.27 ms |           27.67 ms | CrBrowserMain   |
| Forms large  |               23.67 ms |           11.65 ms | CrBrowserMain   |

The Chrome source confirms that `ScreenshotCaptured` runs the selected encoder
before replying. `optimizeForSpeed` selects the fast PNG encoder; it does not
affect WebP. WebP uses the supplied quality, with lossless compression selected
at quality 100. Lowering quality is therefore not a lossless speed setting.

Pinned sources:

- [Capture handler and encoder selection](https://github.com/chromium/chromium/blob/151.0.7922.34/content/browser/devtools/protocol/page_handler.cc)
- [WebP codec](https://github.com/chromium/chromium/blob/151.0.7922.34/ui/gfx/codec/webp_codec.cc)

The rest of the elapsed screenshot time includes preparation, compositor work,
frame waiting, copying and protocol traffic. It cannot all be labeled encoding
or frame waiting. Nested trace spans must not be summed as independent work.
[Trace summaries and raw paths](chrome-screenshot-traces.json).

## Fast PNG is not an automatic improvement

An isolated fixed UI frame compares native WebP against PNG with
`optimizeForSpeed: true`, followed by Sharp lossless WebP at effort zero.
Four excluded warmups, 40 alternating pairs:

| Path             | Screenshot median | Node encoding median | Combined median |  Bytes |
| ---------------- | ----------------: | -------------------: | --------------: | -----: |
| Fast PNG + Sharp |          10.40 ms |             11.11 ms |        21.80 ms | 42,902 |
| Native WebP      |          17.02 ms |             0.014 ms |        17.05 ms | 40,596 |

All per-mode images remain byte-identical and cross-mode decoded RGBA is exact.
Median components need not sum to the median combined value. Native remains
faster on this fixture. This does not prove the same ordering on every image or
at every concurrency; the alternative was not adopted.

## Two browser processes, same total worker count

The diagnostic prototype alternates new contexts across two private Chrome
processes, keeping eight total page workers. Both browsers use unchanged flags,
capture ordering, native WebP and exact comparison. It is one jux run, not two
independent runs. A single process remains the baseline.

Five alternating runs per arm, same immutable controlled build, 120 captures
per run, separate excluded fresh references and warmups:

| M5 Pro, eight workers          | One browser | Two browsers |
| ------------------------------ | ----------: | -----------: |
| Mean wall time                 |     3.166 s |      2.678 s |
| Median wall time               |     3.173 s |      2.690 s |
| Median sampled peak summed RSS |    3.28 GiB |     3.81 GiB |
| Peak process count             |          12 |           15 |

Median time falls **15.2%**, while summed RSS rises about **0.53 GiB**. Sampling
uses `ps` every 250 ms on the CLI's process tree. RSS includes shared mappings
more than once; it is not unique physical memory, and interval sampling can miss
peaks. Sampling adds diagnostic overhead to both arms, so compare within this
pair, not against earlier uninstrumented timings.

All 1,200 measured captures match fresh hashes, all 120 decoded image pairs are
exact, and all 1,200 full structures match the baseline reference with valid
canonical hashes. No retries or failures.
[macOS accounting](two-browser-macos-results.json).

The prototype is preserved as a [patch](experiment-two-browsers.patch) against
`7239da1` and on `perf/two-browser-probe` at `8bde91d`. It is deliberately not in
production code. Before adoption it needs bounded allocation tied to actual
concurrency, small-run/startup measurements, memory limits, crash/teardown tests,
daemon ownership/design, and representative-suite verification. Its private-run
evidence does not establish warm-daemon behavior. Adding processes indiscriminately
would waste memory on one-story runs.

## Linux check

On a four-vCPU AMD EPYC 7763 GitHub runner at three total workers, five alternating
runs per arm measured 12.686 s median with one browser and 12.418 s with two:
**2.1% lower median**, only 1.1% lower mean (12.752 to 12.617 s). This small effect
is insufficient evidence for a general default change. Linux used three workers,
macOS eight, so these measurements do not isolate an operating-system effect.
Memory sampling was not enabled on Linux.

All 1,200 measured captures and full structures passed exactly, with zero retries
or failures; all 120 decoded cross-arm image pairs matched. See
[Linux accounting](two-browser-linux-results.json) and
[workflow artifacts](https://github.com/juxtapose-dev/juxtapose/actions/runs/38826277137).

The next production decision requires matched concurrency sweeps on representative
hardware, including small-run startup and memory costs. Keep one browser as the
production behavior until those results justify the added lifecycle complexity.

## Reproduction

```sh
node scripts/trace-screenshot.mjs examples/storybook/storybook-profile profile--images-large 10
JUX_STATE_DIR=$(mktemp -d) node scripts/profile-fast-png.mjs
JUX_PROFILE_CONCURRENCY=8 JUX_PROFILE_MEMORY=1 node scripts/compare-pipeline.mjs BASELINE_CLI PROTOTYPE_CLI examples/storybook/storybook-profile 5 --pixel-parity
node scripts/check-pipeline-structure-parity.mjs PROFILE_DIRECTORY
```

`JUX_PROFILE_MEMORY=1` adds optional process-tree memory samples to each raw
sample (requires the POSIX `ps` command); it leaves capture behavior unchanged. Omit it for normal timing runs.
