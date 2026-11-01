# Approval batching and manifest size (#255)

Historical contributor measurements from October 16, 2026. These results cover
the stated replay workload and method, not current end-to-end capture performance.
See [profiling](../profiling.md) to measure a new revision.

## Change

`init` and multi-story `approve` use a scoped batch for built-in baseline stores.
Each batch reads its manifest once, updates it in memory while handling images
sequentially, and writes once after the callback succeeds. A custom store without
`batch` retains its existing behavior. Individual panel approvals remain immediate.
The CLI's pre-confirmation manifest conflict check remains in place.

Manifest persistence uses a unique sibling temporary file followed by rename.
Approval success is reported after that commit resolves. An interrupted batch
leaves the previous manifest; rerun approval to complete it. Image files may have
been written already: this is a manifest batch, not an image-store transaction.
In particular, the legacy Git store still overwrites per-story images in place.
This does not introduce cross-process writer locking; use one approval writer per
project, as before. No manifest format or structure-hash changes are required.

## Reproduction

Build the old and new revisions with existing dependencies, then run:

```sh
node scripts/bench-approval.mjs RUN_DIRECTORY OLD_CORE_DIST_DIRECTORY 3
```

The script replays actual current images and structure sidecars through
`approveCapture`, with a fresh project/cache each time. It compares the complete
manifest bytes after each pair and fails on any difference. It measures approval
only: no browser, capture, fresh confirmation, or network is timed. Each trial
runs old then new; filesystem caching may favor the second run. Both paths use
fresh destination caches. These numbers are not end-to-end `jux init` timings.
The corpus includes every available current capture, independently of eligibility;
CLI tests separately exercise the unchanged fresh-confirmation/refusal rules.

Machine: macOS Apple Silicon, Node 26.11.1. Old implementation: main `2ea88f3`
(the core approval code is identical in the hosted-upload checkout used to run it).

## Spectrum: 1,086 real captures

Input: the retained capture corpus described below. Reproduce with your own
corresponding run directory; the original local scratch path is not a public fixture.

| Trial |  Before | Batched |
| ----- | ------: | ------: |
| 1     | 9.899 s | 0.653 s |
| 2     | 8.573 s | 0.646 s |
| 3     | 8.592 s | 0.647 s |

Median: 8.592 s → 0.647 s, **13.3× faster**. All three manifests byte-identical.
This is a large story count but smaller structures than the issue's 30.4 MB file.

## Chakra: 1,227 real captures

Input: the retained capture corpus described below. Reproduce with your own
corresponding run directory; the original local scratch path is not a public fixture.

| Trial |    Before | Batched |
| ----- | --------: | ------: |
| 1     | 108.027 s | 0.844 s |
| 2     | 107.352 s | 0.846 s |
| 3     | 108.427 s | 0.841 s |

Median: 108.027 s → 0.844 s, **127.9× faster**. All three manifests
byte-identical, 18,227,369 bytes each. This corpus has 39,176 captured elements;
it is substantially closer to #255's large-manifest case than Spectrum.

Chakra size audit: compact JSON 17,655,315 bytes (only 3.1% smaller);
whole-manifest gzip 958,328 bytes (94.7% smaller); compact manifest without
structures 336,038 bytes plus 1,599,095 bytes for individually gzipped structures.
Paths account for about 7.57 MB and styles 4.20 MB under the field accounting
below. Lossless path-prefix/style deduplication is more promising than removing
whitespace, but changes reader compatibility and should be a separate experiment.

## Manifest size investigation

Spectrum measurements (bytes):

| Representation                                        |     Bytes |
| ----------------------------------------------------- | --------: |
| Current readable manifest                             | 1,957,575 |
| Same data, compact JSON                               | 1,784,910 |
| Whole readable manifest, gzip                         |    57,342 |
| Compact manifest with inline structures removed       |   291,862 |
| Separate gzip structures, summed (excluding manifest) |   549,575 |

Field accounting across elements, including each field's key/wrapper: styles
500,624 bytes; paths 448,365; rectangles 169,490. The accounting is diagnostic,
not additive to the file size because wrappers are counted per field.

The extractor already omits initial non-inherited style values and inherited
styles that match their parent. Paths support matching/explanation, rectangles
support region association, and styles explain visual changes. Removing those
fields would sacrifice evidence. Whitespace removal saves only about 8.8% here.

Whole-file gzip gives excellent compression but removes readable Git diffs.
Per-story gzip loses cross-story compression and adds a committed-file lifecycle.
Keep the format for this fix. If a separate size change is justified, evaluate a
lossless versioned representation (such as repeated style/path dictionaries)
and measure reconstruction cost and diff quality; do not drop explanation data
or move it exclusively into an optional local cache.

## Validation

123 relevant core baseline and CLI approval/init tests passed. Tests cover one
manifest commit, untouched entries, callback failure, persistence failure, custom
store fallback, structure preservation/removal after corrupt sidecars, and interrupted writes
leaving the old manifest intact.
Build, typecheck, targeted lint, and formatting passed. Browser determinism was
not rerun because capture and rendering are unchanged.
