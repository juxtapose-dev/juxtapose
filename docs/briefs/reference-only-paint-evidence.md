# Reference-only paint evidence: streaming feasibility

Status: opt-in core API on a local research branch. No push, merge or release.
`extractTargetEvidenceStreaming(encodedImage)` returns `TargetEvidence` without
requiring a current DOM or capture. It is not wired to MCP, the default
extractor or the matcher. No capture behavior or acceptance policy changes.

## Why this work instead of another cache optimization

Completed probe agent sessions each used one batch: overlap caching would have
saved no captures there. The existing three-state saved-reference profile also
reports repeated analyses at roughly 2–5ms, negligible beside model decisions.
No speculative cache optimization follows from those workloads.

For a new implementation, pair matching cannot produce DOM-linked facts before
matching current components exist. More concretely, the shipped segmentation
abstains on the whole photo-heavy desktop/mobile website references after
40000 accumulated row runs. It therefore produces zero target blocks on both.

## Measured result

Streaming finalizes components after their last occupied row instead of keeping
all historical runs. It retains every pixel run; no color quantization, short-run
filter or CSS inference is introduced. A 1280×900 website reference has 234780
runs, but the prototype observes only 797 simultaneously live roots. This is a
live-component count, not a measured RSS reduction. Per-row runs, candidates and
returned blocks remain bounded; exceeding a limit abstains.

| Reference                    | Original complexity abstention | Streaming blocks | Substantial regions |
| ---------------------------- | ------------------------------ | ---------------: | ------------------: |
| Website desktop              | Yes                            |               96 |                   8 |
| Website mobile               | Yes                            |               68 |                   2 |
| Website mobile filter drawer | No                             |               18 |                   9 |
| Planner desktop              | No                             |                9 |                   5 |
| Planner mobile               | No                             |                6 |                   5 |
| Billing desktop              | No                             |                3 |                   3 |

“Substantial” is an offline packet filter: at least 144 solid pixels, width and
height at least 12px. Core returns up to 256 blocks. Study packets select at most
eight regions, not a new default response. Painted boxes are not CSS border
boxes, semantic components, recognized text or causes.

All six complete streaming results equal the original algorithm with only its
run limit raised to 400000 in an isolated comparison module, including inner
paint fingerprints, IDs, fills, geometry and abstention counts. This is an exact
pixel-component equivalence check, not proof of DOM matching precision or agent
value. No reference implementation or target DOM was supplied to an agent.

## Timing and rejected alternatives

Ten alternating-order native pairs per image follow one warmup for each method.
Decode plus complete evidence, including fingerprints, is timed. Local medians
on the desktop reference are 23.18ms streaming versus 16.01ms for the raised-limit
original; p95 is 35.00ms versus 27.50ms. Streaming is slower in this comparison.
The shipped budget-limited path abstains quickly, so it is not equal work.
These are local diagnostics, not OS-cold, CI or end-to-end agent measurements.

Short-run filtering recovered regions but changed a filter-screen box and lost
narrow shapes. Palette admission preserved tested shapes but still abstained on
the desktop reference. Both negative results are retained. Neither is adopted.
The first streaming prototype also exposed an abstention-count difference for
an excluded non-rectangular background; geometry was equal, and a regression
check now covers that accounting.

## Verification and next gate

Focused tests check exact evidence across 80 generated join/split/transparency
cases, non-rectangular background exclusion, content fingerprints, an encoded
image beyond the old run budget, repeated equality, extent validation and the
per-row limit, plus equal-area background tie ordering. Build, typecheck and
lint pass. The full serial suite passes 159 files and 2053 tests, with 3 skipped,
in 229.50s (`/private/tmp/jux-streaming-evidence-serial-suite.log`). Final built
API output is rechecked against all six complete saved results, byte-stable on
repeat; the default photo abstentions remain unchanged.

No paid model or browser capture runs were made for these studies. Before an
MCP exposure: validate a compact reference-only packet on a page-building
decision, prove its information helps beyond the same reference image and
source/tool access, and separately verify matcher precision if recovered blocks
are ever used for matching. Default output promotion requires agent-value
results. Cached derived evidence must include the producer/version identity.

Artifacts in `juxtapose-experiments/iteration-billing`: `target-only-evidence-v1`,
`target-short-runs-v1`, `target-palette-runs-v1`,
`target-palette-thresholds-v1`, `target-streaming-v1` (failed count check),
`target-streaming-v2`, and `target-streaming-core-v1` (complete evidence check), and
`target-streaming-core-final-v1` (final built API equality and default-preservation
check).
Each retains inputs/hashes, source snapshots and raw results.
